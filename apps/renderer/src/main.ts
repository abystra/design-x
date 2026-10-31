import { startQueue,stopQueue } from '../../../packages/server-infra/src/queue.js';
import { pool } from '../../../packages/server-infra/src/db.js';
import { ensureBucket } from '../../../packages/server-infra/src/storage.js';
import { runBusinessJob } from '../../worker/src/process.js';
import { renderExport,closeBrowser } from './render.js';
const boss=await startQueue();await ensureBucket();
await boss.work('render.export',{localConcurrency:1,pollingIntervalSeconds:1},async jobs=>{for(const job of jobs)await runBusinessJob(job,renderExport);});
console.log('Design-X renderer ready');
let closing=false;async function close(){if(closing)return;closing=true;await stopQueue();await closeBrowser();await pool.end();}
process.on('SIGTERM',()=>void close());process.on('SIGINT',()=>void close());
