import React, { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Check, ChevronDown, ChevronUp, Cloud, Copy, Download, Eye, EyeOff, ImagePlus, Layers, LayoutTemplate, Lock, Maximize2, Minus, MoreHorizontal, Move, Palette, Plus, Redo2, RotateCcw, Save, Settings2, Shapes, Sparkles, Square, Trash2, Type, Undo2, Unlock, Upload, X, ZoomIn, ZoomOut } from 'lucide-react';
import './editor.css';
import { templates } from '../data/templates';

const FONT = '"PingFang SC", "Microsoft YaHei", sans-serif';
const COLORS = ['#f0e7d8', '#f2634b', '#323a2e', '#f9f8f5', '#cedbd7', '#e8c5c1', '#25272c', '#ffffff'];
const uid = () => `layer-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
const clone = value => JSON.parse(JSON.stringify(value));
const esc = text => String(text).replace(/[<>&"']/g, x => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&apos;'}[x]));
const sizeFor = ratio => ({ '3:4':[600,800], '1:1':[600,600], '16:9':[960,540], '9:16':[540,960] }[ratio] || [600,800]);
const initialDesign = project => {
  const [width,height]=sizeFor(project?.ratio);
  if(project?.design)return {...project.design,width:project.design.width||width,height:project.design.height||height};
  if(project?.blank)return {width,height,background:project.background||'#ffffff',nodes:[]};
  const match=templates.find(t=>t.theme===project?.theme)||templates.find(t=>t.image===project?.image)||templates[0];
  const theme={...match,...project},themeName=theme.theme||match.theme;
  const light=['nature','coffee','interior','audio'].includes(themeName), ink=light?'#ffffff':'#323a2e';
  const fullBleed=['nature','coffee','interior','audio'].includes(themeName);
  const titleText=theme.en||match.en, lines=titleText.split('\n').length;
  const size=themeName==='brand'?104:themeName==='editorial'?84:themeName==='coffee'?94:themeName==='audio'?72:80;
  const sx=width/600,sy=height/800;
  const nodes=[
    { id:'photo',type:'image',label:theme.subtitle||theme.title||'主视觉',src:theme.image||'/assets/coffee.jpg',x:themeName==='fashion'?42:0,y:fullBleed?0:themeName==='fashion'?185:200,w:themeName==='fashion'?516:600,h:fullBleed?800:themeName==='fashion'?512:600,opacity:1 },
    ...(fullBleed?[{id:'photo-shade',type:'rect',label:'文字衬底',x:0,y:0,w:600,h:800,color:'#13251c',opacity:themeName === 'coffee' ? 0.34 : 0.18}]:[]),
    { id:'brand',type:'text',text:theme.label||match.label,x:38,y:35,w:530,h:24,size:14,color:ink,weight:500,font:FONT },
    { id:'title',type:'text',text:titleText,x:35,y:93,w:540,h:lines*size*1.15,size,color:ink,weight:themeName==='skin'||themeName==='interior'?400:700,font:['coffee','skin','interior','editorial'].includes(themeName)?'Georgia, serif':FONT },
    { id:'subtitle',type:'text',text:theme.title||match.title,x:38,y:730,w:510,h:37,size:25,color:fullBleed?'#ffffff':ink,weight:500,font:FONT },
  ];
  if(themeName==='coffee')nodes.push(
    {id:'badge',type:'circle',label:'品牌贴纸',x:429,y:342,w:130,h:130,color:'#e9e5d8',opacity:1},
    {id:'badge-text',type:'text',text:'A LITTLE\nCOFFEE\nA LOT OF JOY',x:443,y:374,w:102,h:63,size:14,color:'#47533c',weight:600,font:FONT,align:'center'}
  );
  return {width,height,background:theme.background||theme.color||'#f0e7d8',nodes:nodes.map(n=>({...n,x:n.x*sx,y:n.y*sy,w:n.w*sx,h:n.h*sy,...(n.size?{size:Math.round(n.size*Math.min(sx,sy))}:{})}))};
};
function IconButton({ icon: Icon, label, onClick, disabled, active, className = '' }) {
  return <button type="button" className={`ed-icon-button ${active ? 'is-active' : ''} ${className}`} onClick={onClick} aria-label={label} title={label} disabled={disabled}><Icon size={18}/></button>;
}
function ColorPicker({ value, onChange, label = '颜色' }) {
  return <div className="ed-color-picker"><label className="ed-color-input" title={label}><input type="color" aria-label={label} value={/^#[0-9a-f]{6}$/i.test(value || '') ? value : '#ffffff'} onChange={e => onChange(e.target.value)}/><span style={{ background: value }}/></label><span>{value?.toUpperCase()}</span></div>;
}
function drawCover(ctx, img, x, y, w, h) {
  const scale = Math.max(w / img.width, h / img.height);
  const sw = w / scale, sh = h / scale;
  ctx.drawImage(img, (img.width-sw)/2, (img.height-sh)/2, sw, sh, x, y, w, h);
}
function loadImage(src) { return new Promise((resolve, reject) => { const img = new Image(); img.crossOrigin = 'anonymous'; img.onload = () => resolve(img); img.onerror = () => reject(new Error('图片载入失败，请重新上传后导出')); img.src = src; }); }
async function imageData(src) {
  if (src.startsWith('data:')) return src;
  const img = await loadImage(src), cv = document.createElement('canvas'); cv.width = img.width; cv.height = img.height; cv.getContext('2d').drawImage(img, 0, 0); return cv.toDataURL('image/png');
}
async function renderDesign(design, scale = 1, transparent = false) {
  const W=design.width||600,H=design.height||800;
  await document.fonts.ready;
  const canvas = document.createElement('canvas'); canvas.width = W * scale; canvas.height = H * scale;
  const ctx = canvas.getContext('2d'); ctx.scale(scale, scale);
  if (!transparent) { ctx.fillStyle = design.background; ctx.fillRect(0, 0, W, H); }
  for (const n of design.nodes) {
    if (n.hidden) continue;
    ctx.save(); ctx.globalAlpha = n.opacity ?? 1;
    if (n.type === 'image') drawCover(ctx, await loadImage(n.src), n.x, n.y, n.w, n.h);
    else if (n.type === 'text') {
      ctx.fillStyle = n.color; ctx.font = `${n.weight || 400} ${n.size}px ${n.font || FONT}`; ctx.textBaseline = 'top'; ctx.textAlign = n.align || 'left';
      n.text.split('\n').forEach((line, i) => ctx.fillText(line, n.x + (n.align === 'center' ? n.w/2 : n.align === 'right' ? n.w : 0), n.y + n.size * 1.15 * i));
    } else {
      ctx.fillStyle = n.color;
      if (n.type === 'circle') { ctx.beginPath(); ctx.ellipse(n.x+n.w/2, n.y+n.h/2, n.w/2, n.h/2, 0, 0, Math.PI*2); ctx.fill(); }
      else ctx.fillRect(n.x, n.y, n.w, n.h);
    }
    ctx.restore();
  }
  return canvas;
}
function download(blob, name) { const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 5000); }

export default function Editor({ project, onBack, onSave, onToast }) {
  const [design, setDesign] = useState(() => clone(initialDesign(project)));
  const W=design.width||600,H=design.height||800;
  const ratio=project?.ratio||['3:4','1:1','16:9','9:16'].find(r=>{const [a,b]=r.split(':').map(Number);return Math.abs(a/b-W/H)<.01})||'自定义';
  const designRef = useRef(design);
  const history = useRef([clone(design)]), historyIndex = useRef(0);
  const [, renderHistory] = useState(0);
  const [title, setTitle] = useState(project?.title || '秋日咖啡 · 品牌海报');
  const [selectedId, setSelectedId] = useState(project?.blank?null:'subtitle');
  const [tab, setTab] = useState('templates');
  const [zoom, setZoom] = useState(68);
  const [autoFit, setAutoFit] = useState(true);
  const [saved, setSaved] = useState(project.persisted !== false);
  const [exportOpen, setExportOpen] = useState(false);
  const [format, setFormat] = useState('PNG');
  const [exportScale, setExportScale] = useState(2);
  const [transparent, setTransparent] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState('');
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [preview, setPreview] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [leftOpen, setLeftOpen] = useState(false);
  const stageRef = useRef(null), fileRef = useRef(null), dragRef = useRef(null);
  const selected = design.nodes.find(n => n.id === selectedId);
  const apply = next => { designRef.current = next; setDesign(next); setSaved(false); };
  const commit = next => {
    const value = typeof next === 'function' ? next(designRef.current) : next;
    if (JSON.stringify(value) === JSON.stringify(history.current[historyIndex.current])) { apply(value); return; }
    history.current = [...history.current.slice(0, historyIndex.current + 1), clone(value)].slice(-80);
    historyIndex.current = history.current.length - 1; apply(value); renderHistory(n => n + 1);
  };
  const updateNode = (id, values) => commit(d => ({ ...d, nodes: d.nodes.map(n => n.id === id ? { ...n, ...values } : n) }));
  const notify = message => onToast?.(message);
  const undo = () => { if (!historyIndex.current) return; historyIndex.current -= 1; apply(clone(history.current[historyIndex.current])); renderHistory(n => n + 1); };
  const redo = () => { if (historyIndex.current >= history.current.length - 1) return; historyIndex.current += 1; apply(clone(history.current[historyIndex.current])); renderHistory(n => n + 1); };
  const save = () => {
    const next = { ...project, id: project?.id || `project-${Date.now()}`, title: title.trim() || '未命名设计', image: designRef.current.nodes.find(n => n.type === 'image')?.src || project?.image, background: designRef.current.background, design: clone(designRef.current), updatedAt: new Date().toISOString() };
    try { const result=onSave?.(next);if(result===false)return false;setSaved(true);notify('设计已保存到我的项目');return true;} catch {notify('保存失败：本地存储空间不足，请先导出作品');return false;}
  };
  useEffect(() => {
    if (!autoFit || !stageRef.current) return;
    const fit = () => { const rect = stageRef.current.getBoundingClientRect(); setZoom(Math.max(20, Math.min(82, Math.floor(Math.min((rect.width - 100)/W, (rect.height - 78)/H) * 100)))); };
    const observer = new ResizeObserver(fit); observer.observe(stageRef.current); fit(); return () => observer.disconnect();
  }, [autoFit, inspectorOpen, leftOpen]);
  useEffect(() => {
    const keyboard = e => {
      const input = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName);
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); }
      if (!input && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
      if (!input && selectedId && (e.key === 'Delete' || e.key === 'Backspace')) { e.preventDefault(); deleteSelected(); }
      if (e.key === 'Escape') { setExportOpen(false); setPreview(false); setInspectorOpen(false); setLeftOpen(false); }
    };
    document.addEventListener('keydown', keyboard); return () => document.removeEventListener('keydown', keyboard);
  });
  useEffect(() => {
    if (!exportOpen) return;
    const dialog = document.querySelector('.ed-export-modal');
    const first = dialog?.querySelector('button'); first?.focus();
    const trap = e => { if (e.key !== 'Tab') return; const all = [...dialog.querySelectorAll('button, input, select')].filter(el => !el.disabled); const firstEl=all[0],lastEl=all.at(-1); if(e.shiftKey && document.activeElement === firstEl){e.preventDefault();lastEl.focus();}else if(!e.shiftKey && document.activeElement === lastEl){e.preventDefault();firstEl.focus();} };
    document.addEventListener('keydown', trap); return () => document.removeEventListener('keydown', trap);
  }, [exportOpen]);

  function deleteSelected() {
    if (!selectedId || designRef.current.nodes.find(n => n.id === selectedId)?.locked) return;
    commit(d => ({...d,nodes:d.nodes.filter(n=>n.id!==selectedId)})); setSelectedId(null);
  }
  function duplicateSelected() {
    if (!selected) return; const n = {...clone(selected),id:uid(),x:selected.x+20,y:selected.y+20,locked:false}; commit(d=>({...d,nodes:[...d.nodes,n]}));setSelectedId(n.id);
  }
  function addText(text = '双击灵感，开始创作', size = 36) {
    const n={id:uid(),type:'text',text,x:Math.round(W*.08),y:Math.round(H*.4),w:Math.round(W*.83),h:size*1.3,size,color:'#323a2e',weight:500,font:FONT};commit(d=>({...d,nodes:[...d.nodes,n]}));setSelectedId(n.id);setInspectorOpen(true);
  }
  function addShape(type) { const n={id:uid(),type,label:type==='circle'?'圆形':'矩形',x:Math.round((W-200)/2),y:Math.round((H-200)/2),w:200,h:200,color:'#f2634b',opacity:1};commit(d=>({...d,nodes:[...d.nodes,n]}));setSelectedId(n.id); }
  function changeLayer(direction) { const index=design.nodes.findIndex(n=>n.id===selectedId),dest=index+direction;if(dest<0||dest>=design.nodes.length)return; const nodes=[...design.nodes];[nodes[index],nodes[dest]]=[nodes[dest],nodes[index]];commit({...design,nodes}); }
  function startDrag(e, node) {
    if (preview || e.button !== 0) return; e.stopPropagation();setSelectedId(node.id); if(node.locked)return;
    e.currentTarget.setPointerCapture(e.pointerId);dragRef.current={kind:'move',id:node.id,startX:e.clientX,startY:e.clientY,x:node.x,y:node.y,origin:clone(designRef.current)};
  }
  function startResize(e, node, corner) {
    e.stopPropagation(); if (node.locked || preview) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current={kind:'resize',id:node.id,corner,startX:e.clientX,startY:e.clientY,x:node.x,y:node.y,w:node.w,h:node.h,size:node.size};
  }
  function moveDrag(e) {
    const drag=dragRef.current;if(!drag)return;
    const dx=(e.clientX-drag.startX)/(zoom/100),dy=(e.clientY-drag.startY)/(zoom/100);
    let patch;
    if(drag.kind==='resize'){
      const left=drag.corner.endsWith('l'),top=drag.corner.startsWith('t');
      const w=Math.max(24,Math.round(drag.w+(left?-dx:dx))),h=Math.max(24,Math.round(drag.h+(top?-dy:dy)));
      patch={x:left?drag.x+drag.w-w:drag.x,y:top?drag.y+drag.h-h:drag.y,w,h};
      if(drag.size)patch.size=Math.max(8,Math.min(240,Math.round(drag.size*w/drag.w)));
    }else patch={x:Math.round(drag.x+dx),y:Math.round(drag.y+dy)};
    apply({...designRef.current,nodes:designRef.current.nodes.map(n=>n.id===drag.id?{...n,...patch}:n)});
  }
  function endDrag() { if(!dragRef.current)return;const next=clone(designRef.current);dragRef.current=null;commit(next); }
  function applyTheme(theme) {
    const palette=theme==='sage'?{bg:'#dce3d8',fg:'#324b3b',accent:'#a4b65e'}:theme==='rose'?{bg:'#f3d9d3',fg:'#823e3b',accent:'#f2634b'}:{bg:'#f0e7d8',fg:'#323a2e',accent:'#f2634b'};
    commit(d=>({...d,background:palette.bg,nodes:d.nodes.map(n=>n.id==='title'||n.id==='subtitle'||n.id==='brand'?{...n,color:palette.fg}:n.id==='badge'?{...n,color:palette.accent}:n)}));notify('已应用模板配色，文字与图层继续保留');
  }
  async function upload(e) {
    const file=e.target.files?.[0];e.target.value='';if(!file)return;setUploadError('');
    if(!/^image\/(png|jpeg|webp)$/.test(file.type)){setUploadError('请选择 PNG、JPG 或 WebP 图片');return;}
    if(file.size>10*1024*1024){setUploadError('图片不能超过 10 MB');return;}
    try {
      const data=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=reject;reader.readAsDataURL(file);});
      const img=await loadImage(data),cv=document.createElement('canvas'),ratio=Math.min(1,1600/Math.max(img.width,img.height));cv.width=Math.round(img.width*ratio);cv.height=Math.round(img.height*ratio);cv.getContext('2d').drawImage(img,0,0,cv.width,cv.height);const src=cv.toDataURL('image/jpeg',.86);
      const photo=designRef.current.nodes.find(n=>n.id===selectedId&&n.type==='image')||designRef.current.nodes.find(n=>n.type==='image');
      if(photo){updateNode(photo.id,{src,label:file.name});setSelectedId(photo.id);}else{const node={id:uid(),type:'image',label:file.name,src,x:50,y:250,w:500,h:400,opacity:1};commit(d=>({...d,nodes:[...d.nodes,node]}));setSelectedId(node.id);}
      notify('图片已加入画布，仅保存在当前浏览器');
    } catch { setUploadError('无法读取这张图片，请换一张试试'); }
  }
  async function exportFile() {
    setExporting(true);setExportError('');
    try {
      if(format==='SVG'){
        const items=[];
        for(const n of design.nodes){if(n.hidden)continue;const opacity=n.opacity??1;
          if(n.type==='image')items.push(`<image href="${await imageData(n.src)}" x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" preserveAspectRatio="xMidYMid slice" opacity="${opacity}"/>`);
          else if(n.type==='text')items.push(`<text x="${n.x+(n.align==='center'?n.w/2:n.align==='right'?n.w:0)}" y="${n.y+n.size*.83}" fill="${n.color}" font-family="${esc(n.font||FONT)}" font-size="${n.size}" font-weight="${n.weight||400}" text-anchor="${n.align==='center'?'middle':n.align==='right'?'end':'start'}" opacity="${opacity}">${n.text.split('\n').map((line,i)=>`<tspan x="${n.x+(n.align==='center'?n.w/2:n.align==='right'?n.w:0)}" dy="${i?n.size*1.15:0}">${esc(line)}</tspan>`).join('')}</text>`);
          else if(n.type==='circle')items.push(`<ellipse cx="${n.x+n.w/2}" cy="${n.y+n.h/2}" rx="${n.w/2}" ry="${n.h/2}" fill="${n.color}" opacity="${opacity}"/>`);
          else items.push(`<rect x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" fill="${n.color}" opacity="${opacity}"/>`);
        }
        const source=`<svg xmlns="http://www.w3.org/2000/svg" width="${W*exportScale}" height="${H*exportScale}" viewBox="0 0 ${W} ${H}">${!transparent?`<rect width="${W}" height="${H}" fill="${design.background}"/>`:''}${items.join('')}</svg>`;
        download(new Blob([source],{type:'image/svg+xml;charset=utf-8'}),`${title||'Design-X'}.svg`);
      }else{
        const canvas=await renderDesign(design,exportScale,transparent&&format==='PNG');
        const blob=await new Promise(resolve=>canvas.toBlob(resolve,format==='JPG'?'image/jpeg':'image/png',.95));if(!blob)throw new Error('导出失败，请重新尝试');download(blob,`${title||'Design-X'}.${format.toLowerCase()}`);
      }
      setExportOpen(false);notify(`${format} 已导出 · ${W*exportScale} × ${H*exportScale} px`);
    }catch(error){setExportError(error.message||'导出失败，请重新尝试');}finally{setExporting(false);}
  }
  const setZoomValue=value=>{setAutoFit(false);setZoom(Math.max(20,Math.min(150,value)));};
  const nav=[{id:'templates',icon:LayoutTemplate,label:'模板'},{id:'text',icon:Type,label:'文字'},{id:'elements',icon:Shapes,label:'元素'},{id:'uploads',icon:Upload,label:'上传'},{id:'background',icon:Palette,label:'背景'},{id:'layers',icon:Layers,label:'图层'}];

  return <div className={`ed-root ${preview?'ed-preview':''} ${inspectorOpen?'ed-properties-open':''} ${leftOpen?'ed-left-open':''}`}>
    <header className="ed-header">
      <div className="ed-header-left"><IconButton icon={ArrowLeft} label="返回工作区" onClick={()=>{if(!saved&&!save())return;onBack?.();}}/><span className="ed-header-divider"/><span className="ed-mini-logo">x<span>✦</span></span><input className="ed-title-input" aria-label="作品名称" value={title} onChange={e=>{setTitle(e.target.value);setSaved(false);}}/><span className="ed-save-state"><Cloud size={15}/>{saved?'已保存':'有未保存更改'}</span></div>
      <div className="ed-header-right"><div className="ed-history-controls"><IconButton icon={Undo2} label="撤销" onClick={undo} disabled={historyIndex.current===0}/><IconButton icon={Redo2} label="重做" onClick={redo} disabled={historyIndex.current>=history.current.length-1}/></div><IconButton icon={Eye} label={preview?'结束预览':'预览作品'} onClick={()=>setPreview(!preview)} active={preview}/><IconButton icon={Settings2} label="显示属性面板" onClick={()=>setInspectorOpen(!inspectorOpen)} className="ed-inspector-toggle"/><button className="ed-button ed-save-button" onClick={save}><Save size={16}/>保存</button><button className="ed-button ed-primary" onClick={()=>setExportOpen(true)}><Download size={16}/>导出作品</button></div>
    </header>
    <div className="ed-body">
      <nav className="ed-tool-rail" aria-label="编辑工具">{nav.map(({id,icon:Icon,label})=><button key={id} className={tab===id?'is-active':''} onClick={()=>{setTab(id);setLeftOpen(true);}}><Icon size={21}/><span>{label}</span></button>)}<div className="ed-tool-rail-bottom"><span>DESIGN<br/>X STUDIO</span></div></nav>
      <aside className="ed-library">
        <div className="ed-panel-heading"><h2>{nav.find(n=>n.id===tab)?.label}</h2><IconButton icon={X} label="收起工具面板" onClick={()=>setLeftOpen(false)} className="ed-close-library"/></div>
        {tab==='templates'&&<><p className="ed-panel-description">一份灵感，许多种可能。</p><div className="ed-search-like"><LayoutTemplate size={15}/>精选咖啡海报 <span>3</span></div><div className="ed-template-grid">{[{id:'classic',label:'秋日咖啡',bg:'#f0e7d8',fg:'#323a2e'},{id:'sage',label:'自然慢生活',bg:'#dce3d8',fg:'#324b3b'},{id:'rose',label:'浪漫日常',bg:'#f3d9d3',fg:'#823e3b'}].map((t,i)=><button className={`ed-template-card ed-template-${i}`} key={t.id} onClick={()=>applyTheme(t.id)}><div style={{background:t.bg,color:t.fg}}><small>MORNING CLUB</small><strong>COFFEE</strong><span>慢一点，也很好。</span><img src="/assets/coffee.jpg" alt="咖啡海报模板"/><i style={{background:t.id==='sage'?'#a4b65e':'#f2634b'}}>秋日<br/>限定</i></div><span>{t.label}</span></button>)}</div><div className="ed-library-tip"><Sparkles size={17}/><div><strong>让设计有自己的风格</strong><p>模板配色可以一键切换，文字与图片都可自由修改。</p></div></div></>}
        {tab==='text'&&<><p className="ed-panel-description">用恰好的文字，说出你的想法。</p><button className="ed-add-text" onClick={()=>addText('添加标题',52)}><Plus size={17}/>添加文本</button><div className="ed-text-presets"><button onClick={()=>addText('这是一段主标题',52)} style={{fontSize:24,fontWeight:700}}>添加大标题</button><button onClick={()=>addText('有温度的设计，从这里开始',30)} style={{fontSize:17,fontWeight:500}}>添加副标题</button><button onClick={()=>addText('为你的作品补充一段说明文字',18)}>添加一段正文</button></div><h3 className="ed-small-heading">文字组合</h3><button className="ed-text-combo" onClick={()=>addText('GOOD\nTHINGS\nTAKE TIME.',64)}><strong>GOOD<br/>THINGS<br/>TAKE TIME.</strong><span>简约英文标题</span></button><button className="ed-text-combo ed-text-combo-cn" onClick={()=>addText('把灵感\n变成日常',58)}><strong>把灵感<br/>变成日常</strong><span>极简中文标题</span></button></>}
        {tab==='elements'&&<><p className="ed-panel-description">简单的形状，不简单的表达。</p><h3 className="ed-small-heading">基础形状</h3><div className="ed-shape-grid"><button aria-label="添加矩形" onClick={()=>addShape('rect')}><span className="ed-shape-square"/></button><button aria-label="添加圆形" onClick={()=>addShape('circle')}><span className="ed-shape-circle"/></button></div><h3 className="ed-small-heading">装饰文字</h3><div className="ed-decoration-grid">{['✦','✳','↗','✷'].map(symbol=><button key={symbol} onClick={()=>addText(symbol,96)}>{symbol}</button>)}</div><p className="ed-muted-note">添加后可在画布中拖动，并在属性面板调整尺寸、颜色和层级。</p></>}
        {tab==='uploads'&&<><p className="ed-panel-description">带上你的素材，开始新的创作。</p><button className="ed-upload-box" onClick={()=>fileRef.current?.click()}><Upload size={28}/><strong>点击上传图片</strong><span>PNG / JPG / WebP · 最大 10 MB</span></button>{uploadError&&<p className="ed-error" role="alert">{uploadError}</p>}<h3 className="ed-small-heading">当前画布素材</h3><div className="ed-upload-list">{design.nodes.filter(n=>n.type==='image').map(n=><button key={n.id} onClick={()=>setSelectedId(n.id)}><img src={n.src} alt={n.label||'画布图片'}/><span>{n.label||'图片素材'}</span></button>)}</div><p className="ed-muted-note">上传图片将替换选中的图片图层。素材仅用于此浏览器中的原型演示。</p></>}
        {tab==='background'&&<><p className="ed-panel-description">从一抹颜色开始。</p><h3 className="ed-small-heading">画布背景</h3><ColorPicker label="画布背景颜色" value={design.background} onChange={color=>commit(d=>({...d,background:color}))}/><h3 className="ed-small-heading">推荐色板</h3><div className="ed-palette-grid">{COLORS.map(color=><button key={color} aria-label={`设置背景为 ${color}`} style={{background:color}} onClick={()=>commit(d=>({...d,background:color}))}>{design.background===color&&<Check size={19} color={color==='#25272c'?'white':'#333'}/>}</button>)}</div><div className="ed-library-tip"><Palette size={17}/><div><strong>少一点颜色，多一点表达</strong><p>试试用一个主色、一个强调色，让作品更有呼吸感。</p></div></div></>}
        {tab==='layers'&&<><p className="ed-panel-description">选中图层，调整每一个细节。</p><div className="ed-layer-list">{[...design.nodes].reverse().map(n=><div key={n.id} className={`ed-layer-row ${n.id===selectedId?'is-active':''}`}><button className="ed-layer-main" onClick={()=>setSelectedId(n.id)}>{n.type==='image'?<img src={n.src} alt=""/>:n.type==='text'?<Type size={16}/>:<Square size={16}/>}<span>{n.text?.replace(/\n/g,' ')||n.label||'形状'}</span></button><button aria-label={`${n.hidden?'显示':'隐藏'}图层 ${n.text||n.label||'形状'}`} onClick={()=>updateNode(n.id,{hidden:!n.hidden})}>{n.hidden?<EyeOff size={14}/>:<Eye size={14}/>}</button><button aria-label={`${n.locked?'解锁':'锁定'}图层 ${n.text||n.label||'形状'}`} onClick={()=>updateNode(n.id,{locked:!n.locked})}>{n.locked?<Lock size={13}/>:<Unlock size={13}/>}</button></div>)}</div><p className="ed-muted-note">列表上方的图层显示在画布上层。通过右侧属性面板调整前后顺序。</p></>}
      </aside>
      <main className="ed-workspace">
        <div className="ed-canvas-toolbar"><div><span className="ed-page-label">第 1 页</span><span className="ed-size-label">{W} × {H} px</span><span className="ed-ratio-label">{ratio}</span></div><div><button onClick={()=>{setSelectedId(null);setTab('background');setLeftOpen(true);}}><Palette size={15}/>画布背景</button><IconButton icon={Maximize2} label="适应画布大小" onClick={()=>setAutoFit(true)}/></div></div>
        <div ref={stageRef} className="ed-stage" onPointerDown={e=>{if(e.target===e.currentTarget)setSelectedId(null);}}>
          <div className="ed-board-holder" style={{width:W*zoom/100,height:H*zoom/100}}>
            <div className="ed-board" aria-label="设计画布" style={{width:W,height:H,transform:`scale(${zoom/100})`,background:design.background}} onPointerDown={e=>{if(e.target===e.currentTarget)setSelectedId(null);}}>
              {design.nodes.filter(n=>!n.hidden).map(n=><div key={n.id} role="button" tabIndex={preview?-1:0} aria-label={`选中${n.type==='text'?'文字':'图层'}：${n.text||n.label||'形状'}`} className={`ed-node ${selectedId===n.id&&!preview?'ed-node-selected':''} ${n.locked?'ed-node-locked':''}`} style={{left:n.x,top:n.y,width:n.w,height:n.h,opacity:n.opacity??1,cursor:preview?'default':n.locked?'pointer':'move',fontFamily:n.font||FONT,fontSize:n.size,fontWeight:n.weight,lineHeight:1.15,color:n.color,textAlign:n.align||'left',background:n.type==='rect'||n.type==='circle'?n.color:'transparent',borderRadius:n.type==='circle'?'50%':0}} onPointerDown={e=>startDrag(e,n)} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag} onKeyDown={e=>{if(e.key==='Enter'){setSelectedId(n.id);setInspectorOpen(true);}}} onDoubleClick={()=>{setSelectedId(n.id);setInspectorOpen(true);}}>
                {n.type==='text'?n.text:n.type==='image'?<img src={n.src} alt={n.label||'画布主视觉'} draggable="false"/>:null}
                {selectedId===n.id&&!preview&&<><span className="ed-selection-label">{n.type==='text'?'文字':n.type==='image'?'图片':'形状'}{n.locked?' · 已锁定':''}</span>{!n.locked&&['tl','tr','bl','br'].map(corner=><i key={corner} className={`ed-handle ${corner}`} onPointerDown={e=>startResize(e,n,corner)}/>)}</>}
              </div>)}
            </div>
          </div>
          {preview&&<button className="ed-end-preview" onClick={()=>setPreview(false)}><X size={15}/>结束预览</button>}
        </div>
        <div className="ed-bottom-bar"><div className="ed-page-strip"><div className="ed-page-thumbnail" style={{background:design.background}}><span>{design.nodes.find(n=>n.id==='title')?.text?.split('\n')[0]||'DESIGN'}</span>{design.nodes.find(n=>n.type==='image')&&<img src={design.nodes.find(n=>n.type==='image').src} alt="第 1 页缩略图"/>}</div><div><strong>第 1 页</strong><span>{W} × {H} px</span></div></div><div className="ed-zoom-controls"><IconButton icon={Minus} label="缩小画布" onClick={()=>setZoomValue(zoom-10)} disabled={zoom<=20}/><span>{zoom}%</span><IconButton icon={Plus} label="放大画布" onClick={()=>setZoomValue(zoom+10)} disabled={zoom>=150}/><span className="ed-zoom-divider"/><button onClick={()=>setAutoFit(true)}>适应</button></div></div>
      </main>
      <aside className="ed-properties"><div className="ed-properties-heading"><h2>{selected?selected.type==='text'?'文字属性':selected.type==='image'?'图片属性':'形状属性':'画布属性'}</h2><IconButton icon={Settings2} label="收起属性面板" onClick={()=>setInspectorOpen(false)} className="ed-close-properties"/></div>
        {selected?<><div className="ed-property-section"><div className="ed-selected-label">{selected.type==='text'?<Type size={15}/>:selected.type==='image'?<ImagePlus size={15}/>:<Shapes size={15}/>}<span>{selected.type==='text'?'编辑文字内容':selected.label||'选中图层'}</span><button aria-label={selected.locked?'解锁选中图层':'锁定选中图层'} onClick={()=>updateNode(selected.id,{locked:!selected.locked})}>{selected.locked?<Lock size={14}/>:<Unlock size={14}/>}</button></div>{selected.type==='text'&&<textarea className="ed-text-content" aria-label="文字内容" value={selected.text} onChange={e=>updateNode(selected.id,{text:e.target.value,h:Math.max(selected.size*1.15,e.target.value.split('\n').length*selected.size*1.15)})} rows={3}/>} {selected.type==='image'&&<><img className="ed-property-image" src={selected.src} alt="选中图片预览"/><button className="ed-button ed-replace-image" onClick={()=>fileRef.current?.click()}><Upload size={15}/>替换图片</button></>}</div>
          {selected.type==='text'&&<div className="ed-property-section"><h3>字体与排版</h3><select className="ed-select ed-font-select" aria-label="字体" value={selected.font||FONT} onChange={e=>updateNode(selected.id,{font:e.target.value})}><option value={FONT}>苹方 · 简体中文</option><option value="Georgia, serif">Georgia · 经典衬线</option><option value="'Songti SC', SimSun, serif">宋体 · 人文衬线</option><option value="'Helvetica Neue', sans-serif">Helvetica · 现代无衬线</option></select><div className="ed-property-row"><select className="ed-select" aria-label="字重" value={selected.weight||400} onChange={e=>updateNode(selected.id,{weight:Number(e.target.value)})}><option value={400}>常规</option><option value={500}>中等</option><option value={600}>半粗</option><option value={700}>粗体</option><option value={800}>特粗</option></select><label className="ed-number-field"><span>字号</span><input aria-label="字号" type="number" min="8" max="240" value={selected.size} onChange={e=>updateNode(selected.id,{size:Math.max(8,Math.min(240,Number(e.target.value)||8))})}/></label></div><div className="ed-align-controls">{[{value:'left',label:'左对齐',symbol:'☰'},{value:'center',label:'居中',symbol:'☷'},{value:'right',label:'右对齐',symbol:'☰'}].map(a=><button key={a.value} aria-label={a.label} className={(selected.align||'left')===a.value?'is-active':''} onClick={()=>updateNode(selected.id,{align:a.value})}><span style={{textAlign:a.value}}>{a.symbol}</span></button>)}</div><div className="ed-labeled-color"><span>文字颜色</span><ColorPicker label="文字颜色" value={selected.color} onChange={color=>updateNode(selected.id,{color})}/></div></div>}
          {selected.type!=='text'&&selected.type!=='image'&&<div className="ed-property-section"><h3>填充颜色</h3><ColorPicker label="形状颜色" value={selected.color} onChange={color=>updateNode(selected.id,{color})}/></div>}
          <div className="ed-property-section"><h3>位置与尺寸 <Move size={13}/></h3><div className="ed-property-grid">{[['x','X'],['y','Y'],['w','宽'],['h','高']].map(([key,label])=><label className="ed-number-field" key={key}><span>{label}</span><input aria-label={`${label==='宽'?'宽度':label==='高'?'高度':`${label}位置`}`} type="number" value={Math.round(selected[key])} onChange={e=>updateNode(selected.id,{[key]:key==='w'||key==='h'?Math.max(10,Number(e.target.value)||10):Number(e.target.value)||0})}/></label>)}</div><div className="ed-opacity-label"><span>不透明度</span><span>{Math.round((selected.opacity??1)*100)}%</span></div><input className="ed-range" aria-label="不透明度" type="range" min="0" max="100" value={(selected.opacity??1)*100} onChange={e=>updateNode(selected.id,{opacity:Number(e.target.value)/100})}/></div>
          <div className="ed-property-section"><h3>图层操作</h3><div className="ed-layer-actions"><button onClick={()=>changeLayer(1)} disabled={design.nodes.at(-1)?.id===selectedId}><ChevronUp size={15}/>上移一层</button><button onClick={()=>changeLayer(-1)} disabled={design.nodes[0]?.id===selectedId}><ChevronDown size={15}/>下移一层</button><button onClick={duplicateSelected}><Copy size={15}/>复制图层</button><button className="ed-delete-layer" onClick={deleteSelected} disabled={selected.locked}><Trash2 size={15}/>删除图层</button></div></div>
        </>:<><div className="ed-property-section"><h3>画布信息</h3><div className="ed-canvas-info"><span>宽度</span><strong>{W} px</strong><span>高度</span><strong>{H} px</strong><span>比例</span><strong>{ratio}</strong></div></div><div className="ed-property-section"><h3>背景颜色</h3><ColorPicker value={design.background} onChange={color=>commit(d=>({...d,background:color}))}/></div><div className="ed-inspector-empty"><Move size={28}/><strong>每个细节，都可以调整</strong><p>选择画布中的文字、图片或形状，开始编辑。</p></div></>}
        <div className="ed-editor-hint"><span>⌘ S</span>保存设计<span>⌘ Z</span>撤销操作</div>
      </aside>
    </div>
    <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={upload}/>
    {exportOpen&&<div className="ed-modal-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget&&!exporting)setExportOpen(false);}}><section className="ed-export-modal" role="dialog" aria-modal="true" aria-labelledby="ed-export-title"><div className="ed-modal-header"><div><span className="ed-modal-eyebrow">READY TO SHARE</span><h2 id="ed-export-title">让好设计，被看见。</h2></div><IconButton icon={X} label="关闭导出弹窗" onClick={()=>setExportOpen(false)} disabled={exporting}/></div><p className="ed-export-description">导出高清作品，带着灵感去往更多地方。</p><label className="ed-export-label">文件格式</label><div className="ed-format-options">{[{name:'PNG',text:'高清图片 · 推荐'},{name:'JPG',text:'轻量分享'},{name:'SVG',text:'可编辑矢量'}].map(f=><button key={f.name} className={format===f.name?'is-active':''} onClick={()=>{setFormat(f.name);if(f.name==='JPG')setTransparent(false);}}><strong>{f.name}</strong><span>{f.text}</span>{format===f.name&&<Check size={15}/>}</button>)}</div><label className="ed-export-label" htmlFor="ed-export-resolution">导出尺寸</label><select className="ed-select" id="ed-export-resolution" value={exportScale} onChange={e=>setExportScale(Number(e.target.value))}><option value={1}>原始尺寸 · {W} × {H} px</option><option value={2}>2 倍高清 · {W*2} × {H*2} px</option><option value={3}>3 倍超清 · {W*3} × {H*3} px</option></select><label className="ed-checkbox-label"><input type="checkbox" checked={transparent} disabled={format==='JPG'} onChange={e=>setTransparent(e.target.checked)}/><span>透明画布背景</span><small>{format==='JPG'?'JPG 不支持透明背景':'保留图片及所有图层'}</small></label><div className="ed-export-summary"><Layers size={17}/><span>第 1 页 · {design.nodes.filter(n=>!n.hidden).length} 个可见图层</span><span>{W*exportScale} × {H*exportScale}</span></div>{exportError&&<p role="alert" className="ed-error">{exportError}</p>}<button className="ed-button ed-primary ed-export-submit" onClick={exportFile} disabled={exporting}>{exporting?<><span className="ed-spinner"/>正在准备作品…</>:<><Download size={18}/>导出 {format}</>}</button><p className="ed-export-footnote">文件保存在你的设备中，无水印。</p></section></div>}
  </div>;
}
