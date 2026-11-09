/** Read-only inventory comparison. No credentials are emitted and no rows change.
 * --source-env PATH --manifest PATH --output PATH [--database-env PATH]
 * Compares historical DB storage references to the source side of a full mirror.
 */
import {readFile,writeFile} from 'node:fs/promises';
import {parse} from 'dotenv';
import pg from 'pg';

const args=process.argv.slice(2),arg=(name:string)=>args[args.indexOf(name)+1];
for(const name of ['--source-env','--manifest','--output'])if(!args.includes(name)||!arg(name)||arg(name).startsWith('--'))throw new Error(`${name} PATH is required`);
const env=parse(await readFile(arg('--source-env')));
const databaseEnv=args.includes('--database-env')?parse(await readFile(arg('--database-env'))):env;
if(!databaseEnv.DATABASE_URL||!env.S3_BUCKET)throw new Error('Explicit env files require DATABASE_URL and S3_BUCKET');
const mainBucket=env.S3_BUCKET,stageBucket=env.S3_STAGING_BUCKET||`${mainBucket}-staging`;
const manifest=JSON.parse(await readFile(arg('--manifest'),'utf8'));
const present=new Set<string>((manifest.entries||[]).map((entry:any)=>JSON.stringify([entry.bucket,entry.key])));
type Reference={table:string;id:string;workspaceId:string;kind:string;state:string;field:string;bucket:string;key:string;exists:boolean;testIdentity:boolean};
const references:Reference[]=[];
const client=new pg.Client({connectionString:databaseEnv.DATABASE_URL});await client.connect();
try{
 await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
 const owners=(await client.query('SELECT w.id,u.email FROM workspaces w JOIN users u ON u.id=w.owner_id')).rows;
 const testWorkspaces=new Set(owners.filter(row=>row.email.endsWith('@example.test')).map(row=>row.id));
 const add=(table:string,row:any,field:string,bucket:any,key:any)=>{if(typeof key!=='string'||!key)return;const actualBucket=typeof bucket==='string'&&bucket?bucket:mainBucket;references.push({table,id:row.id||`${row.bucket}/${row.object_key}`,workspaceId:row.workspace_id,kind:row.kind||table,state:row.status||row.state||row.execution_status||row.stage||'recorded',field,bucket:actualBucket,key,exists:present.has(JSON.stringify([actualBucket,key])),testIdentity:testWorkspaces.has(row.workspace_id)});};
 const walk=(table:string,row:any,value:any,path:string)=>{
  if(Array.isArray(value)){value.forEach((entry,index)=>walk(table,row,entry,`${path}[${index}]`));return;}
  if(!value||typeof value!=='object')return;
  for(const [key,entry] of Object.entries(value)){
   if(key==='objectKey'||key==='thumbnailKey')add(table,row,`${path}.${key}`,value.bucket||value.storageBucket,entry);
   if(key==='sourceKey')add(table,row,`${path}.${key}`,value.sourceBucket,entry);
   if(key==='stagingKey')add(table,row,`${path}.${key}`,value.stagingBucket||stageBucket,entry);
   if(key==='importStaging'&&Array.isArray(entry))entry.forEach((item,index)=>add(table,row,`${path}.${key}[${index}]`,value.storageBucket,item));
   walk(table,row,entry,`${path}.${key}`);
  }
 };
 for(const row of (await client.query('SELECT id,workspace_id,kind,status,payload,result FROM jobs')).rows){walk('jobs',row,row.payload,'payload');walk('jobs',row,row.result,'result');}
 for(const row of (await client.query('SELECT id,workspace_id,status,staging_bucket,staging_key FROM upload_sessions')).rows)add('upload_sessions',row,'staging_key',row.staging_bucket,row.staging_key);
 for(const row of (await client.query('SELECT id,workspace_id,state,staging_bucket,staging_key FROM generation_outputs')).rows)add('generation_outputs',row,'staging_key',row.staging_bucket||stageBucket,row.staging_key);
 for(const row of (await client.query('SELECT id,workspace_id,status,old_bucket,old_object_key,old_thumbnail_key FROM storage_migrations')).rows){add('storage_migrations',row,'old_object_key',row.old_bucket,row.old_object_key);add('storage_migrations',row,'old_thumbnail_key',row.old_bucket,row.old_thumbnail_key);}
 for(const row of (await client.query('SELECT workspace_id,bucket,object_key,purpose AS status FROM storage_candidates')).rows)add('storage_candidates',row,'object_key',row.bucket,row.object_key);
 for(const row of (await client.query('SELECT id,workspace_id,execution_status,snapshot FROM creative_requests')).rows)walk('creative_requests',row,row.snapshot,'snapshot');
 for(const row of (await client.query('SELECT id,workspace_id,stage,context FROM ai_turns')).rows)walk('ai_turns',row,row.context,'context');
 await client.query('COMMIT');
 const missing=references.filter(row=>!row.exists),groups:Record<string,{references:number;missing:number}>={};
 for(const row of references){const key=`${row.table}:${row.kind}.${row.field.replace(/\[\d+\]/g,'[]')} (${row.state})`;groups[key]||={references:0,missing:0};groups[key].references++;if(!row.exists)groups[key].missing++;}
 const report={at:new Date().toISOString(),sourceInventorySha256:manifest.sourceInventorySha256,sourceObjectCount:present.size,readOnly:true,checkedReferences:references.length,missingCount:missing.length,missingOutsideTestIdentities:missing.filter(row=>!row.testIdentity).length,groups,missing,references};
 await writeFile(arg('--output'),JSON.stringify(report,null,2),{mode:0o600});
 console.log(JSON.stringify({checkedReferences:report.checkedReferences,missingCount:report.missingCount,missingOutsideTestIdentities:report.missingOutsideTestIdentities,groups}));
}finally{await client.end();}
