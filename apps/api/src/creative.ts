import type {FastifyInstance} from 'fastify';
import { tenantTransaction } from '../../../packages/server-infra/src/db.js';
import { config } from '../../../packages/server-infra/src/config.js';
import { capabilityCatalog } from '../../../packages/server-domain/src/capabilities.js';
import { GenerationInput,createGeneration,readGeneration,cancelGeneration,reserveQuota } from '../../../packages/server-domain/src/generations.js';
import { RecipeInput,runRecipe } from '../../../packages/server-domain/src/recipes.js';
import { idempotent } from '../../../packages/server-domain/src/idempotency.js';
import { getProjectMetadata } from '../../../packages/server-domain/src/projects.js';
import { createJob } from '../../../packages/server-domain/src/jobs.js';
import { HttpError } from '../../../packages/server-domain/src/common.js';
function key(req:any){const key=req.headers['idempotency-key'];if(typeof key!=='string'||!key.trim()||key.length>200)throw new HttpError(400,'IDEMPOTENCY_KEY_REQUIRED','请提供唯一请求标识');return key;}
function imageAvailable(){if(!config.imageEnabled||!config.openaiApiKey)throw new HttpError(503,'IMAGE_UNAVAILABLE','图片生成尚未启用');}
export async function creativeRoutes(app:FastifyInstance,options:{aiEnabled:boolean}){
 app.get('/api/capabilities',async(req:any)=>tenantTransaction(req.identity.workspace.id,tx=>capabilityCatalog(tx,options.aiEnabled)));
 app.post('/api/projects/:id/generations',async(req:any,reply)=>{
  imageAvailable();const input=GenerationInput.parse(req.body),requestKey=key(req);
  const result=await tenantTransaction(req.identity.workspace.id,async tx=>{await getProjectMetadata(tx,req.params.id,false,true);return idempotent(tx,req.identity.workspace.id,requestKey,{route:'generation.create',projectId:req.params.id,input},()=>createGeneration(tx,req.identity.workspace.id,req.params.id,input));});reply.code(202);return result;
 });
 app.get('/api/projects/:id/generations',async(req:any)=>tenantTransaction(req.identity.workspace.id,async tx=>{await getProjectMetadata(tx,req.params.id);const rows=(await tx.query('SELECT id FROM creative_requests WHERE project_id=$1 ORDER BY created_at DESC LIMIT 100',[req.params.id])).rows;return Promise.all(rows.map(r=>readGeneration(tx,r.id)));}));
 app.get('/api/generations/:id',async(req:any)=>tenantTransaction(req.identity.workspace.id,tx=>readGeneration(tx,req.params.id)));
 app.post('/api/generations/:id/cancel',async(req:any)=>tenantTransaction(req.identity.workspace.id,tx=>idempotent(tx,req.identity.workspace.id,key(req),{route:'generation.cancel',id:req.params.id},()=>cancelGeneration(tx,req.identity.workspace.id,req.params.id))));
 app.post('/api/generations/:id/regenerate',async(req:any,reply)=>{
  imageAvailable();const requestKey=key(req);
  const result=await tenantTransaction(req.identity.workspace.id,async tx=>{const previous=await readGeneration(tx,req.params.id);await getProjectMetadata(tx,previous.projectId,false,true);
   const row=(await tx.query('SELECT snapshot FROM creative_requests WHERE id=$1',[req.params.id])).rows[0];const s=row.snapshot;
   const input=GenerationInput.parse({prompt:s.prompt,count:s.count,size:s.size,quality:s.quality,referenceAssetVersionIds:s.references.map((r:any)=>r.assetVersionId),placement:s.placement});
   return idempotent(tx,req.identity.workspace.id,requestKey,{route:'generation.regenerate',id:req.params.id},()=>createGeneration(tx,req.identity.workspace.id,previous.projectId,input,s.recipe));});reply.code(202);return result;
 });
 app.post('/api/generations/:id/retry-ingestion',async(req:any,reply)=>{
  const result=await tenantTransaction(req.identity.workspace.id,async tx=>{const g=await readGeneration(tx,req.params.id);await getProjectMetadata(tx,g.projectId,false,true);if(g.cancelRequested)throw new HttpError(409,'GENERATION_CANCELLED','已取消请求不能重试摄取');return idempotent(tx,req.identity.workspace.id,key(req),{route:'generation.ingest.retry',id:req.params.id},async()=>{
   const rows=(await tx.query("SELECT o.id,a.id AS attempt_id,a.fence FROM generation_outputs o JOIN generation_attempts a ON a.id=o.attempt_id WHERE o.request_id=$1 AND o.state IN ('failed','ingest_retry') AND (o.staging_key IS NOT NULL OR o.encoded_result IS NOT NULL) FOR UPDATE OF o,a",[req.params.id])).rows;
   for(const r of rows){await reserveQuota(tx,req.identity.workspace.id,r.attempt_id,true);await tx.query("UPDATE generation_attempts SET execution_status='received',error=NULL WHERE id=$1",[r.attempt_id]);await tx.query("UPDATE generation_outputs SET state='received' WHERE id=$1",[r.id]);await createJob(tx,req.identity.workspace.id,'generation.ingest',{outputId:r.id,attemptId:r.attempt_id,fence:r.fence},g.projectId);}return {generation:await readGeneration(tx,req.params.id)};
  });});reply.code(202);return result;
 });
 app.post('/api/projects/:id/recipes',async(req:any,reply)=>{
  const input=RecipeInput.parse(req.body);if(input.recipeId!=='multi-size')imageAvailable();
  const result=await tenantTransaction(req.identity.workspace.id,async tx=>{await getProjectMetadata(tx,req.params.id,false,true);return idempotent(tx,req.identity.workspace.id,key(req),{route:'recipe.run',projectId:req.params.id,input},()=>runRecipe(tx,req.identity.workspace.id,req.params.id,input));});reply.code(input.recipeId==='multi-size'?201:202);return result;
 });
 app.get('/api/projects/:id/activities',async(req:any)=>tenantTransaction(req.identity.workspace.id,async tx=>{
  await getProjectMetadata(tx,req.params.id);
  const rows=(await tx.query(`SELECT id,'generation' AS type,snapshot->>'prompt' AS title,execution_status AS status,error AS detail,created_at FROM creative_requests WHERE project_id=$1
   UNION ALL SELECT id,CASE WHEN kind='ai.turn' THEN 'agent' ELSE kind END,CASE WHEN kind='ai.turn' THEN 'Agent 创作' WHEN kind='render.export' THEN '导出作品' ELSE kind END,status,error,created_at FROM jobs WHERE project_id=$1 AND kind NOT LIKE 'generation.%'
   UNION ALL SELECT id,'version',COALESCE(name,'文档版本 '||revision::text),'succeeded',NULL,created_at FROM document_versions WHERE project_id=$1
   UNION ALL SELECT id::text,type,COALESCE(payload->>'message',payload->>'kind',type),COALESCE(payload->>'status','recorded'),NULL,created_at FROM events WHERE payload->>'projectId'=$1 AND (type LIKE 'interaction.%' OR type='activity.updated') ORDER BY created_at DESC LIMIT 150`,[req.params.id])).rows;
  return rows.map(r=>({id:`${r.type}:${r.id}`,sourceId:r.id,type:r.type,title:r.title,status:r.status,detail:r.detail,createdAt:r.created_at}));
 }));
}
