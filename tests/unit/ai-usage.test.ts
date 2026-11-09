import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {beginNativeUsage, nativeUsageTotal, safeTokenUsage, updateNativeUsage} from '../../packages/ai-runtime/src/usage.js';

const captured = JSON.parse(readFileSync(new URL('../fixtures/codex-0.166-token-usage.json', import.meta.url), 'utf8'));
test('real Codex snapshots retain all observed usage once, excluding context capacity and last-request duplication', () => {
  let usage = beginNativeUsage('real-thread', false, null);
  for (const event of captured.events) {
    usage = updateNativeUsage(usage, event.usage, event.sequence);
    usage = updateNativeUsage(usage, event.usage, event.sequence);
  }
  assert.deepEqual({...usage, native: undefined}, {input_tokens:102099,output_tokens:2819,cached_input_tokens:93440,cache_write_input_tokens:0,reasoning_output_tokens:619,total_tokens:104918,native:undefined});
  assert.equal(usage.native.status,'known');
  assert.equal(usage.native.sequence,23);
  assert.equal(updateNativeUsage(usage,captured.events[0].usage,captured.events[0].sequence),usage);
});

test('resumed thread usage subtracts a persisted baseline and survives serialized observer recovery', () => {
  const prior = nativeUsageTotal(captured.events[0].usage)!;
  let usage = beginNativeUsage('same-thread',true,prior);
  usage = updateNativeUsage(usage,captured.events[0].usage,2); // Replayed resume notification is zero new tokens.
  assert.equal(usage.input_tokens,0);
  usage = JSON.parse(JSON.stringify(usage));
  usage = updateNativeUsage(usage,captured.events[1].usage,3);
  assert.equal(usage.input_tokens,8260);assert.equal(usage.output_tokens,297);assert.equal(usage.total_tokens,8557);
  assert.deepEqual(usage.native.baseline,prior);
});

test('unknown or incomplete counters never become invented zero usage', () => {
  const missing = updateNativeUsage(beginNativeUsage('untracked-resume',true,null),captured.events[0].usage,1);
  assert.equal(missing.native.status,'unknown');assert.equal(missing.input_tokens,undefined);
  const partial = updateNativeUsage(beginNativeUsage('fresh',false,null),{total:{inputTokens:19}},1);
  assert.equal(partial.input_tokens,19);assert.equal(partial.output_tokens,undefined);assert.equal(partial.native.status,'partial');
  const reset = updateNativeUsage(beginNativeUsage('reset',true,{input_tokens:100,output_tokens:30}),{total:{inputTokens:10,outputTokens:3}},1);
  assert.equal(reset.native.status,'unknown');assert.equal(reset.input_tokens,undefined);
  assert.equal(nativeUsageTotal({last:{inputTokens:10}}),null);
});

test('legacy SDK token counters remain compatible and untrusted fields are excluded', () => {
  assert.deepEqual(safeTokenUsage({input_tokens:12,output_tokens:3,cached_input_tokens:0,request_id:21,modelContextWindow:90000,model:'secret',cost:8}),{input_tokens:12,output_tokens:3,cached_input_tokens:0});
  for(const invalid of [-1,NaN,Infinity,1.5,Number.MAX_SAFE_INTEGER+1,'12',null])assert.deepEqual(safeTokenUsage({inputTokens:invalid}),{});
});
