import React, { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, ArrowUpRight, Check, CheckCircle2, ChevronDown, CircleAlert, Clock3, Download, Image, ImagePlus, Layers, LoaderCircle, Palette, Play, Plus, RotateCcw, Save, Settings2, ShoppingBag, Sparkles, Upload, Video, X } from 'lucide-react';
import './workbench.css';

const styles = [
  { name: '自然清新', en: 'NATURAL', color: '#e6eadc', ink: '#3f513d', accent: '#a1b18c' },
  { name: '极简高级', en: 'MINIMAL', color: '#eee8df', ink: '#413a32', accent: '#bb9f82' },
  { name: '杂志时尚', en: 'EDITORIAL', color: '#f4ded5', ink: '#6c382e', accent: '#ee8265' },
  { name: '清透科技', en: 'FUTURE', color: '#e0e9ef', ink: '#344c60', accent: '#8da7bc' },
];
const stages = ['理解需求与素材', '编排内容与视觉', '整理创作方案'];
const choices = ['白底图', '卖点图', '场景图', '细节图'];
const FONT = '"PingFang SC", "Microsoft YaHei", sans-serif';
export function getKind(item) {
  const name=item.name||'', category=item.category||'';
  if (/竞品分析|关键词分析|文案|趋势分析|图文策划|账号诊断/.test(name)) return 'text';
  if (/视频/.test(name) || category === '视频') return 'video';
  if (/PPT|绘本|故事书|手册|画册/.test(name)) return 'document';
  if (/海报|自媒体|Logo|IP形象|表情包|图表|信息图|简历|证件照|办公物料/.test(name)) return 'graphic';
  if (/抠图|消除|扩图|改尺寸|图片编辑|图片翻译|修图|去皱|变清晰|拼图|去水印|改文字|裁剪/.test(name) || category === '图像' || category === '图片处理') return 'image';
  if (/商品|套图|详情页|SKU|促销主图|穿戴|服饰|模特|试衣|试鞋|换色|美甲|穿搭/.test(name) || category === '电商' || category === '服饰') return 'product';
  return 'graphic';
}
function dimensions(ratio) { const [w, h] = ratio.split(':').map(Number); return { width: 600, height: Math.round(600 * h / w) }; }
function makeDesign(config, index, heading, subtitle) {
  const { width, height } = dimensions(config.ratio), style = styles.find(s => s.name === config.style) || styles[0];
  const photoTop = Math.round(height * .36), photoHeight = height - photoTop;
  return { width, height, background: style.color, nodes: [
    { id: `brand-${index}`, type: 'text', text: `${style.en} / DESIGN X`, x: 36, y: 24, w: 520, h: 24, size: 14, color: style.ink, font: FONT, weight: 500 },
    { id: `heading-${index}`, type: 'text', text: heading.slice(0, 12), x: 32, y: height * .09, w: 540, h: height * .1, size: Math.min(45, height * .085), color: style.ink, font: FONT, weight: 600 },
    { id: `subtitle-${index}`, type: 'text', text: subtitle.slice(0, 25), x: 36, y: height * .24, w: 530, h: 30, size: Math.min(19, height * .039), color: style.ink, font: FONT, weight: 400 },
    { id: `photo-${index}`, type: 'image', src: config.image || '/assets/skincare.jpg', label: '参考素材', x: 0, y: photoTop, w: width, h: photoHeight, opacity: 1 },
    { id: `badge-${index}`, type: 'circle', x: width - 120, y: photoTop + 26, w: 85, h: 85, color: style.accent, opacity: 1 },
    { id: `tag-${index}`, type: 'text', text: `0${index + 1}`, x: width - 99, y: photoTop + 48, w: 50, h: 40, size: 30, color: '#ffffff', font: 'Georgia, serif', weight: 500 },
  ] };
}
export function buildResults(config, kind) {
  const n = kind === 'document' ? Number(config.pages) : kind === 'video' ? (Number(config.duration) <= 15 ? 3 : Number(config.duration) <= 30 ? 4 : 6) : kind === 'text' ? 3 : Number(config.count);
  return Array.from({ length: n }, (_, i) => {
    let label = config.types[i % config.types.length] || '创意方案', heading = config.name || config.prompt.slice(0, 12), description = config.selling || config.prompt || '让每一处细节，传递品牌的温度';
    if (kind === 'video') { label = `镜头 ${String(i + 1).padStart(2, '0')}`; heading = ['引入场景', '展现产品', '细节特写', '体验故事', '品牌记忆', '行动邀请'][i]; description = `${config.name || '主题'} · ${['用生活化场景吸引注意', '产品入镜，建立视觉焦点', '展现材质与核心细节', '用故事表达使用体验', '延续一致的品牌风格', '以清晰的行动提示收尾'][i]}`; }
    else if (kind === 'document') { label = `第 ${i + 1} 页`; heading = i === 0 ? config.name : ['内容概览', '背景与目标', '核心观点', '方案展开', '案例与说明', '行动计划', '总结与展望'][Math.min(i - 1, 6)]; description = i === 0 ? config.prompt || '从一个想法，展开一份精彩表达' : `${config.name} · 本页内容结构与视觉示意`; }
    else if (kind === 'text') { label = ['内容方向', '表达结构', '落地建议'][i]; heading = label; description = `${config.name || config.prompt.slice(0, 20)}：${['明确目标受众与核心需求，选择一个清晰的内容切入点。', '以场景引入，围绕核心观点组织信息，用具体细节支撑表达。', '结合目标平台安排内容形式，并在发布前核对事实与素材来源。'][i]}`; }
    else if (kind === 'image') { label = config.operation; description = '原始素材展示 · 处理效果待接入'; }
    return { id: `result-${Date.now()}-${i}`, title: `${config.name || config.prompt.slice(0, 12) || '新设计'} · ${label}`, label, heading, description, image: config.image || '/assets/skincare.jpg', ratio: config.ratio, background: (styles.find(s => s.name === config.style) || styles[0]).color, type: 'AI生成', design: makeDesign(config, i, heading, description), config, outputKind: kind, index: i };
  });
}
function ResultArt({ result, config, compact = false }) {
  const style = styles.find(s => s.name === config.style) || styles[0];
  return <div className={`wb-result-art ${compact ? 'compact' : ''} ${result?.outputKind === 'image' ? 'wb-image-original' : ''}`} style={{ aspectRatio: config.ratio.replace(':', '/'), background: style.color, color: style.ink }}>
    {result?.outputKind === 'image' ? <><img src={config.image || '/assets/skincare.jpg'} alt="原始素材预览" /><span className="wb-original-badge">原始素材</span></> : <><div className="wb-result-type">{style.en} / DESIGN X</div><h3>{result?.heading || config.name || '自然有光，恰好是你'}</h3><p>{result?.description?.slice(0, 29) || config.selling?.slice(0, 29) || '用好设计，讲一个关于美的故事'}</p><div className="wb-result-image"><img src={config.image || '/assets/skincare.jpg'} alt={config.name || '示例设计素材'} /><span style={{ background: style.accent }}>{String((result?.index || 0) + 1).padStart(2, '0')}</span></div>{result?.outputKind === 'video' && <span className="wb-video-play"><Play size={18} fill="currentColor" /></span>}</>}
  </div>;
}

export default function Workbench({ item = {}, onBack, onEdit, onSave, onToast }) {
  const kind = getKind(item);
  const [config, setConfig] = useState({ image: item.image || '', name: '', prompt: item.prompt || '', selling: '', platform: kind === 'video' ? '抖音' : '淘宝 / 天猫', ratio: kind === 'video' ? '9:16' : kind === 'document' ? '16:9' : '3:4', language: '简体中文', style: '自然清新', types: ['卖点图', '场景图'], count: 4, pages: 6, duration: 15, operation: item.name || '智能抠图' });
  const [status, setStatus] = useState('configure');
  const [progress, setProgress] = useState(0);
  const [scenario, setScenario] = useState('normal');
  const [errors, setErrors] = useState({});
  const [results, setResults] = useState([]);
  const [selected, setSelected] = useState(0);
  const [saved, setSaved] = useState([]);
  const [snapshot, setSnapshot] = useState(null);
  const [run, setRun] = useState(0);
  const [dragging, setDragging] = useState(false);
  const uploadRef = useRef(null);
  const working = status === 'running';
  const change = (key, value) => { setConfig(c => ({ ...c, [key]: value })); setErrors(e => ({ ...e, [key]: '' })); };
  const requiresImage = kind === 'product' || kind === 'image';
  const typeName = { product: '商品套图', video: '视频分镜', document: '页面结构', text: '内容方案', image: '图片处理', graphic: '创意设计' }[kind];
  useEffect(() => {
    if (!working) return;
    const start = Date.now();
    const timer = setInterval(() => {
      const elapsed = Date.now() - start;
      const p = Math.min(100, Math.round(elapsed / 42)); setProgress(p);
      if (scenario === 'failure' && elapsed >= 2200) { clearInterval(timer); setStatus('failed'); }
      else if (elapsed >= 4200) { clearInterval(timer); setResults(buildResults(snapshot, kind)); setSelected(0); setStatus('complete'); }
    }, 100);
    return () => clearInterval(timer);
  }, [status, run]);
  async function useFile(file) {
    if (!file) return;
    if (!/^image\/(png|jpeg|webp)$/.test(file.type) || file.size > 3 * 1024 * 1024) { setErrors(e => ({ ...e, image: '请选择 3 MB 内的 JPG、PNG 或 WebP 图片' })); return; }
    const src = await new Promise(resolve => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => resolve(null); reader.readAsDataURL(file); });
    if (src) change('image', src); else setErrors(e => ({ ...e, image: '图片读取失败，请重新选择' }));
  }
  function example() {
    setConfig(c => ({ ...c, image: kind === 'graphic' || kind === 'video' ? '/assets/coffee.jpg' : '/assets/skincare.jpg', name: kind === 'document' ? '新消费品牌的内容增长提案' : kind === 'video' || kind === 'graphic' ? '拾光咖啡 · 秋日上新' : '植萃修护精华', selling: '温和植萃，轻盈修护。让自然的力量，照亮每一天。', prompt: c.prompt || (kind === 'document' ? '面向品牌运营团队，介绍品牌定位、内容策略与行动计划。' : kind === 'video' ? '用温暖的晨间光线，展现咖啡从研磨到入口的片刻。自然、舒缓、有生活感。' : '制作一组自然清新的品牌视觉，突出产品质感，保留呼吸感与留白。') })); setErrors({});
  }
  function generate(isRetry = false) {
    const nextErrors = {};
    if (requiresImage && !config.image) nextErrors.image = '请上传一张素材，或选择下方示例素材';
    if (['product', 'document'].includes(kind) && !config.name.trim()) nextErrors.name = kind === 'document' ? '请填写内容主题' : '请填写商品或品牌名称';
    if (['video', 'graphic', 'text'].includes(kind) && !config.prompt.trim()) nextErrors.prompt = '先描述一下你的创作需求';
    if (kind === 'product' && !config.types.length) nextErrors.types = '至少选择一种图片类型';
    if (Object.keys(nextErrors).length) { setErrors(nextErrors); document.querySelector('.wb-config')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
    if (isRetry) setScenario('normal');
    setSnapshot({ ...config }); setProgress(0); setSaved([]); setStatus('running'); setRun(r => r + 1);
  }
  function saveResult(result) { if(onSave?.(result) === false) return; setSaved(s => [...new Set([...s, result.id])]); }
  function downloadPlan() {
    const data = { title: item.name, note: 'Design X 本地交互原型方案，不是真实 AI 生成结果。', configuration: snapshot, outputs: results.map(({ id, title, label, heading, description, ratio, outputKind, design }) => ({ id, title, label, heading, description, ratio, outputKind, design })) };
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = `${snapshot?.name || '创作方案'}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
  const result = results[selected];
  return <div className="wb-page"><div className="wb-top"><button className="wb-back" onClick={onBack}><ArrowLeft size={17} />返回</button><div className="wb-process"><span className={status === 'configure' || status === 'cancelled' ? 'active' : 'done'}><b>{status === 'complete' ? <Check size={11} /> : '1'}</b>配置创作</span><i /><span className={working || status === 'failed' ? 'active' : status === 'complete' ? 'done' : ''}><b>{status === 'complete' ? <Check size={11} /> : '2'}</b>生成方案</span><i /><span className={status === 'complete' ? 'active' : ''}><b>3</b>编辑与交付</span></div><span className="wb-demo-label"><span />原型演示</span></div>
    <header className="wb-heading"><div className="wb-heading-icon">{kind === 'video' ? <Video size={24} /> : kind === 'product' ? <ShoppingBag size={24} /> : <Sparkles size={24} />}</div><div><h1>{item.name || 'AI 创作工作台'}<span>灵感，开始成形</span></h1><p>{kind === 'product' ? '从一张商品图开始，探索整套视觉的更多可能。' : kind === 'video' ? '描述一个故事，先把每个精彩镜头安排好。' : kind === 'document' ? '理清内容，让每一页都有清楚的表达。' : '告诉我们你的想法，让每一个细节都有方向。'}</p></div></header>
    {status === 'complete' ? <section className="wb-complete"><div className="wb-success-heading"><div><CheckCircle2 size={23} /><div><h2>你的创作方案已就绪</h2><p>{kind === 'video' ? '以下为分镜草案，不包含生成的视频或音频。' : kind === 'document' ? '以下为页面结构与视觉草案，不是可下载的 PPT。' : kind === 'image' ? '保留原图展示操作流程，尚未执行真实图片处理。' : kind === 'text' ? '以下为内容结构示意，未执行外部检索或真实分析。' : '以下为示例素材排版预览，可继续编辑和保存。'}</p></div></div><button className="wb-secondary" onClick={() => setStatus('configure')}><Settings2 size={15} />调整创作参数</button></div><div className="wb-summary"><span>{snapshot.name || snapshot.prompt.slice(0, 20)}</span><span>{snapshot.style}</span><span>{snapshot.ratio}</span><span>{snapshot.language}</span><span>{kind === 'video' ? `${snapshot.duration} 秒 / ${results.length} 个分镜` : `${results.length} ${kind === 'document' ? '页草案' : kind === 'text' ? '个结构' : '张预览'}`}</span></div><div className="wb-results-layout"><div className="wb-result-grid">{results.map((r, i) => <button className={`wb-result-option ${selected === i ? 'selected' : ''}`} onClick={() => setSelected(i)} key={r.id} aria-label={`选择结果 ${i + 1} ${r.label}`} aria-pressed={selected === i}>{kind === 'text' ? <div className="wb-text-preview"><span>0{i + 1}</span><h3>{r.heading}</h3><p>{r.description}</p></div> : <ResultArt result={r} config={snapshot} compact />}<div className="wb-result-caption"><span>{r.label}</span>{selected === i ? <span className="wb-selected-dot"><Check size={11} /></span> : <span className="wb-empty-dot" />}</div></button>)}</div><aside className="wb-result-inspector"><span className="wb-eyebrow">YOUR NEXT CREATIVE STEP</span><h2>{result?.label}</h2><p>{result?.description}</p><dl><div><dt>目标平台</dt><dd>{snapshot.platform}</dd></div><div><dt>设计风格</dt><dd>{snapshot.style}</dd></div><div><dt>画布比例</dt><dd>{snapshot.ratio}</dd></div><div><dt>交付类型</dt><dd>{kind === 'video' ? '静态分镜草案' : kind === 'document' ? '页面设计草案' : kind === 'text' ? '内容结构示意' : kind === 'image' ? '原图与操作配置' : '可编辑排版方案'}</dd></div></dl><button className="wb-primary" onClick={() => onEdit?.(result)}><PencilIcon />{kind === 'video' ? '编辑当前分镜' : kind === 'document' ? '编辑当前页面' : '继续编辑设计'}<ArrowRight size={15} /></button><button className="wb-secondary" onClick={() => saveResult(result)}><Save size={15} />{saved.includes(result?.id) ? '再次保存到项目' : '保存当前方案'}</button><button className="wb-text-button" onClick={downloadPlan}><Download size={14} />下载方案配置</button><div className="wb-inspector-note"><Layers size={17} /><p>保存素材、文字和设计参数，让下一次调整从这里继续。</p></div></aside></div></section> : <div className="wb-layout"><section className="wb-config"><fieldset disabled={working}>
      <div className="wb-section-header"><span>01</span><div><h2>{kind === 'document' ? '从内容开始' : kind === 'text' ? '明确内容方向' : '添加你的创作素材'}</h2><p>{requiresImage ? '一张清晰的图片，是好设计的开始' : '提供一点背景，让创作更有方向'}</p></div><button className="wb-text-button" type="button" onClick={example}>使用示例 <ArrowUpRight size={13} /></button></div>
      {!['document', 'text'].includes(kind) && <><div className={`wb-upload ${dragging ? 'dragging' : ''} ${config.image ? 'has-image' : ''} ${errors.image ? 'has-error' : ''}`} onDragOver={e => { e.preventDefault(); if (!working) setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={e => { e.preventDefault(); setDragging(false); if (!working) useFile(e.dataTransfer.files[0]); }}>{config.image ? <><img src={config.image} alt="当前创作素材" /><div><span><CheckCircle2 size={15} />素材已准备好</span><p>原图将用于下方的视觉预览</p><button type="button" className="wb-text-button" onClick={() => uploadRef.current?.click()}>替换图片</button></div><button type="button" className="wb-remove-image" onClick={() => change('image', '')} aria-label="移除创作素材"><X size={15} /></button></> : <button type="button" onClick={() => uploadRef.current?.click()}><span className="wb-upload-icon"><ImagePlus size={24} strokeWidth={1.5} /></span><strong>点击上传，或将图片拖到这里{!requiresImage && <small>（选填）</small>}</strong><p>JPG / PNG / WebP，单张不超过 3 MB</p></button>}</div><input ref={uploadRef} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={e => { useFile(e.target.files?.[0]); e.target.value = ''; }} />{errors.image && <p className="wb-error" role="alert">{errors.image}</p>}<div className="wb-sample-line"><span>没有素材？先试试</span>{[['/assets/skincare.jpg','护肤产品'],['/assets/coffee.jpg','咖啡品牌'],['/assets/fashion.jpg','服饰穿搭']].map(([image,label]) => <button type="button" key={image} onClick={() => { change('image', image); if (!config.name) change('name', label === '护肤产品' ? '植萃修护精华' : label === '咖啡品牌' ? '拾光咖啡' : '秋日穿搭'); }} aria-label={`使用${label}示例`}><img src={image} alt={label} /></button>)}</div></>}
      <label className="wb-field">{kind === 'document' ? '内容主题' : kind === 'text' ? '内容主题 / 分析对象' : '商品 / 品牌名称'}{['product','document'].includes(kind) && <b>*</b>}<input value={config.name} onChange={e => change('name', e.target.value)} placeholder={kind === 'document' ? '例如：新消费品牌的内容增长提案' : '例如：植萃修护精华'} maxLength={50} /></label>{errors.name && <p className="wb-error" role="alert">{errors.name}</p>}
      {kind === 'product' ? <label className="wb-field">想突出的核心卖点<textarea value={config.selling} onChange={e => change('selling', e.target.value)} placeholder="例如：温和植萃、轻盈修护，适合日常敏感肌护理…" rows={3} maxLength={300} /><span className="wb-field-hint">好的卖点，让设计不止好看。</span></label> : kind === 'image' ? <label className="wb-field">处理方式<select value={config.operation} onChange={e => change('operation', e.target.value)}>{[...new Set([item.name || '智能抠图', '智能抠图', '图片变清晰', '智能裁剪', '图片翻译', '移除杂物'])].map(o => <option key={o}>{o}</option>)}</select><span className="wb-field-hint">原型仅展示配置与原图，不执行真实像素处理。</span></label> : <><label className="wb-field">{kind === 'video' ? '故事或脚本描述' : kind === 'document' ? '主要内容与受众' : '你希望如何创作'}{['graphic','video','text'].includes(kind) && <b>*</b>}<textarea value={config.prompt} onChange={e => change('prompt', e.target.value)} placeholder={kind === 'video' ? '描述视频的场景、主角、镜头与想传递的感觉…' : '描述主题、内容、目标受众，以及你希望呈现的感觉…'} rows={4} maxLength={1500} /></label>{errors.prompt && <p className="wb-error" role="alert">{errors.prompt}</p>}</>}
      <div className="wb-form-divider" /><div className="wb-section-header"><span>02</span><div><h2>给创作一点方向</h2><p>选择适合你的规格与视觉风格</p></div></div>
      <div className="wb-form-row"><label className="wb-field">{kind === 'document' ? '应用场景' : '目标平台'}<select value={config.platform} onChange={e => change('platform', e.target.value)}>{['淘宝 / 天猫','小红书','抖音','Amazon','Instagram','品牌官网','内部汇报'].map(p => <option key={p}>{p}</option>)}</select></label><label className="wb-field">内容语言<select value={config.language} onChange={e => change('language', e.target.value)}><option>简体中文</option><option>English</option><option>日本語</option></select></label></div>
      <label className="wb-field">画布比例</label><div className="wb-ratios">{['1:1','3:4','4:3','9:16','16:9'].map(r => <button type="button" key={r} className={config.ratio === r ? 'selected' : ''} onClick={() => change('ratio', r)}><span style={{ aspectRatio: r.replace(':','/') }} />{r}</button>)}</div>
      {!['image','text'].includes(kind) && <><label className="wb-field">视觉风格</label><div className="wb-styles">{styles.map(s => <button type="button" className={config.style === s.name ? 'selected' : ''} key={s.name} onClick={() => change('style', s.name)}><span style={{ background: s.color }}><i style={{ background: s.ink }} /><i style={{ background: s.accent }} /><small style={{ color: s.ink }}>Aa</small></span><b>{s.name}</b>{config.style === s.name && <Check size={11} />}</button>)}</div></>}
      {kind === 'product' && <><label className="wb-field">想生成哪些图片<b>*</b></label><div className="wb-image-types">{choices.map(type => <label key={type}><input type="checkbox" checked={config.types.includes(type)} onChange={e => change('types', e.target.checked ? [...config.types, type] : config.types.filter(t => t !== type))} /><span>{config.types.includes(type) && <Check size={11} />}</span>{type}</label>)}</div>{errors.types && <p className="wb-error" role="alert">{errors.types}</p>}</>}
      {kind === 'video' ? <label className="wb-field">计划视频时长<select value={config.duration} onChange={e => change('duration', Number(e.target.value))}><option value={15}>15 秒 · 3 个分镜</option><option value={30}>30 秒 · 4 个分镜</option><option value={60}>60 秒 · 6 个分镜</option></select></label> : kind === 'document' ? <label className="wb-field">页面数量<select value={config.pages} onChange={e => change('pages', Number(e.target.value))}>{[4,6,8,12].map(n => <option value={n} key={n}>{n} 页</option>)}</select></label> : !['text','image'].includes(kind) ? <div className="wb-count-row"><label>生成预览数量</label><div>{[1,2,4,6].map(n => <button type="button" key={n} className={config.count === n ? 'selected' : ''} onClick={() => change('count', n)}>{n} 张</button>)}</div></div> : null}
      </fieldset><div className="wb-generate-footer"><div className="wb-demo-config"><span><Settings2 size={13} />演示状态</span><select disabled={working} aria-label="演示状态" value={scenario} onChange={e => setScenario(e.target.value)}><option value="normal">正常完成</option><option value="failure">模拟失败</option></select></div><button className="wb-primary wb-generate" disabled={working} onClick={() => generate()}>{working ? <LoaderCircle className="wb-spinning" size={18} /> : <Sparkles size={18} />}{working ? '正在整理创作方案…' : `生成${typeName}预览`}{!working && <ArrowRight size={17} />}</button><p>使用本地素材演示，不调用真实 AI，不消耗额度。</p></div></section>
      <aside className="wb-preview"><div className="wb-preview-heading"><div><span className="wb-eyebrow">A GLIMPSE OF YOUR IDEA</span><h2>{working ? '好想法，正在成形' : '先看见一点可能'}</h2></div><span><span />实时预览</span></div><div className={`wb-preview-stage ${working ? 'processing' : ''}`}><span className="wb-stage-note">MAKE SOMETHING<br /><em>beautiful.</em></span><div className="wb-preview-back" style={{ background: styles.find(s => s.name === config.style)?.color }} /><div className="wb-preview-front"><ResultArt config={config} result={kind === 'image' ? {outputKind:'image'} : undefined} /></div><span className="wb-preview-stamp"><Sparkles size={12} />FROM YOUR IMAGINATION</span></div><div className="wb-preview-foot"><Image size={15} /><p>{config.image ? '使用已选素材的排版示意，实际结果可在画布继续调整。' : '当前使用示例素材展示布局，上传你的图片后实时替换。'}</p></div>
      {working ? <div className="wb-task-progress" aria-live="polite"><div className="wb-progress-title"><LoaderCircle className="wb-spinning" size={18} /><b>正在演示创作流程</b><span>{progress}%</span></div><div className="wb-progress-track"><span style={{ width: `${progress}%` }} /></div><div className="wb-progress-steps">{stages.map((s, i) => <div className={progress > i * 33 ? 'active' : ''} key={s}>{progress > (i + 1) * 33 ? <CheckCircle2 size={15} /> : <span className={progress > i * 33 ? 'wb-progress-circle current' : 'wb-progress-circle'} />}{s}</div>)}</div><button className="wb-text-button" onClick={() => setStatus('cancelled')}>取消本次演示</button></div> : status === 'failed' ? <div className="wb-task-feedback error" role="alert"><CircleAlert size={21} /><div><h3>这次演示暂停了</h3><p>已触发你选择的失败状态，素材与参数都已保留。</p><button className="wb-secondary" onClick={() => generate(true)}><RotateCcw size={14} />切换正常状态并重试</button></div></div> : status === 'cancelled' ? <div className="wb-task-feedback"><CheckCircle2 size={21} /><div><h3>已取消，灵感还在</h3><p>所有配置已保留，可以调整后重新开始。</p><button className="wb-text-button" onClick={() => generate()}>重新生成预览 <ArrowRight size={13} /></button></div></div> : <div className="wb-tips"><span><Sparkles size={17} /></span><div><h3>让灵感更准确一点</h3><p>{kind === 'product' ? '选择主体清晰的商品图，补充 2–3 个核心卖点。风格越具体，视觉表达越统一。' : kind === 'video' ? '描述镜头发生的地点、主体动作与情绪，让每一个分镜都有清晰的叙事任务。' : '从一个明确的主题开始，补充受众、使用场景和喜欢的视觉风格。'}</p></div></div>}
      <div className="wb-output-note"><Layers size={16} /><div><b>{kind === 'video' ? '从分镜开始，构思一个好故事' : kind === 'document' ? '先理清内容，再打磨每一页' : '不止有结果，还有下一步'}</b><p>{kind === 'video' ? '本原型提供静态分镜预览，视频生成能力留待后续接入。' : kind === 'document' ? '本原型提供页面草案与单页编辑，暂不输出 PPT 文件。' : '选择方案进入画布，调整文案、颜色与布局，保存或导出作品。'}</p></div></div></aside>
    </div>}
  </div>;
}
function PencilIcon() { return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="m16 3 5 5-13 13H3v-5L16 3Z" /><path d="m13 6 5 5" /></svg>; }
