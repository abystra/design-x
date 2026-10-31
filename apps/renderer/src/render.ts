import { collectAssetSources,parsePortableProject } from '../../../packages/server-domain/src/import-format.js';
import { readFile } from 'node:fs/promises';
import { chromium,type Browser } from 'playwright';
import sharp from 'sharp';
import { tenantTransaction } from '../../../packages/server-infra/src/db.js';
import { getObject,putObject } from '../../../packages/server-infra/src/storage.js';
import { updateJob } from '../../../packages/server-domain/src/jobs.js';
import { assetUrlPattern } from '../../../packages/server-domain/src/common.js';
import { renderDocumentHtml } from '../../../packages/doc-render/src/server.js';
import { assertActive } from '../../worker/src/process.js';
let browser:Browser|undefined;
export async function closeBrowser(){await browser?.close();browser=undefined;}
export async function embedSources(workspaceId:string,design:any){
 const sources=new Map<string,string>();
 for(const node of design.nodes){
  if(node.type!=='image'||!node.src||sources.has(node.src))continue;
  let bytes:Buffer,mime:string;
  const match=assetUrlPattern.exec(node.src);
  if(match){
   const asset=await tenantTransaction(workspaceId,async tx=>(await tx.query("SELECT * FROM assets WHERE id=$1 AND status='ready'",[match[1]])).rows[0]);
   if(!asset)throw new Error('导出引用的素材不存在');
   const key=node.src.endsWith('/thumbnail')?asset.thumbnail_key||asset.object_key:asset.object_key;
   const object=await getObject(key);bytes=object.bytes;mime=object.contentType;
  }else if(/^\/assets\/(coffee|skincare|interior|fashion|headphones|nature)\.jpg$/.test(node.src)){
   bytes=await readFile(new URL(`../../../public${node.src}`,import.meta.url));mime='image/jpeg';
  }else throw new Error('导出仅允许已上传素材与内置示例');
  sources.set(node.src,`data:${mime};base64,${bytes.toString('base64')}`);
 }
 return sources;
}
export async function renderExport(job:any){
 const {design,format,scale=1,transparent=false,title}=job.payload;
 const sources=await embedSources(job.workspace_id,design);
 const html=renderDocumentHtml(design,{transparent:format==='jpeg'?false:transparent,resolveAsset:src=>sources.get(src)||src});
 await updateJob(job.workspace_id,job.id,{progress:30},job.execution_token);
 let bytes:Buffer,mime:string,extension=format==='jpeg'?'jpg':format;
 if(format==='dxproj'){
  const documents=job.payload.documents||[{id:job.payload.documentId,kind:'artboard',content:design,revision:job.payload.revision}];
  const allSources=new Map(sources);
  const referenced=collectAssetSources(documents);
  for(const [src,data] of await embedSources(job.workspace_id,{nodes:referenced.map(src=>({type:'image',src}))}))allSources.set(src,data);
  const portable={format:'designx.project',schemaVersion:1,title,primaryArtboardId:job.payload.primaryArtboardId,documents,assets:Object.fromEntries(allSources)};
  bytes=Buffer.from(JSON.stringify(portable,null,2));
  parsePortableProject(bytes); // Export only self-contained packages that satisfy the documented import budgets.
  mime='application/json';
 }else if(format==='svg'){
  // The same DOM renderer is embedded in SVG foreignObject; assets/fonts are self-contained.
  const body=html.slice(html.indexOf('<body>')+6,html.lastIndexOf('</body>'));
  const style=html.slice(html.indexOf('<style>')+7,html.lastIndexOf('</style>'));
  bytes=Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${design.width*scale}" height="${design.height*scale}" viewBox="0 0 ${design.width} ${design.height}"><foreignObject width="100%" height="100%"><div xmlns="http://www.w3.org/1999/xhtml"><style>${style}</style>${body}</div></foreignObject></svg>`);mime='image/svg+xml';
 }else{
  if(!browser||!browser.isConnected())browser=await chromium.launch({headless:true});
  const context=await browser.newContext({viewport:{width:Math.ceil(design.width),height:Math.ceil(design.height)},deviceScaleFactor:scale});
  try{
   const page=await context.newPage();
   // No renderer network access: all authorized media/fonts have been embedded by the trusted worker.
   await page.route('**/*',route=>route.abort());
   await page.setContent(html,{waitUntil:'load',timeout:30000});
   await page.evaluate(async()=>{await document.fonts.ready;await Promise.all([...document.images].map(img=>img.decode()));});
   await assertActive(job);await updateJob(job.workspace_id,job.id,{progress:70},job.execution_token);
   if(format==='pdf'){bytes=await page.pdf({width:`${design.width}px`,height:`${design.height}px`,printBackground:true,margin:{top:0,bottom:0,left:0,right:0},pageRanges:'1'});mime='application/pdf';}
   else{
    const screenshot=await page.screenshot({type:format==='jpeg'?'jpeg':'png',omitBackground:transparent&&format!=='jpeg',clip:{x:0,y:0,width:design.width,height:design.height}});
    bytes=format==='webp'?await sharp(screenshot).webp({quality:95}).toBuffer():screenshot;mime=`image/${format}`;
   }
  }finally{await context.close();}
 }
 await assertActive(job);
 const objectKey=`${job.workspace_id}/exports/${job.id}.${extension}`;
 await putObject(objectKey,bytes,mime);
 const filename=`${String(title||'Design-X').replace(/[\u0000-\u001f/\\]/g,'').slice(0,100)}.${extension}`;
 return {objectKey,filename,format,bytes:bytes.length,mime,documentId:job.payload.documentId,revision:job.payload.revision};
}
