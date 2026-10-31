import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDownWideNarrow, ArrowLeft, ArrowUpRight, Check, CheckCircle2, ChevronDown, ChevronRight, Folder, FolderPlus, Grid2X2, Heart, Image, Layers, List, MoreHorizontal, Palette, Pencil, Plus, RotateCcw, Search, Sparkles, Trash2, Upload, X } from 'lucide-react';
import { api, uploadAsset } from '../lib/api';
import DesignThumbnail from './DesignThumbnail';
import './workspace.css';

const stockAssets = [
  { id: 'stock-coffee', title: '一杯咖啡的慢时光', image: '/assets/coffee.jpg', type: '图片', category: '生活方式', color: '#8b6148' },
  { id: 'stock-skincare', title: '自然本真 · 护肤产品', image: '/assets/skincare.jpg', type: '图片', category: '产品摄影', color: '#e8cbb8' },
  { id: 'stock-interior', title: '留白之间的生活', image: '/assets/interior.jpg', type: '图片', category: '家居空间', color: '#d3c6b0' },
  { id: 'stock-fashion', title: '秋日漫步 · 人像素材', image: '/assets/fashion.jpg', type: '图片', category: '时尚穿搭', color: '#a7aca3' },
];
const defaultBrand = { name: '拾光 SHIGUANG', subtitle: '让好设计，始终如一', colors: ['#F2634B', '#24362B', '#F3EDE2', '#FFFFFF'], font: '思源黑体', logoAssetId: '', description: '自然、温暖、有呼吸感。用细腻的视觉，记录日常的小美好。' };
function Thumb({ item, poster = false }) {
  const isCoffee = /coffee|咖啡|秋日/.test(`${item.image} ${item.title}`);
  return <div className={`ws-thumb ${poster ? 'ws-thumb-poster' : ''}`} style={{ backgroundColor: item.color || '#e4dfd9' }}>
    {item.design ? <DesignThumbnail design={item.design} title={item.title} /> : item.image ? <img src={item.image} alt={item.title} loading="lazy" onError={e => { e.currentTarget.style.visibility = 'hidden'; }} /> : <Image size={36} strokeWidth={1} />}
    {poster && !item.design && !item.elements && <div className={`ws-poster-copy ${isCoffee ? 'coffee' : ''}`}><span>{isCoffee ? 'THE SLOW MOMENTS' : 'A LITTLE INSPIRATION'}</span><strong>{isCoffee ? <>慢一点，<br />也很好。</> : item.title?.slice(0, 8)}</strong><small>{isCoffee ? 'COFFEE & GOOD DAYS' : 'DESIGNED WITH INTENTION'}</small></div>}
  </div>;
}
function Dialog({ title, description, children, onClose, footer }) {
  const ref = useRef(null);
  useEffect(() => {
    const prev = document.activeElement;
    ref.current?.querySelector('input, button, select, textarea')?.focus();
    const onKey = e => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'Tab') {
        const nodes = [...(ref.current?.querySelectorAll('button,input,select,textarea,[tabindex="0"]') || [])].filter(n => !n.disabled);
        if (!nodes.length) return;
        if (e.shiftKey && document.activeElement === nodes[0]) { e.preventDefault(); nodes[nodes.length - 1].focus(); }
        else if (!e.shiftKey && document.activeElement === nodes[nodes.length - 1]) { e.preventDefault(); nodes[0].focus(); }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); prev?.focus?.(); };
  }, []);
  return <div className="ws-modal-shade" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}><section ref={ref} className="ws-modal" role="dialog" aria-modal="true" aria-label={title}><header><div><h2>{title}</h2>{description && <p>{description}</p>}</div><button className="ws-icon-btn" aria-label="关闭弹窗" onClick={onClose}><X size={20} /></button></header>{children}{footer && <footer>{footer}</footer>}</section></div>;
}
function Empty({ title, detail, onAction, action }) { return <div className="ws-empty"><div><Search size={25} strokeWidth={1.5} /></div><h3>{title}</h3><p>{detail}</p>{onAction && <button className="ws-secondary" onClick={onAction}>{action}</button>}</div>; }

export default function Workspace({ mode = 'projects', projects = [], onOpenProject, onToast, onCreateProject, onProjectsChanged }) {
  const isAssets = mode === 'assets';
  const isRecent = mode === 'recent';
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('全部');
  const [layout, setLayout] = useState('grid');
  const [sort, setSort] = useState('updated');
  const [folders, setFolders] = useState([]);
  const [trash, setTrash] = useState([]);
  const [folder, setFolder] = useState(null);
  const [menu, setMenu] = useState(null);
  const [dialog, setDialog] = useState(null);
  const [formValue, setFormValue] = useState('');
  const [formError, setFormError] = useState('');
  const [selectedFolder, setSelectedFolder] = useState('');
  const [assetTab, setAssetTab] = useState('素材');
  const [uploads, setUploads] = useState([]);
  const [references, setReferences] = useState([]);
  const [favorites, setFavorites] = useState([]);
  const [referencePrompt, setReferencePrompt] = useState('');
  const [referenceImage, setReferenceImage] = useState(stockAssets[0].image);
  const [brand, setBrand] = useState(defaultBrand);
  const [brandSaved, setBrandSaved] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState('');
  const fileRef = useRef(null);
  const callbacks = useRef({ onToast, onProjectsChanged });
  callbacks.current = { onToast, onProjectsChanged };
  const loadSequence = useRef(0);
  const loadData = useCallback(async () => {
    const sequence = ++loadSequence.current;
    setLoading(true); setLoadError('');
    try {
      const [folderData, assetData, referenceData, favoriteData, brandData, trashData] = await Promise.all([
        api('/folders'), api('/assets'), api('/preferences/references'),
        api('/preferences/asset-favorites'), api('/preferences/brand'), api('/projects?trash=1'),
      ]);
      if (sequence !== loadSequence.current) return;
      setFolders(folderData); setUploads(assetData); setTrash(trashData);
      setReferences(Array.isArray(referenceData) ? referenceData : []);
      setFavorites(Array.isArray(favoriteData) ? favoriteData : []);
      setBrand({ ...defaultBrand, ...(brandData || {}), colors: brandData?.colors?.length === 4 ? brandData.colors : defaultBrand.colors });
      setReady(true);
    } catch (error) {
      if (sequence !== loadSequence.current) return;
      setLoadError(error.message); callbacks.current.onToast?.(error.message);
    } finally { if (sequence === loadSequence.current) setLoading(false); }
  }, []);
  useEffect(() => {
    loadData();
    const refresh = () => loadData();
    window.addEventListener('designx:refresh', refresh);
    return () => { ++loadSequence.current; window.removeEventListener('designx:refresh', refresh); };
  }, [loadData]);
  useEffect(() => {
    if (!uploads.some(asset => asset.status && !['ready', 'failed'].includes(asset.status))) return;
    let active = true;
    const timer = setInterval(async () => {
      try { const assets = await api('/assets'); if (active) setUploads(assets); }
      catch (error) { if (active) { setLoadError(error.message); clearInterval(timer); } }
    }, 2000);
    return () => { active = false; clearInterval(timer); };
  }, [uploads]);
  useEffect(() => { setSearch(''); setFilter('全部'); setFolder(null); setMenu(null); }, [mode]);
  useEffect(() => {
    if (!menu) return;
    const close = e => { if (!e.target.closest('.ws-menu-wrap')) setMenu(null); };
    const escape = e => { if (e.key === 'Escape') setMenu(null); };
    document.addEventListener('pointerdown', close); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', escape); };
  }, [menu]);
  const isTrash = filter === '回收站';
  const items = useMemo(() => (isTrash ? trash : projects).filter(p => (isTrash || !folder || p.folderId === folder.id) && (!search || p.title?.toLowerCase().includes(search.toLowerCase())) && (filter === '全部' || isTrash || (filter === 'AI生成' ? /ai|生成/i.test(p.type || '') : !/ai|生成/i.test(p.type || '')))).sort((a, b) => sort === 'name' ? (a.title || '').localeCompare(b.title || '', 'zh-CN') : (isRecent ? (Number(b.lastOpenedAt) || Date.parse(b.lastOpenedAt) || 0) - (Number(a.lastOpenedAt) || Date.parse(a.lastOpenedAt) || 0) : (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0))), [projects, trash, folder, search, filter, sort, isRecent, isTrash]);
  const allAssets = [...uploads, ...stockAssets];
  const visibleAssets = (assetTab === '创作参考' ? references : assetTab === '我的收藏' ? [...allAssets, ...references].filter(a => favorites.includes(a.id)) : allAssets).filter(a => !search || `${a.title} ${a.category || ''} ${a.prompt || ''}`.toLowerCase().includes(search.toLowerCase()));
  async function perform(action) {
    if (busy || !ready) return false;
    setBusy(true); setFormError('');
    try { await action(); return true; }
    catch (error) { setFormError(error.message); onToast?.(error.message); return false; }
    finally { setBusy(false); }
  }
  const updateProject = (id, patch) => perform(async () => {
    await api(`/projects/${id}`, { method: 'PATCH', body: patch });
    await onProjectsChanged?.(); setDialog(null); onToast?.('作品已更新');
  });
  const openDialog = (type, item) => { setDialog({ type, item }); setFormValue(type === 'rename' ? item.title : type === 'rename-folder' ? item.name : ''); setFormError(''); setSelectedFolder(item?.folderId || ''); setMenu(null); };
  const toggleFavorite = id => perform(async () => {
    const next = favorites.includes(id) ? favorites.filter(x => x !== id) : [...favorites, id];
    await api('/preferences/asset-favorites', { method: 'PUT', body: next }); setFavorites(next);
  });
  const createFolder = e => {
    e.preventDefault(); const name = formValue.trim();
    if (!name) return setFormError('给文件夹起一个名字吧');
    if (folders.some(f => f.name === name && f.id !== dialog.item?.id)) return setFormError('已有同名文件夹，请换个名字');
    perform(async () => {
      if (dialog.type === 'rename-folder') {
        const updated = await api(`/folders/${dialog.item.id}`, { method: 'PATCH', body: { name } });
        setFolders(list => list.map(f => f.id === updated.id ? updated : f));
        if (folder?.id === updated.id) setFolder(updated);
      } else {
        const created = await api('/folders', { method: 'POST', body: { name, color: '#e6b49b' } });
        setFolders(list => [...list, created]);
      }
      setDialog(null); onToast?.('文件夹已保存');
    });
  };
  async function removeItem() {
    await perform(async () => {
      const item = dialog.item;
      if (dialog.type === 'delete-folder') {
        await api(`/folders/${item.id}`, { method: 'DELETE' });
        setFolders(list => list.filter(f => f.id !== item.id));
        if (folder?.id === item.id) setFolder(null);
        await onProjectsChanged?.();
      } else if (dialog.type === 'delete-project') {
        await api(`/projects/${item.id}`, { method: 'DELETE' });
        await onProjectsChanged?.(); setTrash(await api('/projects?trash=1'));
      } else if (dialog.type === 'delete-reference') {
        const next = references.filter(r => r.id !== item.id);
        await api('/preferences/references', { method: 'PUT', body: next }); setReferences(next);
      } else {
        await api(`/assets/${item.id}`, { method: 'DELETE' });
        setUploads(list => list.filter(a => a.id !== item.id));
      }
      setDialog(null); onToast?.(dialog.type === 'delete-project' ? '作品已移到回收站' : '已删除');
    });
  }
  const restoreProject = item => perform(async () => {
    await api(`/projects/${item.id}/restore`, { method: 'POST' });
    await onProjectsChanged?.(); setTrash(list => list.filter(p => p.id !== item.id));
    setMenu(null); onToast?.('作品已恢复');
  });
  const saveBrand = e => { e.preventDefault(); perform(async () => {
    await api('/preferences/brand', { method: 'PUT', body: brand });
    setBrandSaved(true); onToast?.('品牌套件已保存');
  }); };
  const createReference = e => {
    e.preventDefault();
    if (!formValue.trim() || !referencePrompt.trim()) return setFormError('请填写参考名称和创作提示');
    perform(async () => {
      const asset = allAssets.find(a => a.image === referenceImage);
      const next = [{ id: crypto.randomUUID(), title: formValue.trim(), prompt: referencePrompt.trim(), image: referenceImage, assetId: asset?.id, type: '创作参考', category: '我的参考' }, ...references];
      await api('/preferences/references', { method: 'PUT', body: next });
      setReferences(next); setDialog(null); setReferencePrompt(''); onToast?.('创作参考已保存');
    });
  };
  async function uploadFiles(e) {
    const files = Array.from(e.target.files || []); e.target.value = '';
    if (!files.length || uploading || !ready) return;
    let added = 0, rejected = 0;
    for (const file of files) {
      if (!/^image\/(jpeg|png|webp|gif)$/.test(file.type) || file.size > 10 * 1024 * 1024) { rejected++; continue; }
      setUploading(file.name);
      try { const asset = await uploadAsset(file); setUploads(list => [asset, ...list.filter(a => a.id !== asset.id)]); added++; }
      catch (error) { rejected++; onToast?.(error.message); }
    }
    setUploading('');
    if (added) { setAssetTab('素材'); onToast?.(`已上传 ${added} 张图片${rejected ? `，${rejected} 张未上传` : ''}`); }
    else if (rejected) onToast?.('上传未完成，请检查文件格式、10 MB 大小限制及网络状态');
  }
  const openAsset = item => { setDialog(null); onOpenProject?.({ id: `asset-design-${Date.now()}`, title: `${item.title} · 设计`, image: item.image, assetId: item.assetId || (item.id.startsWith('stock-') ? undefined : item.id), persisted: false, type: '设计作品', updatedAt: new Date().toISOString() }); };
  const title = isAssets ? '每一份灵感，都值得收藏' : isRecent ? '接着上次的灵感，继续创作' : '让好想法，有自己的位置';
  return <div className="ws-page" aria-busy={loading || busy}>
    {loading && <div className="ws-status" role="status">正在同步工作空间…</div>}
    {loadError && <div className="ws-status ws-error" role="alert"><span>{loadError}</span><button className="ws-secondary" onClick={loadData}>重新加载</button></div>}
    {uploading && <div className="ws-status" role="status">正在上传并处理 {uploading}…</div>}
    <div className="ws-page-heading"><div><div className="ws-eyebrow">{isAssets ? 'YOUR CREATIVE COLLECTION' : isRecent ? 'PICK UP WHERE YOU LEFT OFF' : 'YOUR CREATIVE WORKSPACE'}</div><h1>{title}<span>。</span></h1><p>{isAssets ? '汇集素材、创作参考和品牌规范，让下一次创作更轻松。' : isRecent ? '灵感不会中断，每一份作品都等着你来完善。' : '从最初的灵感，到完成的作品。在这里管理你的创作。'}</p></div><div className="ws-heading-actions">{isAssets ? <button className="ws-primary" disabled={!ready || !!uploading} onClick={() => fileRef.current?.click()}><Upload size={17} /> 上传素材</button> : <><button className="ws-secondary" disabled={!ready || busy} onClick={() => openDialog('folder')}><FolderPlus size={17} /> 新建文件夹</button><button className="ws-primary" onClick={() => onCreateProject?.()}><Plus size={18} /> 新建设计</button></>}</div></div>
    <input ref={fileRef} type="file" multiple accept="image/jpeg,image/png,image/webp,image/gif" className="ws-file-input" aria-label="上传素材图片" onChange={uploadFiles} />
    {isAssets ? <><div className="ws-section-tabs" role="tablist" aria-label="资产类型">{[{ name: '素材', icon: Image }, { name: '创作参考', icon: Sparkles }, { name: '品牌套件', icon: Palette }, { name: '我的收藏', icon: Heart }].map(({ name, icon: Icon }) => <button key={name} role="tab" aria-selected={assetTab === name} className={assetTab === name ? 'active' : ''} onClick={() => { setAssetTab(name); setSearch(''); }}><Icon size={17} />{name}{name === '素材' && <span>{allAssets.length}</span>}{name === '我的收藏' && favorites.length > 0 && <span>{favorites.length}</span>}</button>)}</div>
      {assetTab === '品牌套件' ? <div className="ws-brand-layout"><div className="ws-brand-preview" style={{ background: brand.colors[2], color: brand.colors[1], fontFamily: brand.font }}><div className="ws-brand-flag"><span style={{ background: brand.colors[0] }} /> BRAND IDENTITY / 01</div><div className="ws-brand-monogram" style={{ borderColor: brand.colors[1] }}>{uploads.find(a => a.id === brand.logoAssetId)?.image ? <img src={uploads.find(a => a.id === brand.logoAssetId).image} alt="品牌 Logo" /> : brand.name.slice(0, 1) || '字'}</div><h2>{brand.name || '你的品牌'}</h2><p>{brand.subtitle}</p><div className="ws-brand-preview-bottom"><span>{brand.description}</span><ArrowUpRight size={28} /></div></div><form className="ws-brand-form" onSubmit={saveBrand}><div className="ws-form-heading"><div><h3>品牌的每一面，都保持一致</h3><p>保存品牌规范，下次创作时随时查阅。</p></div><Palette size={23} /></div><label>品牌名称<input value={brand.name} maxLength={30} required onChange={e => { setBrand({ ...brand, name: e.target.value }); setBrandSaved(false); }} /></label><label>品牌标语<input value={brand.subtitle} maxLength={60} onChange={e => { setBrand({ ...brand, subtitle: e.target.value }); setBrandSaved(false); }} /></label><label>品牌色卡</label><div className="ws-colors">{brand.colors.map((color, i) => <label key={i} className="ws-color"><input type="color" aria-label={`品牌颜色 ${i + 1}`} value={color} onChange={e => { const colors = [...brand.colors]; colors[i] = e.target.value.toUpperCase(); setBrand({ ...brand, colors }); setBrandSaved(false); }} /><span>{color}</span><small>{['主品牌色', '文字色', '背景色', '辅助色'][i]}</small></label>)}</div><label>品牌字体<select value={brand.font} onChange={e => { setBrand({ ...brand, font: e.target.value }); setBrandSaved(false); }}>{['思源黑体', 'PingFang SC', 'Microsoft YaHei', 'Georgia'].map(font => <option key={font}>{font}</option>)}</select></label><label>品牌 Logo<select value={brand.logoAssetId || ''} onChange={e => { setBrand({ ...brand, logoAssetId: e.target.value }); setBrandSaved(false); }}><option value="">不使用 Logo</option>{uploads.filter(a => a.status === 'ready').map(a => <option key={a.id} value={a.id}>{a.title}</option>)}</select></label><label>品牌描述<textarea rows={3} value={brand.description} onChange={e => { setBrand({ ...brand, description: e.target.value }); setBrandSaved(false); }} /></label><button type="submit" disabled={busy || !ready} className="ws-primary">{brandSaved ? <Check size={16} /> : <CheckCircle2 size={16} />}{brandSaved ? '已保存品牌套件' : '保存品牌套件'}</button></form></div> : <><div className="ws-toolbar"><div className="ws-toolbar-label"><h2>{assetTab === '素材' ? '你的灵感素材' : assetTab === '创作参考' ? '可复用的创作配方' : '我的心动收藏'}</h2><span>{visibleAssets.length} 项</span></div><div className="ws-toolbar-controls"><label className="ws-search"><Search size={16} /><input value={search} onChange={e => setSearch(e.target.value)} placeholder="搜索素材、参考…" aria-label="搜索资产" /></label>{assetTab === '创作参考' && <button className="ws-secondary" onClick={() => openDialog('reference')}><Plus size={16} />新建参考</button>}</div></div>{!visibleAssets.length ? <Empty title={search ? '没有找到相关素材' : assetTab === '我的收藏' ? '把喜欢的灵感收进来' : '建立你的第一份创作参考'} detail={search ? '试试其他关键词，或查看全部素材。' : assetTab === '我的收藏' ? '点击素材上的爱心，喜欢的内容就会在这里相聚。' : '把常用提示词与参考图片放在一起，下次创作直接复用。'} onAction={search ? () => setSearch('') : assetTab === '我的收藏' ? () => setAssetTab('素材') : () => openDialog('reference')} action={search ? '清除搜索' : assetTab === '我的收藏' ? '发现素材' : '新建创作参考'} /> : <div className="ws-asset-grid">{visibleAssets.map(item => <article className="ws-asset-card" key={item.id}><button className="ws-asset-open" onClick={() => openDialog('preview', item)} aria-label={`预览 ${item.title}`}><Thumb item={item} /></button><button className={`ws-favorite ${favorites.includes(item.id) ? 'active' : ''}`} aria-label={`${favorites.includes(item.id) ? '取消收藏' : '收藏'} ${item.title}`} disabled={busy || !ready} onClick={() => toggleFavorite(item.id)}><Heart size={17} fill={favorites.includes(item.id) ? 'currentColor' : 'none'} /></button><div className="ws-card-meta"><h3>{item.title}</h3><span>{item.category || '创作参考'}<span className="ws-dot">·</span>{item.type || '参考'}</span></div>{item.status && item.status !== 'ready' && <p className="ws-asset-status" role="status">{item.status === 'failed' ? '处理失败，请删除后重新上传' : '正在处理素材…'}</p>}{!item.id.startsWith('stock-') && <button className="ws-asset-delete ws-icon-btn" disabled={busy || !ready} aria-label={`删除 ${item.title}`} onClick={() => openDialog(references.some(r => r.id === item.id) ? 'delete-reference' : 'delete-asset', item)}><Trash2 size={14} /></button>}{item.prompt && <p className="ws-reference-excerpt">{item.prompt}</p>}</article>)}</div>}<div className="ws-library-note"><div><Layers size={18} /><span>{assetTab === '素材' ? '上传素材保存在个人工作空间，单张支持 10 MB 内的 JPG / PNG / WebP / GIF。' : '整理好每一份参考，让灵感在下一次创作中继续生长。'}</span></div>{assetTab === '素材' && <span>个人素材库</span>}</div></>}
    </> : <>
      {!isRecent && !isTrash && <section className="ws-folders-section"><div className="ws-section-title"><h2>我的文件夹</h2><span>{folders.length} 个文件夹</span></div><div className="ws-folders">{folders.map(f => <div key={f.id} className="ws-folder-wrap"><button className={`ws-folder ${folder?.id === f.id ? 'active' : ''}`} onClick={() => setFolder(folder?.id === f.id ? null : f)}><div className="ws-folder-symbol" style={{ color: f.color }}><Folder size={33} strokeWidth={1.2} fill="currentColor" /></div><div><strong>{f.name}</strong><span>{projects.filter(p => p.folderId === f.id).length} 个作品</span></div><ChevronRight size={16} /></button><div className="ws-folder-actions"><button className="ws-icon-btn" disabled={busy} aria-label={`重命名文件夹 ${f.name}`} onClick={() => openDialog('rename-folder', f)}><Pencil size={12} /></button><button className="ws-icon-btn" disabled={busy} aria-label={`删除文件夹 ${f.name}`} onClick={() => openDialog('delete-folder', f)}><Trash2 size={12} /></button></div></div>)}<button className="ws-add-folder" disabled={!ready || busy} onClick={() => openDialog('folder')} aria-label="添加文件夹"><Plus size={22} /></button></div></section>}
      <div className="ws-toolbar"><div className="ws-toolbar-label">{folder && !isTrash ? <button className="ws-breadcrumb" onClick={() => setFolder(null)}><ArrowLeft size={17} />{folder.name}<span>{items.length} 个作品</span></button> : <><h2>{isTrash ? '回收站' : isRecent ? '最近打开' : '全部作品'}</h2><span>{items.length} 个作品</span></>}</div><div className="ws-toolbar-controls"><label className="ws-search"><Search size={16} /><input aria-label="搜索作品" placeholder="搜索你的作品…" value={search} onChange={e => setSearch(e.target.value)} /></label><label className="ws-sort"><ArrowDownWideNarrow size={15} /><select value={sort} aria-label="作品排序" onChange={e => setSort(e.target.value)}><option value="updated">最近编辑</option><option value="name">名称排序</option></select><ChevronDown size={13} /></label><div className="ws-view-switch"><button className={layout === 'grid' ? 'active' : ''} onClick={() => setLayout('grid')} aria-label="网格视图" aria-pressed={layout === 'grid'}><Grid2X2 size={16} /></button><button className={layout === 'list' ? 'active' : ''} onClick={() => setLayout('list')} aria-label="列表视图" aria-pressed={layout === 'list'}><List size={17} /></button></div></div></div>
      <div className="ws-filter-pills" aria-label="作品分类">{(isRecent ? ['全部', '设计作品', 'AI生成'] : ['全部', '设计作品', 'AI生成', '回收站']).map(name => <button className={filter === name ? 'active' : ''} key={name} onClick={() => setFilter(name)}>{name}</button>)}</div>
      {!items.length ? <Empty title={isTrash ? '回收站为空' : search ? '没有找到相关作品' : folder ? '给这个文件夹放一点灵感' : '好设计，从第一个想法开始'} detail={isTrash ? '删除的作品会保留在这里，可以随时恢复。' : folder ? '在作品的更多菜单中，选择“移到文件夹”即可整理作品。' : search ? '试试其他关键词，或清除筛选后再看看。' : '创建一个新设计，让灵感变成看得见的作品。'} onAction={isTrash ? () => setFilter('全部') : search ? () => { setSearch(''); setFilter('全部'); } : () => folder ? setFolder(null) : onCreateProject?.()} action={isTrash ? '返回全部作品' : search ? '清除筛选' : folder ? '查看全部作品' : '新建设计'} /> : <div className={`ws-project-grid ${layout === 'list' ? 'ws-project-list' : ''}`}>{items.map((item, index) => <article className="ws-project-card" key={item.id}><button className="ws-project-open" disabled={isTrash} onClick={() => onOpenProject?.(item)} aria-label={`打开作品 ${item.title}`}><Thumb item={item} poster={item.type !== 'AI生成'} />{!isTrash && <span className="ws-card-hover"><Pencil size={16} /> 继续设计</span>}</button><div className="ws-project-info"><div className="ws-project-title"><button disabled={isTrash} onClick={() => onOpenProject?.(item)}>{item.title}</button><div className="ws-menu-wrap"><button className={`ws-icon-btn ${menu === item.id ? 'active' : ''}`} aria-label={`${item.title} 更多操作`} aria-expanded={menu === item.id} onClick={() => setMenu(menu === item.id ? null : item.id)}><MoreHorizontal size={19} /></button>{menu === item.id && <div className="ws-dropdown">{isTrash ? <button disabled={busy} onClick={() => restoreProject(item)}><RotateCcw size={15} />恢复作品</button> : <><button onClick={() => openDialog('rename', item)}><Pencil size={15} />重命名</button><button onClick={() => openDialog('move', item)}><Folder size={15} />移到文件夹</button><button onClick={() => { setMenu(null); onOpenProject?.(item); }}><ArrowUpRight size={15} />打开编辑器</button><button onClick={() => openDialog('delete-project', item)}><Trash2 size={15} />移到回收站</button></>}</div>}</div></div><div className="ws-project-subtitle"><span>{item.type || '设计作品'}</span><span className="ws-dot">·</span><span>{typeof item.updatedAt === 'string' && !/^\d{4}-/.test(item.updatedAt) ? item.updatedAt : index === 0 ? '最近编辑' : '已保存'}</span></div></div>{layout === 'list' && !isTrash && <button className="ws-list-open ws-secondary" onClick={() => onOpenProject?.(item)}>继续设计<ArrowUpRight size={15} /></button>}</article>)}</div>}
      {items.length > 0 && <div className="ws-list-end"><span />每一个好想法，都在这里慢慢成形<span /></div>}
    </>}
    {['folder', 'rename-folder'].includes(dialog?.type) && <Dialog title={dialog.type === 'rename-folder' ? '重命名文件夹' : '给灵感一个新空间'} description="按品牌、活动或内容主题整理作品。" onClose={() => setDialog(null)}><form onSubmit={createFolder}><label className="ws-dialog-label">文件夹名称<input autoFocus placeholder="例如：秋日新品上市" maxLength={24} value={formValue} onChange={e => { setFormValue(e.target.value); setFormError(''); }} /></label>{formError && <p className="ws-error" role="alert">{formError}</p>}<div className="ws-dialog-actions"><button type="button" className="ws-secondary" onClick={() => setDialog(null)}>取消</button><button className="ws-primary" disabled={busy || !ready} type="submit">{dialog.type === 'rename-folder' ? '保存名称' : '创建文件夹'}</button></div></form></Dialog>}
    {dialog?.type === 'rename' && <Dialog title="重命名作品" onClose={() => setDialog(null)}><form onSubmit={e => { e.preventDefault(); if (!formValue.trim()) return setFormError('作品名称不能为空'); updateProject(dialog.item.id, { title: formValue.trim() }); }}><label className="ws-dialog-label">作品名称<input autoFocus maxLength={60} value={formValue} onChange={e => setFormValue(e.target.value)} /></label>{formError && <p className="ws-error">{formError}</p>}<div className="ws-dialog-actions"><button type="button" className="ws-secondary" onClick={() => setDialog(null)}>取消</button><button type="submit" disabled={busy || !ready} className="ws-primary">保存名称</button></div></form></Dialog>}
    {dialog?.type === 'move' && <Dialog title="移动到文件夹" description={dialog.item.title} onClose={() => setDialog(null)} footer={<><button className="ws-secondary" onClick={() => setDialog(null)}>取消</button><button className="ws-primary" disabled={busy} onClick={() => updateProject(dialog.item.id, { folderId: selectedFolder || null })}>移动作品</button></>}><>{formError && <p className="ws-error" role="alert">{formError}</p>}<div className="ws-folder-options">{[{ id: '', name: '我的空间（不归入文件夹）' }, ...folders].map(f => <button key={f.id} className={selectedFolder === f.id ? 'active' : ''} onClick={() => setSelectedFolder(f.id)}><Folder size={19} /><span>{f.name}</span>{selectedFolder === f.id && <Check size={17} />}</button>)}</div></></Dialog>}
    {dialog?.type === 'preview' && <Dialog title={dialog.item.title} description={dialog.item.category || '创作参考'} onClose={() => setDialog(null)} footer={<><button className="ws-secondary" onClick={() => toggleFavorite(dialog.item.id)}><Heart size={16} fill={favorites.includes(dialog.item.id) ? 'currentColor' : 'none'} />{favorites.includes(dialog.item.id) ? '已收藏' : '收藏素材'}</button><button className="ws-primary" disabled={dialog.item.status && dialog.item.status !== 'ready'} onClick={() => openAsset(dialog.item)}>用于新设计<ArrowUpRight size={16} /></button></>}><div className="ws-preview-image"><img src={dialog.item.image} alt={dialog.item.title} /></div>{dialog.item.prompt && <div className="ws-preview-prompt"><span><Sparkles size={15} />创作提示词</span><p>{dialog.item.prompt}</p></div>}</Dialog>}
    {dialog?.type === 'reference' && <Dialog title="把灵感存成创作参考" description="让喜欢的风格与提示词，可以被再次使用。" onClose={() => setDialog(null)}><form onSubmit={createReference}><label className="ws-dialog-label">参考名称<input value={formValue} maxLength={40} onChange={e => setFormValue(e.target.value)} placeholder="例如：温暖自然的咖啡海报" /></label><label className="ws-dialog-label">创作提示词<textarea rows={4} value={referencePrompt} onChange={e => setReferencePrompt(e.target.value)} placeholder="记录喜欢的风格、配色、布局和创作要求…" /></label><label className="ws-dialog-label">选择参考素材</label><div className="ws-reference-images">{allAssets.map(a => <button type="button" className={referenceImage === a.image ? 'active' : ''} key={a.id} onClick={() => setReferenceImage(a.image)} aria-label={`选择 ${a.title}`}><img src={a.image} alt={a.title} />{referenceImage === a.image && <Check size={16} />}</button>)}</div>{formError && <p className="ws-error" role="alert">{formError}</p>}<div className="ws-dialog-actions"><button type="button" className="ws-secondary" onClick={() => setDialog(null)}>取消</button><button className="ws-primary" disabled={busy || !ready} type="submit">保存创作参考</button></div></form></Dialog>}
    {dialog?.type.startsWith('delete-') && <Dialog title={dialog.type === 'delete-project' ? '移到回收站' : '删除' + (dialog.type === 'delete-folder' ? '文件夹' : dialog.type === 'delete-reference' ? '创作参考' : '素材')} description={dialog.item.title || dialog.item.name} onClose={() => setDialog(null)} footer={<><button className="ws-secondary" disabled={busy} onClick={() => setDialog(null)}>取消</button><button className="ws-primary" disabled={busy} onClick={removeItem}>{busy ? '正在保存…' : '确认'}</button></>}><p className="ws-confirm-copy">{dialog.type === 'delete-folder' ? '文件夹内作品会移回个人空间。' : dialog.type === 'delete-project' ? '作品会保留在回收站，可以随时恢复。' : '删除后将不再显示在你的资产库中。'}</p>{formError && <p className="ws-error" role="alert">{formError}</p>}</Dialog>}
  </div>;
}
