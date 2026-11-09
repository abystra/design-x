/** Real local acceptance against already-running API and independent workers.
 * Opt-in: node --import tsx scripts/verify-default-workflow.mjs --live
 * Resumes persisted request IDs; never retries a supplier's unknown result.
 * Leaves the demo project intact. No fixtures, direct handlers or queue mutation.
 */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { chromium } from 'playwright';
import sharp from 'sharp';
import { config } from '../packages/server-infra/src/config.ts';
import { pool, tenantTransaction } from '../packages/server-infra/src/db.ts';

if (!process.argv.includes('--live')) throw new Error('Use --live for one real image call and two real Agent turns');
const base = process.env.DESIGNX_E2E_URL || 'http://127.0.0.1:5173';
assert.ok(new URL(base).hostname === '127.0.0.1', 'this acceptance is local only');
assert.equal(process.env.DESIGNX_RUNNER_V2, 'true', 'switch the default Runner before running acceptance');
assert.ok(config.s3Endpoint.includes('.r2.cloudflarestorage.com'), 'default storage must be R2');
const output = 'artifacts/v2/cutover';
await mkdir(output, { recursive: true });
const privatePath = `${output}/default-workflow.private.json`;
let state;
try { state = JSON.parse(await readFile(privatePath, 'utf8')); }
catch (error) {
  if (error.code !== 'ENOENT') throw error;
  state = { email: `cutover-${randomUUID()}@example.test`, password: randomBytes(24).toString('base64url'), steps: {} };
}
const persist = async () => { await writeFile(privatePath, JSON.stringify(state, null, 2), { mode: 0o600 }); await chmod(privatePath, 0o600); };
await persist();
const report = { startedAt: new Date().toISOString(), status: 'running', base, checks: [], resumed: !!state.identity, storageBucket: config.s3Bucket, template: process.env.DESIGNX_E2B_TEMPLATE };
const save = () => writeFile(`${output}/default-workflow.json`, JSON.stringify(report, null, 2));
const check = async name => { if (!report.checks.includes(name)) report.checks.push(name); console.log(`PASS ${name}`); await save(); };
const sanitize = value => String(value).split(state.password).join('[REDACTED]').replace(/https?:\/\/[^\s"'<>]+/g, '[URL REDACTED]').slice(0, 1500);
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 1050 } });
const page = await context.newPage();
page.setDefaultTimeout(20000);
const pageErrors = [];
page.on('pageerror', error => pageErrors.push(sanitize(error.message)));
async function api(path, data, key) {
  const response = data === undefined ? await context.request.get(base + '/api' + path) : await context.request.post(base + '/api' + path, { data, headers: { Origin: base, 'X-Requested-With': 'Design-X', ...(key ? { 'idempotency-key': key } : {}) } });
  if (!response.ok()) {
    const body = await response.json().catch(() => ({}));
    throw new Error(`${path}: HTTP ${response.status()} ${sanitize(body.code || body.message || 'request failed')}`);
  }
  return response.json();
}
async function submit(step, path, data) {
  if (!state.steps[step]) { state.steps[step] = { key: randomUUID(), path, data }; await persist(); }
  const record = state.steps[step];
  assert.equal(record.path, path, `${step} must resume the same endpoint`);
  // The immutable original input is replayed with its persisted key only if the
  // HTTP acknowledgement was lost. A recorded response always skips submission.
  if (!record.result) { record.result = await api(record.path, record.data, record.key); await persist(); }
  return record.result;
}
async function poll(label, path, success, failure, timeoutMs = 600000) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    const value = await api(path);
    const current = `${value.status || value.executionStatus}/${value.stage || value.assetStatus || ''}`;
    if (current !== last) { console.log(`${label}: ${current}`); last = current; }
    if (success(value)) return value;
    if (failure(value)) throw new Error(`${label} stopped: ${current} ${sanitize(value.error || '')}; existing request is retained, no retry`);
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
  throw new Error(`${label} exceeded acceptance wait; existing request is retained, no retry`);
}
async function turnAudit(turnId) {
  // Document commit can be observed before the Worker finishes its sandbox
  // pause/finally cleanup. Wait for the session acknowledgement independently.
  for (let i = 0; i < 30; i++) {
    const ready = await tenantTransaction(state.identity.workspace.id, async tx => (await tx.query("SELECT 1 FROM ai_turns t JOIN creative_sessions s ON s.id=t.session_id WHERE t.id=$1 AND s.status='paused' AND s.active_attempt_id IS NULL AND NOT EXISTS (SELECT 1 FROM ai_attempts a WHERE a.turn_id=t.id AND a.status<>'closed')", [turnId])).rowCount > 0);
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  return tenantTransaction(state.identity.workspace.id, async tx => {
    const turn = (await tx.query('SELECT runtime_protocol,session_id FROM ai_turns WHERE id=$1', [turnId])).rows[0];
    const attempts = (await tx.query('SELECT id,status,sandbox_id,thread_id,model,usage,event_cursor,outcome FROM ai_attempts WHERE turn_id=$1 ORDER BY created_at', [turnId])).rows;
    const session = (await tx.query('SELECT id,status,sandbox_id,native_thread_id,active_attempt_id,boundary_reason FROM creative_sessions WHERE id=$1', [turn.session_id])).rows[0];
    assert.equal(turn.runtime_protocol, 'designx-runner-v2');
    const nativeAttempts = attempts.filter(attempt => Number(attempt.event_cursor) > 0);
    assert.equal(nativeAttempts.length, 1, 'one accepted turn must have one actual native execution');
    const knownPreparationFailures = state.recovery?.preparationAttempts?.map(attempt => attempt.id) || [];
    for (const attempt of attempts.filter(attempt => Number(attempt.event_cursor) === 0))
      assert.ok(knownPreparationFailures.includes(attempt.id), 'an empty journal alone does not authorize a retry');
    const attempt = nativeAttempts[0];
    assert.equal(attempt.status, 'closed');
    assert.equal(attempt.usage?.native?.status, 'known');
    assert.ok(attempt.usage.input_tokens > 0 && attempt.usage.output_tokens > 0);
    const events = (await tx.query('SELECT sequence,type FROM agent_runtime_events WHERE attempt_id=$1 ORDER BY sequence', [attempt.id])).rows;
    events.forEach((event, i) => assert.equal(Number(event.sequence), i + 1));
    assert.equal(Number(attempt.event_cursor), events.length);
    assert.ok(events.some(event => event.type === 'run.completed'));
    assert.equal(session.status, 'paused');
    assert.equal(session.active_attempt_id, null);
    return { turnId, protocol: turn.runtime_protocol, attempts, attempt, session, eventCount: events.length };
  });
}
try {
  await save();
  if (!state.identity) {
    // Registration is unpaid. A lost register response is recovered by login.
    try { state.identity = await api('/auth/register', { email: state.email, password: state.password, name: 'R2 与 E2B 本地验收' }); }
    catch (error) { if (!String(error).includes('409')) throw error; state.identity = await api('/auth/login', { email: state.email, password: state.password }); }
    await persist();
  } else await api('/auth/login', { email: state.email, password: state.password });
  if (process.argv.includes('--resume-after-preparation-fix') && !state.recovery) {
    const failedId = state.steps.secondTurn?.result?.id;
    assert.ok(failedId, 'a retained failed continuation is required');
    const failed = await api(`/ai-turns/${failedId}`);
    assert.equal(failed.status, 'failed'); assert.equal(failed.stage, 'preparing');
    const diagnostic = JSON.parse(await readFile(`${output}/resume-mount-diagnostic.json`, 'utf8'));
    assert.equal(diagnostic.modelCalls, 0); assert.equal(diagnostic.oldOrder.failed, true); assert.equal(diagnostic.fixedOrder.exitCode, 0);
    const attempts = await tenantTransaction(state.identity.workspace.id, async tx => (await tx.query('SELECT id,status,event_cursor,outcome FROM ai_attempts WHERE turn_id=$1', [failedId])).rows);
    assert.equal(attempts.length, 1); assert.equal(Number(attempts[0].event_cursor), 0); assert.equal(attempts[0].status, 'closed');
    assert.notEqual(attempts[0].outcome, 'unknown');
    state.recovery = { reason: 'confirmed_readonly_material_mount_preparation_failure', originalFirstTurn: state.steps.firstTurn, originalSecondTurn: state.steps.secondTurn, originalFirstAudit: state.firstAudit, preparationAttempts: attempts, originalFailure: failed, requestedAt: new Date().toISOString() };
    await persist();
  }
  if (state.recovery && !state.recovery.prepared) {
    const failedId = state.recovery.originalSecondTurn.result.id;
    const current = await api(`/ai-turns/${failedId}`);
    if (current.status === 'failed') {
      assert.equal(current.stage, 'preparing');
      state.recovery.retryAcknowledgement = await api(`/jobs/${failedId}/retry`, {});
    }
    state.steps.firstTurn = state.recovery.originalSecondTurn;
    delete state.steps.secondTurn; delete state.firstAudit;
    state.recovery.prepared = true; await persist();
  }
  if (state.recovery) report.recovery = { reason: state.recovery.reason, originalFirstTurnId: state.recovery.originalFirstTurn.result.id, retriedTurnId: state.recovery.originalSecondTurn.result.id, preparationAttempts: state.recovery.preparationAttempts, originalFirstAudit: state.recovery.originalFirstAudit, originalFailure: state.recovery.originalFailure, note: 'Original native sandbox was terminated on preparation failure. Explicit retry starts a recorded new native context; the later continuation must reuse that replacement context.' };
  report.workspaceId = state.identity.workspace.id;
  const capabilities = await api('/capabilities');
  assert.equal(capabilities.modes.find(mode => mode.id === 'design')?.enabled, true);
  assert.equal(capabilities.modes.find(mode => mode.id === 'image')?.enabled, true);
  assert.equal(capabilities.uploads.direct, true);
  report.imageModel = capabilities.image.model;
  await check('real HTTP API advertises editable design, image generation and direct uploads');
  const project = await submit('project', '/projects', { title: 'R2 × E2B 完整创作验收' });
  report.projectId = project.id; report.projectUrl = `${base}/#studio/${project.id}`;
  await page.goto(report.projectUrl);
  await page.getByLabel('当前创作名称').waitFor();
  if (!state.upload) {
    const bytes = await readFile('public/assets/coffee.jpg');
    const upload = await api('/uploads', { filename: 'coffee-reference.jpg', mime: 'image/jpeg', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), projectId: project.id });
    state.upload = { id: upload.id }; await persist();
    const result = await page.evaluate(async ({ url, headers, base64 }) => {
      const bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0));
      const response = await fetch(url, { method: 'PUT', headers, body: bytes });
      return { ok: response.ok, status: response.status };
    }, { url: upload.upload.url, headers: upload.upload.headers, base64: bytes.toString('base64') });
    assert.equal(result.ok, true, `real browser R2 PUT: HTTP ${result.status}`);
    state.upload.browserPut = true; await persist();
  }
  assert.equal(state.upload.browserPut, true, 'incomplete browser upload requires operator review; do not substitute a server PUT');
  const currentUpload = await api(`/uploads/${state.upload.id}`);
  if (!['ready', 'processing'].includes(currentUpload.status)) await api(`/uploads/${state.upload.id}/complete`, {});
  const uploaded = await poll('upload media worker', `/uploads/${state.upload.id}`, value => value.status === 'ready', value => ['failed', 'expired', 'rejected'].includes(value.status), 120000);
  state.upload.asset = uploaded.asset; await persist();
  report.upload = { id: state.upload.id, assetId: uploaded.asset.id, assetVersionId: uploaded.asset.versionId };
  await check('browser CORS PUT to R2 and independent media worker produce a verified project asset');
  const generation = (await submit('generation', `/projects/${project.id}/generations`, {
    prompt: '以参考图片的咖啡杯为主角，生成一张秋日咖啡馆商品摄影：暖色自然窗光，橙棕色桌面，少量枫叶，干净高级的真实摄影，杯子位于画面右侧，左侧留出排版空间。画面不要文字、数字、标志或水印。',
    count: 1, size: '1024x1024', quality: 'medium', referenceAssetVersionIds: [uploaded.asset.versionId], placement: 'board',
  })).generation;
  report.generationId = generation.id; await save();
  const generated = await poll('OpenAI generation worker', `/generations/${generation.id}`, value => value.status === 'succeeded' && value.outputs.some(item => item.status === 'ready'), value => ['unknown', 'failed', 'cancelled', 'partial'].includes(value.status));
  assert.equal(generated.outputs.length, 1);
  const image = generated.outputs[0];
  assert.equal(image.placementStatus, 'board');
  report.generatedAsset = { assetId: image.assetId, assetVersionId: image.assetVersionId };
  await check('one real OpenAI image edit is ingested into R2 and placed on the Board');
  const first = await submit('firstTurn', `/projects/${project.id}/ai-turns`, {
    count: 1, mode: 'create', ratio: '4:3', assetIds: [image.assetId],
    prompt: `创建秋日咖啡馆营销海报。品牌是「暖秋咖啡」，主标题必须是「秋日暖咖啡」，副标题为「慢一点，喝杯好咖啡」。记住这些品牌和风格需求供后续修改。只使用本项目已有图片素材 ${image.assetId}，禁止调用 generation.create、recipe.run 或其他生图服务。先读取 context.json，从素材清单中找到该 assetId 的挂载文件并实际打开读取。创建一张 960×720 的可编辑画板，使用该素材的独立 image 图层，src 必须原样使用 context.assets 中对应素材的 src；品牌、主标题和副标题必须分别是独立 text 图层。浅米色和暖棕色、留白充分。无需提问，不要修改已有画板。写入 artifact.json 并运行 node /opt/designx/validate.mjs 验证。`,
  });
  report.firstTurnId = first.id; await save();
  const firstDone = await poll('v2 Agent first turn', `/ai-turns/${first.id}`, value => value.status === 'succeeded', value => ['failed', 'cancelled'].includes(value.status) || value.stage === 'awaiting_input');
  assert.equal(firstDone.artboardIds.length, 1);
  const firstDoc = await api(`/documents/${firstDone.artboardIds[0]}`);
  assert.ok(firstDoc.content.nodes.some(node => node.type === 'text' && node.text.includes('秋日暖咖啡')));
  assert.ok(firstDoc.content.nodes.some(node => node.type === 'image' && node.src === image.image));
  if (!state.firstAudit) { state.firstAudit = await turnAudit(first.id); await persist(); }
  report.firstTurn = state.firstAudit;
  await check('default v2 Agent reads project materials and commits an editable image and independent Chinese text');
  const second = await submit('secondTurn', `/projects/${project.id}/ai-turns`, {
    count: 1, mode: 'create', ratio: '4:3', assetIds: [image.assetId], referenceDocumentIds: [firstDoc.id],
    prompt: '继续前一轮已确认的咖啡海报。请根据会话上下文保留品牌名称、配色和同一张咖啡照片，新建一个版本，将主标题改为「秋日暖咖啡・周末限定」，副标题保持不变。文字和品牌仍是独立 text 图层；使用引用画板里的原始素材 src，必须先实际读取清单中的图片文件。禁止调用 generation.create、recipe.run 或其他生图服务，不要修改旧画板，无需提问。写入 artifact.json 并运行 node /opt/designx/validate.mjs 验证。',
  });
  report.secondTurnId = second.id; await save();
  const secondDone = await poll('v2 Agent continuation', `/ai-turns/${second.id}`, value => value.status === 'succeeded', value => ['failed', 'cancelled'].includes(value.status) || value.stage === 'awaiting_input');
  assert.equal(secondDone.artboardIds.length, 1);
  const secondDoc = await api(`/documents/${secondDone.artboardIds[0]}`);
  assert.notEqual(firstDoc.id, secondDoc.id);
  assert.ok(secondDoc.content.nodes.some(node => node.type === 'text' && node.text.includes('暖秋咖啡')));
  assert.ok(secondDoc.content.nodes.some(node => node.type === 'text' && node.text.includes('周末限定')));
  assert.equal((await api(`/documents/${firstDoc.id}`)).revision, firstDoc.revision);
  report.secondTurn = await turnAudit(second.id);
  assert.equal(report.secondTurn.session.id, state.firstAudit.session.id);
  assert.equal(report.secondTurn.session.sandbox_id, state.firstAudit.session.sandbox_id);
  assert.equal(report.secondTurn.session.native_thread_id, state.firstAudit.session.native_thread_id);
  await check('continuation reuses the paused E2B sandbox and native thread while preserving the original document');
  await page.reload();
  await page.getByLabel('当前创作名称').waitFor();
  if (await page.getByLabel('关闭侧边面板').count()) await page.getByLabel('关闭侧边面板').click();
  await page.getByLabel('适应所有方案').click();
  await page.locator(`[data-board-id="${secondDoc.id}"]`).getByRole('button', { name: /^选中方案 / }).click();
  await page.getByRole('button', { name: '编辑与导出', exact: true }).click();
  await page.getByLabel('作品名称', { exact: true }).waitFor();
  const editedText = '秋日暖咖啡・周末限定｜到店享好礼';
  const titleNode = secondDoc.content.nodes.find(node => node.type === 'text' && node.text.includes('周末限定'));
  await page.getByRole('button', { name: `选中文字：${titleNode.text}`, exact: true }).press('Enter');
  if (!state.editorSaved) {
    await page.getByLabel('文字内容', { exact: true }).fill(editedText);
    await page.getByLabel('作品名称', { exact: true }).fill('秋日暖咖啡 · 精细编辑完成');
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.locator('.ed-save-state').filter({ hasText: '已保存' }).waitFor();
  }
  const saved = await api(`/documents/${secondDoc.id}`);
  if (!state.editorSaved) assert.ok(saved.revision > secondDoc.revision);
  else assert.equal(saved.revision, state.editorSaved.revision, 'resume must not overwrite intervening edits');
  assert.ok(saved.content.nodes.some(node => node.type === 'text' && node.text === editedText));
  state.editorSaved = { documentId: saved.id, revision: saved.revision }; await persist();
  report.documentId = saved.id; report.documentRevision = saved.revision;
  await page.screenshot({ path: `${output}/default-workflow-editor.png`, fullPage: true });
  await check('actual Editor edits the independent Chinese title and accepts the new persisted revision');
  const exported = await submit('export', `/projects/${project.id}/exports`, { documentId: saved.id, format: 'png', scale: 1 });
  const exportDone = await poll('Chromium Renderer worker', `/jobs/${exported.id}`, value => value.status === 'succeeded', value => ['failed', 'cancelled'].includes(value.status), 120000);
  const file = await context.request.get(`${base}/api/exports/${exported.id}/file`);
  assert.equal(file.status(), 200);
  const bytes = await file.body(), metadata = await sharp(bytes).metadata();
  assert.equal(metadata.format, 'png'); assert.equal(metadata.width, saved.content.width); assert.equal(metadata.height, saved.content.height);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), exportDone.result.sha256);
  assert.equal(exportDone.result.storageBucket, config.s3Bucket);
  await writeFile(`${output}/default-workflow-export.png`, bytes);
  report.export = { jobId: exported.id, width: metadata.width, height: metadata.height, bytes: bytes.length, sha256: exportDone.result.sha256, rendererVersion: exportDone.result.rendererVersion };
  await check('independent Renderer exports the saved document and immutable R2 assets as a verified PNG');
  const accounting = await tenantTransaction(state.identity.workspace.id, async tx => ({
    requests: (await tx.query('SELECT id,execution_status,settlement_status FROM creative_requests WHERE project_id=$1', [project.id])).rows,
    calls: (await tx.query('SELECT c.id,c.provider,c.model,c.endpoint,c.status,c.cost_status,c.usage FROM provider_calls c JOIN generation_attempts a ON a.id=c.attempt_id JOIN creative_requests r ON r.id=a.request_id WHERE r.project_id=$1', [project.id])).rows,
    quota: (await tx.query('SELECT quota_limit,reserved,used FROM quota_accounts')).rows[0],
    assetBuckets: (await tx.query('SELECT DISTINCT v.bucket FROM asset_versions v JOIN project_assets p ON p.asset_id=v.asset_id WHERE p.project_id=$1', [project.id])).rows.map(row => row.bucket),
  }));
  assert.equal(accounting.requests.length, 1); assert.equal(accounting.calls.length, 1);
  assert.equal(accounting.quota.reserved, 0); assert.equal(accounting.quota.used, 1);
  assert.deepEqual(accounting.assetBuckets, [config.s3Bucket]);
  report.accounting = accounting;
  await page.getByRole('button', { name: '返回工作区', exact: true }).click();
  await page.getByLabel('当前创作名称').waitFor();
  await page.getByLabel('创作记录').click();
  await page.getByRole('region', { name: '项目活动' }).waitFor();
  const activities = await api(`/projects/${project.id}/activities`);
  assert.ok(activities.some(item => item.type === 'generation'));
  assert.ok(activities.some(item => item.type === 'agent'));
  assert.ok(activities.some(item => item.type === 'render.export'));
  await page.screenshot({ path: `${output}/default-workflow-studio.png`, fullPage: true });
  assert.deepEqual(pageErrors, []);
  await check('refresh restores project activity; one supplier call consumes one quota unit without extra generation');
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = sanitize(error.stack || error);
  await page.screenshot({ path: `${output}/default-workflow-failure.png`, fullPage: true }).catch(() => {});
  console.error(report.error); process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString(); report.pageErrors = pageErrors;
  await save(); await persist(); await browser.close(); await pool.end();
}
