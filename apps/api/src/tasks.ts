import { idempotent } from '../../../packages/server-domain/src/idempotency.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { tenantTransaction,pool } from '../../../packages/server-infra/src/db.js';
import { sendInTransaction,startQueue } from '../../../packages/server-infra/src/queue.js';
import { getObject } from '../../../packages/server-infra/src/storage.js';
import { createJob } from '../../../packages/server-domain/src/jobs.js';
import { getProject } from '../../../packages/server-domain/src/projects.js';
import { id,jobDto,HttpError,notFound,emit } from '../../../packages/server-domain/src/common.js';
// Export payloads can contain every design in a project; status reads never need them.
const jobStatusColumns='id,project_id,kind,status,progress,error,result,attempts,created_at,updated_at';
export async function taskRoutes(app:FastifyInstance) {
 app.get('/api/jobs',async(req:any)=>tenantTransaction(req.identity.workspace.id,async tx=>{
  const projectId=req.query.projectId||req.query.project_id;
  const rows=projectId?(await tx.query(`SELECT ${jobStatusColumns} FROM jobs WHERE project_id=$1 AND EXISTS (SELECT 1 FROM projects p WHERE p.id=jobs.project_id AND p.deleted_at IS NULL) ORDER BY created_at DESC LIMIT 200`,[projectId])).rows:(await tx.query(`SELECT ${jobStatusColumns} FROM jobs WHERE project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=jobs.project_id AND p.deleted_at IS NULL) ORDER BY created_at DESC LIMIT 200`)).rows;
  return rows.map(jobDto);
 }));
 app.get('/api/jobs/:id',async(req:any)=>tenantTransaction(req.identity.workspace.id,async tx=>{const job=(await tx.query(`SELECT ${jobStatusColumns} FROM jobs WHERE id=$1 AND (project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=jobs.project_id AND p.deleted_at IS NULL))`,[req.params.id])).rows[0];if(!job)notFound();return jobDto(job);}));
 app.post('/api/jobs/:id/retry',async(req:any)=>tenantTransaction(req.identity.workspace.id,async tx=>{
  const current=(await tx.query("SELECT * FROM jobs WHERE id=$1 AND (project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=jobs.project_id AND p.deleted_at IS NULL)) FOR UPDATE",[req.params.id])).rows[0];if(!current)notFound();
  if(!['failed','cancelled'].includes(current.status))throw new HttpError(409,'INVALID_JOB_STATE','只有失败或取消的任务可以重试');
  const queueId=id();const job=(await tx.query("UPDATE jobs SET status='queued',progress=0,error=NULL,execution_token=NULL,queue_id=$1,updated_at=now() WHERE id=$2 RETURNING *",[queueId,current.id])).rows[0];
  if(current.kind==='media.ingest'){if(!(await tx.query("UPDATE assets SET status='pending',error=NULL WHERE id=$1 AND deleted_at IS NULL",[current.payload.assetId])).rowCount)notFound();}
  await sendInTransaction(tx,current.kind,{workspaceId:req.identity.workspace.id,jobId:current.id},queueId);
  await emit(tx,req.identity.workspace.id,'job.updated',jobDto(job));return jobDto(job);
 }));
 app.post('/api/jobs/:id/cancel',async(req:any)=>{
  const result=await tenantTransaction(req.identity.workspace.id,async tx=>{
   const current=(await tx.query("SELECT * FROM jobs WHERE id=$1 AND (project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=jobs.project_id AND p.deleted_at IS NULL)) FOR UPDATE",[req.params.id])).rows[0];if(!current)notFound();
   if(['succeeded','failed','cancelled'].includes(current.status))return current;
   const job=(await tx.query("UPDATE jobs SET status='cancelled',error=NULL,updated_at=now() WHERE id=$1 RETURNING *",[current.id])).rows[0];
   await emit(tx,req.identity.workspace.id,'job.updated',jobDto(job));return job;
  });
  if(result.status==='cancelled'&&result.queue_id)await (await startQueue()).cancel(result.kind,result.queue_id);
  return jobDto(result);
 });
 app.post('/api/projects/:id/exports',async(req:any,reply)=>tenantTransaction(req.identity.workspace.id,async tx=>{
  const body=z.object({format:z.enum(['png','jpeg','jpg','webp','pdf','svg','dxproj']).default('png'),scale:z.number().min(0.25).max(4).default(1),transparent:z.boolean().default(false),documentId:z.string().optional()}).parse(req.body||{});
  const project=await getProject(tx,req.params.id);
  const doc=(await tx.query("SELECT * FROM documents WHERE id=$1 AND project_id=$2 AND kind='artboard'",[body.documentId||project.document_id,project.id])).rows[0];if(!doc)notFound();
  if(doc.content.width*body.scale>16384||doc.content.height*body.scale>16384||doc.content.width*doc.content.height*body.scale**2>40000000)throw new HttpError(400,'EXPORT_TOO_LARGE','导出像素超出限制，请降低倍率');
  const documents=body.format==='dxproj'?(await tx.query('SELECT id,kind,title,content,revision FROM documents WHERE project_id=$1',[project.id])).rows:undefined;
  const job=await idempotent(tx,req.identity.workspace.id,req.headers['idempotency-key'],{route:'export.create',projectId:project.id,body},()=>createJob(tx,req.identity.workspace.id,'render.export',{...body,format:body.format==='jpg'?'jpeg':body.format,documentId:doc.id,revision:doc.revision,design:doc.content,title:body.format==='dxproj'?project.title:doc.title||project.title,primaryArtboardId:project.document_id,documents},project.id));
  reply.code(202);return job;
 }));
 app.get('/api/exports/:id/file',async(req:any,reply)=>{
  const job=await tenantTransaction(req.identity.workspace.id,async tx=>(await tx.query("SELECT j.* FROM jobs j JOIN projects p ON p.id=j.project_id WHERE j.id=$1 AND j.kind='render.export' AND p.deleted_at IS NULL",[req.params.id])).rows[0]);
  if(!job)notFound();if(job.status!=='succeeded')throw new HttpError(409,'EXPORT_NOT_READY','导出尚未完成');
  const result=await getObject(job.result.objectKey);reply.type(result.contentType);reply.header('Content-Disposition',`attachment; filename*=UTF-8''${encodeURIComponent(job.result.filename)}`);return result.bytes;
 });
 const streams=new Set<()=>void>();
 const listeners=new Map<string,Set<()=>void>>();
 const notificationConnection=await pool.connect();await notificationConnection.query('LISTEN designx_events');
 notificationConnection.on('notification',event=>{for(const notify of listeners.get(event.payload||'')||[])notify();});
 app.addHook('onClose',async()=>{for(const close of streams)close();await notificationConnection.query('UNLISTEN designx_events');notificationConnection.release();});
 app.get('/api/events',async(req:any,reply)=>{
  const header=req.headers['last-event-id'];let cursor=String(header||req.query.since||'0');
  if(!/^\d{1,20}$/.test(cursor))throw new HttpError(400,'INVALID_CURSOR','事件游标无效');
  reply.hijack();reply.raw.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache, no-transform',Connection:'keep-alive','X-Accel-Buffering':'no'});reply.raw.write('retry: 1500\n\n');
  let closed=false,busy=false;
  const close=()=>{if(closed)return;closed=true;clearInterval(timer);clearInterval(heartbeat);streams.delete(close);listeners.get(req.identity.workspace.id)?.delete(notify);reply.raw.end();};
  const pump=async()=>{
   if(closed||busy)return;busy=true;
   try{
    if(!(await pool.query('SELECT 1 FROM sessions WHERE token_hash=$1 AND expires_at>now()',[req.identity.tokenHash])).rowCount){close();return;}
    const rows=await tenantTransaction(req.identity.workspace.id,async tx=>(await tx.query('SELECT id,type,payload,created_at FROM events WHERE id>$1 ORDER BY id LIMIT 200',[cursor])).rows);
    for(const event of rows){if(closed)break;cursor=String(event.id);reply.raw.write(`id: ${cursor}\nevent: ${event.type}\ndata: ${JSON.stringify({id:cursor,type:event.type,payload:event.payload,createdAt:event.created_at})}\n\n`);}
   }catch(error){req.log.error(error);close();}finally{busy=false;}
  };
  const notify=()=>void pump();if(!listeners.has(req.identity.workspace.id))listeners.set(req.identity.workspace.id,new Set());listeners.get(req.identity.workspace.id)!.add(notify);
  const timer=setInterval(()=>void pump(),10000),heartbeat=setInterval(()=>{if(!closed)reply.raw.write(': heartbeat\n\n');},15000);
  streams.add(close);reply.raw.on('close',close);await pump();
 });
}
