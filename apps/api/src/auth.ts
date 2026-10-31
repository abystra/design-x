import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { pool, transaction } from '../../../packages/server-infra/src/db.js';
import { config } from '../../../packages/server-infra/src/config.js';
import { HttpError, id } from '../../../packages/server-domain/src/common.js';
const scrypt=promisify(scryptCallback);
const digest=(token:string)=>createHash('sha256').update(token).digest('hex');
const schema=z.object({ email:z.string().email().max(254).transform(v=>v.toLowerCase().trim()),password:z.string().min(10,'密码至少 10 位').max(128),name:z.string().trim().min(1).max(80).optional() });
export type Identity={ user:{id:string,email:string,name:string},workspace:{id:string,name:string},tokenHash:string };
declare module 'fastify' { interface FastifyRequest { identity:Identity } }
async function hashPassword(password:string) {
 const salt=randomBytes(16).toString('hex');
 const result=await scrypt(password,salt,64) as Buffer;
 return `${salt}:${result.toString('hex')}`;
}
async function passwordMatches(password:string,stored:string) {
 const [salt,hash]=stored.split(':');
 const calculated=await scrypt(password,salt,64) as Buffer;
 const expected=Buffer.from(hash,'hex');
 return expected.length===calculated.length&&timingSafeEqual(expected,calculated);
}
async function startSession(reply:FastifyReply,userId:string) {
 const token=randomBytes(32).toString('base64url');
 await pool.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '7 days')",[digest(token),userId]);
 reply.setCookie('dx_session',token,{path:'/',httpOnly:true,secure:config.production,sameSite:'lax',maxAge:7*86400});
}
export async function resolveIdentity(token?:string):Promise<Identity|null> {
 if(!token)return null;
 const {rows}=await pool.query('SELECT u.id,u.email,u.name,w.id as workspace_id,w.name as workspace_name FROM sessions s JOIN users u ON u.id=s.user_id JOIN workspaces w ON w.owner_id=u.id WHERE s.token_hash=$1 AND s.expires_at>now()',[digest(token)]);
 const r=rows[0];
 return r?{user:{id:r.id,email:r.email,name:r.name},workspace:{id:r.workspace_id,name:r.workspace_name},tokenHash:digest(token)}:null;
}
export async function requireIdentity(request:FastifyRequest) {
 const identity=await resolveIdentity(request.cookies.dx_session);
 if(!identity)throw new HttpError(401,'UNAUTHENTICATED','请先登录');
 request.identity=identity;
}
export async function authRoutes(app:FastifyInstance) {
 app.post('/api/auth/register',{config:{rateLimit:{max:12,timeWindow:'15 minutes'}}},async(req,reply)=>{
  const body=schema.parse(req.body);const userId=id(),workspaceId=id();
  const passwordHash=await hashPassword(body.password);
  try {
   await transaction(async tx=>{
    await tx.query('INSERT INTO users(id,email,name,password_hash) VALUES($1,$2,$3,$4)',[userId,body.email,body.name||body.email.split('@')[0],passwordHash]);
    await tx.query('INSERT INTO workspaces(id,owner_id,name) VALUES($1,$2,$3)',[workspaceId,userId,`${body.name||body.email.split('@')[0]} 的创作空间`]);
   });
  } catch(error:any) { if(error.code==='23505')throw new HttpError(409,'EMAIL_IN_USE','该邮箱已注册');throw error; }
  await startSession(reply,userId);
  reply.code(201);return {user:{id:userId,email:body.email,name:body.name||body.email.split('@')[0]},workspace:{id:workspaceId,name:`${body.name||body.email.split('@')[0]} 的创作空间`}};
 });
 app.post('/api/auth/login',{config:{rateLimit:{max:20,timeWindow:'15 minutes'}}},async(req,reply)=>{
  const body=schema.parse(req.body);
  const {rows}=await pool.query('SELECT * FROM users WHERE email=$1',[body.email]);
  const row=rows[0];
  const fake='00000000000000000000000000000000:'+ '00'.repeat(64);
  const valid=await passwordMatches(body.password,row?.password_hash||fake);
  if(!row||!valid)throw new HttpError(401,'INVALID_CREDENTIALS','邮箱或密码不正确');
  if(req.cookies.dx_session)await pool.query('DELETE FROM sessions WHERE token_hash=$1',[digest(req.cookies.dx_session)]);
  await startSession(reply,row.id);
  const workspace=(await pool.query('SELECT id,name FROM workspaces WHERE owner_id=$1',[row.id])).rows[0];
  return {user:{id:row.id,email:row.email,name:row.name},workspace};
 });
 app.get('/api/auth/me',{preHandler:requireIdentity},async req=>({user:req.identity.user,workspace:req.identity.workspace}));
 app.post('/api/auth/logout',async(req,reply)=>{
  if(req.cookies.dx_session)await pool.query('DELETE FROM sessions WHERE token_hash=$1',[digest(req.cookies.dx_session)]);
  reply.clearCookie('dx_session',{path:'/'});return {ok:true};
 });
}
