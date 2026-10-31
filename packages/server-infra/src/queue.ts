import { PgBoss } from 'pg-boss';
import { config } from './config.js';
import type { Tx } from './db.js';
export const queues=['media.ingest','render.export'] as const;
let boss:PgBoss|undefined;
export async function startQueue() {
 if(boss)return boss;
 boss=new PgBoss({connectionString:config.databaseUrl,application_name:'designx',max:6});
 boss.on('error',error=>console.error('Queue error',error));
 await boss.start();
 for(const queue of queues)await boss.createQueue(queue,{retryLimit:2,retryDelay:2,expireInSeconds:60});
 return boss;
}
export async function stopQueue(){if(boss){await boss.stop({graceful:true});boss=undefined;}}
export async function sendInTransaction(tx:Tx,queue:string,data:unknown,queueId:string) {
 const instance=await startQueue();
 // The tenant role has no queue administration grants. Only this trusted dispatch section uses the login role.
 await tx.query('RESET ROLE');
 try {return await instance.send(queue,data as object,{id:queueId,db:{executeSql:(text:string,values?:any[])=>tx.query(text,values)},retryLimit:2,retryDelay:2,expireInSeconds:60});}
 finally {await tx.query('SET LOCAL ROLE designx_tenant');}
}
