// Product regression against local API, database and object storage.
// Uses explicit persisted question/image fixtures and one forced list-read
// failure; never calls an AI provider. Run with node --import tsx.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { tenantTransaction, pool } from '../../packages/server-infra/src/db.ts';
import { ingestBufferAsset } from '../../packages/server-domain/src/assets.ts';
import { placeGenerationOutput } from '../../packages/server-domain/src/recipes.ts';
import { cleanupNativeQuestionFixture, nativeQuestionRequest, nativeQuestions } from './v2_product_fixtures.mjs';
const base = process.env.DESIGNX_E2E_URL || 'http://127.0.0.1:5173';
const output = new URL('./.artifacts/v2-product/', import.meta.url);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
page.setDefaultTimeout(15000);
const errors = [], checks = [];
let nativeQuestionFixture;
page.on('pageerror', error => errors.push(error.message));
async function api(path, data) {
  const response = data ? await context.request.post(base + '/api' + path, { data, headers: { Origin: base, 'X-Requested-With': 'Design-X' } }) : await context.request.get(base + '/api' + path);
  assert.ok(response.ok(), `${path}: ${response.status()} ${await response.text()}`);
  return response.json();
}
async function check(name) { checks.push(name); console.log('PASS', name); }
try {
  const identity = await api('/auth/register', { email: `v2-product-${randomUUID()}@example.test`, password: 'product-test-password', name: '创作验收' });
  await page.goto(base);
  await page.getByRole('navigation', { name: '主导航' }).waitFor();
  const video = page.locator('.composer-tabs button').filter({ hasText: '视频' });
  assert.equal(await video.isDisabled(), true);
  await check('capability-driven home: unavailable video disabled');
  await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '模板灵感', exact: true }).click();
  await page.getByRole('button', { name: /^预览模板 / }).first().click();
  await page.getByRole('button', { name: '使用这个模板' }).click();
  await page.getByLabel('当前创作名称').waitFor();
  await page.waitForURL('**/#studio/*');
  const projectId = page.url().split('#studio/')[1];
  assert.ok(projectId);
  const original = await api(`/projects/${projectId}/studio`);
  assert.equal(original.snapshot.results.length, 1);
  const doc = original.snapshot.results[0];
  await check('template creates real project in unified Studio');
  // A local autosave is acknowledged by its PUT. Its SSE event must not fan
  // out into unrelated capability, asset, session and activity reads.
  await page.waitForTimeout(1200);
  const unrelatedReads = [];
  const observeReads = request => {
    if (request.method() === 'GET' && /\/api\/(?:capabilities|assets|projects\/[^/]+\/(?:activities|agent-session|ai-turns))(?:\?|$)/.test(request.url())) unrelatedReads.push(request.url());
  };
  page.on('request', observeReads);
  const autosave = page.waitForResponse(response => response.request().method() === 'PUT' && response.url().includes(`/projects/${projectId}/studio`) && response.ok());
  await page.getByLabel('告诉 AI 你的设计需求').fill('待继续的设计草稿');
  await autosave;
  await page.waitForTimeout(1200);
  page.off('request', observeReads);
  assert.deepEqual(unrelatedReads, [], 'Board autosave must not refetch the entire workspace through SSE');
  assert.equal((await api(`/projects/${projectId}/studio`)).snapshot.draft, '待继续的设计草稿');
  const clearDraft = page.waitForResponse(response => response.request().method() === 'PUT' && response.url().includes(`/projects/${projectId}/studio`) && response.ok());
  await page.getByLabel('告诉 AI 你的设计需求').fill('');
  await clearDraft;
  await check('Board autosave persists drafts without unrelated SSE refreshes');
  await page.getByLabel('关闭侧边面板').click();
  await page.getByRole('button', { name: /^选中方案 1 / }).click();
  await page.getByRole('button', { name: '编辑与导出', exact: true }).click();
  await page.getByLabel('作品名称', { exact: true }).waitFor();
  await page.getByLabel('作品名称', { exact: true }).fill('保存成功而列表失联');
  let readFailures = 0;
  await page.route(/\/api\/projects$/, route => {
    if (route.request().method() === 'GET') { readFailures++; return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: 'Injected list read outage' }) }); }
    return route.continue();
  });
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.locator('.ed-save-state').filter({ hasText: '已保存' }).waitFor();
  assert.ok(readFailures >= 1);
  const first = await api(`/documents/${doc.documentId || doc.id}`);
  await page.getByLabel('作品名称', { exact: true }).fill('继续保存使用新版本');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.locator('.ed-save-state').filter({ hasText: '已保存' }).waitFor();
  const second = await api(`/documents/${doc.documentId || doc.id}`);
  assert.equal(second.revision, first.revision + 1);
  await page.unroute(/\/api\/projects$/);
  await check('accepted save keeps new revision across project-list failure');
  await page.getByRole('button', { name: '返回工作区', exact: true }).click();
  await page.getByLabel('当前创作名称').waitFor();
  await page.getByLabel('快捷选择技能').click();
  await page.locator('.st-quick-skills').getByRole('button', { name: /多尺寸适配/ }).click();
  await page.getByLabel('多尺寸适配原画板').selectOption(doc.documentId || doc.id);
  await page.getByLabel('目标尺寸').fill('400x600,600x600');
  await page.getByLabel('发送设计需求').click();
  await page.waitForFunction(async id => (await (await fetch(`/api/projects/${id}/studio`)).json()).snapshot.results.length === 3, projectId, { polling: 500 });
  await page.getByRole('button', { name: /^选中方案 3 / }).waitFor();
  await check('multi-size Recipe creates independent editable Artboards');
  await page.getByLabel('创作记录').click();
  await page.getByRole('region', { name: '项目活动' }).waitFor();
  assert.ok(await page.locator('.st-project-activity article').count() > 0);
  await check('project activity reads actual document and Recipe records');
  await page.screenshot({ path: new URL('studio.png', output).pathname, fullPage: true });
  await page.getByLabel('关闭侧边面板').click();
  await page.locator('.st-back').click();
  await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '资产库', exact: true }).click();
  await page.getByRole('button', { name: /^预览 / }).first().click();
  const before = await api('/projects');
  await page.getByRole('button', { name: '用于新设计' }).click();
  await page.getByLabel('当前创作名称').waitFor();
  await page.waitForURL('**/#studio/*');
  const assetProjectId = page.url().split('#studio/')[1];
  assert.ok(assetProjectId && !assetProjectId.startsWith('asset-design-'));
  assert.equal((await api('/projects')).length, before.length + 1);
  assert.ok((await api(`/projects/${assetProjectId}/studio`)).snapshot);
  await check('asset use creates a durable project instead of a fabricated ID');
  // Seed a persisted awaiting-input execution without dispatching an Agent.
  // The browser answers through the real control API and verifies the DB command.
  const session = await api(`/projects/${assetProjectId}/agent-session`);
  const turnId = randomUUID(), attemptId = randomUUID(), interactionId = randomUUID();
  await tenantTransaction(identity.workspace.id, async tx => {
    await tx.query("INSERT INTO jobs(id,workspace_id,project_id,kind,status,payload,execution_token,queue_id) VALUES($1,$2,$3,'ai.turn','running','{}',$4,$5)", [turnId, identity.workspace.id, assetProjectId, attemptId, randomUUID()]);
    await tx.query("INSERT INTO ai_turns(id,workspace_id,project_id,session_id,request,context,stage) VALUES($1,$2,$3,$4,$5,'{}','awaiting_input')", [turnId, identity.workspace.id, assetProjectId, session.session.id, JSON.stringify(nativeQuestionRequest)]);
    await tx.query("INSERT INTO ai_attempts(id,workspace_id,turn_id,queue_id,deadline_at) VALUES($1,$2,$3,$4,now()+interval '10 minutes')", [attemptId,identity.workspace.id,turnId,randomUUID()]);
    await tx.query("INSERT INTO agent_interactions(id,workspace_id,session_id,turn_id,attempt_id,native_request_id,questions) VALUES($1,$2,$3,$4,$5,'1',$6)", [interactionId,identity.workspace.id,session.session.id,turnId,attemptId,JSON.stringify(nativeQuestions)]);
  });
  nativeQuestionFixture = { workspaceId: identity.workspace.id, turnId, attemptId, interactionId, sessionId: session.session.id };
  await page.reload();
  await page.getByLabel('选择主色 自定义回答').waitFor();
  await page.getByLabel('选择主色 自定义回答').fill('暖橙色');
  await page.getByRole('button', { name: '提交回答并继续' }).click();
  await page.getByRole('button', { name: '回答已记录，等待继续' }).waitFor();
  assert.equal(await page.getByRole('button', { name: '回答已记录，等待继续' }).isDisabled(), true);
  const commandState = await api(`/projects/${assetProjectId}/agent-session`);
  assert.equal(commandState.commands.filter(item => item.type === 'answer').length, 1);
  await page.reload();
  await page.getByRole('button', { name: '回答已记录，等待继续' }).waitFor();
  await page.getByRole('button', { name: '停止本次创作' }).click();
  await page.waitForFunction(async id => (await (await fetch(`/api/projects/${id}/agent-session`)).json()).interactions.every(item => item.status !== 'pending'), assetProjectId, { polling: 500 });
  await check('persisted native question, deduplicated answer and stop survive reload');
  const generated = await ingestBufferAsset(identity.workspace.id, { bytes: await readFile(new URL('../../public/assets/coffee.jpg', import.meta.url)), mime: 'image/jpeg', title: '验收图片资产', source: { kind: 'test-fixture' }, projectId: assetProjectId, attemptId: randomUUID() });
  const generationId=randomUUID(), generationAttempt=randomUUID(), outputId=randomUUID();
  const snapshot={prompt:'图片资产与画板类型验收',count:1,size:'1024x1536',quality:'medium',model:'browser-test-fixture',references:[],placement:'board'};
  await tenantTransaction(identity.workspace.id, async tx => {
    await tx.query("INSERT INTO creative_requests(id,workspace_id,project_id,snapshot,execution_status,asset_status,settlement_status) VALUES($1,$2,$3,$4,'succeeded','ready','settled')", [generationId,identity.workspace.id,assetProjectId,JSON.stringify(snapshot)]);
    await tx.query("INSERT INTO jobs(id,workspace_id,project_id,kind,status,payload) VALUES($1,$2,$3,'generation.submit','succeeded','{}')",[generationAttempt,identity.workspace.id,assetProjectId]);
    await tx.query("INSERT INTO generation_attempts(id,workspace_id,request_id,ordinal,execution_status) VALUES($1,$2,$3,0,'succeeded')",[generationAttempt,identity.workspace.id,generationId]);
    await tx.query("INSERT INTO generation_outputs(id,workspace_id,request_id,attempt_id,asset_id,asset_version_id,state) VALUES($1,$2,$3,$4,$5,$6,'ready')",[outputId,identity.workspace.id,generationId,generationAttempt,generated.assetId,generated.assetVersionId]);
    await placeGenerationOutput(tx,identity.workspace.id,{snapshot,project_id:assetProjectId,request_id:generationId,ordinal:0},{id:outputId},generated);
  });
  await page.evaluate(() => window.dispatchEvent(new Event('designx:refresh')));
  await page.locator(`[data-generation="${generationId}"]`).waitFor();
  if(await page.getByLabel('关闭侧边面板').count()) await page.getByLabel('关闭侧边面板').click();
  await page.locator(`[data-board-id="image-${outputId}"]`).getByRole('button',{name:/^选中方案 /}).click();
  assert.equal(await page.getByRole('button',{name:'编辑与导出',exact:true}).isDisabled(),true);
  await page.locator('.st-result-inspector').getByRole('button',{name:'参考图编辑',exact:true}).click();
  assert.equal(await page.locator('.st-mode-button').innerText(), '图片生成');
  assert.ok((await page.locator('.st-attachments img').getAttribute('src')).includes(generated.assetVersionId));
  await page.locator(`[data-board-id="image-${outputId}"]`).getByRole('button',{name:/^选中方案 /}).click();
  await page.locator('.st-result-inspector').getByRole('button',{name:'加入可编辑画板',exact:true}).click();
  await page.waitForFunction(async id => (await (await fetch(`/api/projects/${id}/studio`)).json()).snapshot.results.some(item => item.kind !== 'image'),assetProjectId,{ polling: 500 });
  await check('immutable image asset is distinct from Artboard and converts explicitly');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: new URL('mobile.png', output).pathname, fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1), false);
  await check('mobile workspace has no horizontal overflow');
  assert.deepEqual(errors, []);
} catch (error) {
  await page.screenshot({ path: new URL('failure.png', output).pathname, fullPage: true });
  await writeFile(new URL('failure.txt', output), await page.locator('body').innerText());
  throw error;
} finally {
  let fixtureCleanup;
  try {
    if (nativeQuestionFixture) fixtureCleanup = await cleanupNativeQuestionFixture(nativeQuestionFixture);
  } finally {
    try {
      await writeFile(new URL('report.json', output), JSON.stringify({ checks, pageErrors: errors, fixtures: ['forced project-list HTTP 503','DB awaiting-input execution','DB image generation using a local sample, no provider call'], liveAiRequests: false, fixtureCleanup }, null, 2));
    } finally {
      await Promise.all([browser.close(), pool.end()]);
    }
  }
}
