/** Copy -> verify -> switch, never deleting legacy objects. Run with --apply to switch.
 * node --import tsx scripts/migrate-storage.ts --workspace <id> [--apply]
 * node --import tsx scripts/migrate-storage.ts --all-workspaces --exclude-assets <json-path> [--apply]
 * --workspaces <json-path> limits batch migration to an explicit backed-up ID list.
 * node --import tsx scripts/migrate-storage.ts --workspace <id> --rollback <migrationId>
 * LEGACY_S3_* optionally selects the previous private object store.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { S3Client,GetObjectCommand } from '@aws-sdk/client-s3';
import { config } from '../packages/server-infra/src/config.js';
import { pool,tenantTransaction } from '../packages/server-infra/src/db.js';
import { getObject,putObject,ensureBucket } from '../packages/server-infra/src/storage.js';
import { id } from '../packages/server-domain/src/common.js';
import { registerCandidate,assertCandidateAvailable } from '../packages/server-domain/src/assets.js';
const args=process.argv.slice(2),arg=(name:string)=>args[args.indexOf(name)+1];
const workspaceId=args.includes('--workspace')?arg('--workspace'):null;
const selectors=[!!workspaceId,args.includes('--all-workspaces'),args.includes('--workspaces')].filter(Boolean).length;
if(selectors!==1)throw new Error('Choose exactly one: --workspace <id>, --workspaces <json-path>, or --all-workspaces');
if(args.includes('--rollback')&&!workspaceId)throw new Error('Rollback requires one explicit --workspace');
async function readIds(path:string|undefined){
 if(!path||path.startsWith('--'))throw new Error('An explicit JSON file path is required');
 const ids:unknown=JSON.parse(await readFile(path,'utf8'));
 if(!Array.isArray(ids)||ids.some(value=>typeof value!=='string'||!value||value.trim()!==value))throw new Error('ID file must be a JSON array of nonempty strings');
 return [...new Set(ids as string[])];
}
const excludedIds=new Set(args.includes('--exclude-assets')?await readIds(arg('--exclude-assets')):[]);
const legacyBucket=process.env.LEGACY_S3_BUCKET||config.s3Bucket;
const sourceEndpoint=new URL(process.env.LEGACY_S3_ENDPOINT||config.s3Endpoint).href.replace(/\/$/,'');
const targetEndpoint=new URL(config.s3Endpoint).href.replace(/\/$/,'');
// Historical references store a bucket, not a storage endpoint. Equal bucket
// names on different endpoints cannot be routed safely during copy or rollback.
if(legacyBucket===config.s3Bucket&&sourceEndpoint!==targetEndpoint)throw new Error('Legacy and target storage use the same bucket name on different endpoints; choose a different target bucket before migration');
const legacy=new S3Client({endpoint:process.env.LEGACY_S3_ENDPOINT||config.s3Endpoint,region:process.env.LEGACY_S3_REGION||config.s3Region,forcePathStyle:true,credentials:{accessKeyId:process.env.LEGACY_S3_ACCESS_KEY_ID||config.s3AccessKey,secretAccessKey:process.env.LEGACY_S3_SECRET_ACCESS_KEY||config.s3SecretKey}});
const explicitLegacyStore=!!(process.env.LEGACY_S3_ENDPOINT||process.env.LEGACY_S3_ACCESS_KEY_ID||process.env.LEGACY_S3_SECRET_ACCESS_KEY);
const hash=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
async function legacyBytes(key:string,bucket:string){
 if(!explicitLegacyStore)return (await getObject(key,{bucket,maxBytes:100*1024*1024})).bytes;
 const result=await legacy.send(new GetObjectCommand({Bucket:bucket,Key:key}));if(!result.Body)throw new Error('Legacy object missing');
 const chunks:Buffer[]=[];let size=0;
 for await(const chunk of result.Body as any){const bytes=Buffer.from(chunk);size+=bytes.length;if(size>100*1024*1024)throw new Error('Legacy object exceeds 100 MiB migration budget');chunks.push(bytes);}
 return Buffer.concat(chunks,size);
}
try{
 const workspaceIds=workspaceId?[workspaceId]:args.includes('--workspaces')?await readIds(arg('--workspaces')):(await pool.query('SELECT id FROM workspaces ORDER BY id')).rows.map(row=>row.id as string);
 if(!args.includes('--rollback'))await ensureBucket();
 for(const workspaceId of workspaceIds){
 if(args.includes('--rollback')){
  await tenantTransaction(workspaceId,async tx=>{
   const row=(await tx.query('SELECT * FROM storage_migrations WHERE id=$1 FOR UPDATE',[arg('--rollback')])).rows[0];if(!row)throw new Error('Migration not found');
   // Repeating a completed rollback must not overwrite later versions or migrations.
   if(row.status==='rolled_back')return;
   const asset=(await tx.query('SELECT * FROM assets WHERE id=$1 FOR UPDATE',[row.asset_id])).rows[0];
   if(asset.current_version_id!==row.version_id)throw new Error('Asset changed after migration; refusing to overwrite a newer version');
   await tx.query('UPDATE assets SET object_key=$2,thumbnail_key=$3,current_version_id=$4,storage_bucket=$5 WHERE id=$1',[asset.id,row.old_object_key,row.old_thumbnail_key,row.old_version_id,row.old_bucket]);
   await tx.query("UPDATE storage_migrations SET status='rolled_back',updated_at=now() WHERE id=$1",[row.id]);
  });
  console.log('Storage reference rollback completed; copied and original objects retained.');
 }else{
  const assets=await tenantTransaction(workspaceId,async tx=>(await tx.query("SELECT * FROM assets WHERE status='ready' AND deleted_at IS NULL AND current_version_id IS NULL ORDER BY id")).rows);
  for(const asset of assets){
   // Only operator-audited IDs can be excluded; missing objects otherwise fail
   // loudly. Exclusion does not mutate the asset or manufacture a version.
   if(excludedIds.has(asset.id)){console.log(JSON.stringify({workspaceId,assetId:asset.id,status:'excluded'}));continue;}
   // Record the previous bucket before copying. The optional read-only legacy
   // client keeps old references usable while primary storage points at R2.
   if(!asset.storage_bucket)await tenantTransaction(workspaceId,tx=>tx.query('UPDATE assets SET storage_bucket=$2 WHERE id=$1 AND storage_bucket IS NULL',[asset.id,legacyBucket]));
   let record=await tenantTransaction(workspaceId,async tx=>(await tx.query("SELECT * FROM storage_migrations WHERE asset_id=$1 AND status='copied' ORDER BY created_at DESC LIMIT 1",[asset.id])).rows[0]);
   if(!record){
    const sourceBucket=asset.storage_bucket||legacyBucket,bytes=await legacyBytes(asset.object_key,sourceBucket),thumbnail=asset.thumbnail_key?await legacyBytes(asset.thumbnail_key,sourceBucket):null;
    const versionId=id(),migrationId=id(),prefix=`${workspaceId}/assets/${asset.id}/versions/${versionId}`,key=`${prefix}/original`,thumbnailKey=thumbnail?`${prefix}/thumbnail`:null,sha256=hash(bytes);
    await tenantTransaction(workspaceId,async tx=>{await registerCandidate(tx,workspaceId,config.s3Bucket,key,'migration');if(thumbnailKey)await registerCandidate(tx,workspaceId,config.s3Bucket,thumbnailKey,'migration');});
    await putObject(key,bytes,asset.mime,{ifAbsent:true,sha256});if(thumbnail&&thumbnailKey)await putObject(thumbnailKey,thumbnail,'image/webp',{ifAbsent:true});
    const verified=await getObject(key,{maxBytes:100*1024*1024});if(verified.bytes.length!==bytes.length||hash(verified.bytes)!==sha256)throw new Error(`Migration integrity mismatch for ${asset.id}`);
    if(thumbnail&&thumbnailKey){const verifiedThumb=await getObject(thumbnailKey);if(verifiedThumb.bytes.length!==thumbnail.length||hash(verifiedThumb.bytes)!==hash(thumbnail))throw new Error('Thumbnail verification failed');}
    record=await tenantTransaction(workspaceId,async tx=>{
     const current=(await tx.query('SELECT * FROM assets WHERE id=$1 FOR UPDATE',[asset.id])).rows[0];if(current.current_version_id||current.object_key!==asset.object_key)throw new Error('Asset changed during migration; copied objects left for cleanup');
     await assertCandidateAvailable(tx,config.s3Bucket,key);if(thumbnailKey)await assertCandidateAvailable(tx,config.s3Bucket,thumbnailKey);
     await tx.query('INSERT INTO asset_versions(id,workspace_id,asset_id,object_key,thumbnail_key,bucket,bytes,sha256,mime,width,height,source) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',[versionId,workspaceId,asset.id,key,thumbnailKey,config.s3Bucket,bytes.length,sha256,asset.mime,asset.width,asset.height,JSON.stringify({kind:'migration',migrationId})]);
     return (await tx.query("INSERT INTO storage_migrations(id,workspace_id,asset_id,version_id,old_bucket,old_object_key,old_thumbnail_key,old_version_id,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'copied') RETURNING *",[migrationId,workspaceId,asset.id,versionId,sourceBucket,asset.object_key,asset.thumbnail_key,asset.current_version_id])).rows[0];
    });
   }
   if(args.includes('--apply'))await tenantTransaction(workspaceId,async tx=>{
    const current=(await tx.query('SELECT * FROM assets WHERE id=$1 FOR UPDATE',[asset.id])).rows[0];if(current.current_version_id||current.object_key!==record.old_object_key)throw new Error('Asset changed before reference switch');
    const version=(await tx.query('SELECT * FROM asset_versions WHERE id=$1',[record.version_id])).rows[0];
    await tx.query('UPDATE assets SET current_version_id=$2,object_key=$3,thumbnail_key=$4,storage_bucket=$5,bytes=$6 WHERE id=$1',[asset.id,version.id,version.object_key,version.thumbnail_key,version.bucket,version.bytes]);
    await tx.query("UPDATE storage_migrations SET status='switched',updated_at=now() WHERE id=$1",[record.id]);
   });
   console.log(JSON.stringify({workspaceId,assetId:asset.id,migrationId:record.id,status:args.includes('--apply')?'switched':'copied'}));
  }
 }
 }
}finally{legacy.destroy();await pool.end();}
