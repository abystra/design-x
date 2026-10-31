import { buildApp } from './server.js';
import { config } from '../../../packages/server-infra/src/config.js';
import { pool } from '../../../packages/server-infra/src/db.js';
import { stopQueue } from '../../../packages/server-infra/src/queue.js';
const app=await buildApp();
await app.listen({port:config.port,host:config.host});
let closing=false;
async function close(){if(closing)return;closing=true;await app.close();await stopQueue();await pool.end();}
process.on('SIGTERM',()=>void close());process.on('SIGINT',()=>void close());
