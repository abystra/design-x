import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { tenantTransaction } from '../../../packages/server-infra/src/db.js';
import { ensureBucket, putObject, deleteObject } from '../../../packages/server-infra/src/storage.js';
import { createJob } from '../../../packages/server-domain/src/jobs.js';
import { idempotent } from '../../../packages/server-domain/src/idempotency.js';
import { id,HttpError } from '../../../packages/server-domain/src/common.js';
import { IMPORT_LIMITS,parsePortableProject } from '../../../packages/server-domain/src/import-format.js';

export async function importRoutes(app:FastifyInstance){
  app.post('/api/projects/import',{bodyLimit:IMPORT_LIMITS.sourceBytes+1024*1024,config:{rateLimit:{max:12,timeWindow:'1 minute'}}},async(req:any,reply)=>{
    let bytes:Buffer;
    try {
      const file=await req.file({limits:{fileSize:IMPORT_LIMITS.sourceBytes,files:1,fields:0,parts:1}});
      if(!file)throw new HttpError(422,'INVALID_PROJECT_PACKAGE','请选择 .dxproj 项目文件');
      if(!/\.dxproj$/i.test(file.filename))throw new HttpError(422,'INVALID_PROJECT_PACKAGE','请选择 .dxproj 项目文件');
      bytes=await file.toBuffer();
    }catch(error:any){if(error.code==='FST_REQ_FILE_TOO_LARGE')throw new HttpError(413,'PAYLOAD_TOO_LARGE','项目文件不能超过 40 MiB');throw error;}
    const packet=parsePortableProject(bytes);
    const workspaceId=req.identity.workspace.id,sourceKey=`${workspaceId}/imports/sources/${id()}.dxproj`;
    const sha256=createHash('sha256').update(bytes).digest('hex');
    await ensureBucket();await putObject(sourceKey,bytes,'application/json');
    let created=false;
    try{
      const result=await tenantTransaction(workspaceId,tx=>idempotent(tx,workspaceId,req.headers['idempotency-key'],{route:'project.import',sha256},async()=>{
        created=true;
        return createJob(tx,workspaceId,'project.import',{sourceKey,sha256,targetProjectId:id(),title:packet.title||'导入项目',sourceBytes:bytes.length});
      }));
      if(!created)await deleteObject(sourceKey).catch(()=>{});
      reply.code(202);return result;
    }catch(error){await deleteObject(sourceKey).catch(()=>{});throw error;}
  });
}
