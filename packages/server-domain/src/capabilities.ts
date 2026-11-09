import { config } from '../../server-infra/src/config.js';
import type { Tx } from '../../server-infra/src/db.js';

export const MAX_REFERENCES = 3;
export const MAX_GENERATION_COUNT = 3;
export const recipeCatalog = [
 {id:'marketing-poster',version:1,name:'营销海报',description:'图片素材与可独立编辑的标题、正文、品牌和行动按钮',parameters:['prompt','headline','subheadline','cta','brand']},
 {id:'product-set',version:1,name:'商品套图',description:'围绕已关联商品素材生成一组可编辑方案',parameters:['prompt','headline','subheadline','brand','assetId']},
 {id:'multi-size',version:1,name:'多尺寸适配',description:'将已确认设计确定性适配为独立的新画板',parameters:['documentId','sizes']},
] as const;
export async function capabilityCatalog(tx:Tx, aiEnabled=config.aiEnabled){
 const quota=(await tx.query('SELECT * FROM quota_accounts LIMIT 1')).rows[0];
 const enabled=config.imageEnabled && !!config.openaiApiKey;
 return {version:1,modes:[
  {id:'design',label:'可编辑设计',enabled:aiEnabled,reason:aiEnabled?null:'AI 创作未启用',maxReferences:MAX_REFERENCES,maxCount:3},
  {id:'image',label:'图片生成',enabled,reason:enabled?null:'图片生成尚未启用',maxReferences:MAX_REFERENCES,maxCount:MAX_GENERATION_COUNT},
  {id:'video',label:'视频',enabled:false,reason:'视频生成不在本期支持范围',maxReferences:0,maxCount:0},
 ],recipes:recipeCatalog.map(r=>({...r,enabled:r.id==='multi-size'||enabled,outputCount:r.id==='product-set'?3:r.id==='multi-size'?null:1,maxReferences:MAX_REFERENCES})),
 image:{model:config.imageModel,quality:config.imageQuality,maxReferences:MAX_REFERENCES,maxCount:MAX_GENERATION_COUNT,quotaPerImage:1,sizes:['1024x1024','1024x1536','1536x1024']},
 uploads:{direct:config.storageDirectUploadsEnabled,maxBytes:config.maxUploadBytes},
 quota:{limit:quota?.quota_limit??config.generationQuota,reserved:quota?.reserved??0,used:quota?.used??0,remaining:Math.max(0,(quota?.quota_limit??config.generationQuota)-(quota?.reserved??0)-(quota?.used??0))}};
}
