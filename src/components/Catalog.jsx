import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, ArrowUpRight, Bookmark, ChevronRight, Search, SlidersHorizontal, Sparkles, WandSparkles, X } from 'lucide-react';
import catalog from '../data/catalog.json';
import { api } from '../lib/api';
import './catalog.css';

const categoryOrder = ['电商', '海报', '自媒体', '品牌', '视频', '服饰', '办公', '图像'];
const visuals = {
  电商: { image: 'skincare', color: '#e9e4d6', label: 'NATURALLY BEAUTIFUL', heading: '好的产品，\n值得被看见。' },
  海报: { image: 'coffee', color: '#f0e4cd', label: 'MAKE EVERYDAY SPECIAL', heading: '把日常，\n过成好时光。' },
  自媒体: { image: 'interior', color: '#e7e6da', label: 'LIFE WITH INTENTION', heading: '把生活，\n写进灵感里。' },
  品牌: { image: 'skincare', color: '#eadaca', label: 'MADE WITH PURPOSE', heading: '自然之本\n纯粹之美' },
  视频: { image: 'headphones', color: '#dedfdc', label: 'A STORY IN MOTION', heading: '听见，\n新的可能。' },
  服饰: { image: 'fashion', color: '#e2e2db', label: 'YOUR EVERYDAY STYLE', heading: '自在穿行\n秋日之间' },
  办公: { image: 'nature', color: '#e4e8da', label: 'IDEAS WORTH SHARING', heading: '让想法，\n有迹可循。' },
  图像: { image: 'interior', color: '#e5dfd4', label: 'A FRESH PERSPECTIVE', heading: '每一处细节\n都刚刚好' },
};

function visualFor(item) {
  if (visuals[item.category]) return visuals[item.category];
  if (/视频/.test(item.name)) return visuals.视频;
  if (/PPT|证件|Logo/.test(item.name)) return /Logo/.test(item.name) ? visuals.品牌 : visuals.办公;
  if (/模特|试衣|穿戴|服装|试鞋|人像/.test(item.name)) return visuals.服饰;
  if (/商品|套图|详情|带货/.test(item.name)) return visuals.电商;
  if (/海报|文案|笔记/.test(item.name)) return visuals.海报;
  return visuals.图像;
}

function Artwork({ item, index = 0 }) {
  const visual = visualFor(item);
  const variant = index % 5;
  return <div className={`dx-cat-art dx-cat-art-${variant}`} style={{ '--art-bg': visual.color }} aria-hidden="true">
    {variant === 1 ? <>
      <div className="dx-cat-mini-frame frame-back"><img src={`/assets/${visual.image}.jpg`} alt="" loading="lazy" /></div>
      <div className="dx-cat-mini-frame frame-front"><img src={`/assets/${visual.image}.jpg`} alt="" loading="lazy" /><span>{visual.label}</span></div>
      <span className="dx-cat-art-corner">A LITTLE INSPIRATION</span>
    </> : variant === 2 ? <>
      <div className="dx-cat-art-copy"><small>{visual.label}</small><strong>{visual.heading}</strong><span>设计，让表达更动人 <ArrowRight size={12} /></span></div>
      <img className="dx-cat-art-photo" src={`/assets/${visual.image}.jpg`} alt="" loading="lazy" />
    </> : variant === 3 ? <>
      <img className="dx-cat-art-full" src={`/assets/${visual.image}.jpg`} alt="" loading="lazy" />
      <div className="dx-cat-art-overlay"><span>{visual.label}</span><strong>{visual.heading.replace('\n', ' ')}</strong><i>DESIGN YOUR STORY</i></div>
    </> : variant === 4 ? <>
      <div className="dx-cat-art-split"><img src={`/assets/${visual.image}.jpg`} alt="" loading="lazy" /><img src={`/assets/${visual.image}.jpg`} alt="" loading="lazy" /></div>
      <div className="dx-cat-art-caption"><span>{visual.label}</span><strong>{item.category === '视频' ? '让灵感动起来' : '一种灵感，多种表达'}</strong></div>
    </> : <>
      <img className="dx-cat-art-full" src={`/assets/${visual.image}.jpg`} alt="" loading="lazy" />
      <span className="dx-cat-art-stamp">{visual.label}<i /></span>
      <div className="dx-cat-art-bottom">{visual.heading.split('\n')[0]}<ArrowUpRight size={18} /></div>
    </>}
    {item.category === '视频' && <span className="dx-cat-play">▶</span>}
  </div>;
}

export default function Catalog({ mode = 'skills', onSelect, onToast }) {
  const isTools = mode === 'tools';
  const entries = isTools ? catalog.tools : catalog.skills;
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('全部');
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [favorites, setFavorites] = useState([]);
  const [favoritesReady, setFavoritesReady] = useState(false);
  const [favoriteError, setFavoriteError] = useState('');
  const [savingFavorite, setSavingFavorite] = useState(false);
  const toast = useRef(onToast);
  toast.current = onToast;
  const loadFavorites = useCallback(async () => {
    try {
      const value = await api('/preferences/catalog-favorites');
      setFavorites(Array.isArray(value) ? value : []); setFavoritesReady(true); setFavoriteError('');
    } catch (error) { setFavoriteError(error.message); toast.current?.(error.message); }
  }, []);
  useEffect(() => {
    loadFavorites();
    window.addEventListener('designx:refresh', loadFavorites);
    return () => window.removeEventListener('designx:refresh', loadFavorites);
  }, [loadFavorites]);
  useEffect(() => { setQuery(''); setCategory('全部'); setFavoritesOnly(false); }, [mode]);

  const categories = useMemo(() => {
    const available = [...new Set(entries.map(item => item.category))];
    return isTools ? available : categoryOrder.filter(value => available.includes(value));
  }, [entries, isTools]);
  const filtered = useMemo(() => entries.filter(item =>
    (category === '全部' || item.category === category) &&
    (!favoritesOnly || favorites.includes(item.id)) &&
    (!query.trim() || `${item.name} ${item.description} ${item.category}`.toLowerCase().includes(query.trim().toLowerCase()))
  ), [entries, category, query, favoritesOnly, favorites]);
  const favoriteCount = entries.filter(item => favorites.includes(item.id)).length;
  const featured = [
    { find: /^(AI)?商品套图$/, title: '让商品，自带吸引力。', subtitle: '一份商品资料，一整套好设计', tag: '电商视觉', image: 'skincare', className: 'product' },
    { find: isTools ? /^AI海报$/ : /^营销海报$/, title: '每个好点子，都值得放大。', subtitle: '用一张海报，讲好你的故事', tag: '营销创意', image: 'coffee', className: 'poster' },
    { find: isTools ? /^AI试衣$/ : /^模特试穿$/, title: '风格上身，灵感成真。', subtitle: '探索服饰与人物的更多可能', tag: '时尚穿搭', image: 'fashion', className: 'fashion' },
  ].map(item => ({ ...item, entry: entries.find(entry => item.find.test(entry.name)) })).filter(item => item.entry);

  async function toggleFavorite(item) {
    if (!favoritesReady || savingFavorite) return;
    setSavingFavorite(true);
    const wasSaved = favorites.includes(item.id);
    const next = wasSaved ? favorites.filter(id => id !== item.id) : [...favorites, item.id];
    try {
      await api('/preferences/catalog-favorites', { method: 'PUT', body: next });
      setFavorites(next);
      onToast?.(wasSaved ? '已从收藏移除' : '已加入我的收藏');
    } catch (error) { onToast?.(error.message); }
    finally { setSavingFavorite(false); }
  }

  function resetFilters() { setQuery(''); setCategory('全部'); setFavoritesOnly(false); }

  return <section className="dx-catalog" aria-label={isTools ? 'AI工具目录' : '创作技能目录'}>
    {favoriteError && <div className="dx-cat-load-error" role="alert"><span>{favoriteError}</span><button onClick={loadFavorites}>重新加载收藏</button></div>}
    <header className="dx-cat-heading">
      <div className="dx-cat-eyebrow"><span>{isTools ? 'YOUR CREATIVE TOOLKIT' : 'YOUR CREATIVE POSSIBILITIES'}</span><i /><span className="dx-cat-demo">AI 能力稍后开放</span></div>
      <div className="dx-cat-title-row"><div><h1>{isTools ? '每一步设计，都有顺手的工具。' : '让专业能力，成为你的创作直觉。'}</h1><p>{isTools ? '把复杂的操作变简单，让每一个细节都恰到好处。' : '从一个想法，到一份出色作品。为你找到最合适的创作方式。'}</p></div><div className="dx-cat-total"><strong>{entries.length}</strong><span>种{isTools ? '创作工具' : '专业技能'}<Sparkles size={13} /></span></div></div>
    </header>

    <section className="dx-cat-featured" aria-label="精选创作专题">
      {featured.map((feature, i) => <button type="button" key={feature.entry.id} className={`dx-cat-feature dx-cat-feature-${feature.className}`} onClick={() => onSelect?.(feature.entry)} aria-label={`开始${feature.entry.name}`}>
        <div className="dx-cat-feature-text"><span className="dx-cat-feature-tag"><Sparkles size={12} />{feature.tag}</span><h2>{feature.title}</h2><p>{feature.subtitle}</p><span className="dx-cat-feature-link">开始创作<ArrowUpRight size={15} /></span></div>
        <div className="dx-cat-feature-art"><img src={`/assets/${feature.image}.jpg`} alt="" /><span>{['NEW PERSPECTIVES', 'EVERYDAY INSPIRATION', 'STYLE IN MOTION'][i]}</span></div>
      </button>)}
    </section>

    <div className="dx-cat-library-top"><div className="dx-cat-library-title"><h2>{isTools ? '探索全部工具' : '找到你的创作灵感'}</h2><span>{isTools ? '从小调整，到大不同' : '把创意交给你，把复杂交给技能'}</span></div><label className="dx-cat-search"><Search size={17} /><input value={query} onChange={event => setQuery(event.target.value)} placeholder={isTools ? '搜索工具，如抠图、变清晰' : '搜索技能，如海报、商品套图'} aria-label={isTools ? '搜索AI工具' : '搜索创作技能'} />{query && <button type="button" onClick={() => setQuery('')} aria-label="清除搜索"><X size={14} /></button>}</label></div>

    <div className="dx-cat-filter-row"><div className="dx-cat-filters" aria-label="按类别筛选">{['全部', ...categories].map(value => <button type="button" key={value} className={category === value ? 'active' : ''} aria-pressed={category === value} onClick={() => setCategory(value)}>{value}{value === '全部' && <span>{entries.length}</span>}</button>)}</div><button type="button" className={`dx-cat-favorite-filter ${favoritesOnly ? 'active' : ''}`} aria-pressed={favoritesOnly} onClick={() => setFavoritesOnly(!favoritesOnly)}><Bookmark size={14} fill={favoritesOnly ? 'currentColor' : 'none'} />我的收藏{favoriteCount > 0 && <span>{favoriteCount}</span>}</button></div>

    {(query || category !== '全部' || favoritesOnly) && <div className="dx-cat-filter-summary" aria-live="polite"><span><SlidersHorizontal size={13} />找到 {filtered.length} 个{isTools ? '工具' : '技能'}{query.trim() && ` · “${query.trim()}”`}</span><button type="button" onClick={resetFilters}>重置筛选<X size={12} /></button></div>}

    {filtered.length ? <div className="dx-cat-grid">{filtered.map(item => {
      const saved = favorites.includes(item.id);
      const index = entries.findIndex(entry => entry.id === item.id);
      return <article key={item.id} className="dx-cat-card">
        <button type="button" className="dx-cat-card-main" onClick={() => onSelect?.(item)} aria-label={`使用${item.name}`}><Artwork item={item} index={index} /><div className="dx-cat-card-info"><div className="dx-cat-card-title"><h3>{item.name}</h3><ArrowUpRight size={16} /></div><p>{item.description}</p><div className="dx-cat-card-footer"><span>{item.category}</span><span><WandSparkles size={12} />{isTools ? '立即使用' : '灵感即刻开始'}<ChevronRight size={12} /></span></div></div></button>
        <button type="button" className={`dx-cat-save ${saved ? 'saved' : ''}`} disabled={!favoritesReady || savingFavorite} onClick={() => toggleFavorite(item)} aria-label={`${saved ? '取消收藏' : '收藏'}${item.name}`} aria-pressed={saved}>{saved ? <Bookmark size={15} fill="currentColor" /> : <Bookmark size={15} />}</button>
      </article>;
    })}</div> : <div className="dx-cat-empty" role="status"><div>{favoritesOnly ? <Bookmark size={28} strokeWidth={1.4} /> : <Search size={28} strokeWidth={1.4} />}</div><h3>{favoritesOnly && !query && category === '全部' ? '把喜欢的灵感，留在这里。' : '暂时没有找到合适的结果'}</h3><p>{favoritesOnly && !query && category === '全部' ? '点击卡片上的收藏图标，让顺手的技能随时可用。' : '试试“海报”“商品”或“图片”，也可以清除筛选重新探索。'}</p><button type="button" onClick={resetFilters}>探索全部{isTools ? '工具' : '技能'}<ArrowRight size={15} /></button></div>}

    {filtered.length > 0 && <footer className="dx-cat-end"><span /><Sparkles size={13} /><p>灵感不设限，让创作继续发生</p><span /></footer>}
  </section>;
}
