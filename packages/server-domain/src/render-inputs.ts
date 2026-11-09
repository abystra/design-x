import {collectAssetSources} from './import-format.js';
import type {Tx} from '../../server-infra/src/db.js';
import {assetUrlPattern,HttpError} from './common.js';
export async function freezeRenderInputs(tx:Tx,design:any,documents?:any[]){
 const sources=collectAssetSources({design,documents}).filter(src=>assetUrlPattern.test(src));
 const assets=[];
 for(const src of sources){const match=assetUrlPattern.exec(src)!;
  const asset=(await tx.query("SELECT a.*,v.id AS version_id,v.object_key AS version_key,v.thumbnail_key AS version_thumbnail,v.bucket AS version_bucket,v.sha256 AS version_sha256,v.bytes AS version_bytes FROM assets a LEFT JOIN asset_versions v ON v.asset_id=a.id AND v.id=COALESCE($2,(SELECT av.id FROM asset_versions av WHERE av.asset_id=a.id AND a.current_version_id IS NOT NULL ORDER BY av.created_at,av.id LIMIT 1)) WHERE a.id=$1 AND a.deleted_at IS NULL AND a.status='ready' FOR SHARE OF a",[match[1],match[2]||null])).rows[0];
  if(!asset||match[2]&&!asset.version_id)throw new HttpError(400,'INVALID_ASSET','导出引用的素材版本不可用');
  const thumbnail=src.endsWith('/thumbnail');
  assets.push({src,assetId:asset.id,assetVersionId:asset.version_id||null,objectKey:thumbnail?(asset.version_thumbnail||asset.thumbnail_key||asset.object_key):(asset.version_key||asset.object_key),bucket:asset.version_bucket||asset.storage_bucket||process.env.LEGACY_S3_BUCKET||undefined,sha256:thumbnail?null:asset.version_sha256,bytes:thumbnail?null:Number(asset.version_bytes||asset.bytes)});
 }
 return assets;
}
