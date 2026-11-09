import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { Tx } from '../../server-infra/src/db.js';
import { ArtboardSchema,resizeArtboard } from '../../doc-core/src/index.js';
import { BoardSchema } from '../../doc-core/src/board.js';
import { createGeneration,GenerationInput } from './generations.js';
import { getProjectMetadata,artboardDto } from './projects.js';
import { emit,id,saveVersion,syncAssetRefs,notFound,HttpError } from './common.js';
import { recordOps } from './document-ops.js';
export const RecipeInput=z.object({recipeId:z.enum(['marketing-poster','product-set','multi-size']),recipeVersion:z.literal(1),parameters:z.object({prompt:z.string().trim().max(10000).optional(),headline:z.string().trim().max(160).default('新的灵感'),subheadline:z.string().max(500).optional(),cta:z.string().max(60).optional(),brand:z.string().max(80).optional(),assetId:z.string().max(150).optional(),documentId:z.string().max(150).optional(),sizes:z.array(z.object({width:z.number().int().min(64).max(4096),height:z.number().int().min(64).max(4096)}).strict()).min(1).max(3).optional()}).strict(),referenceAssetIds:z.array(z.string()).max(3).default([]),referenceAssetVersionIds:z.array(z.string()).max(3).default([]),baseBoardRevision:z.number().int().positive().optional()}).strict();
export function composeRecipe(parameters:z.infer<typeof RecipeInput>['parameters'],image:string,width=1080,height=1440){
 const margin=Math.round(width*.065),textWidth=width-margin*2,font=Math.min(96,Math.max(24,width/(Math.max(8,parameters.headline.length)*.6)));
 return ArtboardSchema.parse({width,height,background:'#f6f3ec',nodes:[
  {id:'visual',type:'image',src:image,x:0,y:0,w:width,h:height*.62,fit:'cover'},
  {id:'copy-panel',type:'rect',color:'#f6f3ec',x:0,y:height*.60,w:width,h:height*.40},
  {id:'headline',type:'text',text:parameters.headline,x:margin,y:height*.65,w:textWidth,h:height*.12,size:font,font:'Noto Sans SC',weight:700,color:'#222222'},
  ...(parameters.subheadline?[{id:'subheadline',type:'text',text:parameters.subheadline,x:margin,y:height*.78,w:textWidth,h:height*.09,size:Math.max(18,width*.026),font:'Noto Sans SC',color:'#555555'}]:[]),
  ...(parameters.brand?[{id:'brand',type:'text',text:parameters.brand,x:margin,y:height*.035,w:textWidth,h:height*.05,size:width*.028,font:'Noto Sans SC',weight:600,color:'#ffffff'}]:[]),
  ...(parameters.cta?[{id:'cta-bg',type:'rect',x:margin,y:height*.9,w:textWidth*.6,h:height*.055,color:'#292722'},{id:'cta',type:'text',text:parameters.cta,x:margin+width*.02,y:height*.906,w:textWidth*.55,h:height*.045,size:width*.026,font:'Noto Sans SC',weight:600,color:'#ffffff'}]:[]),
 ]});
}
export async function appendArtboards(tx:Tx,workspaceId:string,projectId:string,designs:{title:string;design:any}[],source:Record<string,unknown>={}){
 await getProjectMetadata(tx,projectId,false,true);
 const board=(await tx.query("SELECT * FROM documents WHERE project_id=$1 AND kind='board' FOR UPDATE",[projectId])).rows[0];if(!board)notFound();
 const results=[...(board.content.results||[])],artboards=[];const y=Math.min(99000,Math.max(0,...results.map((r:any)=>r.position?.y||0))+360);
 for(const [index,item] of designs.entries()){
  const design=ArtboardSchema.parse(item.design),doc=(await tx.query("INSERT INTO documents(id,workspace_id,project_id,kind,title,content) VALUES($1,$2,$3,'artboard',$4,$5) RETURNING *",[id(),workspaceId,projectId,item.title,JSON.stringify(design)])).rows[0];
  await syncAssetRefs(tx,workspaceId,doc.id,design);await saveVersion(tx,workspaceId,doc,'创作配方');
  const dto={...artboardDto(doc,{x:40+index*310,y}),kind:'artboard',...source};artboards.push(dto);const {design:_design,revision:_revision,...ref}=dto;results.push(ref);
 }
 const content=BoardSchema.parse({...board.content,results});
 const updated=(await tx.query('UPDATE documents SET content=$1,revision=revision+1,updated_at=now() WHERE id=$2 RETURNING *',[JSON.stringify(content),board.id])).rows[0];
 await recordOps(tx,workspaceId,updated,board.content);await tx.query('UPDATE projects SET updated_at=now() WHERE id=$1',[projectId]);
 await emit(tx,workspaceId,'board.committed',{projectId,revision:updated.revision,artboardIds:artboards.map(a=>a.id)});
 return {artboards,boardRevision:updated.revision};
}
export async function runRecipe(tx:Tx,workspaceId:string,projectId:string,input:z.infer<typeof RecipeInput>){
 await getProjectMetadata(tx,projectId,false,true);
 const board=(await tx.query("SELECT revision FROM documents WHERE project_id=$1 AND kind='board'",[projectId])).rows[0];
 if(input.baseBoardRevision!==undefined&&board.revision!==input.baseBoardRevision)throw new HttpError(409,'DOC_REVISION_CONFLICT','工作区已更新');
 if(input.recipeId==='multi-size'){
  if(!input.parameters.documentId||!input.parameters.sizes)throw new HttpError(400,'RECIPE_PARAMETERS_REQUIRED','多尺寸适配需要原画板及目标尺寸');
  const source=(await tx.query("SELECT * FROM documents WHERE project_id=$1 AND id=$2 AND kind='artboard'",[projectId,input.parameters.documentId])).rows[0];if(!source)notFound();
  const result=await appendArtboards(tx,workspaceId,projectId,input.parameters.sizes.map(size=>({title:`${source.title} · ${size.width}×${size.height}`,design:resizeArtboard(source.content,size.width,size.height)})),{recipeId:input.recipeId,recipeVersion:1,sourceDocumentId:source.id,sourceRevision:source.revision});
  await emit(tx,workspaceId,'activity.updated',{projectId,kind:'recipe',recipeId:input.recipeId,status:'succeeded',...result,artboards:undefined});
  return {...result,status:'succeeded',recipeId:input.recipeId};
 }
 const refs=[...new Set([...input.referenceAssetIds,...(input.parameters.assetId?[input.parameters.assetId]:[])])];
 if(input.recipeId==='product-set'&&!refs.length&&!input.referenceAssetVersionIds.length)throw new HttpError(400,'RECIPE_ASSET_REQUIRED','商品套图需要关联的商品参考图');
 const prompt=`${input.parameters.prompt||input.parameters.headline}\nCreate a campaign visual with space for typography. Do not render text, logos, lettering, or watermarks; text and brand elements will be composed as editable layers.`;
 return createGeneration(tx,workspaceId,projectId,GenerationInput.parse({prompt,count:input.recipeId==='product-set'?3:1,size:'1024x1536',referenceAssetIds:refs,referenceAssetVersionIds:input.referenceAssetVersionIds,baseBoardRevision:input.baseBoardRevision}),input);
}
export async function placeGenerationOutput(tx:Tx,workspaceId:string,attempt:any,output:any,asset:any){
 // Placement is an independent, idempotent side effect. Never recreate a removed node on retry.
 const current=(await tx.query('SELECT placement_status FROM generation_outputs WHERE id=$1 FOR UPDATE',[output.id])).rows[0];if(current.placement_status!=='pending')return;
 const request=attempt.snapshot;let reason=request.placement==='library'?'requested_library':null;
 const board=(await tx.query("SELECT * FROM documents WHERE project_id=$1 AND kind='board' FOR UPDATE",[attempt.project_id])).rows[0];
 if(!board)reason='board_missing';
 if(request.targetDocumentId){const target=(await tx.query('SELECT revision FROM documents WHERE id=$1 AND project_id=$2',[request.targetDocumentId,attempt.project_id])).rows[0];if(!target||!board?.content.results.some((r:any)=>r.id===request.targetDocumentId))reason='target_deleted';else if(target.revision!==request.baseRevision)reason='target_changed';}
 if(reason){await tx.query("UPDATE generation_outputs SET placement_status='library',placement_reason=$1 WHERE id=$2",[reason,output.id]);return;}
 if(request.recipe){
  const recipe=RecipeInput.parse(request.recipe);const result=await appendArtboards(tx,workspaceId,attempt.project_id,[{title:`${recipe.parameters.headline} · ${attempt.ordinal+1}`,design:composeRecipe(recipe.parameters,asset.image)}],{recipeId:recipe.recipeId,recipeVersion:1,generationId:attempt.request_id,assetVersionId:asset.assetVersionId});
  await tx.query("UPDATE generation_outputs SET placement_status='board',document_ids=$1 WHERE id=$2",[JSON.stringify(result.artboards.map(a=>a.id)),output.id]);return;
 }
 const item={id:`image-${output.id}`,kind:'image',assetId:asset.assetId,assetVersionId:asset.assetVersionId,generationId:attempt.request_id,title:request.prompt.slice(0,80),position:{x:40+attempt.ordinal*310,y:Math.min(99000,Math.max(0,...board.content.results.map((r:any)=>r.position?.y||0))+360)}};
 const content=BoardSchema.parse({...board.content,results:[...board.content.results,item]});
 const updated=(await tx.query('UPDATE documents SET content=$1,revision=revision+1,updated_at=now() WHERE id=$2 RETURNING *',[JSON.stringify(content),board.id])).rows[0];await recordOps(tx,workspaceId,updated,board.content);
 await tx.query("UPDATE generation_outputs SET placement_status='board' WHERE id=$1",[output.id]);await emit(tx,workspaceId,'board.committed',{projectId:attempt.project_id,revision:updated.revision,generationId:attempt.request_id});
}
