import assert from 'node:assert/strict';
import { encodeStudioSession, decodeStudioSession } from '../src/lib/studioSession.js';

const image = 'data:image/jpeg;base64,' + 'A'.repeat(180_000);
const otherImage = 'data:image/png;base64,' + 'B'.repeat(70_000);
const asset = { id: 'upload-1', name: '我的素材.jpg', url: image };
const session = {
  id: 'studio-session-test', title: '秋日咖啡', draft: '继续调整', skill: { name: '商品套图' },
  assets: [asset], attached: [asset], mode: 'Agent', ratio: '自动', count: '自动',
  messages: [{ role: 'user', text: '请按参考图设计', assets: [asset] }, { role: 'assistant', context: { brief: { image, assets: [asset] } } }],
  results: Array.from({ length: 6 }, (_, index) => ({ id: `result-${index}`, image, design: { nodes: [{ type: 'image', src: image }, { type: 'image', src: otherImage }] }, brief: { assets: [asset] } })),
  selected: 'result-2', view: { x: 1, y: -3, zoom: .8 },
  // User-defined keys and literal nulls must remain unchanged by the envelope.
  custom: { __designxImageRef: 0, snapshot: null, references: [], '': image, nullValue: null },
};
const before = JSON.stringify(session);
const encoded = encodeStudioSession(session);
assert.deepEqual(decodeStudioSession(encoded), JSON.parse(before), 'All session data must round-trip');
assert.equal(JSON.stringify(session), before, 'Encoding must not mutate shared objects or assets');
assert(encoded.length < before.length / 8, 'Repeated images should occupy one resource-table entry');
assert.equal(JSON.parse(encoded).images.length, 2, 'Identical image values are deduplicated, including separate objects');
assert.deepEqual(decodeStudioSession(before), JSON.parse(before), 'Legacy sessions stay readable');
assert.deepEqual(decodeStudioSession(encodeStudioSession({ id: 'text', draft: '你好', assets: [], results: [] })), { id: 'text', draft: '你好', assets: [], results: [] });

for (const raw of [undefined, null, '', '{', 'null', '[]', '"text"', '23', 'true']) assert.equal(decodeStudioSession(raw), null);
for (const value of [null, [], 'text', 42]) assert.throws(() => encodeStudioSession(value), TypeError);
const circular = {}; circular.self = circular;
assert.throws(() => encodeStudioSession(circular), TypeError, 'Storage errors remain visible to the caller');

function corrupt(mutator) { const value = JSON.parse(encoded); mutator(value); assert.equal(decodeStudioSession(JSON.stringify(value)), null); }
corrupt(value => { value.version = 999; });
corrupt(value => { value.images[0] = 'https://example.com/not-an-inline-image'; });
corrupt(value => { value.references[0].image = -1; });
corrupt(value => { value.references[0].image = 2; });
corrupt(value => { value.references[0].path = ['not-present']; });
corrupt(value => { value.references[0].path = ['title']; });
corrupt(value => { value.references[0].path = []; });
corrupt(value => { value.references.push(value.references[0]); });
corrupt(value => { value.references[0].path = ['__proto__', 'polluted']; });
assert.equal({}.polluted, undefined);

const unusual = JSON.parse('{"id":"unusual","__proto__":{"url":null},"constructor":{"url":null}}');
unusual.__proto__.url = image;
unusual.constructor.url = image;
assert.deepEqual(decodeStudioSession(encodeStudioSession(unusual)), unusual, 'Own unusual keys must remain data');
assert.equal({}.url, undefined);

console.log(`Studio session checks passed: round-trip, image deduplication (${Math.round(encoded.length / before.length * 100)}% of plain JSON), legacy compatibility, immutable inputs, and corrupt storage rejection.`);
