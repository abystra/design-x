import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { tenantTransaction } from '../../../packages/server-infra/src/db.js';
import { id,notFound,HttpError,emit } from '../../../packages/server-domain/src/common.js';
import { templates } from '../../../src/data/templates.js';
import { readFile } from 'node:fs/promises';
const preferenceKeys=new Set(['favorites','template-favorites','asset-favorites','catalog-favorites','references','brand','ui','recent']);
export async function libraryRoutes(app:FastifyInstance) {
 app.get('/api/templates',async()=>templates);
 app.get('/api/catalog',async()=>JSON.parse(await readFile(new URL('../../../src/data/catalog.json',import.meta.url),'utf8')));
 app.get('/api/folders',async(req:any)=>tenantTransaction(req.identity.workspace.id,async tx=>(await tx.query('SELECT id,name,color FROM folders ORDER BY created_at')).rows));
 app.post('/api/folders',async(req:any,reply)=>tenantTransaction(req.identity.workspace.id,async tx=>{
  const body=z.object({name:z.string().trim().min(1).max(100),color:z.string().regex(/^#[0-9a-f]{6}$/i).default('#e6b49b')}).parse(req.body);
  const result=(await tx.query('INSERT INTO folders(id,workspace_id,name,color) VALUES($1,$2,$3,$4) RETURNING id,name,color',[id(),req.identity.workspace.id,body.name,body.color])).rows[0];reply.code(201);return result;
 }));
 app.patch('/api/folders/:id',async(req:any)=>tenantTransaction(req.identity.workspace.id,async tx=>{
  const body=z.object({name:z.string().trim().min(1).max(100)}).parse(req.body);
  const row=(await tx.query('UPDATE folders SET name=$1 WHERE id=$2 RETURNING id,name,color',[body.name,req.params.id])).rows[0];if(!row)notFound();return row;
 }));
 app.delete('/api/folders/:id',async(req:any)=>tenantTransaction(req.identity.workspace.id,async tx=>{
  if(!(await tx.query('DELETE FROM folders WHERE id=$1',[req.params.id])).rowCount)notFound();return {ok:true};
 }));
 app.get('/api/preferences/:key',async(req:any)=>tenantTransaction(req.identity.workspace.id,async tx=>{
  if(!preferenceKeys.has(req.params.key))notFound();
  return (await tx.query('SELECT value FROM preferences WHERE key=$1',[req.params.key])).rows[0]?.value??null;
 }));
 app.put('/api/preferences/:key',async(req:any)=>tenantTransaction(req.identity.workspace.id,async tx=>{
  const key=req.params.key;if(!preferenceKeys.has(key))notFound();let value=req.body;
  if(/favorites/.test(key))value=z.array(z.string().max(200)).max(5000).parse(value);
  if(key==='references')value=z.array(z.object({id:z.string().max(100),title:z.string().max(200),prompt:z.string().max(10000).optional(),image:z.string().max(2048).optional()}).passthrough()).max(500).parse(value);
  if(key==='brand')value=z.object({name:z.string().max(100),colors:z.array(z.string().regex(/^#[0-9a-f]{6}$/i)).min(1).max(20),description:z.string().max(3000).optional(),font:z.string().max(200).optional(),logo:z.string().max(2048).optional(),subtitle:z.string().max(300).optional()}).passthrough().parse(value);
  if(value===undefined||Buffer.byteLength(JSON.stringify(value))>1000000)throw new HttpError(400,'INVALID_PREFERENCE','设置数据超出限制');
  await tx.query('INSERT INTO preferences(workspace_id,key,value) VALUES($1,$2,$3) ON CONFLICT(workspace_id,key) DO UPDATE SET value=excluded.value,updated_at=now()',[req.identity.workspace.id,key,JSON.stringify(value)]);
  await emit(tx,req.identity.workspace.id,'preference.updated',{key});return value;
 }));
}
