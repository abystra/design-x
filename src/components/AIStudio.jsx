import React, {useEffect, useMemo, useRef, useState} from 'react';
import {ArrowLeft, ArrowUp, ArrowUpRight, Check, ChevronDown, ChevronRight, Download, Expand, FolderOpen, Hand, History, ImagePlus, Images, LoaderCircle, MessageSquare, Minus, MousePointer2, Plus, Save, Search, Sparkles, Square, WandSparkles, X, Video, Bot, Library, PanelLeftClose, PanelLeftOpen, RotateCcw} from 'lucide-react';
import catalog from '../data/catalog.json';
import {buildBrief, buildStudioResults, resolveStudioBrief} from '../lib/studioModel.js';
import {encodeStudioSession} from '../lib/studioSession.js';
import './ai-studio.css';

const SAMPLES = [
 {name:'商品套图', category:'电商', image:'headphones', prompt:'为这款无线耳机设计 3 张电商商品图，突出轻盈、降噪和长续航，简洁绿色风格'},
 {name:'营销海报', category:'海报', image:'coffee', prompt:'为咖啡品牌设计 3 张秋日上新海报，温暖奶油色，标题“把秋天，装进一杯咖啡”'},
 {name:'爆款图复刻', category:'电商', image:'skincare', prompt:'为护肤新品做 3 张自然质感的推广图，突出植物精华与温和护肤'},
 {name:'换模特', category:'服饰', image:'fashion', prompt:'为秋季服饰设计 3 张穿搭展示方案，杂志风格，低饱和配色'},
 {name:'社媒图文笔记', category:'自媒体', image:'interior', prompt:'设计 3 张小红书家居图文封面，分享舒适自然的居家灵感'},
 {name:'剧情广告', category:'视频', image:'nature', prompt:'为自然旅行主题创作一组广告分镜，清新绿色，3 个关键镜头'}
];
const CATEGORIES=['推荐','最近使用','电商','海报','视频','自媒体','品牌','办公','服饰','图像'];
const STOCK=[['coffee','秋日咖啡'],['skincare','植物护肤'],['fashion','秋季服饰'],['headphones','无线耳机'],['interior','自然家居'],['nature','户外灵感']].map(([key,name])=>({id:key,name,url:`/assets/${key}.jpg`}));
const read=(key,fallback)=>{try{return JSON.parse(localStorage.getItem(key))??fallback}catch{return fallback}};
const uid=()=>`dx-${Date.now()}-${Math.random().toString(36).slice(2,6)}`;
const skillImage=s=>SAMPLES.find(x=>x.name===s.name)?.image||({电商:'skincare',海报:'coffee',视频:'nature',自媒体:'interior',品牌:'headphones',办公:'interior',服饰:'fashion',图像:'nature'})[s.category]||'coffee';
function IconButton({label,children,...props}){return <button className="st-icon" aria-label={label} title={label} {...props}>{children}</button>}
export function DesignPreview({project}){
 const design=project.design;if(!design)return <img src={project.image} alt={project.title}/>;
 return <div className="st-design" style={{aspectRatio:`${design.width}/${design.height}`,background:design.background}}><svg viewBox={`0 0 ${design.width} ${design.height}`} role="img" aria-label={project.title}>
  <defs><clipPath id={`clip-${project.id}`}><rect width={design.width} height={design.height}/></clipPath></defs>
  <g clipPath={`url(#clip-${project.id})`}>{design.nodes.filter(n=>!n.hidden).map(n=>n.type==='image'?<image key={n.id} href={n.src} x={n.x} y={n.y} width={n.w} height={n.h} preserveAspectRatio="xMidYMid slice" opacity={n.opacity??1}/>:n.type==='circle'?<ellipse key={n.id} cx={n.x+n.w/2} cy={n.y+n.h/2} rx={n.w/2} ry={n.h/2} fill={n.color} opacity={n.opacity??1}/>:n.type==='rect'?<rect key={n.id} x={n.x} y={n.y} width={n.w} height={n.h} fill={n.color} opacity={n.opacity??1}/>:<foreignObject key={n.id} x={n.x} y={n.y} width={n.w} height={n.h}><div xmlns="http://www.w3.org/1999/xhtml" style={{fontFamily:n.font||'PingFang SC, sans-serif',fontSize:n.size,fontWeight:n.weight,color:n.color,textAlign:n.align||'left',lineHeight:1.15,whiteSpace:'pre-wrap',overflowWrap:'anywhere',opacity:n.opacity??1}}>{n.text}</div></foreignObject>)}</g>
 </svg></div>
}
export default function AIStudio({session,onBack,onNew,onEdit,onSave,onToast,editedProject}){
 const snap=session.snapshot||{};
 const [title,setTitle]=useState(snap.title||'新创作');
 const [messages,setMessages]=useState((snap.messages||[]).map(m=>m.status==='running'?{...m,status:'cancelled',text:'上次创作已暂停，需求与素材已保留，可以继续生成。',retry:m.context?.brief?.prompt}:m));
 const [results,setResults]=useState(snap.results||[]);
 const [draft,setDraft]=useState(snap.draft||session.draft||'');
 const [skill,setSkill]=useState(snap.skill||session.skill||null);
 const [mode,setMode]=useState(snap.mode||session.mode||'Agent');
 const [assets,setAssets]=useState(snap.assets||session.assets||[]);
 const [attached,setAttached]=useState(snap.attached||session.assets||[]);
 const [ratio,setRatio]=useState(snap.ratio||'自动');
 const [count,setCount]=useState(snap.count||'自动');
 const [panel,setPanel]=useState(session.initialPrompt?null:session.panel===undefined?'skills':session.panel);
 const [category,setCategory]=useState('推荐');
 const [query,setQuery]=useState('');
 const [assetTab,setAssetTab]=useState('示例素材');
 const [recentSkills,setRecentSkills]=useState(()=>read('dx-studio-skills',[]));
 const [popover,setPopover]=useState(null);
 const [selected,setSelected]=useState(snap.selected||null);
 const [reference,setReference]=useState(snap.reference||null);
 const [running,setRunning]=useState(null);
 const [progress,setProgress]=useState(0);
 const [error,setError]=useState('');
 const [storageError,setStorageError]=useState(false);
 const [view,setView]=useState(snap.view||{x:70,y:140,zoom:1});
 const [tool,setTool]=useState('select');
 const [mobileView,setMobileView]=useState('chat');
 const [chatHidden,setChatHidden]=useState(false);
 const [showNew,setShowNew]=useState(false);
 const viewport=useRef(), chat=useRef(), input=useRef(), file=useRef(), drag=useRef(), generation=useRef(), boot=useRef(false), latest=useRef();
 const selectedResult=results.find(r=>r.id===selected);
 const referenceResult=results.find(r=>r.id===reference);
 const skillList=useMemo(()=>{
  let list=category==='最近使用'?recentSkills.map(id=>catalog.skills.find(s=>s.id===id)||SAMPLES.find(s=>s.name===id)).filter(Boolean):category==='推荐'?[...SAMPLES.map(s=>catalog.skills.find(c=>c.name===s.name)||s),...catalog.skills.filter(s=>!SAMPLES.some(x=>x.name===s.name)).slice(0,9)]:catalog.skills.filter(s=>s.category===category);
  return list.filter(s=>`${s.name}${s.description||''}`.includes(query));
 },[category,query,recentSkills]);
 const library=assetTab==='本次文件'?assets:assetTab==='我的资产'?read('designx-assets',[]).map(a=>({id:a.id,name:a.title||a.name,url:a.image||a.url})).filter(a=>a.url):assetTab==='创作参考'?read('designx-references',[]).map(a=>({id:a.id,name:a.title||a.name,url:a.image||a.url})).filter(a=>a.url):STOCK;
 latest.current={id:session.id,title,messages,results,draft,skill,mode,assets,attached,ratio,count,view,selected,reference};
 useEffect(()=>{try{localStorage.setItem('dx-ai-studio',encodeStudioSession(latest.current));setStorageError(false)}catch{setStorageError(true)}},[title,messages,results,draft,skill,mode,assets,attached,ratio,count,view,selected,reference]);
 useEffect(()=>{chat.current?.scrollTo({top:chat.current.scrollHeight,behavior:'smooth'})},[messages,progress]);
 useEffect(()=>()=>clearInterval(generation.current),[]);
 useEffect(()=>{if(editedProject)setResults(list=>list.map(r=>r.id===editedProject.id?{...r,...editedProject,position:r.position}:r))},[editedProject]);
 useEffect(()=>{if(session.initialPrompt&&!boot.current){boot.current=true;generate(session.initialPrompt)}},[]);
 useEffect(()=>{const onKey=e=>{if(e.key==='Escape'){setPanel(null);setPopover(null);setShowNew(false)}};window.addEventListener('keydown',onKey);return()=>window.removeEventListener('keydown',onKey)},[]);
 function togglePanel(next){setPanel(p=>p===next?null:next);setPopover(null);setMobileView('canvas')}
 function chooseSkill(s){setSkill(s);setPopover(null);setError('');setDraft(v=>v.replace(/\/[\w\u4e00-\u9fa5]*$/,''));const next=[s.id||s.name,...recentSkills.filter(id=>id!==(s.id||s.name))].slice(0,12);setRecentSkills(next);try{localStorage.setItem('dx-studio-skills',JSON.stringify(next))}catch{}input.current?.focus();setMobileView('chat')}
 function attachAsset(a){if(attached.some(x=>x.url===a.url))return;setAttached(v=>[...v,a].slice(-4));setAssets(v=>v.some(x=>x.url===a.url)?v:[...v,a]);setDraft(v=>v.replace(/@[^\s]*$/,''));setError('');setMobileView('chat');input.current?.focus()}
 async function upload(e){const files=[...e.target.files];e.target.value='';if(files.length)setMobileView('chat');for(const f of files.slice(0,4)){
  if(!['image/jpeg','image/png','image/webp'].includes(f.type)||f.size>5*1024*1024){setError('请选择 5 MB 以内的 JPG、PNG 或 WebP 图片');continue}
  try{const url=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=reject;r.readAsDataURL(f)});const a={id:uid(),name:f.name,url};setAssets(v=>[...v,a]);setAttached(v=>[...v,a].slice(-4));setPanel(null);setError('')}catch{setError('图片读取失败，请重新选择')}
 }}
 function fit(list=results){if(!list.length){setView({x:70,y:140,zoom:1});return}const bounds=viewport.current?.getBoundingClientRect();const minX=Math.min(...list.map(r=>r.position.x)),minY=Math.min(...list.map(r=>r.position.y));const maxX=Math.max(...list.map(r=>r.position.x+260)),maxY=Math.max(...list.map(r=>r.position.y+260*r.design.height/r.design.width+65));const w=bounds?.width||900,h=bounds?.height||700;const z=Math.max(.2,Math.min(1,(w-90)/(maxX-minX),(h-190)/(maxY-minY)));setView({x:(w-(maxX-minX)*z)/2-minX*z,y:100-minY*z,zoom:z})}
 function zoomBy(delta){setView(v=>{const z=Math.max(.2,Math.min(2,Math.round((v.zoom+delta)*100)/100));const w=viewport.current?.clientWidth||800,h=viewport.current?.clientHeight||700;return {zoom:z,x:w/2-(w/2-v.x)*z/v.zoom,y:h/2-(h/2-v.y)*z/v.zoom}})}
 function generate(text=draft,retryContext){if(generation.current)return;const prompt=text.trim();if(!prompt){setError('描述一下你想做的设计，或点击技能下方的示例需求');input.current?.focus();return}
  const previous=retryContext?.previous||referenceResult;const brief={...(retryContext?.brief||buildBrief({prompt,skill,mode,ratio:ratio==='自动'?undefined:ratio,count:count==='自动'?undefined:Number(count),assets:attached})),sessionId:session.id,turn:uid()};
  const effectiveBrief=resolveStudioBrief(brief,{previous,revision:previous?prompt:undefined});
  const id=uid();setMessages(m=>[...m,{id:uid(),role:'user',text:prompt,skill:brief.skill||skill?.name,assets:brief.assets,reference:previous?.title},{id,role:'assistant',text:effectiveBrief.summary,brief,status:'running',context:{brief,previous}}]);
  setRunning(id);setProgress(0);setDraft('');setAttached([]);setPanel(null);setPopover(null);setError('');if(title==='新创作')setTitle(brief.title||prompt.slice(0,18));
  let step=0;generation.current=setInterval(()=>{step++;setProgress(step);if(step<3)return;clearInterval(generation.current);generation.current=null;
   try{const generated=buildStudioResults(brief,{previous,revision:previous?prompt:undefined});const bottom=results.length?Math.max(...results.map(r=>r.position.y+260*r.design.height/r.design.width+110))+80:0;const rowHeight=Math.max(...generated.map(r=>260*r.design.height/r.design.width))+100;const placed=generated.map((r,i)=>({...r,position:{x:(i%3)*310,y:bottom+Math.floor(i/3)*rowHeight},persisted:false}));setResults(old=>[...old,...placed]);setSelected(placed[0]?.id);setReference(null);setMessages(m=>m.map(item=>item.id===id?{...item,status:'complete',context:undefined,resultIds:placed.map(r=>r.id),text:previous?'已保留原方案，并生成新的版本。可以在画布上对比，也可以继续调整。':`已准备好 ${placed.length} 个${brief.outputKind==='storyboard'?'静态分镜':'设计方案'}。选中画布上的方案，继续提要求或进入精细编辑。`}:item));setRunning(null);fit(placed);setMobileView('canvas')}
   catch{setMessages(m=>m.map(item=>item.id===id?{...item,status:'error',text:'这次方案没有完成，需求已保留，请重新尝试。',retry:prompt}:item));setRunning(null)}
  },700);
 }
 function cancel(){clearInterval(generation.current);generation.current=null;setMessages(m=>m.map(item=>item.id===running?{...item,status:'cancelled',text:'已停止本次生成。你可以补充需求，再继续创作。',retry:messages.findLast(m=>m.role==='user')?.text}:item));setRunning(null)}
 function referenceDesign(r){setSelected(r.id);setReference(r.id);setPanel(null);setMobileView('chat');input.current?.focus()}
 function saveDesign(r){if(onSave?.({...r,persisted:true})!==false)setResults(list=>list.map(x=>x.id===r.id?{...x,persisted:true}:x))}
 function startPointer(e,r){if(e.button!==0||e.target.closest('button,input,textarea,select'))return;e.currentTarget.setPointerCapture(e.pointerId);if(r&&tool==='select'){setSelected(r.id);drag.current={id:r.id,x:e.clientX,y:e.clientY,start:{...r.position}}}else{drag.current={x:e.clientX,y:e.clientY,start:{x:view.x,y:view.y}}}e.stopPropagation()}
 function movePointer(e){const d=drag.current;if(!d)return;const dx=e.clientX-d.x,dy=e.clientY-d.y;if(d.id)setResults(items=>items.map(r=>r.id===d.id?{...r,position:{x:d.start.x+dx/view.zoom,y:d.start.y+dy/view.zoom}}:r));else setView(v=>({...v,x:d.start.x+dx,y:d.start.y+dy}))}
 function samplePrompt(){return SAMPLES.find(s=>s.name===skill?.name)?.prompt||`使用${skill?.name||'营销海报'}，为我的新品设计 3 个简约自然的方案`}
 function addBlank(){const p={id:uid(),title:'自由画板',ratio:'3:4',type:'自由设计',persisted:false,design:{width:600,height:800,background:'#ffffff',nodes:[]},position:{x:results.length*80,y:0}};setResults(v=>[...v,p]);setSelected(p.id);setPanel(null);onEdit(p)}
 const panelTitle={skills:'技能',files:'文件',history:'创作记录',assets:'资产库',help:'画布操作'}[panel];
 return <div className={`ai-studio ${chatHidden?'st-chat-hidden':''} st-mobile-${mobileView}`}>
  <aside className="st-chat">
   <header className="st-chat-header"><button className="st-brand" onClick={onBack} title="返回首页"><span>✳</span><b>design<i>x</i></b></button><IconButton label="收起对话区" onClick={()=>setChatHidden(true)}><PanelLeftClose size={15}/></IconButton><button className={'st-skill-toggle '+(panel==='skills'?'active':'')} onClick={()=>togglePanel('skills')}><Sparkles size={13}/>技能<ChevronRight size={12}/></button></header>
   <div className="st-task-row"><input aria-label="当前创作名称" value={title} onChange={e=>setTitle(e.target.value)} maxLength={40}/><span>AI 创作</span><div><IconButton label="本次文件" onClick={()=>togglePanel('files')}><FolderOpen size={15}/></IconButton><IconButton label="创作记录" onClick={()=>togglePanel('history')}><History size={15}/></IconButton><IconButton label="新建创作" onClick={()=>setShowNew(true)}><Plus size={16}/></IconButton></div></div>
   <div className="st-conversation" ref={chat}>
    {!messages.length?<div className="st-greeting"><span className="st-greeting-symbol">✳</span><h1>你好，让灵感发生。</h1><p>从一个想法，开始一场自由创作</p><div className="st-starters">{SAMPLES.map(s=><button key={s.name} onClick={()=>chooseSkill(catalog.skills.find(c=>c.name===s.name)||s)}><img src={`/assets/${s.image}.jpg`} alt=""/><span>{s.name}</span><ArrowUpRight size={14}/></button>)}</div><button className="st-all-skills" onClick={()=>togglePanel('skills')}>探索全部技能 <ChevronRight size={14}/></button></div>:
     <div className="st-messages" aria-live="polite">{messages.map(m=><article className={`st-message st-message-${m.role}`} key={m.id}>{m.role==='assistant'&&<div className="st-assistant-label"><span>✳</span><b>Design X</b><small>创作助手</small></div>}{m.skill&&<div className="st-message-context"><Sparkles size={11}/>{m.skill}</div>}{m.reference&&<div className="st-message-context">↳ {m.reference}</div>}{m.assets?.length>0&&<div className="st-message-images">{m.assets.map(a=><img key={a.id} src={a.url} alt={a.name}/>)}</div>}<p>{m.text}</p>{m.status==='running'&&<div className="st-progress">{['理解需求与素材','构思配色与版式','将设计放入画布'].map((s,i)=><div key={s} className={progress>i?'done':progress===i?'current':''}>{progress>i?<Check size={13}/>:progress===i?<LoaderCircle size={13} className="st-spin"/>:<span/>}{s}</div>)}</div>}{m.status==='complete'&&<><button className="st-result-link" onClick={()=>{fit(results.filter(r=>m.resultIds.includes(r.id)));setPanel(null);setMobileView('canvas')}}><Images size={15}/>{m.resultIds.length} 个方案已放入画布<ArrowUpRight size={14}/></button><small className="st-demo-note">规则排版演示 · 可精细编辑</small></>}{m.retry&&<button className="st-result-link" disabled={!!running} onClick={()=>generate(m.retry,m.context)}><RotateCcw size={14}/>重新生成</button>}</article>)}</div>}
   </div>
   <div className="st-composer-area">
    {referenceResult&&<div className="st-reference"><img src={referenceResult.image} alt=""/><span>基于此方案继续<small>{referenceResult.title}</small></span><IconButton label="取消引用方案" onClick={()=>setReference(null)}><X size={13}/></IconButton></div>}
    {skill&&!messages.length&&<button className="st-prompt-suggestion" onClick={()=>{setDraft(samplePrompt());input.current?.focus()}}><WandSparkles size={13}/><span>试试：{samplePrompt()}</span><ArrowUpRight size={12}/></button>}
    <div className="st-composer">
     {skill&&<div className="st-selected-skill"><Sparkles size={12}/>{skill.name}<button aria-label="移除当前技能" onClick={()=>setSkill(null)}><X size={11}/></button></div>}
     {attached.length>0&&<div className="st-attachments">{attached.map(a=><div key={a.id}><img src={a.url} alt={a.name}/><span>{a.name}</span><button aria-label={`移除素材 ${a.name}`} onClick={()=>setAttached(v=>v.filter(x=>x.id!==a.id))}><X size={11}/></button></div>)}</div>}
     <textarea ref={input} value={draft} maxLength={3000} aria-label="告诉 AI 你的设计需求" placeholder={referenceResult?'描述你想调整的地方，例如：换成暖色，标题更醒目…':'描述你的设计想法…\n输入 / 选择技能，@ 引用素材'} onChange={e=>{const v=e.target.value;setDraft(v);setError('');if(v.endsWith('/')){setQuery('');setPopover('skills')};if(v.endsWith('@')){setPanel('assets');setAssetTab('示例素材');setMobileView('canvas')}}} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing){e.preventDefault();generate()}}}/>
     <div className="st-composer-options"><select aria-label="生成比例" value={ratio} onChange={e=>setRatio(e.target.value)}>{['自动','3:4','1:1','16:9','9:16','4:3'].map(v=><option key={v} value={v}>{v==='自动'?'比例自动':v}</option>)}</select><select aria-label="方案数量" value={count} onChange={e=>setCount(e.target.value)}><option value="自动">数量自动</option>{[1,2,3,4,6].map(n=><option key={n} value={n}>{n} 个方案</option>)}</select></div>
     <div className="st-composer-actions"><button className="st-add" onClick={()=>file.current?.click()}><Plus size={16}/>添加</button><IconButton label="引用资产" onClick={()=>togglePanel('assets')}><Library size={16}/></IconButton><IconButton label="快捷选择技能" onClick={()=>{setQuery('');setPopover(v=>v==='skills'?null:'skills')}}><Sparkles size={15}/></IconButton><button className="st-mode-button" aria-label="切换创作模式" onClick={()=>setPopover(v=>v==='mode'?null:'mode')}>{mode==='Agent'?<Bot size={15}/>:mode==='图片生成'?<Images size={15}/>:<Video size={15}/>}<span>{mode}</span><ChevronDown size={10}/></button>{running?<button className="st-send is-stop" onClick={cancel} aria-label="停止生成"><Square size={13} fill="currentColor"/></button>:<button className="st-send" disabled={!draft.trim()} onClick={()=>generate()} aria-label="发送设计需求"><ArrowUp size={18}/></button>}</div>
     {popover==='mode'&&<div className="st-popover st-mode-popover">{[['Agent',Bot,'自动规划创作'],['图片生成',Images,'图片与视觉方案'],['视频生成',Video,'故事分镜预览']].map(([m,I,t])=><button key={m} onClick={()=>{setMode(m);setPopover(null)}}><I size={16}/><span>{m}<small>{t}</small></span>{mode===m&&<Check size={14}/>}</button>)}</div>}
     {popover==='skills'&&<div className="st-popover st-quick-skills"><div className="st-quick-search"><Search size={14}/><input aria-label="快捷搜索技能" placeholder="搜索技能" value={query} onChange={e=>setQuery(e.target.value)}/><button onClick={()=>{setPanel('skills');setPopover(null);setMobileView('canvas')}}>全部<ChevronRight size={12}/></button></div><div>{catalog.skills.filter(s=>!query||s.name.includes(query)).slice(0,10).map(s=><button key={s.id} onClick={()=>chooseSkill(s)}><Sparkles size={13}/>{s.name}{skill?.name===s.name&&<Check size={13}/>}</button>)}</div></div>}
    </div>
    {error&&<p className="st-error" role="alert">{error}</p>}<div className="st-composer-footnote"><span>交互演示 · 未接入真实 AI 模型</span><span>Shift ↵ 换行</span></div>
   </div>
  </aside>
  <main className={`st-canvas ${tool==='hand'?'st-pan':''}`} ref={viewport} onPointerDown={e=>startPointer(e)} onPointerMove={movePointer} onPointerUp={()=>drag.current=null} onPointerCancel={()=>drag.current=null}>
   <div className="st-canvas-top"><div className="st-canvas-top-left">{chatHidden&&<IconButton label="展开对话区" onClick={()=>setChatHidden(false)}><PanelLeftOpen size={18}/></IconButton>}<button onClick={onBack} className="st-back"><ArrowLeft size={14}/>工作空间</button><span className="st-board-name">{title}</span></div><div className="st-board-actions"><span className={storageError?'st-storage-warning':''}>{storageError?'本地存储已满':'本地草稿'}</span><span className="st-avatar">Y</span><button className="st-export" disabled={!selectedResult} onClick={()=>onEdit(selectedResult)}><Download size={14}/><span>编辑与导出</span></button></div></div>
   {!results.length&&!running&&<div className="st-empty-canvas"><span className="st-empty-symbol">✳</span><span className="st-overline">A SPACE FOR YOUR IDEAS</span><h2>好想法，自由生长。</h2><p>聊一聊灵感，让你的第一份设计在这里发生。</p><div><button onClick={()=>{setPanel(null);setMobileView('chat');input.current?.focus()}}><span><Sparkles size={19}/></span><b>对话创作<small>从一句话，到一整套方案</small></b><ChevronRight size={16}/></button><button onClick={()=>file.current?.click()}><span><ImagePlus size={19}/></span><b>带上你的素材<small>上传产品图，开始新的创作</small></b><ChevronRight size={16}/></button></div><button className="st-blank-link" onClick={addBlank}>也可以从自由画板开始 <ArrowUpRight size={12}/></button></div>}
   {running&&!results.length&&<div className="st-canvas-loading"><div className="st-orbit">✳</div><h2>正在为想法寻找形状</h2><p>{['理解你的创作需求','准备配色与布局','即将放入画布'][Math.min(progress,2)]}</p><span>演示生成</span></div>}
   <div className="st-world" style={{transform:`translate(${view.x}px,${view.y}px) scale(${view.zoom})`}}>{results.map((r,i)=><article key={r.id} className={`st-result ${selected===r.id?'is-selected':''}`} style={{left:r.position.x,top:r.position.y}} onPointerDown={e=>startPointer(e,r)} onDoubleClick={()=>onEdit(r)}><div className="st-result-label"><span>{String(i+1).padStart(2,'0')} / {r.label||r.title}</span><b>V{r.version||1}</b></div><button className="st-design-select" aria-label={`选中方案 ${i+1} ${r.title}`} onClick={()=>setSelected(r.id)}><DesignPreview project={r}/></button><div className="st-result-caption"><span>{r.ratio} · {r.design.width} × {r.design.height}</span><IconButton label={`引用方案 ${i+1}`} onClick={()=>referenceDesign(r)}><MessageSquare size={14}/></IconButton></div>{selected===r.id&&<div className="st-result-actions"><button onClick={()=>referenceDesign(r)}><WandSparkles size={13}/>继续修改</button><button onClick={()=>onEdit(r)}><Expand size={13}/>精细编辑</button><IconButton label={`保存方案 ${i+1}`} onClick={()=>saveDesign(r)}>{r.persisted?<Check size={14}/>:<Save size={14}/>}</IconButton></div>}</article>)}</div>
   {selectedResult&&!panel&&!running&&<div className="st-refine-bar"><Sparkles size={14}/><span>让它更合心意</span>{['换成暖色调','调整为 1:1','标题更简洁'].map(text=><button key={text} onClick={()=>{referenceDesign(selectedResult);setDraft(text)}}>{text}<ArrowUpRight size={11}/></button>)}</div>}
   <div className="st-canvas-tools"><IconButton label="选择与移动方案" className={'st-icon '+(tool==='select'?'active':'')} onClick={()=>setTool('select')}><MousePointer2 size={17}/></IconButton><IconButton label="拖动画布" className={'st-icon '+(tool==='hand'?'active':'')} onClick={()=>setTool('hand')}><Hand size={17}/></IconButton><i/><IconButton label="新建自由画板" onClick={addBlank}><Plus size={18}/></IconButton><IconButton label="添加图片素材" onClick={()=>file.current?.click()}><ImagePlus size={18}/></IconButton></div>
   <div className="st-zoom"><IconButton label="缩小画布" disabled={view.zoom<=.2} onClick={()=>zoomBy(-.1)}><Minus size={15}/></IconButton><span>{Math.round(view.zoom*100)}%</span><IconButton label="放大画布" disabled={view.zoom>=2} onClick={()=>zoomBy(.1)}><Plus size={15}/></IconButton><i/><IconButton label="适应所有方案" onClick={()=>fit()}><Expand size={16}/></IconButton></div>
   {results.length>0&&<span className="st-canvas-count">{results.length} 个方案 · 拖动标题调整位置</span>}
   {panel&&<section className={`st-panel st-panel-${panel}`} aria-label={panelTitle} onPointerDown={e=>e.stopPropagation()}><div className="st-panel-heading"><h2>{panelTitle}{panel==='skills'&&<small>发现你的下一个可能</small>}</h2><IconButton label="关闭侧边面板" onClick={()=>setPanel(null)}><X size={18}/></IconButton></div>
    {panel==='skills'&&<><div className="st-panel-tabs">{CATEGORIES.map(c=><button key={c} className={category===c?'active':''} onClick={()=>setCategory(c)}>{['电商','海报','品牌','办公'].includes(c)?c+'设计':c==='视频'?'视频创作':c}</button>)}</div><div className="st-skill-search"><Search size={15}/><input aria-label="搜索工作区技能" placeholder="搜索你想完成的事" value={query} onChange={e=>setQuery(e.target.value)}/>{query&&<button aria-label="清空技能搜索" onClick={()=>setQuery('')}><X size={13}/></button>}<span>{skillList.length} 个技能</span></div><div className="st-panel-scroll"><div className="st-skill-grid">{skillList.map((s,i)=><button key={s.id||s.name} className={'st-skill-card '+(skill?.name===s.name?'selected':'')} onClick={()=>chooseSkill(s)}><div className={`st-skill-art st-skill-art-${s.category}`}><img src={`/assets/${skillImage(s)}.jpg`} alt="" loading="lazy"/><span className="st-card-editorial">{s.category==='海报'?'MAKE IT\nMATTER.':s.category==='品牌'?'A NEW\nIDENTITY.':s.category==='办公'?'Ideas,\nin order.':''}</span>{i<2&&<small>精选</small>}<span className="st-card-cta">{skill?.name===s.name?<><Check size={12}/>已添加</>:<>添加到对话<Plus size={12}/></>}</span></div><div className="st-skill-info"><strong>{s.name}</strong><p>{s.description||s.prompt}</p></div></button>)}</div>{!skillList.length&&<div className="st-panel-empty"><Search size={28}/><h3>{category==='最近使用'?'还没有使用过的技能':'没有找到这个技能'}</h3><p>试试推荐技能，或换个关键词</p><button onClick={()=>{setCategory('推荐');setQuery('')}}>查看推荐</button></div>}<div className="st-panel-bottom"><span>65 种技能，让创作少一点门槛。</span><Sparkles size={15}/></div></div></>}
    {(panel==='assets'||panel==='files')&&<>{panel==='assets'&&<div className="st-panel-tabs">{['示例素材','本次文件','我的资产','创作参考'].map(t=><button key={t} className={assetTab===t?'active':''} onClick={()=>setAssetTab(t)}>{t}</button>)}</div>}<div className="st-panel-scroll"><button className="st-upload-area" onClick={()=>file.current?.click()}><ImagePlus size={25}/><b>上传素材，给灵感一个参照</b><span>JPG / PNG / WebP · 每张不超过 5 MB</span></button><div className="st-asset-grid">{(panel==='files'?assets:library).map(a=><button key={a.id} onClick={()=>attachAsset(a)}><div><img src={a.url} alt={a.name}/><span><Plus size={13}/>引用到对话</span></div><b>{a.name}</b>{attached.some(x=>x.url===a.url)&&<Check size={13}/>}</button>)}</div>{!(panel==='files'?assets:library).length&&<div className="st-panel-empty"><Images size={30}/><h3>这里还没有素材</h3><p>上传图片后，可以在对话中随时引用</p></div>}</div></>}
    {panel==='history'&&<div className="st-panel-scroll">{messages.filter(m=>m.role==='user').length?<div className="st-history-list">{messages.filter(m=>m.role==='user').map((m,i)=><button key={m.id} onClick={()=>{setDraft(m.text);setPanel(null);setMobileView('chat');input.current?.focus()}}><span>{String(i+1).padStart(2,'0')}</span><div><b>{m.text}</b><small>{m.skill||'自由创作'} · 复用这次需求</small></div><ArrowUpRight size={15}/></button>)}</div>:<div className="st-panel-empty"><MessageSquare size={34}/><h3>让第一段对话从这里开始</h3><p>本次创作的每一步，都会留在这里</p></div>}</div>}
   </section>}
  </main>
  <nav className="st-mobile-tabs"><button className={mobileView==='chat'?'active':''} onClick={()=>setMobileView('chat')}><MessageSquare size={16}/>对话</button><button className={mobileView==='canvas'?'active':''} onClick={()=>setMobileView('canvas')}><Images size={16}/>画布{results.length?` · ${results.length}`:''}</button></nav>
  {showNew&&<div className="st-dialog-shade"><section role="dialog" aria-modal="true" aria-label="开始新的创作"><span className="st-greeting-symbol">✳</span><h2>给新的想法，一个空间。</h2><p>新建会替换当前本地会话。需要保留的方案，请先保存到我的项目。</p><button className="st-primary" onClick={onNew}>开始新创作 <ArrowUpRight size={16}/></button><button onClick={()=>setShowNew(false)}>继续当前创作</button></section></div>}
  <input type="file" accept="image/png,image/jpeg,image/webp" multiple hidden ref={file} onChange={upload}/>
 </div>
}
