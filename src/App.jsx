import React, { useState, useEffect, useRef } from "react";
import {
  Home,
  Sparkles,
  LayoutGrid,
  PanelsTopLeft,
  FolderOpen,
  Images,
  History,
  Plus,
  ChevronDown,
  ArrowUpRight,
  ArrowUp,
  ArrowRight,
  Search,
  SlidersHorizontal,
  Heart,
  Check,
  X,
  HelpCircle,
  Command,
  PanelLeftClose,
  Bell,
  ImagePlus,
  WandSparkles,
  ShoppingBag,
  Video,
  Scissors,
  Presentation,
  Brush,
  Leaf,
  Play,
  Upload,
  Clock,
  BookOpen,
  Menu,
  CheckCircle2,
  ChevronRight,
  Folder,
  Layers,
  Settings2,
} from "lucide-react";
import Editor from "./components/Editor.jsx";
import Workspace from "./components/Workspace.jsx";
import { api, uploadAsset, refreshWorkspace } from "./lib/api";
import { initialDesign } from "./components/Editor.jsx";
import JobPanel from "./components/JobPanel.jsx";
import DesignThumbnail from "./components/DesignThumbnail.jsx";
import Catalog from "./components/Catalog.jsx";
import Workbench from "./components/Workbench.jsx";
import AIStudio from "./components/AIStudio.jsx";
import { templates } from "./data/templates.js";
import catalog from "./data/catalog.json";
import "./components/workbench.css";

const NAV = [
  ["home", "创作首页", Home],
  ["skills", "AI 技能", Sparkles],
  ["tools", "设计工具", LayoutGrid],
  ["templates", "模板灵感", PanelsTopLeft],
  ["recent", "最近打开", History],
  ["projects", "我的项目", FolderOpen],
  ["assets", "资产库", Images],
];
export function Modal({ children, onClose, className = "" }) {
  const ref = useRef();
  useEffect(() => {
    const old = document.activeElement;
    ref.current?.focus();
    const f = (e) => {
      if (e.key === "Escape") onClose();
      if (e.key === "Tab") {
        const a = ref.current?.querySelectorAll(
          'button:not([disabled]),input,textarea,select,a,[tabindex="0"]',
        );
        if (!a?.length) return;
        const first = a[0],
          last = a[a.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", f);
    return () => {
      document.removeEventListener("keydown", f);
      old?.focus();
    };
  }, []);
  return (
    <div
      className="modal-shade"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <section
        className={"modal " + className}
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
      >
        <button
          className="modal-close icon-button"
          aria-label="关闭弹窗"
          onClick={onClose}
        >
          <X size={20} />
        </button>
        {children}
      </section>
    </div>
  );
}
export function Artwork({ item, compact = false }) {
  return (
    <div
      className={"artwork art-" + item.theme + (compact ? " compact" : "")}
      style={{ backgroundColor: item.color }}
    >
      <img src={item.image} alt={item.title} loading="lazy" />
      <div className="art-shade" />
      <div className="art-content">
        <span className="art-label">{item.label}</span>
        <strong>
          {item.en?.split("\n").map((t, i) => (
            <React.Fragment key={i}>
              {t}
              <br />
            </React.Fragment>
          ))}
        </strong>
        <div className="art-bottom">
          <span>{item.title}</span>
          <ArrowUpRight size={19} />
        </div>
      </div>
      {item.theme === "coffee" && (
        <span className="art-stamp">
          A LITTLE
          <br />
          COFFEE
          <br />A LOT OF JOY
        </span>
      )}
    </div>
  );
}
function TemplateCard({ item, onSelect, favorites, toggleFavorite }) {
  return (
    <article className="template-card">
      <button
        className="art-trigger"
        onClick={() => onSelect(item)}
        aria-label={"预览模板 " + item.title}
      >
        <Artwork item={item} />
        {item.tag && <span className="template-tag">{item.tag}</span>}
        <span className="art-hover">
          查看模板 <ArrowUpRight size={16} />
        </span>
      </button>
      <button
        className={
          "favorite-button " +
          (favorites.includes(item.id) ? "is-favorite" : "")
        }
        aria-label={
          (favorites.includes(item.id) ? "取消收藏 " : "收藏 ") + item.title
        }
        onClick={() => toggleFavorite(item.id)}
      >
        <Heart
          size={16}
          fill={favorites.includes(item.id) ? "currentColor" : "none"}
        />
      </button>
      <div className="template-caption">
        <h3>{item.title}</h3>
        <span>{item.subtitle}</span>
      </div>
    </article>
  );
}
function HomePage({
  onNavigate,
  onTask,
  onTemplate,
  onCreate,
  projects,
  onProject,
  favorites,
  toggleFavorite,
}) {
  const [prompt, setPrompt] = useState("");
  const [mode, setMode] = useState("智能创作");
  const [tab, setTab] = useState("为你推荐");
  const [attachment, setAttachment] = useState(null);
  const [error, setError] = useState("");
  const upload = useRef();
  const modes = ["智能创作", "图片生成", "视频生成"];
  const visible =
    tab === "最近使用"
      ? templates.filter((t) => projects.some((p) => p.image === t.image))
      : tab === "我的收藏"
        ? templates.filter((t) => favorites.includes(t.id))
        : templates.slice(0, 6);
  function submit() {
    if (!prompt.trim()) {
      setError("先写下你的设计想法，或试试下方的灵感建议");
      return;
    }
    setError("");
    const product = /商品|套图|电商/.test(prompt),
      social = /小红书|社媒|种草/.test(prompt);
    onTask({
      name:
        mode === "视频生成"
          ? "视频创作"
          : mode === "图片生成"
            ? "图片生成"
            : product
              ? "AI 商品套图"
              : social
                ? "社媒图文笔记"
                : "营销海报",
      prompt,
      mode,
      image: attachment?.url,
      category:
        mode === "视频生成"
          ? "视频"
          : product
            ? "电商"
            : social
              ? "自媒体"
              : "海报",
    });
  }
  async function attach(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setError("正在上传素材…");
    try {
      const asset = await uploadAsset(file);
      setAttachment({ id: asset.id, name: asset.title, url: asset.image });
      setError("");
    } catch (e) {
      setError(e.message);
    }
  }
  return (
    <div className="home-page">
      <div className="welcome-row">
        <span>
          <span className="hello-dot" />
          灵感不设限，创作正当时
        </span>
        <button className="text-button" onClick={() => onNavigate("guide")}>
          认识你的创作空间 <ArrowUpRight size={14} />
        </button>
      </div>
      <section className="hero">
        <div className="hero-copy">
          <span className="eyebrow">YOUR IDEAS, BEAUTIFULLY MADE.</span>
          <h1>
            从一个想法，
            <br />到
            <span className="hero-accent">
              一整套好设计
              <svg viewBox="0 0 320 12">
                <path d="M3 8 Q145 -2 315 6" />
              </svg>
            </span>
            <span className="hero-star">✳</span>
          </h1>
          <p>
            把灵感交给 AI，把时间留给创造。
            <br className="small-only" />
            商品图、海报、视频，一站完成。
          </p>
        </div>
        <div className="hero-collage" aria-hidden="true">
          <div className="collage-note">
            A little idea.
            <br />
            <em>Endless possibilities.</em>
            <span>↗</span>
          </div>
          <div className="collage-art collage-back">
            <Artwork item={templates[1]} compact />
          </div>
          <div className="collage-art collage-front">
            <Artwork item={templates[0]} compact />
          </div>
          <div className="collage-caption">
            <Sparkles size={13} /> 灵感正在发生
          </div>
        </div>
      </section>
      <section className="composer">
        <div className="composer-tabs">
          {modes.map((m, i) => (
            <button
              className={mode === m ? "active" : ""}
              key={m}
              onClick={() => setMode(m)}
            >
              {i === 0 ? (
                <Sparkles size={15} />
              ) : i === 1 ? (
                <Images size={15} />
              ) : (
                <Video size={15} />
              )}{" "}
              {m}
            </button>
          ))}
          <span>DESIGN WITH AI</span>
        </div>
        <textarea
          value={prompt}
          onChange={(e) => {
            setPrompt(e.target.value);
            setError("");
          }}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === "Enter") submit();
          }}
          placeholder={
            mode === "视频生成"
              ? "描述你的镜头、故事或产品，开始一段有想法的视频…"
              : "描述你想做的设计，例如：为我的咖啡品牌设计一组温暖、自然的秋日上新海报…"
          }
          aria-label="描述你的设计需求"
        />
        {attachment && (
          <div className="attachment">
            <img src={attachment.url} />
            <span>{attachment.name}</span>
            <button onClick={() => setAttachment(null)} aria-label="移除附件">
              <X size={13} />
            </button>
          </div>
        )}
        <div className="composer-footer">
          <div>
            <button onClick={() => upload.current.click()}>
              <Plus size={18} />
              <span>添加素材</span>
            </button>
            <button
              onClick={() =>
                onTask({
                  draft: prompt,
                  image: attachment?.url,
                  mode,
                  panel: "skills",
                })
              }
            >
              <Sparkles size={16} />
              <span>选择技能</span>
            </button>
            <button
              onClick={() =>
                onTask({
                  draft: prompt,
                  image: attachment?.url,
                  mode,
                  panel: "assets",
                })
              }
            >
              <FolderOpen size={16} />
              <span>引用资产</span>
            </button>
          </div>
          <span className="composer-key">⌘ Enter</span>
          <button
            className="send-button"
            onClick={submit}
            aria-label="开始创作"
          >
            <ArrowUp size={20} />
          </button>
        </div>
        <input
          ref={upload}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          hidden
          onChange={attach}
        />
        {error && <span className="inline-error">{error}</span>}
      </section>
      <div className="prompt-chips">
        <span>试试这些灵感</span>
        {["为新品做一套商品图", "设计秋日咖啡海报", "制作小红书种草图"].map(
          (s, i) => (
            <button
              key={s}
              onClick={() => {
                setPrompt(s);
                setMode("智能创作");
              }}
            >
              {
                [
                  <ShoppingBag size={13} />,
                  <Leaf size={13} />,
                  <Heart size={13} />,
                ][i]
              }
              {s}
              <ArrowUpRight size={12} />
            </button>
          ),
        )}
      </div>
      <section className="quick-section">
        <div className="section-heading">
          <h2>让创作，再简单一点</h2>
          <button className="text-button" onClick={() => onNavigate("tools")}>
            全部工具 <ArrowRight size={15} />
          </button>
        </div>
        <div className="quick-tools">
          {[
            {
              name: "AI 商品套图",
              desc: "一张商品图，一整套好设计",
              icon: ShoppingBag,
              color: "peach",
              cat: "电商",
              tag: "热门",
            },
            {
              name: "AI 营销海报",
              desc: "把好想法，变成好画面",
              icon: WandSparkles,
              color: "green",
              cat: "海报",
            },
            {
              name: "AI 视频创作",
              desc: "让产品故事，生动起来",
              icon: Video,
              color: "blue",
              cat: "视频",
            },
            {
              name: "智能抠图",
              desc: "轻松去背景，细节更干净",
              icon: Scissors,
              color: "sand",
              cat: "图像",
            },
            {
              name: "PPT 设计",
              desc: "从一段内容，到精彩提案",
              icon: Presentation,
              color: "rose",
              cat: "办公",
            },
          ].map((t) => (
            <button
              className={"quick-tool " + t.color}
              key={t.name}
              onClick={() => onTask({ name: t.name, category: t.cat })}
            >
              <span className="quick-icon">
                <t.icon size={23} strokeWidth={1.5} />
              </span>
              <div>
                <h3>
                  {t.name}
                  {t.tag && <b>{t.tag}</b>}
                </h3>
                <p>{t.desc}</p>
              </div>
              <ArrowUpRight className="quick-arrow" size={16} />
            </button>
          ))}
        </div>
      </section>
      <section className="inspiration-section">
        <div className="section-heading">
          <div>
            <h2>
              好设计，从这里发生<span className="hand-star">✳</span>
            </h2>
            <p>发现喜欢的风格，让灵感有迹可循。</p>
          </div>
          <button
            className="text-button"
            onClick={() => onNavigate("templates")}
          >
            探索模板灵感 <ArrowRight size={15} />
          </button>
        </div>
        <div className="inspiration-tabs">
          {[
            "为你推荐",
            "电商设计",
            "海报设计",
            "社媒内容",
            "品牌设计",
            "最近使用",
            "我的收藏",
          ].map((t) => (
            <button
              className={tab === t ? "active" : ""}
              onClick={() => setTab(t)}
              key={t}
            >
              {t === "为你推荐" && <Sparkles size={14} />} {t}
            </button>
          ))}
          <button
            className="filter-link"
            onClick={() => onNavigate("templates")}
          >
            <SlidersHorizontal size={15} /> 筛选
          </button>
        </div>
        <div className="template-grid">
          {(templates.some((t) => t.category === tab)
            ? templates.filter((t) => t.category === tab)
            : visible
          ).map((item) => (
            <TemplateCard
              key={item.id}
              {...{ item, favorites, toggleFavorite }}
              onSelect={onTemplate}
            />
          ))}
        </div>
        {visible.length === 0 && ["我的收藏", "最近使用"].includes(tab) && (
          <div className="empty-block">
            <Heart />
            <h3>把喜欢的灵感留在这里</h3>
            <p>点击作品右上角的爱心，即可收藏。</p>
          </div>
        )}
      </section>
      <section className="recent-section">
        <div className="section-heading">
          <h2>接着上次的灵感</h2>
          <button
            className="text-button"
            onClick={() => onNavigate("projects")}
          >
            全部项目 <ArrowRight size={15} />
          </button>
        </div>
        <div className="home-projects">
          {projects.slice(0, 3).map((p) => (
            <button key={p.id} onClick={() => onProject(p)}>
              {p.design ? (
                <DesignThumbnail
                  design={p.design}
                  title={p.title}
                  style={{ width: 60, height: 44, borderRadius: 5 }}
                />
              ) : (
                <img src={p.image} alt={p.title} />
              )}
              <div>
                <h3>{p.title}</h3>
                <span>
                  {p.updatedAt} · {p.type}
                </span>
              </div>
              <ChevronRight size={17} />
            </button>
          ))}
          <button className="blank-project" onClick={onCreate}>
            <Plus />
            <span>开启新的创作</span>
          </button>
        </div>
      </section>
      <div className="page-footer">
        <span>让每个想法，都值得被看见。</span>
        <span>DESIGN X / MADE FOR CREATORS</span>
      </div>
    </div>
  );
}
function TemplatesPage({ onSelect, favorites, toggleFavorite }) {
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("全部");
  const [style, setStyle] = useState("所有风格");
  const [sort, setSort] = useState("编辑精选");
  let list = templates.filter(
    (t) =>
      (cat === "全部" || t.category === cat) &&
      (style === "所有风格" || t.style === style) &&
      `${t.title}${t.subtitle}`.includes(q),
  );
  if (sort === "最近上新") list = [...list].reverse();
  return (
    <div className="templates-page">
      <div className="page-intro">
        <span className="eyebrow">A GOOD PLACE TO START</span>
        <h1>
          每一个好设计，
          <br />
          都从一点灵感开始。
        </h1>
        <p>找到喜欢的模板，加入你的想法，让它成为你的作品。</p>
        <div className="large-search">
          <Search size={19} />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索模板，例如：咖啡、护肤、秋日…"
            aria-label="搜索模板"
          />
          {q && (
            <button aria-label="清空搜索" onClick={() => setQ("")}>
              <X size={16} />
            </button>
          )}
        </div>
        <span className="intro-decoration">✳</span>
      </div>
      <div className="inspiration-tabs">
        {[
          "全部",
          "电商设计",
          "海报设计",
          "社媒内容",
          "服饰穿戴",
          "办公设计",
          "品牌设计",
        ].map((c) => (
          <button
            className={cat === c ? "active" : ""}
            onClick={() => setCat(c)}
            key={c}
          >
            {c}
          </button>
        ))}
      </div>
      <div className="filter-row">
        <span>
          为你找到 <b>{list.length}</b> 个精选模板
        </span>
        <div>
          <select
            aria-label="模板风格"
            value={style}
            onChange={(e) => setStyle(e.target.value)}
          >
            {["所有风格", "简约", "自然", "现代", "杂志"].map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
          <select
            aria-label="模板排序"
            value={sort}
            onChange={(e) => setSort(e.target.value)}
          >
            <option>编辑精选</option>
            <option>最近上新</option>
          </select>
        </div>
      </div>
      <div className="template-grid full-templates">
        {list.map((item) => (
          <TemplateCard
            key={item.id}
            {...{ item, onSelect, favorites, toggleFavorite }}
          />
        ))}
      </div>
      {!list.length && (
        <div className="empty-block">
          <Search size={32} />
          <h3>暂时没有找到这个灵感</h3>
          <p>换个关键词，或者试试其他风格。</p>
          <button
            className="secondary"
            onClick={() => {
              setQ("");
              setCat("全部");
              setStyle("所有风格");
            }}
          >
            重置筛选
          </button>
        </div>
      )}
    </div>
  );
}
function Guide({ onNavigate }) {
  return (
    <div className="guide-page">
      <span className="eyebrow">DESIGN X · CREATIVE GUIDE</span>
      <h1>一个想法，走完创作的全程。</h1>
      <p className="lead">
        以任务为中心组织能力，以可编辑的作品承接结果，以资产复用延续创作。
      </p>
      <div className="flow-guide">
        {[
          ["01", "开始创作", "空白画板 / 模板"],
          ["02", "添加素材", "图片 / 品牌 / 参考"],
          ["03", "组织画布", "画板 / 排列 / 分组"],
          ["04", "打磨设计", "画布 / 文字 / 元素"],
          ["05", "保存与复用", "导出 / 项目 / 资产"],
        ].map(([n, t, s]) => (
          <div key={n}>
            <span>{n}</span>
            <h3>{t}</h3>
            <p>{s}</p>
            <ArrowRight size={20} />
          </div>
        ))}
      </div>
      <div className="guide-columns">
        <section>
          <h2>先体验这三条路径</h2>
          <button onClick={() => onNavigate("projects")}>
            <ShoppingBag />
            项目管理与版本延续 <ArrowUpRight />
          </button>
          <button onClick={() => onNavigate("templates")}>
            <PanelsTopLeft />
            模板选择与画布编辑 <ArrowUpRight />
          </button>
          <button onClick={() => onNavigate("assets")}>
            <Images />
            资产管理与品牌复用 <ArrowUpRight />
          </button>
        </section>
        <section>
          <h2>当前创作能力</h2>
          <p>
            从模板或空白画板开始，上传素材并调整文字、图片和图层。保存后可以继续编辑、恢复历史版本，或导出图片和
            PDF。
          </p>
          <p>
            模板、画布编辑、项目、素材和导出已连接个人空间。AI
            生成能力暂未接入；可以先使用模板或自由画板开始创作。
          </p>
          <span className="guide-note">
            修改会自动保存。离线时请保留当前浏览器，联网后完成同步。
          </span>
        </section>
      </div>
    </div>
  );
}
export default function App({
  sessionUser = { name: "创作者" },
  workspace,
  onLogout,
}) {
  const [page, setPage] = useState(
    () => location.hash.slice(1).split("/")[0] || "home",
  );
  const [collapsed, setCollapsed] = useState(false),
    [projects, setProjects] = useState([]),
    [favorites, setFavorites] = useState([]);
  const [template, setTemplate] = useState(null),
    [editing, setEditing] = useState(null),
    [task, setTask] = useState(null),
    [studio, setStudio] = useState(null),
    [editedProject, setEditedProject] = useState(null);
  const [notice, setNotice] = useState(false),
    [toast, setToast] = useState(""),
    [searchOpen, setSearchOpen] = useState(false),
    [query, setQuery] = useState(""),
    [loading, setLoading] = useState(true),
    [loadError, setLoadError] = useState("");
  const timer = useRef();
  function notify(text) {
    setToast(text);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setToast(""), 4500);
  }
  async function reloadProjects() {
    const list = await api("/projects");
    setProjects(list);
    return list;
  }
  async function restoreStudio(id, options = {}, loaded = {}) {
    const [project, board] = await Promise.all([
      loaded.project || api("/projects/" + id + "?view=metadata"),
      loaded.board || api("/projects/" + id + "/studio"),
    ]);
    setStudio({
      id,
      projectId: id,
      revision: board.revision,
      snapshot: {
        ...board.snapshot,
        title: board.snapshot?.title || project.title,
      },
      ...options,
    });
    setEditing(null);
    setTask(null);
    setPage("studio");
    await api("/projects/" + id + "/open", { method: "POST" });
  }
  async function openStudio(item = {}) {
    try {
      const project = await api("/projects", {
        method: "POST",
        body: { title: item.name || "新创作", blank: true },
      });
      const skill = item.name
        ? catalog.skills.find((s) => s.name === item.name) || item
        : null;
      await restoreStudio(
        project.id,
        {
          skill,
          draft: item.prompt || item.draft || "",
          mode: item.mode === "智能创作" ? "Agent" : item.mode || "Agent",
          assets: item.image
            ? [
                {
                  id: item.assetId || "reference",
                  name: "参考素材",
                  url: item.image,
                },
              ]
            : [],
          panel: item.panel,
        },
        { project },
      );
      history.pushState(null, "", "#studio/" + project.id);
      await reloadProjects();
    } catch (e) {
      notify(e.message);
    }
  }
  function navigate(p) {
    if (p === "product-demo") {
      openStudio({ name: "商品套图", category: "电商" });
      return;
    }
    setStudio(null);
    setPage(p);
    history.pushState(null, "", "#" + p);
    setEditing(null);
    setTask(null);
    reloadProjects().catch((e) => notify(e.message));
    window.scrollTo(0, 0);
  }
  useEffect(() => {
    let active = true;
    async function boot() {
      setLoading(true);
      try {
        const [list, favs] = await Promise.all([
          api("/projects"),
          api("/preferences/template-favorites"),
        ]);
        if (!active) return;
        setProjects(list);
        setFavorites(favs || []);
        setLoadError("");
        const route = location.hash.slice(1);
        if (route.startsWith("studio/")) await restoreStudio(route.slice(7));
        else if (route.startsWith("editor/")) {
          const p = await api("/projects/" + route.slice(7));
          if (active) setEditing(p);
        } else if (route === "studio") await openStudio();
      } catch (e) {
        if (active) setLoadError(e.message);
      } finally {
        if (active) setLoading(false);
      }
    }
    boot();
    const onHash = () => {
      setStudio(null);
      setEditing(null);
      setTask(null);
      setPage(location.hash.slice(1).split("/")[0] || "home");
      boot();
    };
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setSearchOpen((v) => !v);
      }
    };
    let refreshTimer;
    const refresh = () => {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => reloadProjects().catch(() => {}), 180);
    };
    window.addEventListener("hashchange", onHash);
    window.addEventListener("popstate", onHash);
    window.addEventListener("keydown", onKey);
    window.addEventListener("designx:refresh", refresh);
    const events = new EventSource("/api/events");
    // Reconnection replays persisted events. Coalesce that burst before notifying
    // subscribers, each of which may read several workspace resources.
    let workspaceEventTimer;
    const event = (message) => {
      if (message?.type === 'job.updated') {
        try {
          const payload = JSON.parse(message.data).payload;
          if (payload?.kind === 'ai.turn') {
            window.dispatchEvent(new CustomEvent('designx:ai-turn', { detail: payload }));
            // Token/tool progress must not reload every design in a large project.
            if (!['succeeded','failed','cancelled'].includes(payload.status)) return;
          }
        } catch { /* Normal resource refresh handles non-protocol events. */ }
      }
      clearTimeout(workspaceEventTimer);
      workspaceEventTimer = setTimeout(refreshWorkspace, 180);
    };
    events.onmessage = event;
    [
      "job.updated",
      "asset.ready",
      "project.updated",
      "document.committed",
    ].forEach((name) => events.addEventListener(name, event));
    return () => {
      active = false;
      events.close();
      window.removeEventListener("hashchange", onHash);
      window.removeEventListener("popstate", onHash);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("designx:refresh", refresh);
      clearTimeout(refreshTimer);
      clearTimeout(workspaceEventTimer);
      clearTimeout(timer.current);
    };
  }, []);
  async function save(p) {
    const body = { title: p.title, design: p.design, baseRevision: p.revision };
    const result =
      p.projectId && p.documentId && p.id !== p.projectId
        ? await api(`/projects/${p.projectId}/artboards/${p.documentId}`, {
            method: "PATCH",
            body,
          })
        : await api("/projects/" + p.id, { method: "PATCH", body });
    const savedProject = { ...p, ...result, persisted: true };
    setEditedProject(savedProject);
    await reloadProjects();
    return savedProject;
  }
  async function favorite(id) {
    const next = favorites.includes(id)
      ? favorites.filter((x) => x !== id)
      : [...favorites, id];
    try {
      await api("/preferences/template-favorites", {
        method: "PUT",
        body: next,
      });
      setFavorites(next);
    } catch (e) {
      notify(e.message);
    }
  }
  async function edit(p) {
    try {
      let target;
      if (p.projectId && p.documentId) target = p;
      else if (p.persisted && p.id) {
        target = await api("/projects/" + p.id);
        await api("/projects/" + p.id + "/open", { method: "POST" });
      } else
        target = await api("/projects", {
          method: "POST",
          body: {
            title: p.title || "未命名设计",
            design: initialDesign(p),
            image: p.image,
            type: "设计作品",
          },
        });
      setTemplate(null);
      setTask(null);
      setEditing({ ...target, persisted: true });
      if (!studio) history.pushState(null, "", "#editor/" + target.id);
      await reloadProjects();
      window.scrollTo(0, 0);
    } catch (e) {
      notify(e.message);
    }
  }
  async function openProject(p) {
    try {
      const board = await api("/projects/" + p.id + "/studio");
      if (board.snapshot) {
        await restoreStudio(p.id, {}, { project: p, board });
        history.pushState(null, "", "#studio/" + p.id);
      } else await edit(p);
    } catch (e) {
      notify(e.message);
    }
  }
  const current = NAV.find((x) => x[0] === page);
  return (
    <>
      <div className={"app-shell " + (collapsed ? "collapsed" : "")}>
        {loadError && (
          <div className="app-load-error" role="alert">
            {loadError}
            <button onClick={() => location.reload()}>重试</button>
          </div>
        )}
        {studio && (
          <div style={{ display: editing ? "none" : "contents" }}>
            <AIStudio
              key={studio.id}
              session={studio}
              onBack={() => navigate("home")}
              onNew={() => openStudio()}
              onEdit={edit}
              onSave={save}
              onToast={notify}
              editedProject={editedProject}
            />
          </div>
        )}
        {editing ? (
          <Editor
            key={editing.id}
            project={editing}
            onBack={() => {
              setEditing(null);
              if (!studio) navigate("projects");
            }}
            onSave={save}
            onToast={notify}
          />
        ) : studio ? null : (
          <>
            <aside className="sidebar">
              <button
                className="brand"
                onClick={() => navigate("home")}
                aria-label="Design X 首页"
              >
                <span className="brand-symbol">✳</span>
                <span>
                  design<span className="brand-x">x</span>
                  <small>灵感设计室</small>
                </span>
              </button>
              <button
                className="space-picker"
                onClick={() => navigate("projects")}
              >
                <span className="space-avatar">Y</span>
                <span>
                  我的创作空间<small>个人空间</small>
                </span>
                <ChevronDown size={14} />
              </button>
              <button className="create-button" onClick={() => openStudio()}>
                <Plus size={20} />
                <span>开始创作</span>
              </button>
              <nav aria-label="主导航">
                {NAV.map(([id, name, Icon], i) => (
                  <React.Fragment key={id}>
                    {i === 4 && (
                      <div className="nav-separator">
                        <span>我的工作空间</span>
                      </div>
                    )}
                    <button
                      className={
                        "nav-item " + (page === id && !task ? "active" : "")
                      }
                      onClick={() => navigate(id)}
                      title={name}
                    >
                      <Icon size={19} strokeWidth={1.7} />
                      <span>{name}</span>
                      {id === "skills" && <b>NEW</b>}
                      {page === id && !task && <i />}
                    </button>
                  </React.Fragment>
                ))}
              </nav>
              <div className="sidebar-bottom">
                <div className="sidebar-tip">
                  <div>
                    <Sparkles size={17} />
                    <span>给灵感，一个开始</span>
                  </div>
                  <p>从一句话，开始你的第一份设计</p>
                  <button
                    onClick={() => {
                      navigate("home");
                      setTimeout(
                        () =>
                          document.querySelector(".composer textarea")?.focus(),
                        100,
                      );
                    }}
                  >
                    试试 AI 创作 <ArrowUpRight size={14} />
                  </button>
                  <span className="tip-drawing">✳</span>
                </div>
                <button className="nav-item" onClick={() => navigate("guide")}>
                  <BookOpen size={18} />
                  <span>创作指南</span>
                  <ArrowUpRight size={14} />
                </button>
                <div className="profile">
                  <button
                    className="profile-avatar"
                    onClick={onLogout}
                    title="退出登录"
                    aria-label="退出登录"
                  >
                    {sessionUser.name?.slice(0, 1) || "我"}
                  </button>
                  <div>
                    <b>{sessionUser.name} 的设计空间</b>
                    <small>
                      <span /> 个人创作者
                    </small>
                  </div>
                  <button
                    aria-label="收起侧栏"
                    onClick={() => setCollapsed((v) => !v)}
                  >
                    <PanelLeftClose size={17} />
                  </button>
                </div>
              </div>
            </aside>
            <div className="main-shell">
              <header className="topbar">
                <div className="breadcrumb">
                  {collapsed && (
                    <button
                      className="icon-button"
                      onClick={() => setCollapsed(false)}
                      aria-label="展开导航"
                    >
                      <Menu size={18} />
                    </button>
                  )}
                  <span>工作空间</span>
                  <ChevronRight size={13} />
                  <b>{task ? task.name : current?.[1] || "创作指南"}</b>
                </div>
                <div className="header-actions">
                  <button
                    className="header-search"
                    onClick={() => setSearchOpen(true)}
                  >
                    <Search size={15} />
                    <span>搜索灵感、工具或作品</span>
                    <kbd>⌘ K</kbd>
                  </button>
                  <span className="prototype-badge">
                    <span />
                    创作空间
                  </span>
                  <button
                    className="icon-button notification-toggle"
                    aria-label="查看消息"
                    onClick={() => setNotice(!notice)}
                  >
                    <Bell size={18} />
                    <i />
                  </button>
                  <button
                    className="header-avatar"
                    onClick={() => navigate("projects")}
                    aria-label="我的空间"
                  >
                    Y
                  </button>
                </div>
                {notice && (
                  <JobPanel
                    onClose={() => setNotice(false)}
                    onToast={notify}
                    onOpenProject={openProject}
                  />
                )}
              </header>
              <main
                className={"main-content " + (task ? "workbench-content" : "")}
              >
                {task ? (
                  <Workbench
                    key={task.name + task.prompt}
                    item={task}
                    onBack={() => setTask(null)}
                    onEdit={edit}
                    onSave={save}
                    onToast={notify}
                  />
                ) : page === "home" ? (
                  <HomePage
                    onNavigate={navigate}
                    onTask={openStudio}
                    onTemplate={setTemplate}
                    onCreate={() => openStudio()}
                    projects={projects}
                    onProject={openProject}
                    favorites={favorites}
                    toggleFavorite={favorite}
                  />
                ) : page === "templates" ? (
                  <TemplatesPage
                    onSelect={setTemplate}
                    favorites={favorites}
                    toggleFavorite={favorite}
                  />
                ) : page === "skills" || page === "tools" ? (
                  <Catalog
                    mode={page}
                    onSelect={page === "skills" ? openStudio : setTask}
                    onToast={notify}
                  />
                ) : ["projects", "assets", "recent"].includes(page) ? (
                  <Workspace
                    key={page}
                    mode={page}
                    projects={
                      page === "recent"
                        ? projects
                            .filter((p) => p.lastOpenedAt)
                            .sort(
                              (a, b) =>
                                new Date(b.lastOpenedAt) -
                                new Date(a.lastOpenedAt),
                            )
                        : projects
                    }
                    onOpenProject={openProject}
                    onProjectsChanged={reloadProjects}
                    onToast={notify}
                    onCreateProject={() => openStudio()}
                  />
                ) : (
                  <Guide onNavigate={navigate} />
                )}
              </main>
            </div>
          </>
        )}
      </div>
      {toast && (
        <div className="toast" role="status">
          <CheckCircle2 size={18} />
          {toast}
        </div>
      )}
      {template && (
        <Modal onClose={() => setTemplate(null)} className="template-modal">
          <div className="template-preview">
            <Artwork item={template} />
          </div>
          <div className="template-detail">
            <span className="eyebrow">DESIGN X / EDITOR'S PICK</span>
            <h2>{template.title}</h2>
            <p>{template.description}</p>
            <div className="detail-chips">
              <span>{template.category}</span>
              <span>{template.style}</span>
              <span>可编辑模板</span>
            </div>
            <dl>
              <div>
                <dt>画布比例</dt>
                <dd>3 : 4</dd>
              </div>
              <div>
                <dt>设计内容</dt>
                <dd>图片、文字与装饰元素</dd>
              </div>
              <div>
                <dt>适用场景</dt>
                <dd>{template.subtitle}</dd>
              </div>
            </dl>
            <button className="primary" onClick={() => edit(template)}>
              使用这个模板 <ArrowRight size={17} />
            </button>
            <button className="secondary" onClick={() => favorite(template.id)}>
              <Heart
                size={16}
                fill={favorites.includes(template.id) ? "currentColor" : "none"}
              />
              {favorites.includes(template.id) ? "已收藏灵感" : "收藏这个灵感"}
            </button>
            <small>文字、图片与配色均可在画布中自由调整</small>
          </div>
        </Modal>
      )}
      {searchOpen && (
        <Modal onClose={() => setSearchOpen(false)} className="search-modal">
          <div className="global-search">
            <Search size={22} />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="想找什么灵感？"
              aria-label="全局搜索"
            />
          </div>
          <h4>{query ? "搜索结果" : "快捷导航"}</h4>
          {NAV.filter((x) => !query || x[1].includes(query)).map(
            ([id, n, I]) => (
              <button
                className="search-result"
                key={id}
                onClick={() => {
                  setSearchOpen(false);
                  navigate(id);
                }}
              >
                <I size={18} />
                <span>{n}</span>
                <ArrowUpRight size={15} />
              </button>
            ),
          )}
          {templates
            .filter((t) => query && `${t.title}${t.subtitle}`.includes(query))
            .map((t) => (
              <button
                className="search-result"
                key={t.id}
                onClick={() => {
                  setSearchOpen(false);
                  setTemplate(t);
                }}
              >
                <img src={t.image} />
                <span>{t.title}</span>
                <ArrowUpRight size={15} />
              </button>
            ))}
          {query &&
            [...catalog.skills, ...catalog.tools]
              .filter((t) => t.name.includes(query))
              .slice(0, 8)
              .map((t) => (
                <button
                  className="search-result"
                  key={t.id}
                  onClick={() => {
                    setSearchOpen(false);
                    catalog.skills.some((s) => s.id === t.id)
                      ? openStudio(t)
                      : setTask(t);
                  }}
                >
                  <Sparkles size={18} />
                  <span>
                    {t.name} · {t.category}
                  </span>
                  <ArrowUpRight size={15} />
                </button>
              ))}
          {query &&
            projects
              .filter((p) => p.title.includes(query))
              .map((p) => (
                <button
                  className="search-result"
                  key={p.id}
                  onClick={() => {
                    setSearchOpen(false);
                    edit(p);
                  }}
                >
                  <FolderOpen size={18} />
                  <span>{p.title}</span>
                  <ArrowUpRight size={15} />
                </button>
              ))}
          {query &&
            ![...catalog.skills, ...catalog.tools].some((t) =>
              t.name.includes(query),
            ) &&
            !projects.some((p) => p.title.includes(query)) &&
            !NAV.some((x) => x[1].includes(query)) &&
            !templates.some((t) =>
              `${t.title}${t.subtitle}`.includes(query),
            ) && (
              <div className="empty-block">
                <p>没有找到匹配内容</p>
                <button
                  onClick={() => {
                    setSearchOpen(false);
                    navigate("skills");
                  }}
                  className="text-button"
                >
                  去技能库继续探索 <ArrowRight size={14} />
                </button>
              </div>
            )}
        </Modal>
      )}
    </>
  );
}
