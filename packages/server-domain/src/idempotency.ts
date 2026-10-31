import {createHash} from 'node:crypto';
import type {Tx} from '../../server-infra/src/db.js';
import {HttpError} from './common.js';
export async function idempotent<T>(tx:Tx,workspaceId:string,key:unknown,request:unknown,operation:()=>Promise<T>):Promise<T>{
 if(!key)return operation();
 if(typeof key!=='string'||key.length>200)throw new HttpError(400,'INVALID_IDEMPOTENCY_KEY','幂等键无效');
 const hash=createHash('sha256').update(JSON.stringify(request)).digest('hex');
 await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${workspaceId}:${key}`]);
 const existing=(await tx.query('SELECT request_hash,response FROM idempotency_keys WHERE key=$1',[key])).rows[0];
 if(existing){if(existing.request_hash!==hash)throw new HttpError(409,'IDEMPOTENCY_KEY_REUSED','此请求标识已用于其他操作');return existing.response;}
 const response=await operation();
 await tx.query('INSERT INTO idempotency_keys(workspace_id,key,request_hash,response) VALUES($1,$2,$3,$4)',[workspaceId,key,hash,JSON.stringify(response)]);return response;
}
