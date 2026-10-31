import assert from 'node:assert/strict';
import test from 'node:test';
import { boardShapes, fromCamera, fromShapeId, readOrganization, toCamera, toShapeId } from '../../src/components/board/tldraw-adapter.js';

test('legacy camera and SDK page-space camera round-trip at every supported zoom', () => {
  for (const zoom of [0.2, 0.75, 1, 2]) {
    const view = { x: -315.25, y: 123.5, zoom };
    assert.deepEqual(fromCamera(toCamera(view)), view);
    const camera = toCamera(view), point = { x: 1300, y: -80 };
    assert.equal((point.x + camera.x) * camera.z, point.x * zoom + view.x);
  }
});

test('SDK IDs do not enter Board IDs or section membership', () => {
  assert.equal(fromShapeId(toShapeId('dx-a_1')), 'dx-a_1');
  const board = {
    results: [{ id: 'art-1', title: '画板', position: { x: 40, y: 60 }, design: { width: 400, height: 300, nodes: [{ id: 'node', text: '精修内容' }] } }],
    notes: [{ id: 'note-1', text: '中文\n便签', position: { x: 0, y: 0 }, width: 240, height: 200, color: '#FFF0B5' }],
    sections: [{ id: 'section-1', title: '分区', position: { x: -30, y: -30 }, width: 560, height: 420, color: '#CBD8BE', itemIds: ['art-1', 'note-1'] }],
  };
  const shapes = boardShapes(board);
  assert.deepEqual(shapes.map(s => s.type), ['dx-section', 'dx-note', 'dx-artboard']);
  assert(!JSON.stringify(shapes).includes('精修内容'), 'Document bodies must not be copied into SDK records/history');
  const map = new Map(shapes.map(s => [s.id, s]));
  const editor = { getShape: (id: string) => map.get(id) };
  assert.deepEqual(readOrganization(editor, board), board);
  const note = map.get('shape:note-1')!;
  note.x = 180;
  const result = readOrganization(editor, board);
  assert.equal(result.notes[0].position.x, 180);
  assert.strictEqual(result.results[0].design, board.results[0].design);
  assert.deepEqual(result.sections[0].itemIds, ['art-1', 'note-1']);
});
