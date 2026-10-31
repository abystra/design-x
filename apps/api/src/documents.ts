import {canonical} from '../../../packages/server-domain/src/idempotency.js';
import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {applyOps,type DocOp} from '../../../packages/doc-core/src/index.js';
import {tenantTransaction} from '../../../packages/server-infra/src/db.js';
import {recordOps} from '../../../packages/server-domain/src/document-ops.js';
import {syncAssetRefs,saveVersion,emit,HttpError,notFound} from '../../../packages/server-domain/src/common.js';
const opsSchema=z.array(z.discriminatedUnion('type',[
 z.object({type:z.literal('canvas'),patch:z.object({width:z.number().optional(),height:z.number().optional(),background:z.string().optional()})}),
 z.object({type:z.literal('put'),node:z.record(z.string(),z.any()),index:z.number().int().min(0).max(1000)}),
 z.object({type:z.literal('remove'),id:z.string()}),
 z.object({type:z.literal('order'),ids:z.array(z.string()).max(1000)}),
])).max(2000);
export async function documentRoutes(app:FastifyInstance){
 app.get('/api/documents/:id',async(req:any)=>tenantTransaction(req.identity.workspace.id,async tx=>{
  const row=(await tx.query('SELECT d.* FROM documents d JOIN projects p ON p.id=d.project_id WHERE d.id=$1 AND p.deleted_at IS NULL',[req.params.id])).rows[0];if(!row)notFound();
  return {id:row.id,projectId:row.project_id,kind:row.kind,title:row.title,content:row.content,revision:row.revision};
 }));
 app.get('/api/documents/:id/ops',async(req:any)=>tenantTransaction(req.identity.workspace.id,async tx=>{
  if(!(await tx.query('SELECT d.id FROM documents d JOIN projects p ON p.id=d.project_id WHERE d.id=$1 AND p.deleted_at IS NULL',[req.params.id])).rowCount)notFound();
  const since=z.coerce.number().int().min(0).default(0).parse(req.query.since);
  return (await tx.query('SELECT revision,client_op_id AS "clientOpId",ops,created_at AS "createdAt" FROM document_ops WHERE document_id=$1 AND revision>$2 ORDER BY revision LIMIT 500',[req.params.id,since])).rows;
 }));
 app.post('/api/documents/:id/ops',async(req:any)=>tenantTransaction(req.identity.workspace.id,async tx=>{
  const body=z.object({baseRevision:z.number().int().min(1),clientOpId:z.string().min(1).max(200),ops:opsSchema}).parse(req.body);
  const doc=(await tx.query("SELECT d.* FROM documents d JOIN projects p ON p.id=d.project_id WHERE d.id=$1 AND p.deleted_at IS NULL AND d.kind='artboard' FOR UPDATE OF d",[req.params.id])).rows[0];if(!doc)notFound();
  const previous=(await tx.query('SELECT revision,ops FROM document_ops WHERE document_id=$1 AND client_op_id=$2',[doc.id,body.clientOpId])).rows[0];
  if(previous){if(canonical(previous.ops)!==canonical(body.ops))throw new HttpError(409,'IDEMPOTENCY_KEY_REUSED','操作标识已使用');return {documentId:doc.id,revision:previous.revision};}
  if(doc.revision!==body.baseRevision)throw new HttpError(409,'DOC_REVISION_CONFLICT','文档已更新，请重新载入');
  const content=applyOps(doc.content,body.ops as DocOp[]);await syncAssetRefs(tx,req.identity.workspace.id,doc.id,content);
  const updated=(await tx.query('UPDATE documents SET content=$1,revision=revision+1,updated_at=now() WHERE id=$2 RETURNING *',[JSON.stringify(content),doc.id])).rows[0];
  await recordOps(tx,req.identity.workspace.id,updated,doc.content,body.clientOpId,body.ops);await saveVersion(tx,req.identity.workspace.id,updated);
  await tx.query('UPDATE projects SET updated_at=now() WHERE id=$1',[doc.project_id]);
  await emit(tx,req.identity.workspace.id,'document.committed',{projectId:doc.project_id,documentId:doc.id,revision:updated.revision});
  return {documentId:doc.id,revision:updated.revision,content:updated.content};
 }));
}
