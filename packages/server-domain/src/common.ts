import { randomUUID } from 'node:crypto';
import { ArtboardSchema } from '../../doc-core/src/index.js';
import type { Tx } from '../../server-infra/src/db.js';
export const id = () => randomUUID();
export class HttpError extends Error { constructor(public statusCode: number, public code: string, message: string) { super(message); } }
export function notFound(): never { throw new HttpError(404, 'NOT_FOUND', '内容不存在或无权访问'); }
export const blankDesign = () => ({ width: 600, height: 800, background: '#ffffff', nodes: [] });
export const designSchema = ArtboardSchema;
export function validateDesign(input: unknown) { return ArtboardSchema.parse(input); }
export async function emit(tx: Tx, workspaceId: string, type: string, payload: unknown) {
 const {rows}=await tx.query('INSERT INTO events(workspace_id,type,payload) VALUES($1,$2,$3) RETURNING id',[workspaceId,type,JSON.stringify(payload)]);
 await tx.query("SELECT pg_notify('designx_events',$1)",[workspaceId]);
 return rows[0].id;
}
export const assetUrlPattern = /^\/api\/assets\/([a-zA-Z0-9-]+)\/(?:file|thumbnail)$/;
const samplePattern = /^\/assets\/(coffee|skincare|interior|fashion|headphones|nature)\.jpg$/;
export async function validateSources(tx: Tx, design: any) {
 const assetIds=new Set<string>();
 for (const node of design.nodes || []) {
   if (node.type!=='image' || !node.src) continue;
   const match=assetUrlPattern.exec(node.src);
   if (match) assetIds.add(match[1]);
   else if (!samplePattern.test(node.src)) throw new HttpError(400,'INVALID_ASSET','请先上传图片到素材库');
 }
 for (const assetId of assetIds) {
   const result=await tx.query("SELECT id FROM assets WHERE id=$1 AND deleted_at IS NULL AND status='ready' FOR SHARE",[assetId]);
   if (!result.rowCount) throw new HttpError(400,'INVALID_ASSET','引用的素材尚未就绪或不属于此空间');
 }
 return [...assetIds];
}
export async function syncAssetRefs(tx: Tx, workspaceId: string, documentId: string, design: any) {
 const refs=await validateSources(tx,design);
 await tx.query('DELETE FROM asset_refs WHERE document_id=$1',[documentId]);
 for (const assetId of refs) await tx.query('INSERT INTO asset_refs(workspace_id,asset_id,document_id) VALUES($1,$2,$3)',[workspaceId,assetId,documentId]);
}
export async function saveVersion(tx: Tx, workspaceId: string, doc: any, name?: string) {
 await tx.query('INSERT INTO document_versions(id,workspace_id,project_id,document_id,revision,name,content) VALUES($1,$2,$3,$4,$5,$6,$7)',[id(),workspaceId,doc.project_id,doc.id,doc.revision,name||null,JSON.stringify(doc.content)]);
}
export function assetDto(row:any) { return { id: row.id, title: row.title, image:`/api/assets/${row.id}/file`,thumbnail:`/api/assets/${row.id}/thumbnail`,type:'图片',category:'我的上传',status:row.status,error:row.error,bytes:Number(row.bytes),width:row.width,height:row.height,createdAt:row.created_at }; }
export function jobDto(row:any) { return { id:row.id,type:row.kind,kind:row.kind,projectId:row.project_id,status:row.status,progress:row.progress,error:row.error,result:row.result,attempts:row.attempts,createdAt:row.created_at,updatedAt:row.updated_at,downloadUrl:row.status==='succeeded'&&row.kind==='render.export'?`/api/exports/${row.id}/file`:null }; }
