import { importProject } from './import-project.js';
import { runAiTurn } from './ai-turn.js';
import { reconcileJobs } from './reconcile.js';
import { startQueue,stopQueue } from '../../../packages/server-infra/src/queue.js';
import { pool } from '../../../packages/server-infra/src/db.js';
import { ensureBucket } from '../../../packages/server-infra/src/storage.js';
import { runBusinessJob,ingestAsset } from './process.js';
const boss=await startQueue();await ensureBucket();
await boss.work('media.ingest',{localConcurrency:2,pollingIntervalSeconds:1},async jobs=>{for(const job of jobs)await runBusinessJob(job,ingestAsset);});
await boss.work('project.import',{localConcurrency:1,pollingIntervalSeconds:1},async jobs=>{for(const job of jobs)await runBusinessJob(job,importProject);});
await boss.work('ai.turn',{localConcurrency:1,pollingIntervalSeconds:1},async jobs=>{for(const job of jobs)await runBusinessJob(job,runAiTurn);});
let reconciling=false;const reconcileTimer=setInterval(async()=>{if(reconciling)return;reconciling=true;try{await reconcileJobs();}catch(error){console.error('Job reconciliation failed',error);}finally{reconciling=false;}},15000);
console.log('Design-X media worker ready');
let closing=false;async function close(){if(closing)return;closing=true;clearInterval(reconcileTimer);await stopQueue();await pool.end();}
process.on('SIGTERM',()=>void close());process.on('SIGINT',()=>void close());
