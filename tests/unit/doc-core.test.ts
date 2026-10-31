import test from 'node:test';
import assert from 'node:assert/strict';
import { ArtboardSchema, applyOps, assetIds, diffDesign, resizeArtboard, type Artboard, type DesignNode } from '../../packages/doc-core/src/index.js';

const node = (id: string, patch: Partial<DesignNode> = {}): DesignNode => ({
  id, type: 'rect', x: 12, y: 18, w: 80, h: 40, color: '#decabe', ...patch,
});
const poster = (): Artboard => ({
  width: 400, height: 600, background: '#ffffff',
  nodes: [node('photo', {type: 'image', src: '/api/assets/asset-1/file'}), node('title', {type: 'text', text: '秋日咖啡', size: 24}), node('badge')],
});

test('an edit batch and reverse diff restore content, canvas and layer order without mutating input', () => {
  const before = poster();
  const original = structuredClone(before);
  const after: Artboard = {...before, width: 800, background: '#fff0d0', nodes: [node('new-shape'), {...before.nodes[1], text: '保存后重新打开', x: -20}, before.nodes[0]]};
  const edited = applyOps(before, diffDesign(before, after));
  assert.deepEqual(edited, after);
  assert.deepEqual(applyOps(edited, diffDesign(edited, before)), before);
  assert.deepEqual(before, original, 'diff/apply must not mutate the source document');
  edited.nodes[0].x = 90;
  assert.equal(after.nodes[0].x, 12, 'op payload must not remain aliased to returned document');
});

test('diff is empty for unchanged content and supports deleting every layer', () => {
  const source = poster();
  assert.deepEqual(diffDesign(source, structuredClone(source)), []);
  const empty = {...source, nodes: []};
  assert.deepEqual(applyOps(source, diffDesign(source, empty)), empty);
  assert.deepEqual(applyOps(empty, diffDesign(empty, source)), source);
});

test('deterministic edit histories round-trip insertions, deletions, reorders and property changes', () => {
  let state = poster();
  let seed = 0xdeface;
  const random = () => {seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 0x100000000;};
  for (let step = 0; step < 120; step++) {
    const next = structuredClone(state);
    if (next.nodes.length && random() < 0.4) next.nodes.splice(Math.floor(random() * next.nodes.length), 1);
    if (random() < 0.7) next.nodes.splice(Math.floor(random() * (next.nodes.length + 1)), 0, node(`insert-${step}`, {x: step, y: -step}));
    if (next.nodes.length) next.nodes[Math.floor(random() * next.nodes.length)].opacity = Math.round(random() * 100) / 100;
    if (random() < 0.5) next.nodes.reverse();
    next.width = 400 + step;
    assert.deepEqual(applyOps(state, diffDesign(state, next)), next, `forward round-trip at step ${step}`);
    assert.deepEqual(applyOps(next, diffDesign(next, state)), state, `reverse round-trip at step ${step}`);
    state = next;
  }
});

test('layer IDs remain unique and invalid reorder requests cannot lose or duplicate a layer', () => {
  const source = poster();
  assert.equal(ArtboardSchema.safeParse({...source, nodes: [source.nodes[0], source.nodes[0]]}).success, false);
  const replaced = applyOps(source, [{type: 'put', node: {...source.nodes[0], x: 100}, index: 2}]);
  assert.equal(replaced.nodes.length, source.nodes.length);
  assert.equal(replaced.nodes.filter(n => n.id === 'photo').length, 1);
  assert.equal(replaced.nodes[2].x, 100);
  for (const ids of [['photo', 'photo', 'badge'], ['photo', 'title'], ['photo', 'title', 'missing']]) {
    assert.throws(() => applyOps(source, [{type: 'order', ids}]));
  }
  assert.deepEqual(source, poster());
});

test('resize scales positions and boxes per axis, scales text by smaller axis, and rejects invalid bounds', () => {
  const source = poster();
  const resized = resizeArtboard(source, 800, 300);
  assert.equal(resized.width, 800);
  assert.equal(resized.height, 300);
  assert.deepEqual(resized.nodes.map(n => [n.x, n.y, n.w, n.h]), source.nodes.map(n => [n.x * 2, n.y / 2, n.w * 2, n.h / 2]));
  assert.equal(resized.nodes[1].size, 12);
  assert.deepEqual(resizeArtboard(source, 400, 600), source);
  for (const width of [0, -10, 8193, Infinity, 12.5]) assert.throws(() => resizeArtboard(source, width, 600));
  assert.deepEqual(source, poster(), 'invalid resizing cannot corrupt the source');
});

test('asset references are deduplicated and exclude unrelated URL paths', () => {
  const source: Artboard = {...poster(), nodes: [
    node('a', {type: 'image', src: '/api/assets/asset-1/file'}),
    node('b', {type: 'image', src: '/api/assets/asset-1/thumbnail?v=2'}),
    node('c', {type: 'image', src: '/api/assets/asset-2/file?download=1'}),
    node('external', {type: 'image', src: 'https://example.test/api/assets/private/file'}),
    node('stock', {type: 'image', src: '/samples/coffee.jpg'}),
    node('data', {type: 'image', src: 'data:image/png;base64,abcd'}),
  ]};
  assert.deepEqual(assetIds(source), ['asset-1', 'asset-2']);
  assert.deepEqual(assetIds({...source, nodes: []}), []);
});

test('asset reference endpoints must have an exact file or thumbnail path segment', () => {
  assert.deepEqual(assetIds({...poster(), nodes: [
    node('suffix', {type: 'image', src: '/api/assets/not-an-asset/file-spoof'}),
    node('nested', {type: 'image', src: '/api/assets/not-an-asset/thumbnail/extra'}),
  ]}), []);
});
