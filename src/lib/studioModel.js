// Local, deterministic prototype rules. No model or image-generation API is called.
const FONT = '"PingFang SC", "Microsoft YaHei", sans-serif';
const THEMES = {
  coffee: { subject: '咖啡', image: '/assets/coffee.jpg', brand: 'SLOW COFFEE', headline: '把日子，\n调成喜欢的温度', tagline: '一杯好咖啡，留一点时间给自己', palette: 'warm' },
  skincare: { subject: '护肤', image: '/assets/skincare.jpg', brand: 'DAILY RITUAL', headline: '让肌肤，\n自在呼吸', tagline: '把温柔，留在每一天的日常里', palette: 'green' },
  fashion: { subject: '服饰', image: '/assets/fashion.jpg', brand: 'EVERYDAY EDIT', headline: '穿出，\n自己的节奏', tagline: '轻松的轮廓，自在的日常', palette: 'warm' },
  interior: { subject: '家居', image: '/assets/interior.jpg', brand: 'ROOM FOR LIVING', headline: '把喜欢，\n安放在日常', tagline: '让每个角落，都有生活的温度', palette: 'warm' },
  digital: { subject: '数码', image: '/assets/headphones.jpg', brand: 'SOUND OF NOW', headline: '听见，\n另一种可能', tagline: '让灵感与每一次连接同时发生', palette: 'dark' },
  nature: { subject: '自然', image: '/assets/nature.jpg', brand: 'INTO THE GREEN', headline: '向自然，\n借一点呼吸', tagline: '走慢一点，让生活重新生长', palette: 'green' },
  custom: { subject: '品牌', image: '/assets/coffee.jpg', brand: 'YOUR NEXT IDEA', headline: '让好想法，\n成为好设计', tagline: '从一个灵感，开启新的日常', palette: 'warm' },
};
const PALETTES = {
  warm: { name: '温暖奶油', background: '#f4eadc', ink: '#493b2b', accent: '#b76b45', muted: '#8c7964' },
  dark: { name: '深色质感', background: '#242927', ink: '#f5f1e8', accent: '#d5e7a8', muted: '#bcc6ba' },
  green: { name: '自然草木', background: '#e9eee2', ink: '#314537', accent: '#6f8453', muted: '#75816c' },
  blue: { name: '清透蓝调', background: '#e8eff6', ink: '#263b54', accent: '#557da6', muted: '#788ba0' },
  rose: { name: '柔和玫瑰', background: '#f5e7e5', ink: '#653d42', accent: '#bd747c', muted: '#a27e80' },
};
const SIZES = { '3:4': [600, 800], '1:1': [600, 600], '16:9': [960, 540], '9:16': [540, 960], '4:3': [800, 600], '4:5': [640, 800], '2:3': [600, 900], '3:2': [900, 600] };
const NUMBERS = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
const str = value => typeof value === 'string' ? value.trim() : '';
const copy = value => JSON.parse(JSON.stringify(value));
const clampCount = value => Math.min(6, Math.max(1, Math.round(Number(value) || 1)));
const hash = value => { let result = 2166136261; for (const c of value) result = Math.imul(result ^ c.charCodeAt(0), 16777619); return (result >>> 0).toString(36); };

function detectTheme(text) {
  return /咖啡|拿铁|美式|冷萃|coffee|latte/i.test(text) ? 'coffee'
    : /护肤|精华|面霜|美容|美妆|保湿|skincare/i.test(text) ? 'skincare'
      : /服饰|服装|穿搭|时装|衣服|衬衫|连衣裙|fashion/i.test(text) ? 'fashion'
        : /家居|家具|客厅|沙发|室内|软装|interior/i.test(text) ? 'interior'
          : /数码|耳机|科技|音箱|手机|电脑|智能设备|headphone/i.test(text) ? 'digital'
            : /自然|森林|山野|户外|露营|植物|环保|nature/i.test(text) ? 'nature' : null;
}
function detectPalette(text) {
  const matches = [...text.matchAll(/暗色|深色|黑色|黑金|暗黑|暖色|温暖|暖调|更暖|暖一点|奶油|橙色|绿色|绿调|草木|薄荷|蓝色|蓝调|科技蓝|粉色|玫瑰|粉调/g)];
  const last = matches.at(-1)?.[0] || '';
  return /暗|深|黑/.test(last) ? 'dark' : /暖|奶油|橙/.test(last) ? 'warm' : /绿|草木|薄荷/.test(last) ? 'green' : /蓝/.test(last) ? 'blue' : /粉|玫瑰/.test(last) ? 'rose' : null;
}
function parseRatio(text) {
  const exact = text.match(/(?:^|[^\d])(16\s*[:：/]\s*9|9\s*[:：/]\s*16|3\s*[:：/]\s*4|4\s*[:：/]\s*3|1\s*[:：/]\s*1|4\s*[:：/]\s*5|2\s*[:：/]\s*3|3\s*[:：/]\s*2)(?=$|[^\d])/);
  if (exact) return exact[1].replace(/\s/g, '').replace(/[：/]/, ':');
  return /正方形|方图|方形主图/.test(text) ? '1:1' : /横版|横屏|演示封面|PPT/i.test(text) ? '16:9' : /竖屏|手机壁纸|短视频/.test(text) ? '9:16' : /小红书|竖版海报/.test(text) ? '3:4' : null;
}
function parseCount(text) {
  const match = [...text.matchAll(/([1-9]\d*|[一二两三四五六七八九十])\s*(?:张|幅|个方案|套方案|版设计|个设计|个海报|页|个(?:关键)?镜头|个分镜|帧)/g)].at(-1);
  return match ? clampCount(NUMBERS[match[1]] || Number(match[1])) : null;
}
function normalizeAssets(assets) {
  return (Array.isArray(assets) ? assets : assets ? [assets] : []).flatMap((asset, index) => {
    const url = str(typeof asset === 'string' ? asset : asset?.url || asset?.src || asset?.image);
    if (!url || /^(?:javascript|vbscript):/i.test(url)) return [];
    return [{ id: str(asset?.id) || `asset-${index + 1}`, name: str(asset?.name || asset?.title) || `参考素材 ${index + 1}`, url }];
  });
}
function requestedHeadline(text) {
  const quoted = text.match(/(?<!副)(?:主标题|标题|主文案)(?:文字)?\s*(?:改成|改为|换成|换为|设置为|用|写|为|是|[:：])?\s*[“「"『]([^”」"』\n]{1,32})[”」"』]/);
  if (quoted) return quoted[1].trim();
  const match = text.match(/(?<!副)(?:标题|主文案|主标题)(?:文字)?\s*(?:改成|改为|换成|换为|设置为|用|写|为|是|[:：])\s*[“「"『]?([^”」"』\n，,。；;]{1,32})/);
  return match?.[1]?.trim() || null;
}
function requestedSubtitle(text) {
  const match = text.match(/(?:副标题|副文案)\s*(?:改成|改为|换成|换为|设置为|用|写|为|是|[:：])\s*[“「"『]?([^”」"』\n。；;]{1,42})/);
  return match?.[1]?.trim() || null;
}
function platformFor(text) {
  return /小红书/.test(text) ? '小红书' : /抖音/.test(text) ? '抖音' : /天猫/.test(text) ? '天猫' : /淘宝/.test(text) ? '淘宝' : /微信|朋友圈/.test(text) ? '微信' : /电商|商品|主图/.test(text) ? '电商平台' : '通用设计';
}

/** Infer an editable brief locally. Explicit control values override prompt inference. */
export function buildBrief({ prompt = '', skill = null, mode = '智能创作', ratio, count, assets = [] } = {}) {
  const input = str(prompt);
  const skillName = str(typeof skill === 'string' ? skill : skill?.name);
  const context = `${input} ${skillName}`;
  const theme = detectTheme(context) || 'custom';
  const content = THEMES[theme];
  const normalizedAssets = normalizeAssets(assets);
  const paletteKey = detectPalette(input) || content.palette;
  const outputKind = mode === '视频生成' || /视频|分镜|镜头|剧情广告/.test(context) ? 'storyboard' : 'graphic';
  const explicitRatio = SIZES[ratio] ? ratio : null;
  const explicitCount = Number.isFinite(Number(count)) && count !== '' && count != null ? clampCount(count) : null;
  const actualRatio = explicitRatio || parseRatio(context) || (outputKind === 'storyboard' ? '9:16' : '3:4');
  const actualCount = explicitCount || parseCount(input) || 3;
  const headline = requestedHeadline(input) || content.headline;
  const platform = platformFor(context);
  const subject = theme === 'custom' && normalizedAssets.length ? '素材创作' : content.subject;
  const title = `${subject}${outputKind === 'storyboard' ? '广告分镜' : /套图|一套|一组/.test(context) ? '系列设计' : /主图|商品/.test(context) ? '商品设计' : '创意海报'}`;
  const palette = { ...PALETTES[paletteKey] };
  const summary = `围绕${subject}制作 ${actualCount} 张 ${actualRatio} ${outputKind === 'storyboard' ? '静态分镜草案' : platform === '通用设计' ? '海报' : `${platform}配图`}，采用${palette.name}配色${normalizedAssets.length ? '，优先使用你提供的素材' : '，使用本地示例素材演示'}。${outputKind === 'storyboard' ? '不生成视频或音频。' : ''}`;
  return {
    prompt: input, skill: skillName, mode: str(mode) || '智能创作', title, subject, theme, platform, outputKind,
    ratio: actualRatio, count: actualCount, style: palette.name, paletteKey, palette,
    assets: normalizedAssets, image: normalizedAssets[0]?.url || content.image,
    headline, subtitle: requestedSubtitle(input) || content.tagline,
    source: 'demo-rules', isDemo: true, summary,
    overrides: { ratio: explicitRatio, count: explicitCount, assets: normalizedAssets },
    steps: [`梳理${subject}主题与设计需求`, normalizedAssets.length ? `整理 ${normalizedAssets.length} 份参考素材` : '选用本地示例主视觉', `编排 ${actualCount} 张可编辑设计`],
    assumptions: ['当前为规则排版演示，未调用 AI 生成服务', ...(normalizedAssets.length ? [] : ['尚未提供素材，先用本地示例图展示构图'])],
  };
}

/** Resolve the same brief for the assistant summary and actual generated layouts. */
export function resolveStudioBrief(brief, { previous, revision = '' } = {}) {
  const incoming = copy(brief || buildBrief());
  const originals = Array.isArray(previous) ? previous : previous ? [previous] : [];
  const first = originals[0];
  const request = str(revision);
  if (!request || !first) return { ...buildBrief(incoming), ...incoming, assets: normalizeAssets(incoming.assets), count: clampCount(incoming.count ?? 3) };
  const originalNodes = first.design?.nodes || [];
  const mainImage = originalNodes.find(n => n.id === 'photo' && n.type === 'image') || originalNodes.find(n => n.type === 'image');
  const old = first.brief || buildBrief({ prompt: first.title, ratio: first.ratio, assets: mainImage?.src ? [{ url: mainImage.src }] : [] });
  let effective = { ...buildBrief(old), ...copy(old) };
  // A selected result is the source of truth, including edits made in the layer editor.
  const titleNode = originalNodes.find(n => n.id === 'title' && n.type === 'text');
  const subtitleNode = originalNodes.find(n => n.id === 'subtitle' && n.type === 'text');
  const inheritedImages = originals.map((project, index) => {
    const node = project.design?.nodes?.find(n => n.id === 'photo' && n.type === 'image') || project.design?.nodes?.find(n => n.type === 'image');
    return { id: `inherited-${index + 1}`, name: node?.label || '原方案素材', url: node?.src || project.image };
  }).filter(a => a.url);
  const controls = incoming.overrides || {};
  const replacementAssets = normalizeAssets(incoming.overrides ? controls.assets : incoming.assets);
  const paletteKey = detectPalette(request);
  const headline = requestedHeadline(request);
  const subtitle = requestedSubtitle(request);
  const palette = paletteKey ? { ...PALETTES[paletteKey] } : {
    ...effective.palette,
    ...(first.design?.background ? { background: first.design.background } : {}),
    ...(titleNode?.color ? { ink: titleNode.color } : {}),
    ...(subtitleNode?.color ? { muted: subtitleNode.color } : {}),
  };
  const actualAssets = replacementAssets.length ? replacementAssets : inheritedImages.length ? normalizeAssets(inheritedImages) : normalizeAssets(effective.assets);
  effective = {
    ...effective,
    ...(incoming.sessionId !== undefined ? { sessionId: incoming.sessionId } : {}),
    ...(incoming.turn !== undefined ? { turn: incoming.turn } : {}),
    ratio: controls.ratio || parseRatio(request) || first.ratio || effective.ratio,
    count: controls.count || parseCount(request) || effective.count,
    assets: actualAssets, image: actualAssets[0]?.url || effective.image,
    palette, ...(paletteKey ? { paletteKey, style: palette.name } : {}),
    headline: headline || (/简洁|简约|精简|短一点/.test(request) ? `${effective.subject}，\n刚刚好` : titleNode?.text ?? effective.headline),
    subtitle: subtitle || subtitleNode?.text || effective.subtitle,
    overrides: copy(controls),
  };
  const requestedKind = incoming.mode === '视频生成' ? 'storyboard' : incoming.mode === '图片生成' ? 'graphic' : effective.outputKind;
  if (requestedKind !== effective.outputKind) {
    effective.ratio = controls.ratio || parseRatio(request) || (requestedKind === 'storyboard' ? '9:16' : '3:4');
    effective.title = `${effective.subject}${requestedKind === 'storyboard' ? '广告分镜' : '创意海报'}`;
  }
  effective.outputKind = requestedKind;
  effective.mode = incoming.mode || effective.mode;
  effective.count = clampCount(effective.count);
  effective.summary = `保留${effective.subject}主题${replacementAssets.length ? '，使用新引用的素材' : '与当前素材'}，调整为 ${effective.count} 张 ${effective.ratio} ${effective.outputKind === 'storyboard' ? '静态分镜' : '设计'}，采用${effective.style}配色。${effective.outputKind === 'storyboard' ? '不生成视频或音频。' : ''}`;
  return effective;
}

function wrapText(value, maxChars = 8, maxLines = 3) {
  return String(value).split('\n').flatMap(line => {
    const chars = Array.from(line), lines = [];
    while (chars.length) lines.push(chars.splice(0, maxChars).join(''));
    return lines.length ? lines : [''];
  }).slice(0, maxLines).join('\n');
}
function designFor(brief, index, image) {
  const [width, height] = SIZES[brief.ratio] || SIZES['3:4'];
  const p = brief.palette;
  const landscape = width > height;
  const margin = Math.round(width * .065);
  const fontSize = Math.round(Math.min(width, height) * (landscape ? .074 : .072));
  const variant = index % 3;
  const photo = landscape
    ? { x: Math.round(width * .48), y: 0, w: Math.round(width * .52), h: height }
    : variant === 1
      ? { x: margin, y: Math.round(height * .31), w: width - margin * 2, h: Math.round(height * .49) }
      : { x: 0, y: Math.round(height * .35), w: width, h: Math.round(height * .58) };
  const textWidth = landscape ? Math.round(width * .38) : width - margin * 2;
  const maxChars = Math.max(5, Math.floor(textWidth / fontSize));
  const text = wrapText(brief.headline, maxChars, landscape ? 4 : 2);
  const headingY = landscape ? Math.round(height * .21) : Math.round(height * .105);
  const subSize = Math.round(Math.min(width, height) * .025);
  const subY = landscape ? Math.round(height * .65) : Math.round(height * (width === height ? .29 : .265));
  const nodes = [
    { id: 'photo', type: 'image', label: brief.assets.length ? '用户参考素材' : `${brief.subject}示例主视觉`, src: image, ...photo, opacity: 1 },
    { id: 'brand', type: 'text', text: THEMES[brief.theme]?.brand || 'YOUR NEXT IDEA', x: margin, y: Math.round(height * .045), w: textWidth, h: 25, size: Math.round(Math.min(width, height) * .02), color: p.muted, weight: 600, font: FONT },
    { id: 'title', type: 'text', text, x: margin, y: headingY, w: textWidth, h: Math.ceil(fontSize * 1.16 * text.split('\n').length), size: fontSize, color: p.ink, weight: variant === 1 ? 400 : 600, font: FONT },
    { id: 'subtitle', type: 'text', text: wrapText(brief.subtitle, Math.floor(textWidth / subSize), landscape ? 3 : 2), x: margin, y: subY, w: textWidth, h: subSize * 2.4, size: subSize, color: p.muted, weight: 400, font: FONT },
    { id: 'footer', type: 'text', text: `${brief.platform === '通用设计' ? 'DESIGN FOR EVERYDAY' : brief.platform}  /  ${String(index + 1).padStart(2, '0')}`, x: margin, y: Math.round(height * .955), w: width - margin * 2, h: 19, size: Math.round(Math.min(width, height) * .018), color: p.muted, weight: 500, font: FONT },
  ];
  if (variant !== 1) {
    const diameter = Math.round(Math.min(width, height) * .13);
    const x = landscape ? Math.round(width * .38) : width - margin - diameter;
    const y = landscape ? Math.round(height * .81) : Math.round(height * .32);
    nodes.push({ id: 'badge', type: 'circle', label: '主题标记', x, y, w: diameter, h: diameter, color: p.accent, opacity: 1 });
    nodes.push({ id: 'badge-text', type: 'text', text: `0${index + 1}`, x, y: y + diameter * .34, w: diameter, h: diameter * .4, size: Math.round(diameter * .25), color: brief.paletteKey === 'dark' ? p.background : '#ffffff', weight: 600, font: FONT, align: 'center' });
  }
  return { width, height, background: p.background, nodes };
}

function reviseDesign(original, brief, request, image) {
  if (!original?.nodes) return null;
  const [width, height] = SIZES[brief.ratio] || [original.width, original.height];
  const sx = width / original.width, sy = height / original.height;
  const recolor = Boolean(detectPalette(request));
  const changeHeadline = Boolean(requestedHeadline(request) || /简洁|简约|精简|短一点/.test(request));
  const changeSubtitle = Boolean(requestedSubtitle(request));
  const firstImageId = original.nodes.find(n => n.id === 'photo' && n.type === 'image')?.id || original.nodes.find(n => n.type === 'image')?.id;
  const nodes = original.nodes.map(node => {
    const n = { ...copy(node), x: node.x * sx, y: node.y * sy, w: node.w * sx, h: node.h * sy, ...(node.size ? { size: node.size * Math.min(sx, sy) } : {}) };
    if (n.id === firstImageId) n.src = image;
    if (n.type === 'text') {
      if (n.id === 'title' && changeHeadline) n.text = wrapText(brief.headline, Math.max(5, Math.floor(n.w / n.size)), 4);
      if (n.id === 'subtitle' && changeSubtitle) n.text = wrapText(brief.subtitle, Math.max(8, Math.floor(n.w / n.size)), 3);
      if ((n.id === 'title' && changeHeadline) || (n.id === 'subtitle' && changeSubtitle)) n.size = Math.min(n.size, n.h / (n.text.split('\n').length * 1.15));
      if (recolor) n.color = n.id === 'title' ? brief.palette.ink : n.id === 'badge-text' ? brief.paletteKey === 'dark' ? brief.palette.background : '#ffffff' : brief.palette.muted;
    } else if (recolor && n.id === 'badge') n.color = brief.palette.accent;
    return n;
  });
  return { ...copy(original), width, height, background: recolor ? brief.palette.background : original.background, nodes };
}

/** Create editable layout demonstrations; revisions inherit assets and theme. */
export function buildStudioResults(brief, { previous, revision = '' } = {}) {
  const originals = Array.isArray(previous) ? previous : previous ? [previous] : [];
  const request = str(revision);
  const effective = resolveStudioBrief(brief, { previous, revision });
  const version = Math.max(0, ...originals.map(p => Number(p.version) || 1)) + 1;
  const seed = hash(JSON.stringify([effective, request, version]));
  return Array.from({ length: effective.count }, (_, index) => {
    const previousImage = originals[index % Math.max(1, originals.length)]?.image;
    const image = effective.assets[index % Math.max(1, effective.assets.length)]?.url || (request ? previousImage : '') || effective.image || THEMES[effective.theme]?.image || THEMES.custom.image;
    const previousDesign = originals[index % Math.max(1, originals.length)]?.design;
    const previousKind = originals[0]?.outputKind || originals[0]?.brief?.outputKind || 'graphic';
    const changedMode = request && effective.outputKind !== previousKind;
    const design = (request && previousDesign && !changedMode ? reviseDesign(previousDesign, effective, request, image) : null) || designFor(effective, index, image);
    const storyboard = effective.outputKind === 'storyboard';
    const shot = ['开场建立', '主体展示', '细节特写', '场景延展', '情绪转场', '品牌收尾'][index];
    if (storyboard) {
      const footer = design.nodes.find(n => n.id === 'footer');
      if (footer) footer.text = `镜头 ${String(index + 1).padStart(2, '0')} · ${shot} / 静态分镜`;
    }
    return {
      id: `studio-${seed}-${index + 1}`, title: `${effective.title} · 方案 ${index + 1}${version > 1 ? ` · V${version}` : ''}`,
      label: storyboard ? `镜头 ${index + 1} · ${shot}` : ['主视觉', '留白排版', '品牌表达', '延展方案', '内容配图', '系列收尾'][index],
      image, ratio: effective.ratio, background: design.background, theme: effective.theme,
      type: storyboard ? '静态分镜草案' : 'AI 创作草案', outputKind: effective.outputKind, design, brief: copy(effective), config: copy(effective),
      revision: request, version, source: 'demo-rules', isDemo: true,
      description: storyboard ? `${shot} · 静态分镜排版演示，不包含生成的视频或音频` : request ? `根据「${request}」调整的规则排版演示` : `${effective.style} · ${effective.assets.length ? '你的参考素材' : '本地示例素材'} · 可编辑图层`,
    };
  });
}
