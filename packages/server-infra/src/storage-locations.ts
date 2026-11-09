export type BucketAlias = {bucket: string; prefix: string};
export type BucketAliases = ReadonlyMap<string, BucketAlias>;
const bucketName = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

/** One-hop logical bucket aliases preserve immutable historical references. */
export function parseBucketAliases(raw: string | undefined): BucketAliases {
  const parsed: unknown = raw ? JSON.parse(raw) : {};
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('S3_BUCKET_ALIASES_JSON must be an object');
  const aliases = new Map<string, BucketAlias>();
  for (const [logical, value] of Object.entries(parsed)) {
    if (!bucketName.test(logical) || !value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid storage bucket alias');
    const {bucket, prefix = ''} = value as Record<string, unknown>;
    if (typeof bucket !== 'string' || !bucketName.test(bucket) || typeof prefix !== 'string'
      || /[\\\p{Cc}]/u.test(prefix) || prefix.startsWith('/')
      || prefix && (!prefix.endsWith('/') || prefix.split('/').slice(0, -1).some(p => !p || p === '.' || p === '..')))
      throw new Error('Invalid storage bucket alias target');
    if (Object.keys(value).some(key => !['bucket', 'prefix'].includes(key))) throw new Error('Unknown storage bucket alias option');
    aliases.set(logical, {bucket, prefix});
  }
  for (const [logical, target] of aliases) {
    if (aliases.has(target.bucket) && target.bucket !== logical) throw new Error('Storage bucket aliases cannot be chained');
    if (target.bucket === logical && !target.prefix) throw new Error('Storage bucket alias must change its target');
  }
  return aliases;
}

export function resolveObjectLocation(bucket: string, key: string, aliases: BucketAliases) {
  const alias = aliases.get(bucket);
  if (!alias) return {bucket, key};
  if (key.startsWith('/') || /[\\\p{Cc}]/u.test(key) || key.split('/').some(p => p === '.' || p === '..'))
    throw new Error('Unsafe object key for storage bucket alias');
  return {bucket: alias.bucket, key: alias.prefix + key};
}
