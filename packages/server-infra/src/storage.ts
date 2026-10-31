import { S3Client, HeadBucketCommand, CreateBucketCommand, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { config } from './config.js';
export const storage = new S3Client({ endpoint: config.s3Endpoint, region: config.s3Region, forcePathStyle: true, credentials: { accessKeyId: config.s3AccessKey, secretAccessKey: config.s3SecretKey } });
export async function ensureBucket() {
  try { await storage.send(new HeadBucketCommand({ Bucket: config.s3Bucket })); }
  catch (error: any) {
    if (error.$metadata?.httpStatusCode !== 404 && error.name !== 'NotFound') throw error;
    await storage.send(new CreateBucketCommand({ Bucket: config.s3Bucket }));
  }
}
export async function putObject(key: string, bytes: Buffer, contentType: string) {
  await storage.send(new PutObjectCommand({ Bucket: config.s3Bucket, Key: key, Body: bytes, ContentType: contentType }));
}
export async function getObject(key: string) {
  const result = await storage.send(new GetObjectCommand({ Bucket: config.s3Bucket, Key: key }));
  if (!result.Body) throw new Error('Stored object has no body');
  return { bytes: Buffer.from(await result.Body.transformToByteArray()), contentType: result.ContentType || 'application/octet-stream' };
}
export async function deleteObject(key: string) { await storage.send(new DeleteObjectCommand({ Bucket: config.s3Bucket, Key: key })); }
