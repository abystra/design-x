import test from 'node:test';
import assert from 'node:assert/strict';
import { parseJournal, shellQuote } from '../../packages/ai-runtime/src/protocol.js';
const session={id:'s1',projectId:'p1',attemptId:'a1',fence:7,deadline:Date.now()+60000};
test('Runner journal requires continuous committed cursor and matching fence',()=>{
 const event={version:2,attemptId:'a1',fence:7,sequence:2,type:'tool.completed',payload:{}};
 assert.equal(parseJournal(JSON.stringify({events:[event],cursor:2}),session,1).cursor,2);
 for(const patch of [{fence:6},{attemptId:'old'},{sequence:3}])assert.throws(()=>parseJournal(JSON.stringify({events:[{...event,...patch}],cursor:2}),session,1));
 assert.throws(()=>parseJournal(JSON.stringify({events:[event],cursor:3}),session,1));
});
test('Runner shell arguments do not interpolate tool or asset data',()=>{
 assert.equal(shellQuote("it's $(touch /tmp/x)"),"'it'\"'\"'s $(touch /tmp/x)'");
});
