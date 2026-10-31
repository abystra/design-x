import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { tenantTransaction } from '../../../packages/server-infra/src/db.js';
import { getObject,putObject,deleteObject } from '../../../packages/server-infra/src/storage.js';
import { ArtboardSchema } from '../../../packages/doc-core/src/index.js';
import { BoardSchema } from '../../../packages/doc-core/src/board.js';
import { IMPORT_LIMITS,parsePortableProject,decodePortableAsset,importedId,invalidImport } from '../../../packages/server-domain/src/import-format.js';
import { emit,jobDto,saveVersion,syncAssetRefs } from '../../../packages/server-domain/src/common.js';
import { updateJob } from '../../../packages/server-domain/src/jobs.js';
import { assertActive } from './process.js';

type PreparedAsset={id:string,hash:string,title:string,bytes:Buffer,thumbnail:Buffer,width:number,height:number,key:string,thumbnailKey:string};
// Only delete this attempt's staging objects. A committed asset always wins over cleanup.
export async function cleanupImportStaging(workspaceId:string,jobId:string,keys:string[]){
  const owned=keys.filter(key=>typeof key==='string'&&key.startsWith(`${workspaceId}/imports/${jobId}/`));
  if(!owned.length)return;
  const live=await tenantTransaction(workspaceId,async tx=>(await tx.query('SELECT object_key,thumbnail_key FROM assets WHERE object_key=ANY($1) OR thumbnail_key=ANY($1)',[owned])).rows);
  const retained=new Set(live.flatMap(row=>[row.object_key,row.thumbnail_key]));
  for(const key of owned)if(!retained.has(key))await deleteObject(key);
}
export async function importProject(job:any){
  const workspaceId=job.workspace_id,projectId=job.payload.targetProjectId;
  if(typeof projectId!=='string'||!job.payload.sourceKey?.startsWith(`${workspaceId}/imports/sources/`))throw new Error('导入任务来源无效');
  const priorKeys=Array.isArray(job.payload.importStaging)?job.payload.importStaging:[];
  if(priorKeys.length)await cleanupImportStaging(workspaceId,job.id,priorKeys);
  const source=await getObject(job.payload.sourceKey);
  if(createHash('sha256').update(source.bytes).digest('hex')!==job.payload.sha256)throw new Error('导入文件校验失败');
  const packet=parsePortableProject(source.bytes);
  const prepared:PreparedAsset[]=[],byHash=new Map<string,PreparedAsset>(),sourceMap=new Map<string,PreparedAsset>();
  let pixels=0,outputBytes=0;
  for(const [url,data] of Object.entries(packet.assets)){
    await assertActive(job);
    const decoded=decodePortableAsset(data);
    if(byHash.has(decoded.hash)){sourceMap.set(url,byHash.get(decoded.hash)!);continue;}
    let png:Buffer,thumbnail:Buffer,width:number,height:number;
    try{
      const pipeline=sharp(decoded.bytes,{limitInputPixels:IMPORT_LIMITS.pixelsPerAsset,animated:false}).rotate();
      const metadata=await pipeline.metadata();
      if(metadata.format!==decoded.format)invalidImport('素材实际格式与声明的 MIME 不一致');
      if(!metadata.width||!metadata.height)invalidImport('素材尺寸无效');
      pixels+=metadata.width*metadata.height;
      if(pixels>IMPORT_LIMITS.totalPixels)invalidImport('素材总像素超过 100 MP 导入预算');
      const normalized=await pipeline.clone().png().toBuffer({resolveWithObject:true});
      png=normalized.data;width=normalized.info.width;height=normalized.info.height;
      thumbnail=await pipeline.clone().resize({width:256,height:256,fit:'inside',withoutEnlargement:true}).webp({quality:82}).toBuffer();
    }catch(error:any){throw new Error(`导入素材无法解码：${error.message}`);}
    outputBytes+=png.length+thumbnail.length;
    if(outputBytes>IMPORT_LIMITS.outputBytes)invalidImport('标准化素材超过 64 MiB 存储预算');
    const assetId=importedId(job.id,'asset',decoded.hash),prefix=`${workspaceId}/imports/${job.id}/${job.execution_token}/${assetId}`;
    const asset={id:assetId,hash:decoded.hash,title:`导入素材 ${prepared.length+1}`,bytes:png,thumbnail,width,height,key:`${prefix}.png`,thumbnailKey:`${prefix}.webp`};
    prepared.push(asset);byHash.set(decoded.hash,asset);sourceMap.set(url,asset);
    if(prepared.length%5===0)await updateJob(workspaceId,job.id,{progress:10+Math.floor(prepared.length/Math.max(1,Object.keys(packet.assets).length)*25)},job.execution_token);
  }
  const artboards=packet.documents.filter(doc=>doc.kind==='artboard'),sourceBoard=packet.documents.find(doc=>doc.kind==='board');
  const docIds=new Map(packet.documents.map(doc=>[doc.id,importedId(job.id,'document',doc.id)]));
  const boardInput=sourceBoard?BoardSchema.parse(sourceBoard.content):BoardSchema.parse({title:packet.title,results:artboards.map((doc,index)=>({id:doc.id,position:{x:index*310,y:0}}))});
  const itemIds=new Map(docIds);
  for(const note of boardInput.notes){if(itemIds.has(note.id))invalidImport('便签 ID 与文档 ID 重复');itemIds.set(note.id,importedId(job.id,'note',note.id));}
  for(const section of boardInput.sections){if(itemIds.has(section.id))invalidImport('分区 ID 与其他项目内容 ID 重复');itemIds.set(section.id,importedId(job.id,'section',section.id));}
  const removedKeys=new Set(['workspaceId','workspace_id','userId','user_id','ownerId','owner_id','sessionId','session_id','token','accessToken','refreshToken']);
  const humanFields=new Set(['text','prompt','draft','title','name','description','subtitle','label']);
  const assetIds=new Map<string,string>(),auxiliaryIds=new Map<string,string>();
  // A package may carry different bytes for an old asset's original and thumbnail.
  // Bare references prefer the original; records with their own URL use that exact resource.
  for(const [url,asset] of sourceMap){
    const oldId=url.match(/^\/api\/assets\/([^/]+)\/(file|thumbnail)$/);
    if(oldId&&(!assetIds.has(oldId[1])||oldId[2]==='file'))assetIds.set(oldId[1],asset.id);
  }
  const recordAsset=(value:any)=>['url','image','src','thumbnail'].map(key=>sourceMap.get(value[key])).find(Boolean);
  function collectIds(value:any):void{
    if(Array.isArray(value)){value.forEach(collectIds);return;}
    if(!value||typeof value!=='object')return;
    const asset=recordAsset(value);
    if(asset)for(const key of ['id','assetId','asset_id'])if(typeof value[key]==='string'&&!itemIds.has(value[key])&&!assetIds.has(value[key]))assetIds.set(value[key],asset.id);
    if(typeof value.id==='string'&&!itemIds.has(value.id)&&!assetIds.has(value.id))auxiliaryIds.set(value.id,importedId(job.id,'auxiliary',value.id));
    for(const [key,child] of Object.entries(value))if(!humanFields.has(key))collectIds(child);
  }
  collectIds(boardInput);
  function remap(value:any,key='',path='board'):any{
    if(typeof value==='string'){
      if(humanFields.has(key))return value;
      const asset=sourceMap.get(value);if(asset)return `/api/assets/${asset.id}/file`;
      if(key==='projectId'||key==='project_id')return projectId;
      if(itemIds.has(value))return itemIds.get(value);
      if(assetIds.has(value))return assetIds.get(value);
      if(auxiliaryIds.has(value))return auxiliaryIds.get(value);
      if(key==='assetId'||key==='asset_id')invalidImport('素材元数据引用了未打包的素材');
      if(key==='id')return importedId(job.id,'auxiliary',`${path}:${value}`);
      if(['selected','reference'].includes(key))return null;
      return value;
    }
    if(Array.isArray(value))return value.map((item,index)=>remap(item,key,`${path}[${index}]`));
    if(value&&typeof value==='object'){
      const result:Record<string,any>={};
      for(const [childKey,child] of Object.entries(value))if(!removedKeys.has(childKey))result[childKey]=remap(child,childKey,`${path}.${childKey}`);
      const asset=recordAsset(value);
      if(asset){
        if(value.id&&!itemIds.has(value.id))result.id=asset.id;
        for(const field of ['assetId','asset_id'])if(field in value)result[field]=asset.id;
        if('status'in result)result.status='ready';
      }
      return result;
    }
    return value;
  }
  const designs=new Map<string,any>();
  for(const doc of artboards){
    const original=ArtboardSchema.parse(doc.content);
    const nodes=original.nodes.map(node=>({...node,id:importedId(job.id,`node:${doc.id}`,node.id),...(node.groupId?{groupId:importedId(job.id,`group:${doc.id}`,node.groupId)}:{}),...(node.src?{src:`/api/assets/${sourceMap.get(node.src)!.id}/file`}:{})}));
    designs.set(doc.id,ArtboardSchema.parse({...original,nodes}));
  }
  const board=BoardSchema.parse({...remap(boardInput),id:projectId,title:packet.title||'导入项目',results:boardInput.results.map(result=>{
    const doc=artboards.find(doc=>doc.id===result.id)!;
    const mapped=remap(result);delete mapped.design;delete mapped.revision;
    return {...mapped,id:docIds.get(result.id),documentId:docIds.get(result.id),projectId,title:doc.title||result.title||'导入画板',persisted:true};
  })});
  const primaryOriginal=packet.primaryArtboardId||boardInput.results[0]?.id||artboards[0].id;
  const primaryId=docIds.get(primaryOriginal)!,primaryDesign=designs.get(primaryOriginal);
  const keys=prepared.flatMap(asset=>[asset.key,asset.thumbnailKey]);
  await tenantTransaction(workspaceId,async tx=>{
    const active=(await tx.query('SELECT status,execution_token FROM jobs WHERE id=$1 FOR UPDATE',[job.id])).rows[0];
    if(active?.status!=='running'||active.execution_token!==job.execution_token)throw new Error('导入已取消或由新执行接管');
    await tx.query("UPDATE jobs SET payload=jsonb_set(payload,'{importStaging}',$1::jsonb) WHERE id=$2",[JSON.stringify(keys),job.id]);
  });
  try{
    for(let index=0;index<prepared.length;index++){
      await assertActive(job);const asset=prepared[index];
      await putObject(asset.key,asset.bytes,'image/png');await putObject(asset.thumbnailKey,asset.thumbnail,'image/webp');
      if(index%5===0)await updateJob(workspaceId,job.id,{progress:40+Math.floor(index/Math.max(1,prepared.length)*35)},job.execution_token);
    }
    await assertActive(job);
    const result=await tenantTransaction(workspaceId,async tx=>{
      const active=(await tx.query('SELECT * FROM jobs WHERE id=$1 FOR UPDATE',[job.id])).rows[0];
      if(active?.status==='succeeded')return active.result;
      if(active?.status!=='running'||active.execution_token!==job.execution_token)throw new Error('导入已取消或由新执行接管');
      // All rows and the job's successful result commit together. A redelivery cannot create a second project.
      await tx.query('INSERT INTO projects(id,workspace_id,title,type,image,color,primary_artboard_id) VALUES($1,$2,$3,$4,$5,$6,$7)',[projectId,workspaceId,packet.title||'导入项目','设计作品',primaryDesign.nodes.find((node:any)=>node.type==='image')?.src||null,primaryDesign.background,primaryId]);
      for(const asset of prepared)await tx.query("INSERT INTO assets(id,workspace_id,title,mime,bytes,width,height,object_key,thumbnail_key,status) VALUES($1,$2,$3,'image/png',$4,$5,$6,$7,$8,'ready')",[asset.id,workspaceId,asset.title,asset.bytes.length,asset.width,asset.height,asset.key,asset.thumbnailKey]);
      for(const original of artboards){
        const design=designs.get(original.id);
        const doc=(await tx.query("INSERT INTO documents(id,workspace_id,project_id,kind,title,content) VALUES($1,$2,$3,'artboard',$4,$5) RETURNING *",[docIds.get(original.id),workspaceId,projectId,original.title||'导入画板',JSON.stringify(design)])).rows[0];
        await syncAssetRefs(tx,workspaceId,doc.id,design);await saveVersion(tx,workspaceId,doc,'导入版本');
      }
      await tx.query("INSERT INTO documents(id,workspace_id,project_id,kind,title,content) VALUES($1,$2,$3,'board',$4,$5)",[sourceBoard?docIds.get(sourceBoard.id):importedId(job.id,'document','board'),workspaceId,projectId,packet.title||'导入项目',JSON.stringify(board)]);
      const completed={projectId,artboardCount:artboards.length,assetCount:prepared.length,noteCount:board.notes.length,sectionCount:board.sections.length};
      const updated=(await tx.query("UPDATE jobs SET project_id=$1,status='succeeded',progress=100,result=$2,error=NULL,payload=jsonb_set(payload,'{importStaging}','[]'::jsonb),updated_at=now() WHERE id=$3 RETURNING *",[projectId,JSON.stringify(completed),job.id])).rows[0];
      await emit(tx,workspaceId,'project.created',{projectId,source:'import'});await emit(tx,workspaceId,'job.updated',jobDto(updated));
      return completed;
    });
    await deleteObject(job.payload.sourceKey).catch(()=>{});
    return result;
  }catch(error){
    await cleanupImportStaging(workspaceId,job.id,keys).catch(cleanupError=>console.error('Import staging cleanup deferred',cleanupError));
    throw error;
  }
}
