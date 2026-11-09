import { S3Client, HeadBucketCommand, CreateBucketCommand, PutObjectCommand, GetObjectCommand, HeadObjectCommand, CopyObjectCommand, DeleteObjectCommand, PutBucketCorsCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Readable } from 'node:stream';
import { config } from './config.js';
import { parseBucketAliases,resolveObjectLocation } from './storage-locations.js';

const bucketAliases = parseBucketAliases(process.env.S3_BUCKET_ALIASES_JSON);
const locate = (bucket:string,key='') => resolveObjectLocation(bucket,key,bucketAliases);

export const storage = new S3Client({ endpoint: config.s3Endpoint, region: config.s3Region, forcePathStyle: true, requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED', credentials: { accessKeyId: config.s3AccessKey, secretAccessKey: config.s3SecretKey } });
// Legacy objects remain readable during verified copy/switch and rollback. This
// client is deliberately used only by GET/HEAD; all writes use the primary store.
export const legacyReadBucket = () => process.env.LEGACY_S3_BUCKET || undefined;
const legacyStorage = process.env.LEGACY_S3_BUCKET && process.env.LEGACY_S3_BUCKET !== config.s3Bucket ? new S3Client({
 endpoint:process.env.LEGACY_S3_ENDPOINT||config.s3Endpoint,region:process.env.LEGACY_S3_REGION||config.s3Region,forcePathStyle:true,
 requestChecksumCalculation:'WHEN_REQUIRED',responseChecksumValidation:'WHEN_REQUIRED',
 credentials:{accessKeyId:process.env.LEGACY_S3_ACCESS_KEY_ID||config.s3AccessKey,secretAccessKey:process.env.LEGACY_S3_SECRET_ACCESS_KEY||config.s3SecretKey},
}) : undefined;
const readerFor=(bucket:string)=>!bucketAliases.has(bucket)&&legacyStorage&&bucket===legacyReadBucket()?legacyStorage:storage;
export const stagingBucket = () => config.s3StagingBucket || `${config.s3Bucket}-staging`;
export type ObjectOptions = { bucket?: string; maxBytes?: number; ifAbsent?: boolean; sha256?: string; signal?: AbortSignal };
// Cloud bucket provisioning and CORS are operator-owned, even in local acceptance.
// A shared cloud bucket must never have its global settings replaced by an upload.
function localDevelopmentStorage() {
  const endpoint = new URL(config.s3Endpoint);
  return !config.production && endpoint.protocol === 'http:' && ['localhost','127.0.0.1','[::1]','storage'].includes(endpoint.hostname);
}
export async function ensureBucket(bucket = config.s3Bucket) {
  bucket=locate(bucket).bucket;
  try { await storage.send(new HeadBucketCommand({ Bucket: bucket })); }
  catch (error: any) {
    if (error.$metadata?.httpStatusCode !== 404 && error.name !== 'NotFound') throw error;
    if (!localDevelopmentStorage()) throw new Error(`Required private storage bucket is missing: ${bucket}`);
    await storage.send(new CreateBucketCommand({ Bucket: bucket }));
  }
}
export async function ensureUploadStorage() {
  await ensureBucket(stagingBucket());
  if (localDevelopmentStorage()) {
    try { await storage.send(new PutBucketCorsCommand({ Bucket: locate(stagingBucket()).bucket, CORSConfiguration: { CORSRules: [{ AllowedOrigins: [config.webOrigin], AllowedMethods: ['PUT','HEAD'], AllowedHeaders: ['content-type','content-length','x-amz-*'], ExposeHeaders: ['ETag'], MaxAgeSeconds: 300 }] } })); }
    catch(error:any) { if(error.name!=='NotImplemented')throw error; } // SeaweedFS local S3 supplies its development CORS policy.
  }
}
export async function putObject(key: string, bytes: Buffer, contentType: string, options: ObjectOptions = {}) {
  options.signal?.throwIfAborted();
  const target=locate(options.bucket||config.s3Bucket,key);
  await storage.send(new PutObjectCommand({ Bucket: target.bucket, Key: target.key, Body: bytes, ContentType: contentType, ...(options.ifAbsent ? { IfNoneMatch: '*' } : {}), ...(options.sha256 ? { Metadata: { sha256: options.sha256 } } : {}) }), {abortSignal:options.signal});
}
export async function headObject(key: string, options: ObjectOptions = {}) {
  options.signal?.throwIfAborted();
  const target=locate(options.bucket||config.s3Bucket,key);
  const result = await readerFor(options.bucket||config.s3Bucket).send(new HeadObjectCommand({ Bucket: target.bucket, Key: target.key }), {abortSignal:options.signal});
  return { bytes: Number(result.ContentLength || 0), contentType: result.ContentType || 'application/octet-stream', etag: result.ETag, metadata: result.Metadata };
}
export async function openObject(key: string, options: ObjectOptions = {}) {
  options.signal?.throwIfAborted();
  const target=locate(options.bucket||config.s3Bucket,key);
  const result = await readerFor(options.bucket||config.s3Bucket).send(new GetObjectCommand({ Bucket: target.bucket, Key: target.key }), {abortSignal:options.signal});
  if (!result.Body) throw new Error('Stored object has no body');
  const body = result.Body as Readable;
  if (options.maxBytes && Number(result.ContentLength) > options.maxBytes) { body.destroy(); throw new Error('Stored object exceeds byte budget'); }
  return { stream: body, contentType: result.ContentType || 'application/octet-stream', bytes: result.ContentLength };
}
export async function getObject(key: string, options: ObjectOptions = {}) {
  const result = await openObject(key, options), chunks: Buffer[] = [];
  const limit = options.maxBytes ?? 128 * 1024 * 1024;
  let length = 0;
  const abort=()=>result.stream.destroy(options.signal?.reason instanceof Error?options.signal.reason:new Error('Storage read aborted'));
  options.signal?.addEventListener('abort',abort,{once:true});
  try {
    options.signal?.throwIfAborted();
    for await (const chunk of result.stream) {
      options.signal?.throwIfAborted();
      const bytes = Buffer.from(chunk); length += bytes.length;
      if (length > limit) throw new Error('Stored object exceeds byte budget');
      chunks.push(bytes);
    }
  } finally { options.signal?.removeEventListener('abort',abort);result.stream.destroy(); }
  return { bytes: Buffer.concat(chunks, length), contentType: result.contentType };
}
export async function signedUpload(key: string, mime: string, bytes: number, expiresIn = 600) {
  const target=locate(stagingBucket(),key);
  return getSignedUrl(storage, new PutObjectCommand({ Bucket: target.bucket, Key: target.key, ContentType: mime, ContentLength: bytes }), { expiresIn });
}
export async function deleteObject(key: string, options: ObjectOptions = {}) { const target=locate(options.bucket||config.s3Bucket,key);await storage.send(new DeleteObjectCommand({ Bucket: target.bucket, Key: target.key })); }

export async function copyObject(sourceKey:string,targetKey:string,options:{sourceBucket?:string,bucket?:string,sourceEtag?:string}={}) {
  const source=locate(options.sourceBucket||config.s3Bucket,sourceKey),target=locate(options.bucket||config.s3Bucket,targetKey);
  await storage.send(new CopyObjectCommand({Bucket:target.bucket,Key:target.key,CopySource:`${source.bucket}/${source.key.split('/').map(encodeURIComponent).join('/')}`,...(options.sourceEtag?{CopySourceIfMatch:options.sourceEtag}:{})}));
}
