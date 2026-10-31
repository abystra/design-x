import React, { useRef, useState } from 'react';
import { uploadAsset } from '../lib/api';
import { ArrowLeft, ArrowRight, ArrowUpRight, Check, CheckCircle2, Image, ImagePlus, Layers, LoaderCircle, Play, Settings2, ShoppingBag, Sparkles, Video, X } from 'lucide-react';
import './workbench.css';

const styles = [
  { name: '自然清新', en: 'NATURAL', color: '#e6eadc', ink: '#3f513d', accent: '#a1b18c' },
  { name: '极简高级', en: 'MINIMAL', color: '#eee8df', ink: '#413a32', accent: '#bb9f82' },
  { name: '杂志时尚', en: 'EDITORIAL', color: '#f4ded5', ink: '#6c382e', accent: '#ee8265' },
  { name: '清透科技', en: 'FUTURE', color: '#e0e9ef', ink: '#344c60', accent: '#8da7bc' },
];
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
// Retained only for the legacy prototype regression fixtures. Product actions do not call this generator.
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

export default function Workbench({ item = {}, onBack, onEdit, onToast }) {
  const kind = getKind(item);
  const [config, setConfig] = useState({ image: item.image || '', assetId: item.assetId, name: '', prompt: item.prompt || '', selling: '', platform: kind === 'video' ? '抖音' : '淘宝 / 天猫', ratio: kind === 'video' ? '9:16' : kind === 'document' ? '16:9' : '3:4', language: '简体中文', style: '自然清新', types: ['卖点图', '场景图'], count: 4, pages: 6, duration: 15, operation: item.name || '智能抠图' });
  const [errors, setErrors] = useState({});
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const uploadRef = useRef(null);
  const basicEdit = kind === 'image' && /裁剪|改尺寸|图片编辑/.test(config.operation);
  const change = (key, value) => { setConfig(c => ({ ...c, [key]: value, ...(key === 'image' ? { assetId: undefined } : {}) })); setErrors(e => ({ ...e, [key]: '' })); };
  const requiresImage = kind === 'product' || kind === 'image';
  async function useFile(file) {
    if (!file || uploading) return;
    if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type) || file.size > 10 * 1024 * 1024) { setErrors(e => ({ ...e, image: '请选择 10 MB 内的 JPG、PNG、WebP 或 GIF 图片' })); return; }
    setUploading(true); setErrors(e => ({ ...e, image: '' }));
    try {
      const asset = await uploadAsset(file);
      setConfig(c => ({ ...c, image: asset.image, assetId: asset.id }));
      onToast?.('素材已上传，可以继续配置');
    } catch (error) { setErrors(e => ({ ...e, image: error.message })); onToast?.(error.message); }
    finally { setUploading(false); }
  }
  function example() {
    setConfig(c => ({ ...c, assetId: undefined, image: kind === 'graphic' || kind === 'video' ? '/assets/coffee.jpg' : '/assets/skincare.jpg', name: kind === 'document' ? '新消费品牌的内容增长提案' : kind === 'video' || kind === 'graphic' ? '拾光咖啡 · 秋日上新' : '植萃修护精华', selling: '温和植萃，轻盈修护。让自然的力量，照亮每一天。', prompt: c.prompt || '制作一组自然清新的品牌视觉，突出产品质感，保留呼吸感与留白。' })); setErrors({});
  }
  function openImageEditor() {
    if (!basicEdit || uploading) return;
    if (!config.image) { setErrors({ image: '请先上传图片，或选择下方示例素材' }); return; }
    const { width, height } = dimensions(config.ratio);
    onEdit?.({ id: `image-edit-${crypto.randomUUID()}`, title: config.name || config.operation, type: '设计作品', persisted: false, image: config.image, assetId: config.assetId, ratio: config.ratio, config: { ...config }, design: { width, height, background: '#ffffff', nodes: [{ id: crypto.randomUUID(), type: 'image', label: '图片素材', src: config.image, assetId: config.assetId, x: 0, y: 0, w: width, h: height, opacity: 1 }] } });
  }
  return <div className="wb-page"><div className="wb-top"><button className="wb-back" onClick={onBack}><ArrowLeft size={17} />返回</button><div className="wb-process"><span className="active"><b>1</b>配置创作</span><i /><span><b>2</b>{basicEdit ? '编辑图片' : '生成方案'}</span><i /><span><b>3</b>编辑与交付</span></div><span className="wb-demo-label"><span />{basicEdit ? '基础图片编辑' : 'AI 能力稍后开放'}</span></div>
    <header className="wb-heading"><div className="wb-heading-icon">{kind === 'video' ? <Video size={24} /> : kind === 'product' ? <ShoppingBag size={24} /> : <Sparkles size={24} />}</div><div><h1>{item.name || 'AI 创作工作台'}<span>灵感，开始成形</span></h1><p>{kind === 'product' ? '从一张商品图开始，探索整套视觉的更多可能。' : kind === 'video' ? '描述一个故事，先把每个精彩镜头安排好。' : kind === 'document' ? '理清内容，让每一页都有清楚的表达。' : '告诉我们你的想法，让每一个细节都有方向。'}</p></div></header>
    <div className="wb-layout"><section className="wb-config"><fieldset disabled={uploading}>
      <div className="wb-section-header"><span>01</span><div><h2>{kind === 'document' ? '从内容开始' : kind === 'text' ? '明确内容方向' : '添加你的创作素材'}</h2><p>{requiresImage ? '一张清晰的图片，是好设计的开始' : '提供一点背景，让创作更有方向'}</p></div><button className="wb-text-button" type="button" onClick={example}>使用示例 <ArrowUpRight size={13} /></button></div>
      {!['document', 'text'].includes(kind) && <><div className={`wb-upload ${dragging ? 'dragging' : ''} ${config.image ? 'has-image' : ''} ${errors.image ? 'has-error' : ''}`} onDragOver={e => { e.preventDefault(); if (!uploading) setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={e => { e.preventDefault(); setDragging(false); if (!uploading) useFile(e.dataTransfer.files[0]); }}>{config.image ? <><img src={config.image} alt="当前创作素材" /><div><span><CheckCircle2 size={15} />素材已准备好</span><p>原图将用于下方的视觉预览</p><button type="button" className="wb-text-button" onClick={() => uploadRef.current?.click()}>替换图片</button></div><button type="button" className="wb-remove-image" onClick={() => change('image', '')} aria-label="移除创作素材"><X size={15} /></button></> : <button type="button" onClick={() => uploadRef.current?.click()}><span className="wb-upload-icon"><ImagePlus size={24} strokeWidth={1.5} /></span><strong>点击上传，或将图片拖到这里{!requiresImage && <small>（选填）</small>}</strong><p>JPG / PNG / WebP，单张不超过 10 MB</p></button>}</div><input ref={uploadRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden onChange={e => { useFile(e.target.files?.[0]); e.target.value = ''; }} />{errors.image && <p className="wb-error" role="alert">{errors.image}</p>}<div className="wb-sample-line"><span>没有素材？先试试</span>{[['/assets/skincare.jpg','护肤产品'],['/assets/coffee.jpg','咖啡品牌'],['/assets/fashion.jpg','服饰穿搭']].map(([image,label]) => <button type="button" key={image} onClick={() => { change('image', image); if (!config.name) change('name', label === '护肤产品' ? '植萃修护精华' : label === '咖啡品牌' ? '拾光咖啡' : '秋日穿搭'); }} aria-label={`使用${label}示例`}><img src={image} alt={label} /></button>)}</div></>}
      <label className="wb-field">{kind === 'document' ? '内容主题' : kind === 'text' ? '内容主题 / 分析对象' : '商品 / 品牌名称'}{['product','document'].includes(kind) && <b>*</b>}<input value={config.name} onChange={e => change('name', e.target.value)} placeholder={kind === 'document' ? '例如：新消费品牌的内容增长提案' : '例如：植萃修护精华'} maxLength={50} /></label>{errors.name && <p className="wb-error" role="alert">{errors.name}</p>}
      {kind === 'product' ? <label className="wb-field">想突出的核心卖点<textarea value={config.selling} onChange={e => change('selling', e.target.value)} placeholder="例如：温和植萃、轻盈修护，适合日常敏感肌护理…" rows={3} maxLength={300} /><span className="wb-field-hint">好的卖点，让设计不止好看。</span></label> : kind === 'image' ? <label className="wb-field">处理方式<select value={config.operation} onChange={e => change('operation', e.target.value)}>{[...new Set([item.name || '智能抠图', '智能抠图', '图片变清晰', '智能裁剪', '改尺寸', '图片编辑', '图片翻译', '移除杂物'])].map(o => <option key={o}>{o}</option>)}</select><span className="wb-field-hint">裁剪、改尺寸和图片编辑可进入画布手动调整；AI 图像处理稍后开放。</span></label> : <><label className="wb-field">{kind === 'video' ? '故事或脚本描述' : kind === 'document' ? '主要内容与受众' : '你希望如何创作'}{['graphic','video','text'].includes(kind) && <b>*</b>}<textarea value={config.prompt} onChange={e => change('prompt', e.target.value)} placeholder={kind === 'video' ? '描述视频的场景、主角、镜头与想传递的感觉…' : '描述主题、内容、目标受众，以及你希望呈现的感觉…'} rows={4} maxLength={1500} /></label>{errors.prompt && <p className="wb-error" role="alert">{errors.prompt}</p>}</>}
      <div className="wb-form-divider" /><div className="wb-section-header"><span>02</span><div><h2>给创作一点方向</h2><p>选择适合你的规格与视觉风格</p></div></div>
      <div className="wb-form-row"><label className="wb-field">{kind === 'document' ? '应用场景' : '目标平台'}<select value={config.platform} onChange={e => change('platform', e.target.value)}>{['淘宝 / 天猫','小红书','抖音','Amazon','Instagram','品牌官网','内部汇报'].map(p => <option key={p}>{p}</option>)}</select></label><label className="wb-field">内容语言<select value={config.language} onChange={e => change('language', e.target.value)}><option>简体中文</option><option>English</option><option>日本語</option></select></label></div>
      <label className="wb-field">画布比例</label><div className="wb-ratios">{['1:1','3:4','4:3','9:16','16:9'].map(r => <button type="button" key={r} className={config.ratio === r ? 'selected' : ''} onClick={() => change('ratio', r)}><span style={{ aspectRatio: r.replace(':','/') }} />{r}</button>)}</div>
      {!['image','text'].includes(kind) && <><label className="wb-field">视觉风格</label><div className="wb-styles">{styles.map(s => <button type="button" className={config.style === s.name ? 'selected' : ''} key={s.name} onClick={() => change('style', s.name)}><span style={{ background: s.color }}><i style={{ background: s.ink }} /><i style={{ background: s.accent }} /><small style={{ color: s.ink }}>Aa</small></span><b>{s.name}</b>{config.style === s.name && <Check size={11} />}</button>)}</div></>}
      {kind === 'product' && <><label className="wb-field">想生成哪些图片<b>*</b></label><div className="wb-image-types">{choices.map(type => <label key={type}><input type="checkbox" checked={config.types.includes(type)} onChange={e => change('types', e.target.checked ? [...config.types, type] : config.types.filter(t => t !== type))} /><span>{config.types.includes(type) && <Check size={11} />}</span>{type}</label>)}</div>{errors.types && <p className="wb-error" role="alert">{errors.types}</p>}</>}
      {kind === 'video' ? <label className="wb-field">计划视频时长<select value={config.duration} onChange={e => change('duration', Number(e.target.value))}><option value={15}>15 秒 · 3 个分镜</option><option value={30}>30 秒 · 4 个分镜</option><option value={60}>60 秒 · 6 个分镜</option></select></label> : kind === 'document' ? <label className="wb-field">页面数量<select value={config.pages} onChange={e => change('pages', Number(e.target.value))}>{[4,6,8,12].map(n => <option value={n} key={n}>{n} 页</option>)}</select></label> : !['text','image'].includes(kind) ? <div className="wb-count-row"><label>生成预览数量</label><div>{[1,2,4,6].map(n => <button type="button" key={n} className={config.count === n ? 'selected' : ''} onClick={() => change('count', n)}>{n} 张</button>)}</div></div> : null}
      </fieldset><div className="wb-generate-footer"><div className="wb-demo-config"><span><Settings2 size={13} />{basicEdit ? '图片编辑已开放' : '当前阶段暂未开放 AI 生成'}</span></div><button className="wb-primary wb-generate" disabled={!basicEdit || uploading} onClick={openImageEditor}>{uploading ? <LoaderCircle className="wb-spinning" size={18} /> : basicEdit ? <Image size={18} /> : <Sparkles size={18} />}{uploading ? '正在上传并处理素材…' : basicEdit ? '在画布中编辑图片' : 'AI 生成暂未开放'}{basicEdit && !uploading && <ArrowRight size={17} />}</button><p>{basicEdit ? '图片与配置将带入编辑器，可手动调整并保存到项目。' : '可查看和填写创作参数，生成能力将在后续阶段接入。'}</p></div></section>
      <aside className="wb-preview"><div className="wb-preview-heading"><div><span className="wb-eyebrow">A GLIMPSE OF YOUR IDEA</span><h2>{basicEdit ? '你的图片，准备就绪' : '先看见一点可能'}</h2></div><span><span />构图参考</span></div><div className="wb-preview-stage"><span className="wb-stage-note">MAKE SOMETHING<br /><em>beautiful.</em></span><div className="wb-preview-back" style={{ background: styles.find(s => s.name === config.style)?.color }} /><div className="wb-preview-front"><ResultArt config={config} result={kind === 'image' ? {outputKind:'image'} : undefined} /></div><span className="wb-preview-stamp"><Sparkles size={12} />FROM YOUR IMAGINATION</span></div><div className="wb-preview-foot"><Image size={15} /><p>{config.image ? '使用已选素材的排版示意，实际结果可在画布继续调整。' : '当前使用示例素材展示布局，上传你的图片后实时替换。'}</p></div>
      <div className="wb-tips"><span><Sparkles size={17} /></span><div><h3>{basicEdit ? '精细调整，由你掌控' : '让灵感更准确一点'}</h3><p>{basicEdit ? '在编辑器中调整图片位置、尺寸与画布比例，修改结果可以保存和导出。' : '从一个明确的主题开始，补充受众、使用场景和喜欢的视觉风格。AI 执行能力尚未接入。'}</p></div></div>
      <div className="wb-output-note"><Layers size={16} /><div><b>{basicEdit ? '保留可继续编辑的源稿' : '创作入口已就位'}</b><p>{basicEdit ? '编辑后保存到我的项目，再次打开可继续调整。' : '当前画面是配置和构图参考，不代表 AI 生成结果。你也可以从模板或空白画板开始设计。'}</p></div></div></aside>
    </div>
  </div>;
}
