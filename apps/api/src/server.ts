import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import { ZodError } from 'zod';
import { config } from '../../../packages/server-infra/src/config.js';
import { pool } from '../../../packages/server-infra/src/db.js';
import { startQueue } from '../../../packages/server-infra/src/queue.js';
import { HttpError } from '../../../packages/server-domain/src/common.js';
import { authRoutes, requireIdentity } from './auth.js';
import { projectRoutes } from './projects.js';
import { libraryRoutes } from './library.js';
import { mediaRoutes } from './media.js';
import { documentRoutes } from './documents.js';
import { taskRoutes } from './tasks.js';
export async function buildApp(options:{logger?:boolean}={}) {
 const app=Fastify({logger:options.logger??true,bodyLimit:6*1024*1024,trustProxy:false});
 await app.register(cookie);
 await app.register(multipart,{limits:{fileSize:config.maxUploadBytes,files:1,fields:3}});
 await app.register(rateLimit,{global:true,max:600,timeWindow:'1 minute'});
 app.addHook('onRequest',async(req,reply)=>{
  reply.header('X-Content-Type-Options','nosniff');reply.header('Cache-Control','no-store');
  if(!['GET','HEAD','OPTIONS'].includes(req.method)){
   const origin=req.headers.origin;
   if((origin&&origin!==config.webOrigin)||req.headers['sec-fetch-site']==='cross-site')throw new HttpError(403,'INVALID_ORIGIN','请求来源不允许');
  }
 });
 app.setErrorHandler((error:any,req,reply)=>{
  if(error instanceof ZodError){reply.code(400).send({error:'VALIDATION_FAILED',message:error.issues[0]?.message||'输入数据无效',details:error.issues});return;}
  if(error.code==='23505'){reply.code(409).send({error:'ALREADY_EXISTS',message:'名称或记录已存在'});return;}
  if(error.code==='FST_REQ_FILE_TOO_LARGE'){reply.code(413).send({error:'PAYLOAD_TOO_LARGE',message:'文件不能超过 10 MB'});return;}
  const status=error.statusCode||500;
  if(status>=500)req.log.error(error);
  reply.code(status).send({error:error instanceof HttpError?error.code:status>=500?'INTERNAL_ERROR':error.code||'BAD_REQUEST',message:status>=500?'服务暂时不可用，请稍后重试':error.message});
 });
 app.get('/api/health',async()=>{await pool.query('SELECT 1');return {status:'ok',aiEnabled:false};});
 await app.register(authRoutes);
 await app.register(async privateApi=>{
  privateApi.addHook('preHandler',requireIdentity);
  await privateApi.register(projectRoutes);await privateApi.register(documentRoutes);await privateApi.register(libraryRoutes);await privateApi.register(mediaRoutes);await privateApi.register(taskRoutes);
 });
 await startQueue();
 return app;
}
