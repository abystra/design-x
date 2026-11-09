// Opt-in cloud acceptance: fixed template + real native Codex turn, no database writes.
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
const metadata = JSON.parse(await readFile('infra/e2b/dist/build.json', 'utf8'));
process.env.DESIGNX_E2B_TEMPLATE = metadata.pinnedTemplate;
const { runAppServerTurn, killSandbox, pauseSandbox } = await import('../../packages/ai-runtime/src/index.js');
const started = Date.now();
const records: any[] = [];
let sandboxId: string | undefined;
let threadId: string | undefined;
let toolBridgeCalls = 0;
const sessionId = randomUUID();
try {
  for (let round = 0; round < 2; round++) {
    const attemptId = randomUUID();
    const input = { executionKey: attemptId,
      session: { id: sessionId, projectId: 'cloud-acceptance', attemptId, fence: round + 1, deadline: Date.now() + 300000, sandboxId, threadId },
      context: { count: 1, assets: [], referenceArtboards: [], builtinSources: [], messages: records.map(r => ({ role: 'assistant', content: { text: r.summary } })) },
      tools: [{name:'assets.list',description:'列出当前项目素材',inputSchema:{type:'object',properties:{},additionalProperties:false}}],
      onTool: async () => { toolBridgeCalls++; return {success:true,result:{assets:[]}}; },
      prompt: round === 0 ? '先实际调用 assets_list 工具查看项目素材，然后创建一个400×400画板，白色背景，只有一个可编辑文字图层，写“Design X 云端验收”。无需图片。写 artifact.json 并调用验证器。' : '延续前轮，文字改为“Design X 第二轮”，仍然只有一个可编辑文字图层。必须写本轮当前目录 artifact.json 并验证。',
      onSandbox: async (id:string) => { sandboxId = id; },
      onRuntimeEvent: async (event:any) => { console.log(JSON.stringify({ round, type: event.type, sequence: event.sequence, ...(event.type === 'run.failed' ? { payload: event.payload } : {}) })); },
    };
    let output;
    if (round === 0) {
      let owns = true;
      try {
        await runAppServerTurn({ ...input, ownsRuntime: async () => owns, onRuntimeEvent: async event => {
          await input.onRuntimeEvent(event);
          if (event.type === 'turn.started') { owns = false; throw new Error('Acceptance: observer connection deliberately detached'); }
        }});
        throw new Error('Observer detachment was not exercised');
      } catch (error) { if (owns) throw error; }
      output = await runAppServerTurn({ ...input, session: { ...input.session, sandboxId, resumeAttempt: true, cursor: 0 } });
    } else output = await runAppServerTurn(input);
    threadId = output.runtime.threadId;
    records.push({ round, sandboxId, threadId, summary: output.manifest.summary, artboardCount: output.manifest.artboards.length, textNodes: output.manifest.artboards[0].design.nodes.filter((node:any) => node.type === 'text').length });
    await pauseSandbox(sandboxId!);
  }
  if (records[0].sandboxId !== records[1].sandboxId || records[0].threadId !== records[1].threadId) throw new Error('Native session continuation was not preserved');
  const stop = new AbortController(); let questionObserved = false;
  const questionStarted = Date.now();
  try {
    const attemptId = randomUUID();
    await runAppServerTurn({ executionKey: attemptId, session: {id:sessionId,projectId:'cloud-acceptance',attemptId,fence:3,deadline:Date.now()+90000,sandboxId,threadId},
      context:{count:1,assets:[],referenceArtboards:[]}, signal:stop.signal,
      prompt:'先调用原生 request_user_input 工具询问我选择海报主色（红色或蓝色），在收到我的答复之前不要写文件。必须真实调用提问工具，不要在普通聊天里列出问题。',
      onRuntimeEvent:async event=>{console.log(JSON.stringify({round:2,type:event.type,sequence:event.sequence,...(event.type==='run.failed'?{payload:event.payload}:{})}));if(event.type==='interaction.requested'){questionObserved=true;stop.abort(new Error('Acceptance: stop during native question'));}},
    });
    throw new Error('Question stop unexpectedly completed');
  } catch (error) { if(!questionObserved) throw error; }
  if (toolBridgeCalls < 1) throw new Error('Native business tool bridge was not exercised');
  const result = { passed: true, template: metadata.pinnedTemplate, codexVersion: '0.166.0', elapsedMs: Date.now() - started,
    observerReconnect:true, toolBridgeCalls, questionStop:{passed:questionObserved,elapsedMs:Date.now()-questionStarted}, records, verifiedAt: new Date().toISOString() };
  await writeFile('infra/e2b/dist/acceptance.json', JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ passed: true, rounds: records.length, elapsedMs: result.elapsedMs }));
} finally { if (sandboxId) await killSandbox(sandboxId); }
