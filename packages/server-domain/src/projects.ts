import { recordOps } from './document-ops.js';
import { BoardSchema } from '../../doc-core/src/board.js';
import { z } from 'zod';
import type { Tx } from '../../server-infra/src/db.js';
import { id, blankDesign, validateDesign, syncAssetRefs, saveVersion, emit, HttpError, notFound } from './common.js';
export async function getProject(tx:Tx,projectId:string,includeDeleted=false) {
 return readProject(tx,projectId,includeDeleted,true);
}
export async function getProjectMetadata(tx:Tx,projectId:string,includeDeleted=false) {
 return readProject(tx,projectId,includeDeleted,false);
}
async function readProject(tx:Tx,projectId:string,includeDeleted:boolean,includeDesign:boolean) {
 const {rows}=await tx.query(`SELECT p.*, ${includeDesign?'d.content AS design,':''}d.revision,d.id as document_id FROM projects p LEFT JOIN documents d ON d.id=p.primary_artboard_id WHERE p.id=$1 ${includeDeleted?'':'AND p.deleted_at IS NULL'}`,[projectId]);
 if(!rows[0])notFound();return rows[0];
}
export function projectDto(p:any) {return {id:p.id,projectId:p.id,documentId:p.document_id,title:p.title,type:p.type,image:p.image,color:p.color,folderId:p.folder_id,design:p.design,revision:p.revision,persisted:true,updatedAt:p.updated_at,createdAt:p.created_at,lastOpenedAt:p.last_opened_at?new Date(p.last_opened_at).getTime():0,deletedAt:p.deleted_at};}
export function artboardDto(d:any,position={x:0,y:0}) {return {id:d.id,documentId:d.id,projectId:d.project_id,title:d.title,type:'设计作品',design:d.content,revision:d.revision,image:d.content?.nodes?.find((n:any)=>n.type==='image')?.src,persisted:true,position};}
export async function createProject(tx:Tx,workspaceId:string,input:any) {
 const title=z.string().trim().min(1).max(200).parse(input.title||'未命名创作');
 const design=validateDesign(input.design||blankDesign());
 const projectId=id(),documentId=id(),boardId=id();
 await tx.query('INSERT INTO projects(id,workspace_id,title,image,color,primary_artboard_id) VALUES($1,$2,$3,$4,$5,$6)',[projectId,workspaceId,title,design.nodes.find((n:any)=>n.type==='image')?.src||null,input.color||design.background,documentId]);
 const doc=(await tx.query("INSERT INTO documents(id,workspace_id,project_id,kind,title,content) VALUES($1,$2,$3,'artboard',$4,$5) RETURNING *",[documentId,workspaceId,projectId,title,JSON.stringify(design)])).rows[0];
 await syncAssetRefs(tx,workspaceId,documentId,design);await saveVersion(tx,workspaceId,doc,'初始版本');
 const snapshot={id:projectId,title,results:[artboardDto(doc)],messages:[],assets:[],attached:[],draft:'',view:{x:70,y:100,zoom:1},selected:documentId};
 await tx.query("INSERT INTO documents(id,workspace_id,project_id,kind,title,content) VALUES($1,$2,$3,'board',$4,$5)",[boardId,workspaceId,projectId,title,JSON.stringify(snapshot)]);
 await emit(tx,workspaceId,'project.created',{projectId});
 return projectDto(await getProject(tx,projectId));
}
export async function patchProject(tx:Tx,workspaceId:string,projectId:string,input:any) {
 await tx.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE',[projectId]);
 const project=await getProject(tx,projectId);
 if(input.folderId){if(!(await tx.query('SELECT id FROM folders WHERE id=$1',[input.folderId])).rowCount)notFound();}
 const title=input.title===undefined?project.title:z.string().trim().min(1).max(200).parse(input.title);
 if(input.design!==undefined){
  if(input.baseRevision!==project.revision)throw new HttpError(409,'DOC_REVISION_CONFLICT','设计已在其他页面更新，请重新载入后继续');
  const design=validateDesign(input.design);await syncAssetRefs(tx,workspaceId,project.document_id,design);
  const doc=(await tx.query('UPDATE documents SET content=$1,revision=revision+1,title=$2,updated_at=now() WHERE id=$3 RETURNING *',[JSON.stringify(design),title,project.document_id])).rows[0];
  await recordOps(tx,workspaceId,doc,project.design);
  await saveVersion(tx,workspaceId,doc);
  await tx.query('UPDATE projects SET image=$1 WHERE id=$2',[design.nodes.find((n:any)=>n.type==='image')?.src||null,projectId]);
  await emit(tx,workspaceId,'document.committed',{projectId,documentId:doc.id,revision:doc.revision});
 }
 await tx.query('UPDATE projects SET title=$1,folder_id=$2,updated_at=now() WHERE id=$3',[title,input.folderId===undefined?project.folder_id:input.folderId||null,projectId]);
 return projectDto(await getProject(tx,projectId));
}
export async function studioSnapshot(tx:Tx,projectId:string) {
 await getProjectMetadata(tx,projectId);
 const board=(await tx.query("SELECT * FROM documents WHERE project_id=$1 AND kind='board'",[projectId])).rows[0];
 if(!board)notFound();
 return hydrateStudio(tx,projectId,board);
}
async function hydrateStudio(tx:Tx,projectId:string,board:any) {
 const memberIds=(board.content.results||[]).map((result:any)=>result.id);
 const docs=(await tx.query("SELECT id,project_id,title,content,revision FROM documents WHERE project_id=$1 AND kind='artboard' AND id=ANY($2::text[])",[projectId,memberIds])).rows;
 const byId=new Map(docs.map(d=>[d.id,d]));
 const results=(board.content.results||[]).filter((r:any)=>byId.has(r.id)).map((r:any)=>({...r,...artboardDto(byId.get(r.id),r.position)}));
 return {snapshot:{...board.content,results},revision:board.revision};
}
export async function saveStudio(tx:Tx,workspaceId:string,projectId:string,input:any,acknowledgeOnly=false) {
 await getProjectMetadata(tx,projectId);
 const board=(await tx.query("SELECT * FROM documents WHERE project_id=$1 AND kind='board' FOR UPDATE",[projectId])).rows[0];
 if(!board)notFound();
 if(input.baseRevision!==board.revision)throw new HttpError(409,'DOC_REVISION_CONFLICT','工作区已更新，请刷新后重试');
 const snapshot=BoardSchema.parse(input.snapshot);
 if(Buffer.byteLength(JSON.stringify(snapshot))>5*1024*1024)throw new HttpError(413,'PAYLOAD_TOO_LARGE','工作区数据过大');
 // Board saves only organize existing Artboards. Their design contents remain authoritative in documents.
 const memberIds=snapshot.results.map(result=>z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/).parse(result.id));
 const members=(await tx.query('SELECT id,project_id,kind FROM documents WHERE id=ANY($1::text[])',[memberIds])).rows;
 const byId=new Map(members.map(member=>[member.id,member]));
 for(const result of snapshot.results){
  const existing=byId.get(result.id);
  if(existing){if(existing.project_id!==projectId||existing.kind!=='artboard')notFound();continue;}
  throw new HttpError(400,'UNKNOWN_ARTBOARD','请先创建画板，再加入工作区');
 }
 // Do not duplicate document bodies in the Board's persistence format.
 const content={...snapshot,id:projectId,results:snapshot.results.map(({design,revision,...rest}:any)=>rest)};
 const updated=(await tx.query('UPDATE documents SET content=$1,revision=revision+1,updated_at=now() WHERE id=$2 RETURNING *',[JSON.stringify(content),board.id])).rows[0];
 await recordOps(tx,workspaceId,updated,board.content);
 if(snapshot.title?.trim())await tx.query('UPDATE projects SET title=$1,updated_at=now() WHERE id=$2',[snapshot.title.trim(),projectId]);
 await emit(tx,workspaceId,'board.committed',{projectId,revision:board.revision+1});
 if(acknowledgeOnly)return {projectId,documentId:updated.id,revision:updated.revision,updatedAt:updated.updated_at};
 return hydrateStudio(tx,projectId,updated);
}
