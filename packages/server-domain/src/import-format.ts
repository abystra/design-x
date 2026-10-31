import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ArtboardSchema } from '../../doc-core/src/index.js';
import { BoardSchema, BoardItemIdSchema } from '../../doc-core/src/board.js';
import { HttpError } from './common.js';

export const IMPORT_LIMITS = {
  sourceBytes: 40 * 1024 * 1024,
  assetBytes: 10 * 1024 * 1024,
  totalAssetBytes: 30 * 1024 * 1024,
  assets: 200,
  artboards: 100,
  nodes: 10000,
  pixelsPerAsset: 40_000_000,
  totalPixels: 100_000_000,
  outputBytes: 64 * 1024 * 1024,
};
export const portableAssetPattern = /^(?:\/api\/assets\/[a-zA-Z0-9-]+\/(?:file|thumbnail)|\/assets\/(?:coffee|skincare|interior|fashion|headphones|nature)\.jpg)$/;
const assetFields = new Set(['src', 'image', 'url', 'thumbnail', 'logo', 'logoUrl']);
const humanFields = new Set(['text', 'prompt', 'draft', 'title', 'name', 'description', 'subtitle', 'label']);
const rootSchema = z.object({
  format: z.literal('designx.project'), schemaVersion: z.literal(1), title: z.string().max(200),
  primaryArtboardId: BoardItemIdSchema.optional(),
  documents: z.array(z.object({id: BoardItemIdSchema, kind: z.enum(['board','artboard']), title: z.string().max(200).optional(), content: z.unknown(), revision: z.number().int().positive().optional()}).strict()).min(1).max(IMPORT_LIMITS.artboards + 1),
  assets: z.record(z.string(), z.string()).default({}),
}).strict();
export type PortableProject = z.infer<typeof rootSchema>;
export function invalidImport(message: string): never { throw new HttpError(422, 'INVALID_PROJECT_PACKAGE', message); }
function guardTree(value: unknown) {
  const stack: {value:any, depth:number}[] = [{value,depth:0}]; let count=0;
  while(stack.length) {
    const item=stack.pop()!;
    if(++count>200000||item.depth>32) invalidImport('项目数据嵌套或条目数量超出限制');
    if(item.value&&typeof item.value==='object') for(const [key,child] of Object.entries(item.value)) {
      if(['__proto__','constructor','prototype'].includes(key)) invalidImport('项目包含不允许的字段');
      stack.push({value:child,depth:item.depth+1});
    }
  }
}
export function collectAssetSources(value: unknown): string[] {
  const sources=new Set<string>();
  const walk=(node:any,key='')=>{
    if(typeof node==='string') {
      if(humanFields.has(key))return;
      if(node.startsWith('/api/assets/')||node.startsWith('/assets/')) {
        if(!portableAssetPattern.test(node)) invalidImport('素材引用路径无效');
        sources.add(node);
      } else if(assetFields.has(key)&&node) invalidImport('导入只允许包内素材，不允许外部网址或内联图片引用');
      if(!humanFields.has(key)&&/url\s*\(|@import|javascript:/i.test(node)) invalidImport('项目样式包含外部资源引用');
    } else if(Array.isArray(node)) node.forEach(value=>walk(value,key));
    else if(node&&typeof node==='object') for(const [childKey,value] of Object.entries(node)) walk(value,childKey);
  };
  walk(value);return [...sources];
}
export function decodePortableAsset(dataUrl: string) {
  const match=/^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/]*={0,2})$/.exec(dataUrl);
  if(!match||!match[2]||match[2].length%4!==0) invalidImport('素材必须是有效的 PNG/JPEG/WebP/GIF base64 数据');
  if(match[2].length/4*3>IMPORT_LIMITS.assetBytes+2) invalidImport('单张素材不能超过 10 MiB');
  const bytes=Buffer.from(match[2],'base64');
  if(bytes.length>IMPORT_LIMITS.assetBytes||bytes.toString('base64')!==match[2]) invalidImport('素材 base64 已损坏或超出大小限制');
  return {bytes,mime:`image/${match[1]}`,format:match[1],hash:createHash('sha256').update(bytes).digest('hex')};
}
export function parsePortableProject(bytes: Buffer): PortableProject {
  if(bytes.length>IMPORT_LIMITS.sourceBytes)throw new HttpError(413,'PAYLOAD_TOO_LARGE','项目文件不能超过 40 MiB');
  let input:any;try{input=JSON.parse(bytes.toString('utf8'));}catch{invalidImport('不是有效的 .dxproj JSON 文件');}
  guardTree(input);
  if(input?.schemaVersion!==1)invalidImport('不支持此项目版本，目前支持 schemaVersion 1');
  const parsed=rootSchema.safeParse(input);if(!parsed.success)invalidImport(`项目结构无效：${parsed.error.issues[0]?.message}`);
  const packet=parsed.data;
  if(new Set(packet.documents.map(doc=>doc.id)).size!==packet.documents.length)invalidImport('文档 ID 重复');
  const artboards=packet.documents.filter(doc=>doc.kind==='artboard'),boards=packet.documents.filter(doc=>doc.kind==='board');
  if(!artboards.length||artboards.length>IMPORT_LIMITS.artboards||boards.length>1)invalidImport('项目需要 1–100 张画板，最多一个工作区');
  if(packet.primaryArtboardId&&!artboards.some(doc=>doc.id===packet.primaryArtboardId))invalidImport('主画板不属于此项目');
  let nodes=0;
  for(const doc of artboards){
    const validated=ArtboardSchema.safeParse(doc.content);if(!validated.success)invalidImport(`画板数据无效：${validated.error.issues[0]?.message}`);
    if(validated.data.nodes.some(node=>node.type==='image'&&!node.src))invalidImport('图片图层缺少素材地址');
    nodes+=validated.data.nodes.length;doc.content=validated.data;
  }
  if(nodes>IMPORT_LIMITS.nodes)invalidImport('项目图层总数不能超过 10000');
  if(boards.length){
    const validated=BoardSchema.safeParse(boards[0].content);if(!validated.success)invalidImport(`工作区数据无效：${validated.error.issues[0]?.message}`);
    if(validated.data.results.some(result=>!artboards.some(doc=>doc.id===result.id)))invalidImport('工作区引用了不存在的画板');
    boards[0].content=validated.data;
  }
  const entries=Object.entries(packet.assets);if(entries.length>IMPORT_LIMITS.assets)invalidImport('项目素材不能超过 200 张');
  let bytesTotal=0;
  for(const [source,data] of entries){
    if(!portableAssetPattern.test(source))invalidImport('项目包含不允许的素材地址');
    bytesTotal+=decodePortableAsset(data).bytes.length;
    if(bytesTotal>IMPORT_LIMITS.totalAssetBytes)invalidImport('项目素材总大小不能超过 30 MiB');
  }
  for(const source of collectAssetSources(packet.documents))if(!Object.hasOwn(packet.assets,source))invalidImport(`项目缺少已打包素材：${source}`);
  return packet;
}
export function importedId(jobId:string,scope:string,oldId:string) {
  const hex=createHash('sha256').update(`${jobId}:${scope}:${oldId}`).digest('hex');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`;
}
