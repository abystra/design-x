import { PgBoss } from 'pg-boss';
import { config } from './config.js';
import type { Tx } from './db.js';
export const queues=['media.ingest','render.export','project.import','ai.turn'] as const;
export const aiTurnTimeoutSeconds=Math.max(600,Math.min(1800,Number(process.env.AI_TURN_TIMEOUT_SECONDS)||600));
export function queuePolicy(queue:string){return queue==='ai.turn'?{retryLimit:0,retryDelay:2,expireInSeconds:aiTurnTimeoutSeconds+120}:{retryLimit:2,retryDelay:2,expireInSeconds:queue==='project.import'?180:60};}
let boss:PgBoss|undefined;
export async function startQueue() {
 if(boss)return boss;
 boss=new PgBoss({connectionString:config.databaseUrl,application_name:'designx',max:6});
 boss.on('error',error=>console.error('Queue error',error));
 await boss.start();
 for(const queue of queues)await boss.createQueue(queue,queuePolicy(queue));
 return boss;
}
export async function stopQueue(){if(boss){await boss.stop({graceful:true});boss=undefined;}}
export async function sendInTransaction(tx:Tx,queue:string,data:unknown,queueId:string) {
 const instance=await startQueue();
 // The tenant role has no queue administration grants. Only this trusted dispatch section uses the login role.
 await tx.query('RESET ROLE');
 try {return await instance.send(queue,data as object,{id:queueId,db:{executeSql:(text:string,values?:any[])=>tx.query(text,values)},...queuePolicy(queue)});}
 finally {await tx.query('SET LOCAL ROLE designx_tenant');}
}
