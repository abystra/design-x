import {fileURLToPath} from 'node:url';

const localHosts = new Set(['localhost', '127.0.0.1', '[::1]', 'postgres', 'storage', 'minio']);
function localUrl(value, protocols, label) {
  let url;
  try { url = new URL(value); } catch { throw new Error(`${label} must be a local test URL`); }
  if (!protocols.includes(url.protocol) || !localHosts.has(url.hostname))
    throw new Error(`${label} must point to loopback or a local development service`);
  return value;
}
function bucketName(value) {
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(value)) throw new Error('Invalid local test bucket name');
  return value;
}

/** Only explicit TEST_* settings can select test infrastructure. Never load .env. */
export function buildTestEnvironment(source, runId) {
  const env = {...source};
  for (const key of Object.keys(env)) {
    if (/^(?:S3_|LEGACY_S3_|AWS_|OPENAI_|DEEPSEEK_|E2B_|WORKX_R2_)/.test(key)) delete env[key];
  }
  const bucket = bucketName(source.TEST_S3_BUCKET || `designx-test-${runId.slice(0,20)}`);
  const staging = bucketName(source.TEST_S3_STAGING_BUCKET || `${bucket.slice(0,55)}-staging`);
  const legacy = bucketName(`${bucket.slice(0,56)}-legacy`);
  if (new Set([bucket, staging, legacy]).size !== 3) throw new Error('Local test buckets must be distinct');
  return {
    ...env,
    NODE_ENV: 'test', DESIGNX_TEST_ENV: 'true',
    DOTENV_CONFIG_PATH: fileURLToPath(new URL('../tests/fixtures/empty.env', import.meta.url)),
    DOTENV_CONFIG_OVERRIDE: 'false', DOTENV_CONFIG_QUIET: 'true',
    DATABASE_URL: localUrl(source.TEST_DATABASE_URL || 'postgres://designx:designx-local-only@127.0.0.1:55432/designx', ['postgres:','postgresql:'], 'TEST_DATABASE_URL'),
    S3_ENDPOINT: localUrl(source.TEST_S3_ENDPOINT || 'http://127.0.0.1:58333', ['http:'], 'TEST_S3_ENDPOINT'),
    S3_REGION: source.TEST_S3_REGION || 'us-east-1',
    S3_BUCKET: bucket, S3_STAGING_BUCKET: staging, TEST_LEGACY_BUCKET: legacy,
    S3_ACCESS_KEY_ID: source.TEST_S3_ACCESS_KEY_ID || 'designx-local',
    S3_SECRET_ACCESS_KEY: source.TEST_S3_SECRET_ACCESS_KEY || 'designx-local-only',
    S3_BUCKET_ALIASES_JSON: '{}',
    LEGACY_S3_ENDPOINT: '', LEGACY_S3_REGION: '', LEGACY_S3_BUCKET: '',
    LEGACY_S3_ACCESS_KEY_ID: '', LEGACY_S3_SECRET_ACCESS_KEY: '',
    AI_ENABLED: 'false', IMAGE_GENERATION_ENABLED: 'false', DESIGNX_RUNNER_V2: 'false',
    DESIGNX_E2B_TEMPLATE: 'local-test-template:local-test-build',
    E2B_API_KEY: 'test-only-no-cloud-credential', E2B_TEMPLATE_ID: 'local-test-template',
    DEEPSEEK_API_KEY: 'test-only-no-model-credential', DEEPSEEK_MODEL: 'deepseek-flash',
    OPENAI_API_KEY: 'test-only-no-image-credential',
    STORAGE_DIRECT_UPLOADS_ENABLED: 'true', WEB_ORIGIN: 'http://127.0.0.1:5173',
    API_HOST: '127.0.0.1', PORT: '3001',
  };
}
