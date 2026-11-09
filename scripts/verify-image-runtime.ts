// Explicit live acceptance: two paid Image API calls (generate + reference edit).
// No SDK retries or provider fallback. Results stay in an isolated verification project.
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {buildApp} from '../apps/api/src/server.js';
import {config} from '../packages/server-infra/src/config.js';
import {pool} from '../packages/server-infra/src/db.js';
import {stopQueue} from '../packages/server-infra/src/queue.js';
import {ensureUploadStorage} from '../packages/server-infra/src/storage.js';
import {submitGeneration,ingestGeneration} from '../apps/worker/src/generation.js';
import {runBusinessJob} from '../apps/worker/src/process.js';
import {renderExport,closeBrowser} from '../apps/renderer/src/render.js';
if(!process.argv.includes('--live'))throw new Error('Use --live to authorize two billable Image API acceptance calls');
if(!config.openaiApiKey)throw new Error('OPENAI_API_KEY is not configured');
config.imageEnabled=true;await ensureUploadStorage();const app=await buildApp({logger:false});
const report:any={startedAt:new Date().toISOString(),model:config.imageModel,quality:config.imageQuality,storage:config.s3Endpoint.includes('r2.cloudflarestorage.com')?'R2':'local S3-compatible',checks:[]};
let cookie='',workspaceId='';
async function api(method:string,url:string,payload?:any){const result=await app.inject({method:method as any,url,payload,headers:{cookie,origin:config.webOrigin,'idempotency-key':randomUUID()}});if(result.statusCode>=400)throw new Error(`${method} ${url}: HTTP ${result.statusCode}`);return result.json();}
async function perform(projectId:string,input:any){
 const {generation}=await api('POST',`/api/projects/${projectId}/generations`,input);
 const jobs=(await pool.query('SELECT j.* FROM jobs j JOIN generation_attempts a ON a.id=j.id WHERE a.request_id=$1',[generation.id])).rows;
 for(const job of jobs)await submitGeneration({id:job.queue_id,data:{jobId:job.id,workspaceId}});
 let state=await api('GET',`/api/generations/${generation.id}`);
 if(state.attempts.some((a:any)=>a.status!=='received'))throw new Error(`Image call ${state.status}: ${state.error}`);
 const media=(await pool.query("SELECT j.* FROM jobs j JOIN generation_outputs o ON o.id=j.payload->>'outputId' WHERE o.request_id=$1 AND j.kind='generation.ingest'",[generation.id])).rows;
 for(const job of media)await runBusinessJob({id:job.queue_id,data:{jobId:job.id,workspaceId}},j=>ingestGeneration(j));
 state=await api('GET',`/api/generations/${generation.id}`);if(state.status!=='succeeded')throw new Error(`Media pipeline ${state.status}`);return state;
}
try{
 const auth=await app.inject({method:'POST',url:'/api/auth/register',payload:{email:`live-image-${randomUUID()}@example.test`,password:randomUUID()+randomUUID(),name:'Image API acceptance'}});if(auth.statusCode!==201)throw new Error('Verification identity creation failed');cookie=String(auth.headers['set-cookie']).split(';')[0];workspaceId=auth.json().workspace.id;
 const project=await api('POST','/api/projects',{title:'Design X v2 · Image API acceptance'});report.projectId=project.id;
 const generated=await perform(project.id,{prompt:'Studio product photograph of an unbranded white ceramic mug on warm beige stone, soft morning sunlight, clean background, no lettering, no logos.',count:1,size:'1024x1024',quality:'medium'});report.checks.push({name:'text-to-image + media + Board',status:'passed',generationId:generated.id,assetVersionId:generated.outputs[0].assetVersionId});console.log('Text-to-image, durable media and Board: passed');
 const edited=await perform(project.id,{prompt:'Preserve the ceramic mug shape and camera angle, change only the mug color to muted forest green. Keep the warm stone and soft light. No text.',count:1,size:'1024x1024',quality:'medium',referenceAssetVersionIds:[generated.outputs[0].assetVersionId]});report.checks.push({name:'reference edit + frozen lineage',status:'passed',generationId:edited.id,assetVersionId:edited.outputs[0].assetVersionId});console.log('Reference edit and frozen lineage: passed');
 const image=edited.outputs[0];const art=await api('POST',`/api/projects/${project.id}/artboards`,{title:'可编辑中文海报',design:{width:600,height:800,background:'#f6f3ec',nodes:[{id:'visual',type:'image',src:image.image,x:0,y:0,w:600,h:600},{id:'headline',type:'text',text:'清晨的一杯灵感',x:40,y:640,w:520,h:80,size:36,color:'#223322',font:'Noto Sans SC'}]}});
 const task=await api('POST',`/api/projects/${project.id}/exports`,{format:'png',documentId:art.id});const job=(await pool.query('SELECT * FROM jobs WHERE id=$1',[task.id])).rows[0];await runBusinessJob({id:job.queue_id,data:{jobId:job.id,workspaceId}},renderExport);const exported=await api('GET',`/api/jobs/${job.id}`);if(exported.status!=='succeeded')throw new Error('Renderer failed');
 report.checks.push({name:'editable Chinese layers + Renderer export',status:'passed',documentId:art.id,jobId:job.id});
 report.costs=(await pool.query('SELECT model,status,usage,cost_usd,cost_status FROM provider_calls WHERE workspace_id=$1',[workspaceId])).rows;
 report.status='passed';console.log('Editable design and Renderer export: passed');
}catch(error){report.status='failed';report.error=error instanceof Error?error.message:'Unknown verification error';console.log(JSON.stringify({status:report.status,error:report.error}));process.exitCode=1;}
finally{report.finishedAt=new Date().toISOString();await mkdir('artifacts/v2',{recursive:true});await writeFile('artifacts/v2/image-acceptance.json',JSON.stringify(report,null,2));await app.close();await closeBrowser();await stopQueue();await pool.end();}
