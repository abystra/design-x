import type {Tx} from '../../server-infra/src/db.js';
import {config} from '../../server-infra/src/config.js';
import {idempotent} from './idempotency.js';
import {HttpError,notFound} from './common.js';
import {GenerationInput,createGeneration} from './generations.js';
import {RecipeInput,runRecipe} from './recipes.js';
import {freezeRenderInputs} from './render-inputs.js';
import {createJob} from './jobs.js';
import {authorizeFrozenMaterials} from './project-materials.js';
const objectSchema=(properties:any)=>({type:'object',properties,additionalProperties:false});
export const agentToolCatalog=[
 {name:'assets.list',description:'列出本轮冻结并已授权的项目素材及版本；不会打开个人素材库',inputSchema:objectSchema({})},
 {name:'generation.create',description:'提交异步图片生成或参考图编辑，每次最多三张，结果通过项目活动查看',inputSchema:{...objectSchema({prompt:{type:'string'},count:{type:'integer',minimum:1,maximum:3},referenceAssetVersionIds:{type:'array',items:{type:'string'},maxItems:3},size:{enum:['1024x1024','1024x1536','1536x1024']}}),required:['prompt']}},
 {name:'recipe.run',description:'执行固定版本的营销海报、商品套图或多尺寸适配配方',inputSchema:{type:'object',properties:{recipeId:{enum:['marketing-poster','product-set','multi-size']},recipeVersion:{const:1},parameters:{type:'object'},referenceAssetIds:{type:'array',items:{type:'string'}}},required:['recipeId','recipeVersion','parameters'],additionalProperties:false}},
 {name:'render.preview',description:'渲染已保存的项目画板，返回持久化的导出任务',inputSchema:{...objectSchema({documentId:{type:'string'}}),required:['documentId']}},
 {name:'proposal.get',description:'查看当前回合的提案；应用提案需要用户在界面确认并通过版本校验',inputSchema:objectSchema({})},
];
export async function executeAgentTool(tx:Tx,workspaceId:string,input:{turnId:string;attemptId:string;fence:number;callId:string;name:string;arguments:any}){
 const turn=(await tx.query("SELECT t.*,j.execution_token,j.status AS job_status,a.deadline_at,a.fence,a.lease_until,p.deleted_at FROM ai_turns t JOIN jobs j ON j.id=t.id JOIN ai_attempts a ON a.turn_id=t.id AND a.id=$2 JOIN projects p ON p.id=t.project_id WHERE t.id=$1 FOR UPDATE OF p,j",[input.turnId,input.attemptId])).rows[0];
 if(!turn||turn.deleted_at||turn.job_status!=='running'||turn.execution_token!==input.attemptId||Number(turn.fence)!==input.fence||new Date(turn.lease_until).getTime()<Date.now()||new Date(turn.deadline_at).getTime()<Date.now())throw new HttpError(409,'TOOL_LEASE_EXPIRED','工具调用执行权已失效');
 if(turn.context.materialManifest)await authorizeFrozenMaterials(tx,turn.context.materialManifest);
 const allowedVersions=new Set(turn.context.assets.map((a:any)=>a.assetVersionId||a.versionId)),allowedAssets=new Set(turn.context.assets.map((a:any)=>a.id));
 const args=input.arguments||{};
 if(args.referenceAssetVersionIds?.some((a:string)=>!allowedVersions.has(a))||args.referenceAssetIds?.some((a:string)=>!allowedAssets.has(a))||args.parameters?.assetId&&!allowedAssets.has(args.parameters.assetId))throw new HttpError(403,'TOOL_ASSET_SCOPE','工具仅能引用本回合已授权素材');
 const frozenArgs=structuredClone(args);
 const assetIds=[...(args.referenceAssetIds||[]),...(args.parameters?.assetId?[args.parameters.assetId]:[])];
 if(assetIds.length){
  frozenArgs.referenceAssetVersionIds=[...new Set([...(args.referenceAssetVersionIds||[]),...assetIds.map(id=>turn.context.assets.find((a:any)=>a.id===id).assetVersionId)])];
  frozenArgs.referenceAssetIds=[];if(frozenArgs.parameters)delete frozenArgs.parameters.assetId;
 }
 const key=`tool:${input.turnId}:${input.callId}`;if(key.length>200)throw new HttpError(400,'TOOL_CALL_ID','工具调用 ID 超出限制');
 const used=Number((await tx.query("SELECT count(*) FROM idempotency_keys WHERE key LIKE $1",[`tool:${input.turnId}:%`])).rows[0].count);
 if(used>=12&&!(await tx.query('SELECT 1 FROM idempotency_keys WHERE key=$1',[key])).rowCount)throw new HttpError(429,'TOOL_BUDGET_EXCEEDED','本轮工具调用预算已耗尽');
 return idempotent(tx,workspaceId,key,{name:input.name,arguments:args},async()=>{
  switch(input.name){
   case 'assets.list':return {assets:turn.context.assets};
   case 'generation.create':if(!config.imageEnabled||!config.openaiApiKey)throw new HttpError(503,'IMAGE_UNAVAILABLE','图片生成未启用');return createGeneration(tx,workspaceId,turn.project_id,GenerationInput.parse(frozenArgs));
   case 'recipe.run':{const recipe=RecipeInput.parse(frozenArgs);if(recipe.recipeId!=='multi-size'&&(!config.imageEnabled||!config.openaiApiKey))throw new HttpError(503,'IMAGE_UNAVAILABLE','图片生成未启用');return runRecipe(tx,workspaceId,turn.project_id,recipe);}
   case 'render.preview':{const doc=(await tx.query("SELECT * FROM documents WHERE id=$1 AND project_id=$2 AND kind='artboard'",[args.documentId,turn.project_id])).rows[0];if(!doc)notFound();const assets=await freezeRenderInputs(tx,doc.content);if(assets.some(a=>!allowedAssets.has(a.assetId)||a.assetVersionId&&!allowedVersions.has(a.assetVersionId)))throw new HttpError(403,'TOOL_ASSET_SCOPE','预览包含本轮未授权素材');return createJob(tx,workspaceId,'render.export',{format:'png',scale:1,documentId:doc.id,revision:doc.revision,design:doc.content,title:doc.title,assetVersions:assets},turn.project_id);}
   case 'proposal.get':return {proposals:turn.proposals,requiresUserConfirmation:true};
   default:throw new HttpError(403,'TOOL_NOT_ALLOWED','工具未获授权');
  }
 });
}
