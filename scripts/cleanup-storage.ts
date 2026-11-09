/** Only registered, aged, unreferenced objects are eligible; versions are retained.
 * node --import tsx scripts/cleanup-storage.ts [--apply]
 */
import { pool,tenantTransaction,type Tx } from '../packages/server-infra/src/db.js';
import { deleteObject } from '../packages/server-infra/src/storage.js';
const apply=process.argv.includes('--apply');
const workspaceArg=process.argv.indexOf('--workspace'),workspaceFilter=workspaceArg>=0?process.argv[workspaceArg+1]:null;
if(workspaceArg>=0&&!workspaceFilter)throw new Error('--workspace requires an ID');
async function unreferenced(tx:Tx,bucket:string,key:string){
 return !(await tx.query(`SELECT 1 WHERE
  EXISTS(SELECT 1 FROM asset_versions v WHERE v.bucket=$1 AND (v.object_key=$2 OR v.thumbnail_key=$2))
  OR EXISTS(SELECT 1 FROM assets a WHERE a.status='ready' AND (a.object_key=$2 OR a.thumbnail_key=$2))
  OR EXISTS(SELECT 1 FROM storage_migrations m WHERE m.old_bucket=$1 AND (m.old_object_key=$2 OR m.old_thumbnail_key=$2))
  OR EXISTS(SELECT 1 FROM upload_sessions u WHERE u.staging_key=$2 AND u.status='uploading' AND u.expires_at>now())
  OR EXISTS(SELECT 1 FROM generation_outputs o WHERE o.staging_key=$2 AND (o.state<>'ready' OR o.updated_at>now()-interval '7 days'))
  OR EXISTS(SELECT 1 FROM jobs j WHERE j.status IN ('queued','running','failed') AND (j.payload::text LIKE '%'||$2||'%' OR j.result::text LIKE '%'||$2||'%'))`,[bucket,key])).rowCount;
}
try{
 for(const workspace of (await pool.query('SELECT id FROM workspaces WHERE $1::text IS NULL OR id=$1',[workspaceFilter])).rows){
  const candidates=await tenantTransaction(workspace.id,async tx=>(await tx.query("SELECT * FROM storage_candidates WHERE created_at<now()-interval '48 hours' ORDER BY created_at LIMIT 1000")).rows);
  for(const candidate of candidates)await tenantTransaction(workspace.id,async tx=>{
   // Publication takes a SHARE lock on this row. GC's lock closes the check/delete race;
   // a late publisher sees the missing candidate and must produce a fresh object.
   if(!(await tx.query('SELECT 1 FROM storage_candidates WHERE bucket=$1 AND object_key=$2 FOR UPDATE',[candidate.bucket,candidate.object_key])).rowCount)return;
   if(!await unreferenced(tx,candidate.bucket,candidate.object_key))return;
   if(apply){await deleteObject(candidate.object_key,{bucket:candidate.bucket});await tx.query('DELETE FROM storage_candidates WHERE bucket=$1 AND object_key=$2',[candidate.bucket,candidate.object_key]);}
   console.log(JSON.stringify({workspaceId:workspace.id,key:candidate.object_key,action:apply?'deleted':'eligible'}));
  });
 }
}finally{await pool.end();}
