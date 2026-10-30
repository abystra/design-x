import assert from 'node:assert/strict';
import { buildBrief, buildStudioResults, resolveStudioBrief } from '../src/lib/studioModel.js';

const asset = 'data:image/png;base64,USER_REFERENCE';
const brief = buildBrief({ prompt: '帮我做四张暖色咖啡海报，发布小红书', assets: [{ id: 'upload', name: '自己的咖啡.png', url: asset }] });
assert.equal(brief.count, 4);
assert.equal(brief.ratio, '3:4');
assert.equal(brief.theme, 'coffee');
assert.equal(brief.platform, '小红书');
assert.equal(brief.image, asset, 'Uploaded material must take priority over the local demo photograph.');
assert.equal(brief.source, 'demo-rules');
assert.match(brief.assumptions.join(''), /未调用 AI/);

const frozen = JSON.stringify(brief);
const results = buildStudioResults(brief);
assert.equal(results.length, 4);
assert.equal(results[0].design.width, 600);
assert.equal(results[0].design.height, 800);
assert(results.every(result => result.image === asset && result.design.nodes.some(node => node.type === 'image' && node.src === asset)));
assert.deepEqual(buildStudioResults(brief), results, 'The demo model must be deterministic.');
assert.equal(JSON.stringify(brief), frozen, 'Generating layouts must not mutate the brief.');
assert.equal(new Set(results.map(result => result.id)).size, 4);

const revised = buildStudioResults(buildBrief({ prompt: '无关的新默认草稿' }), { previous: results, revision: '改成深色，做两张 16:9 横版，标题改为“秋日来信”' });
assert.equal(revised.length, 2);
assert.equal(revised[0].version, 2);
assert.equal(revised[0].brief.theme, 'coffee', 'A revision must inherit the existing subject.');
assert.equal(revised[0].image, asset, 'A revision must retain the user-provided material.');
assert.equal(revised[0].brief.paletteKey, 'dark');
assert.equal(revised[0].design.width, 960);
assert.equal(revised[0].design.height, 540);
assert.equal(revised[0].design.nodes.find(node => node.id === 'title').text, '秋日来信');
assert.notEqual(revised[0].id, results[0].id, 'Revisions need distinct project IDs so prior versions survive.');
assert.equal(JSON.stringify(brief), frozen);
assert.equal(results[0].brief.paletteKey, 'warm', 'Revising must not mutate previous results.');

const continued = buildStudioResults(brief, { previous: revised[0], revision: '副标题改为“把时间留给自己”' });
assert.equal(continued[0].brief.paletteKey, 'dark');
assert.equal(continued[0].brief.ratio, '16:9');
assert.equal(continued[0].version, 3);
assert.equal(continued[0].brief.subtitle, '把时间留给自己');
assert.equal(continued[0].brief.headline, '秋日来信', 'Changing a subtitle must not also replace the headline.');

for (const [prompt, theme, image] of [['补水护肤海报', 'skincare', 'skincare'], ['春日服饰穿搭', 'fashion', 'fashion'], ['客厅家居上新', 'interior', 'interior'], ['数码耳机海报', 'digital', 'headphones'], ['户外自然旅行', 'nature', 'nature']]) {
  const inferred = buildBrief({ prompt });
  assert.equal(inferred.theme, theme);
  assert.equal(inferred.image, `/assets/${image}.jpg`);
}
for (const [ratio, width, height] of [['3:4', 600, 800], ['1:1', 600, 600], ['16:9', 960, 540], ['9:16', 540, 960]]) {
  const [result] = buildStudioResults(buildBrief({ prompt: '咖啡海报', ratio, count: 1 }));
  assert.deepEqual([result.design.width, result.design.height], [width, height]);
  assert(result.design.nodes.every(node => Number.isFinite(node.x) && Number.isFinite(node.y) && node.w > 0 && node.h > 0));
  assert(result.design.nodes.every(node => ['text', 'image', 'circle'].includes(node.type)));
  assert.equal(new Set(result.design.nodes.map(node => node.id)).size, result.design.nodes.length);
}
assert.equal(buildBrief({ prompt: '做20张咖啡海报' }).count, 6);
assert.equal(buildBrief({ prompt: '用一张商品图制作四张海报' }).count, 4);
assert.equal(buildBrief({ count: -1 }).count, 1);
assert.equal(buildBrief({ prompt: '做六张横版', count: 2, ratio: '1:1' }).count, 2);
assert.equal(buildBrief({ prompt: '做六张横版', count: 2, ratio: '1:1' }).ratio, '1:1');
const multipleAssets = buildStudioResults(buildBrief({ assets: [{ src: '/assets/fashion.jpg' }, { url: '/assets/interior.jpg' }], count: 3 }));
assert.deepEqual(multipleAssets.map(result => result.image), ['/assets/fashion.jpg', '/assets/interior.jpg', '/assets/fashion.jpg']);
assert.equal(buildBrief({ assets: [{ url: 'javascript:bad' }] }).assets.length, 0);

// The UI sends a fresh brief for each turn; explicit controls must override inherited defaults.
const newAsset = 'data:image/png;base64,NEW_REFERENCE';
const turnBrief = { ...buildBrief({ prompt: '换成蓝色', ratio: '1:1', count: 2, assets: [{ url: newAsset }] }), sessionId: 'session-a', turn: 2 };
const controlsRevision = buildStudioResults(turnBrief, { previous: results[0], revision: turnBrief.prompt });
assert.equal(controlsRevision.length, 2);
assert.equal(controlsRevision[0].ratio, '1:1');
assert.equal(controlsRevision[0].image, newAsset);
assert.equal(controlsRevision[0].design.nodes.find(node => node.id === 'photo').src, newAsset);
assert.equal(controlsRevision[0].brief.theme, 'coffee');
assert.match(resolveStudioBrief(turnBrief, { previous: results[0], revision: turnBrief.prompt }).summary, /2 张 1:1/);
const subsequentTurn = buildStudioResults({ ...turnBrief, turn: 4 }, { previous: results[0], revision: turnBrief.prompt });
assert.notEqual(subsequentTurn[0].id, controlsRevision[0].id, 'Repeating the same edit in another conversation turn must not create duplicate IDs.');
const otherSession = buildStudioResults({ ...turnBrief, sessionId: 'session-b' }, { previous: results[0], revision: turnBrief.prompt });
assert.notEqual(otherSession[0].id, controlsRevision[0].id);
const autoRevision = buildStudioResults(buildBrief({ prompt: '标题更简洁' }), { previous: controlsRevision[0], revision: '标题更简洁' });
assert.equal(autoRevision.length, 2, 'Automatic count must inherit the referenced result.');
assert.equal(autoRevision[0].ratio, '1:1');
assert.equal(autoRevision[0].image, newAsset);

// A manually edited canvas, including extra layers and positions, is the revision baseline.
const manual = JSON.parse(JSON.stringify(results[0]));
manual.design.nodes.find(node => node.id === 'title').text = '手动改好的标题';
manual.design.nodes.find(node => node.id === 'subtitle').text = '保留这段副文案';
manual.design.nodes.find(node => node.id === 'photo').src = '/assets/fashion.jpg';
manual.design.nodes.find(node => node.id === 'title').x = 57;
manual.design.nodes.push({ id: 'custom-label', type: 'text', text: '手工补充', x: 20, y: 400, w: 150, h: 30, size: 20, color: '#333333' });
manual.design.nodes = manual.design.nodes.filter(node => node.id !== 'badge');
const manualSnapshot = JSON.stringify(manual);
const manualRevision = buildStudioResults(buildBrief({ prompt: '背景换成蓝色' }), { previous: manual, revision: '背景换成蓝色' })[0];
assert.equal(manualRevision.image, '/assets/fashion.jpg');
assert.equal(manualRevision.design.nodes.find(node => node.id === 'title').text, '手动改好的标题');
assert.equal(manualRevision.design.nodes.find(node => node.id === 'title').x, 57);
assert.equal(manualRevision.design.nodes.find(node => node.id === 'subtitle').text, '保留这段副文案');
assert.equal(manualRevision.design.nodes.find(node => node.id === 'custom-label').text, '手工补充');
assert(!manualRevision.design.nodes.some(node => node.id === 'badge'), 'Removed decorations must not reappear during a color revision.');
assert.equal(JSON.stringify(manual), manualSnapshot);
const resolvedOnce = resolveStudioBrief(buildBrief({ prompt: '背景换成蓝色' }), { previous: manual, revision: '背景换成蓝色' });
assert.deepEqual(resolveStudioBrief(resolvedOnce, { previous: manual, revision: '背景换成蓝色' }), resolvedOnce, 'Resolving an assistant summary and then generating must use the same effective brief.');

const videoBrief = buildBrief({ prompt: '咖啡新品，3 个关键镜头', mode: '视频生成' });
assert.equal(videoBrief.outputKind, 'storyboard');
assert.equal(videoBrief.ratio, '9:16');
assert.equal(videoBrief.count, 3);
assert.match(videoBrief.summary, /静态分镜/);
const shots = buildStudioResults(videoBrief);
assert(shots.every(shot => shot.type === '静态分镜草案' && shot.outputKind === 'storyboard' && shot.description.includes('不包含生成的视频或音频')));
assert(shots.every(shot => shot.label.includes('镜头') && shot.design.nodes.find(node => node.id === 'footer').text.includes('静态分镜')));
assert.equal(buildBrief({ prompt: '设计广告分镜，四个镜头' }).count, 4);
assert.equal(buildBrief({ prompt: '标题“把秋天，装进一杯咖啡”' }).headline, '把秋天，装进一杯咖啡');
console.log('Studio model checks passed: materials, themes, manual-edit inheritance, explicit/automatic controls, distinct conversation IDs, canvas sizes, immutable revisions, and static storyboard labeling.');
