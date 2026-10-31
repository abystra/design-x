import { recordOps } from '../../../packages/server-domain/src/document-ops.js';
import { BoardPositionSchema } from '../../../packages/doc-core/src/board.js';
import { idempotent } from '../../../packages/server-domain/src/idempotency.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { tenantTransaction } from '../../../packages/server-infra/src/db.js';
import { createProject,patchProject,getProject,projectDto,studioSnapshot,saveStudio,artboardDto } from '../../../packages/server-domain/src/projects.js';
import { id,notFound,emit,validateDesign,saveVersion,syncAssetRefs,HttpError,blankDesign,jobDto } from '../../../packages/server-domain/src/common.js';
const params=(req:any)=>req.params as Record<string,string>;
export async function projectRoutes(app:FastifyInstance) {
 app.get('/api/projects',async(req:any)=>tenantTransaction(req.identity.workspace.id,async tx=>{
  const trash=(req.query as any)?.trash==='1';
  const rows=(await tx.query(`SELECT p.*,d.content as design,d.revision,d.id as document_id FROM projects p LEFT JOIN documents d ON d.id=p.primary_artboard_id WHERE p.deleted_at IS ${trash?'NOT ':''}NULL ORDER BY p.updated_at DESC LIMIT 1000`)).rows;
  return rows.map(projectDto);
 }));
 app.post('/api/projects',async(req:any,reply)=>{const result=await tenantTransaction(req.identity.workspace.id,tx=>idempotent(tx,req.identity.workspace.id,req.headers['idempotency-key'],{route:'project.create',body:req.body},()=>createProject(tx,req.identity.workspace.id,req.body||{})));reply.code(201);return result;});
 app.get('/api/projects/:id',async(req:any)=>tenantTransaction(req.identity.workspace.id,async tx=>projectDto(await getProject(tx,params(req).id))));
 app.patch('/api/projects/:id',async(req:any)=>tenantTransaction(req.identity.workspace.id,tx=>patchProject(tx,req.identity.workspace.id,params(req).id,req.body||{})));
 app.delete('/api/projects/:id',async(req:any)=>tenantTransaction(req.identity.workspace.id,async tx=>{
  await getProject(tx,params(req).id);await tx.query('UPDATE projects SET deleted_at=now() WHERE id=$1',[params(req).id]);
  const cancelled=(await tx.query("UPDATE jobs SET status='cancelled',updated_at=now() WHERE project_id=$1 AND status IN ('queued','running') RETURNING *",[params(req).id])).rows;
  for(const job of cancelled)await emit(tx,req.identity.workspace.id,'job.updated',jobDto(job));
  await emit(tx,req.identity.workspace.id,'project.deleted',{projectId:params(req).id});return {ok:true};
 }));
 app.post('/api/projects/:id/restore',async(req:any)=>tenantTransaction(req.identity.workspace.id,async tx=>{
  await getProject(tx,params(req).id,true);await tx.query('UPDATE projects SET deleted_at=NULL,updated_at=now() WHERE id=$1',[params(req).id]);
  return projectDto(await getProject(tx,params(req).id));
 }));
 app.post('/api/projects/:id/open',async(req:any)=>tenantTransaction(req.identity.workspace.id,async tx=>{
  await getProject(tx,params(req).id);await tx.query('UPDATE projects SET last_opened_at=now() WHERE id=$1',[params(req).id]);return {ok:true};
 }));
 app.get('/api/projects/:id/studio',async(req:any)=>tenantTransaction(req.identity.workspace.id,tx=>studioSnapshot(tx,params(req).id)));
 app.put('/api/projects/:id/studio',async(req:any)=>tenantTransaction(req.identity.workspace.id,tx=>saveStudio(tx,req.identity.workspace.id,params(req).id,req.body||{})));
 app.post('/api/projects/:id/artboards',async(req:any)=>tenantTransaction(req.identity.workspace.id,async tx=>{
  const projectId=params(req).id;await getProject(tx,projectId);
  const body=req.body||{},design=validateDesign(body.design||blankDesign()),title=z.string().trim().min(1).max(200).parse(body.title||'自由画板');
  const position=BoardPositionSchema.parse(body.position||{x:0,y:0});
  const doc=(await tx.query("INSERT INTO documents(id,workspace_id,project_id,kind,title,content) VALUES($1,$2,$3,'artboard',$4,$5) RETURNING *",[id(),req.identity.workspace.id,projectId,title,JSON.stringify(design)])).rows[0];
  await syncAssetRefs(tx,req.identity.workspace.id,doc.id,design);await saveVersion(tx,req.identity.workspace.id,doc,'初始版本');
  const dto=artboardDto(doc,position);
  await tx.query("UPDATE documents SET content=jsonb_set(content,'{results}',coalesce(content->'results','[]'::jsonb)||$1::jsonb),revision=revision+1 WHERE project_id=$2 AND kind='board'",[JSON.stringify([{...dto,design:undefined}]),projectId]);
  await emit(tx,req.identity.workspace.id,'artboard.created',{projectId,documentId:doc.id});return dto;
 }));
 app.patch('/api/projects/:id/artboards/:artboardId',async(req:any)=>tenantTransaction(req.identity.workspace.id,async tx=>{
  const p=params(req),body=req.body||{};await getProject(tx,p.id);
  const current=(await tx.query("SELECT * FROM documents WHERE id=$1 AND project_id=$2 AND kind='artboard' FOR UPDATE",[p.artboardId,p.id])).rows[0];if(!current)notFound();
  if(body.baseRevision!==current.revision)throw new HttpError(409,'DOC_REVISION_CONFLICT','画板已更新，请重新载入');
  const design=validateDesign(body.design||current.content);await syncAssetRefs(tx,req.identity.workspace.id,current.id,design);
  const doc=(await tx.query('UPDATE documents SET content=$1,title=$2,revision=revision+1,updated_at=now() WHERE id=$3 RETURNING *',[JSON.stringify(design),String(body.title||current.title).slice(0,200),current.id])).rows[0];
  await recordOps(tx,req.identity.workspace.id,doc,current.content);
  await saveVersion(tx,req.identity.workspace.id,doc);
  await tx.query('UPDATE projects SET updated_at=now(),image=CASE WHEN primary_artboard_id=$1 THEN $2 ELSE image END WHERE id=$3',[current.id,design.nodes.find((n:any)=>n.type==='image')?.src||null,p.id]);
  await emit(tx,req.identity.workspace.id,'document.committed',{projectId:p.id,documentId:doc.id,revision:doc.revision});return artboardDto(doc,body.position);
 }));
 app.get('/api/projects/:id/versions',async(req:any)=>tenantTransaction(req.identity.workspace.id,async tx=>{
  await getProject(tx,params(req).id);return (await tx.query('SELECT id,document_id AS "documentId",revision,name,created_at AS "createdAt" FROM document_versions WHERE project_id=$1 ORDER BY created_at DESC LIMIT 300',[params(req).id])).rows;
 }));
 app.post('/api/projects/:id/versions',async(req:any)=>tenantTransaction(req.identity.workspace.id,async tx=>{
  const project=await getProject(tx,params(req).id),body=req.body||{};
  const doc=(await tx.query('SELECT * FROM documents WHERE id=$1 AND project_id=$2',[body.documentId||project.document_id,project.id])).rows[0];if(!doc)notFound();
  const name=z.string().trim().min(1).max(120).parse(body.name||'命名版本');await saveVersion(tx,req.identity.workspace.id,doc,name);return {ok:true};
 }));
 app.post('/api/projects/:id/versions/:versionId/restore',async(req:any)=>tenantTransaction(req.identity.workspace.id,async tx=>{
  const p=params(req),project=await getProject(tx,p.id);
  const version=(await tx.query('SELECT * FROM document_versions WHERE id=$1 AND project_id=$2',[p.versionId,p.id])).rows[0];if(!version)notFound();
  const current=(await tx.query('SELECT * FROM documents WHERE id=$1 FOR UPDATE',[version.document_id])).rows[0];
  const doc=(await tx.query('UPDATE documents SET content=$1,revision=revision+1,updated_at=now() WHERE id=$2 RETURNING *',[JSON.stringify(version.content),version.document_id])).rows[0];
  await recordOps(tx,req.identity.workspace.id,doc,current.content);
  await syncAssetRefs(tx,req.identity.workspace.id,doc.id,doc.content);await saveVersion(tx,req.identity.workspace.id,doc,`恢复：${version.name||version.revision}`);
  await tx.query('UPDATE projects SET updated_at=now(),image=CASE WHEN primary_artboard_id=$1 THEN $2 ELSE image END WHERE id=$3',[doc.id,doc.content.nodes?.find((n:any)=>n.type==='image')?.src||null,p.id]);
  await emit(tx,req.identity.workspace.id,'document.committed',{projectId:p.id,documentId:doc.id,revision:doc.revision});
  return projectDto(await getProject(tx,project.id));
 }));
}
