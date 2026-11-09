import { importProject } from './import-project.js';
import { runAiTurn } from './ai-turn.js';
import { reconcileJobs } from './reconcile.js';
import { submitGeneration,ingestGeneration,reconcileGenerations } from './generation.js';
import { startQueue,stopQueue } from '../../../packages/server-infra/src/queue.js';
import { pool } from '../../../packages/server-infra/src/db.js';
import { ensureBucket,ensureUploadStorage } from '../../../packages/server-infra/src/storage.js';
import { runBusinessJob,ingestAsset } from './process.js';
const role=process.env.WORKER_ROLE||'all';
if(!['all','media','generation','agent','import'].includes(role))throw new Error('Invalid WORKER_ROLE');
const boss=await startQueue();await ensureBucket();await ensureUploadStorage();
if(['all','media'].includes(role)){
 await boss.work('media.ingest',{localConcurrency:2,pollingIntervalSeconds:1},async jobs=>{for(const job of jobs)await runBusinessJob(job,ingestAsset);});
 await boss.work('generation.ingest',{localConcurrency:2,pollingIntervalSeconds:1},async jobs=>{for(const job of jobs)await runBusinessJob(job,ingestGeneration);});
}
if(['all','import'].includes(role))await boss.work('project.import',{localConcurrency:1,pollingIntervalSeconds:1},async jobs=>{for(const job of jobs)await runBusinessJob(job,importProject);});
if(['all','agent'].includes(role))await boss.work('ai.turn',{localConcurrency:1,pollingIntervalSeconds:1},async jobs=>{for(const job of jobs)await runBusinessJob(job,runAiTurn);});
if(['all','generation'].includes(role))await boss.work('generation.submit',{localConcurrency:2,pollingIntervalSeconds:1},async jobs=>{for(const job of jobs)await submitGeneration(job);});
let reconciling=false;const reconcileTimer=setInterval(async()=>{if(reconciling)return;reconciling=true;try{if(['all','agent'].includes(role))await reconcileJobs();if(['all','generation'].includes(role))await reconcileGenerations();}catch(error){console.error('Job reconciliation failed',error instanceof Error?error.message:'Unknown error');}finally{reconciling=false;}},15000);
console.log(`Design-X ${role} worker ready`);
let closing=false;async function close(){if(closing)return;closing=true;clearInterval(reconcileTimer);await stopQueue();await pool.end();}
process.on('SIGTERM',()=>void close());process.on('SIGINT',()=>void close());
