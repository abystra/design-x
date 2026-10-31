import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowUp,
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronRight,
  Download,
  Expand,
  FolderOpen,
  Hand,
  History,
  ImagePlus,
  Images,
  LoaderCircle,
  MessageSquare,
  Minus,
  MousePointer2,
  Plus,
  Save,
  Search,
  Sparkles,
  Square,
  WandSparkles,
  X,
  Video,
  Bot,
  Library,
  PanelLeftClose,
  PanelLeftOpen,
  RotateCcw,
  Undo2,
  Redo2,
  Copy,
  Trash2,
  AlignLeft,
  AlignStartVertical,
  LayoutTemplate,
  StickyNote,
  SquareDashed,
  FolderPlus,
  FileArchive,
} from "lucide-react";
import catalog from "../data/catalog.json";
import { api, uploadAsset, waitForJob } from "../lib/api";
import {
  boardItems,
  boardItemSize,
  organizationSnapshot,
  moveBoardItems,
  removeBoardItems,
  alignBoardItems,
  assignSectionMembers,
  expandSelection,
  copyBoardValue,
  boardPersistenceSnapshot,
  initialPersistenceBaseline,
} from "./board-state";
import { templates } from "../data/templates";
import { initialDesign } from "./Editor";
import BoardWorld, { DesignPreview } from "./BoardWorld";
import TldrawBoard from "./TldrawBoard";
export { DesignPreview } from "./BoardWorld";
import "./ai-studio.css";

const SAMPLES = [
  {
    name: "商品套图",
    category: "电商",
    image: "headphones",
    prompt:
      "为这款无线耳机设计 3 张电商商品图，突出轻盈、降噪和长续航，简洁绿色风格",
  },
  {
    name: "营销海报",
    category: "海报",
    image: "coffee",
    prompt:
      "为咖啡品牌设计 3 张秋日上新海报，温暖奶油色，标题“把秋天，装进一杯咖啡”",
  },
  {
    name: "爆款图复刻",
    category: "电商",
    image: "skincare",
    prompt: "为护肤新品做 3 张自然质感的推广图，突出植物精华与温和护肤",
  },
  {
    name: "换模特",
    category: "服饰",
    image: "fashion",
    prompt: "为秋季服饰设计 3 张穿搭展示方案，杂志风格，低饱和配色",
  },
  {
    name: "社媒图文笔记",
    category: "自媒体",
    image: "interior",
    prompt: "设计 3 张小红书家居图文封面，分享舒适自然的居家灵感",
  },
  {
    name: "剧情广告",
    category: "视频",
    image: "nature",
    prompt: "为自然旅行主题创作一组广告分镜，清新绿色，3 个关键镜头",
  },
];
const CATEGORIES = [
  "推荐",
  "最近使用",
  "电商",
  "海报",
  "视频",
  "自媒体",
  "品牌",
  "办公",
  "服饰",
  "图像",
];
const STOCK = [
  ["coffee", "秋日咖啡"],
  ["skincare", "植物护肤"],
  ["fashion", "秋季服饰"],
  ["headphones", "无线耳机"],
  ["interior", "自然家居"],
  ["nature", "户外灵感"],
].map(([key, name]) => ({ id: key, name, url: `/assets/${key}.jpg` }));
const uid = () => `dx-${crypto.randomUUID()}`;
const skillImage = (s) =>
  SAMPLES.find((x) => x.name === s.name)?.image ||
  {
    电商: "skincare",
    海报: "coffee",
    视频: "nature",
    自媒体: "interior",
    品牌: "headphones",
    办公: "interior",
    服饰: "fashion",
    图像: "nature",
  }[s.category] ||
  "coffee";
function IconButton({ label, children, ...props }) {
  return (
    <button className="st-icon" aria-label={label} title={label} {...props}>
      {children}
    </button>
  );
}
function BoardSizeField({ label, value, min, max, onCommit }) {
  const [draftValue, setDraftValue] = useState(String(value));
  useEffect(() => setDraftValue(String(value)), [value]);
  return (
    <label className="st-board-field">
      <span>{label.endsWith("宽度") ? "宽度" : "高度"}</span>
      <input
        type="number"
        aria-label={label}
        min={min}
        max={max}
        value={draftValue}
        onChange={(event) => setDraftValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
        onBlur={() => {
          const parsed = Number(draftValue);
          const next =
            Number.isFinite(parsed) && draftValue.trim()
              ? Math.min(max, Math.max(min, Math.round(parsed)))
              : value;
          setDraftValue(String(next));
          if (next !== value) onCommit(next);
        }}
      />
    </label>
  );
}
export default function AIStudio({
  session,
  onBack,
  onNew,
  onEdit,
  onSave,
  onToast,
  editedProject,
}) {
  const snap = session.snapshot || {};
  const projectId = session.projectId || session.id;
  const [boardEngine] = useState(() =>
    new URLSearchParams(typeof window === "undefined" ? "" : window.location.search).get("boardEngine") === "legacy"
      ? "legacy"
      : "tldraw",
  );
  const nativeBoard = boardEngine === "tldraw";
  const Canvas = nativeBoard ? TldrawBoard : BoardWorld;
  const [title, setTitle] = useState(snap.title || "新创作");
  const [messages, setMessages] = useState(
    (snap.messages || []).map((m) =>
      m.status === "running"
        ? {
            ...m,
            status: "cancelled",
            text: "此需求未执行，AI 能力将在后续开放。",
          }
        : m,
    ),
  );
  const [results, setResults] = useState(snap.results || []);
  const [notes, setNotes] = useState(snap.notes || []);
  const [sections, setSections] = useState(snap.sections || []);
  const [editingNote, setEditingNote] = useState(null);
  const [exportingPackage, setExportingPackage] = useState(false);
  const [exportStatus, setExportStatus] = useState("");
  const [targetSection, setTargetSection] = useState("");
  const [draft, setDraft] = useState(
    snap.draft || session.draft || session.initialPrompt || "",
  );
  const [skill, setSkill] = useState(snap.skill || session.skill || null);
  const [mode, setMode] = useState(snap.mode || session.mode || "Agent");
  const [assets, setAssets] = useState(
    snap.assets?.length ? snap.assets : session.assets || snap.assets || [],
  );
  const [attached, setAttached] = useState(
    snap.attached?.length
      ? snap.attached
      : session.assets || snap.attached || [],
  );
  const [ratio, setRatio] = useState(snap.ratio || "自动");
  const [count, setCount] = useState(snap.count || "自动");
  const [panel, setPanel] = useState(
    session.panel === undefined ? "skills" : session.panel,
  );
  const [category, setCategory] = useState("推荐");
  const [query, setQuery] = useState("");
  const [assetTab, setAssetTab] = useState("示例素材");
  const [recentSkills, setRecentSkills] = useState([]);
  const [serverAssets, setServerAssets] = useState([]);
  const [references, setReferences] = useState([]);
  const [popover, setPopover] = useState(null);
  const [selected, setSelected] = useState(snap.selected || null);
  const [selection, setSelection] = useState(
    snap.selection || (snap.selected ? [snap.selected] : []),
  );
  const [reference, setReference] = useState(snap.reference || null);
  const [error, setError] = useState("");
  const [libraryError, setLibraryError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [saveState, setSaveState] = useState("saved");
  const [conflicted, setConflicted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [view, setView] = useState(snap.view || { x: 70, y: 140, zoom: 1 });
  const [tool, setTool] = useState("select");
  const [mobileView, setMobileView] = useState("chat");
  const [chatHidden, setChatHidden] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [, renderHistory] = useState(0);
  const viewport = useRef(),
    chat = useRef(),
    input = useRef(),
    file = useRef(),
    drag = useRef(),
    latest = useRef();
  const revision = useRef(session.revision || 1);
  const savedJson = useRef("");
  const savedSnapshot = useRef(null);
  const initializedSnapshot = useRef(false);
  const world = useRef(null);
  const handlers = useRef({});
  const gestureFrame = useRef(null);
  const liveView = useRef(view);
  const chain = useRef(Promise.resolve());
  const saveTimer = useRef();
  const conflict = useRef(false);
  const history = useRef({ past: [], future: [] });
  const known = useRef(new Map((snap.results || []).map((r) => [r.id, r])));
  const mounted = useRef(true);
  const selectedResult = results.find((r) => r.id === selected);
  const selectedNote = notes.find((r) => r.id === selected);
  const selectedSection = sections.find((r) => r.id === selected);
  const selectedItem = selectedNote || selectedSection;
  const referenceResult = results.find((r) => r.id === reference);
  const skillList = useMemo(() => {
    const list =
      category === "最近使用"
        ? recentSkills
            .map(
              (id) =>
                catalog.skills.find((s) => s.id === id) ||
                SAMPLES.find((s) => s.name === id),
            )
            .filter(Boolean)
        : category === "推荐"
          ? [
              ...SAMPLES.map(
                (s) => catalog.skills.find((c) => c.name === s.name) || s,
              ),
              ...catalog.skills
                .filter((s) => !SAMPLES.some((x) => x.name === s.name))
                .slice(0, 9),
            ]
          : catalog.skills.filter((s) => s.category === category);
    return list.filter((s) =>
      `${s.name}${s.description || ""}`.includes(query),
    );
  }, [category, query, recentSkills]);
  const library =
    assetTab === "本次文件"
      ? assets
      : assetTab === "我的资产"
        ? serverAssets
        : assetTab === "创作参考"
          ? references
          : STOCK;
  const snapshot = useMemo(
    () => ({
      id: projectId,
      title,
      messages,
      results,
      notes,
      sections,
      draft,
      skill,
      mode,
      assets,
      attached,
      ratio,
      count,
      view,
      selected,
      selection,
      reference,
    }),
    [
      projectId,
      title,
      messages,
      results,
      notes,
      sections,
      draft,
      skill,
      mode,
      assets,
      attached,
      ratio,
      count,
      view,
      selected,
      selection,
      reference,
    ],
  );
  latest.current = snapshot;
  if (!savedSnapshot.current) {
    const candidate = JSON.stringify(persistedSnapshot(snapshot));
    const baseline = initializedSnapshot.current
      ? candidate
      : JSON.stringify(initialPersistenceBaseline(snapshot, snap));
    savedJson.current = baseline;
    savedSnapshot.current = candidate === baseline ? snapshot : {};
    initializedSnapshot.current = true;
  }
  handlers.current = {
    startPointer,
    selectResult,
    updateItem,
    setEditingNote,
    openEditor,
    referenceDesign,
    saveDesign,
    finishGesture,
    canvasCommit: (next, before) => commitBoard(next, before),
    canvasSelection: (ids, active) => {
      latest.current = { ...latest.current, selection: ids, selected: active };
      setSelection(ids);
      setSelected(active);
    },
    canvasView: (next) => {
      liveView.current = next;
      latest.current = { ...latest.current, view: next };
      setView(next);
    },
    canvasInteractionStart: () => setSaveState("dirty"),
  };

  function enqueue(action) {
    const next = chain.current.catch(() => {}).then(action);
    chain.current = next;
    return next;
  }
  function persistedSnapshot(value) {
    return boardPersistenceSnapshot(value);
  }
  async function saveNow() {
    const value = latest.current;
    if (value === savedSnapshot.current) return;
    // Serialize only the light Board organization, once at the settled save
    // boundary. Designs remain in their authoritative artboard documents.
    const payload = persistedSnapshot(value);
    const serialized = JSON.stringify(payload);
    if (serialized === savedJson.current) {
      savedSnapshot.current = value;
      if (mounted.current) setSaveState("saved");
      return;
    }
    if (conflict.current)
      throw new Error("工作区存在版本冲突，请先处理未保存的更改");
    if (mounted.current) setSaveState("saving");
    try {
      const saved = await api(`/projects/${projectId}/studio?response=ack`, {
        method: "PUT",
        body: { snapshot: payload, baseRevision: revision.current },
      });
      revision.current = saved.revision;
      savedJson.current = serialized;
      savedSnapshot.current = value;
      if (mounted.current) {
        setSaveError("");
        setSaveState(latest.current === value ? "saved" : "dirty");
      }
    } catch (failure) {
      if (failure.status === 409) {
        conflict.current = true;
        if (mounted.current) setConflicted(true);
      }
      if (mounted.current) {
        setSaveError(failure.message);
        setSaveState("error");
      }
      throw failure;
    }
  }
  function flush() {
    finishGesture();
    clearTimeout(saveTimer.current);
    return enqueue(saveNow);
  }
  useEffect(() => {
    if (snapshot === savedSnapshot.current || conflict.current) return;
    setSaveState("dirty");
    clearTimeout(saveTimer.current);
    const autosave = () => {
      // A gesture owns its temporary positions until pointer release. Saving
      // selection changes must not terminate a long drag or pan halfway through.
      if (drag.current || world.current?.isInteracting?.()) {
        saveTimer.current = setTimeout(autosave, 250);
        return;
      }
      flush().catch(() => {});
    };
    saveTimer.current = setTimeout(autosave, 650);
    return () => clearTimeout(saveTimer.current);
  }, [snapshot]);
  useEffect(() => {
    mounted.current = true;
    const warn = (event) => {
      finishGesture();
      if (latest.current !== savedSnapshot.current) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    const blur = () => finishGesture();
    const visibility = () => {
      if (document.visibilityState === "hidden") finishGesture();
    };
    window.addEventListener("beforeunload", warn);
    window.addEventListener("blur", blur);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      finishGesture({ render: false });
      mounted.current = false;
      clearTimeout(saveTimer.current);
      window.removeEventListener("beforeunload", warn);
      window.removeEventListener("blur", blur);
      document.removeEventListener("visibilitychange", visibility);
      if (!conflict.current) enqueue(saveNow).catch(() => {});
    };
  }, []);
  useEffect(() => {
    chat.current?.scrollTo({
      top: chat.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages]);
  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const [libraryAssets, referenceData, skills] = await Promise.all([
          api("/assets"),
          api("/preferences/references"),
          api("/preferences/studio-skills"),
        ]);
        if (!active) return;
        const normalize = (a) => ({
          ...a,
          name: a.title || a.name,
          url: a.image || a.url,
          assetId: a.assetId || (a.status ? a.id : undefined),
        });
        setServerAssets(
          libraryAssets.filter((a) => a.status === "ready").map(normalize),
        );
        setReferences(
          (Array.isArray(referenceData) ? referenceData : []).map(normalize),
        );
        setRecentSkills(Array.isArray(skills) ? skills : []);
        setLibraryError("");
      } catch (failure) {
        if (active) setLibraryError(failure.message);
      }
    };
    load();
    window.addEventListener("designx:refresh", load);
    return () => {
      active = false;
      window.removeEventListener("designx:refresh", load);
    };
  }, []);
  useEffect(() => {
    if (!editedProject || editedProject.projectId !== projectId) return;
    const id = editedProject.documentId || editedProject.id;
    updateResults(
      latest.current.results.map((r) =>
        r.id === id
          ? {
              ...r,
              ...editedProject,
              id: r.id,
              documentId: id,
              position: r.position,
            }
          : r,
      ),
    );
  }, [editedProject]);
  function organization(board = latest.current) {
    return organizationSnapshot(board);
  }
  function updateResults(list) {
    list.forEach((r) => known.current.set(r.id, r));
    latest.current = { ...latest.current, results: list };
    setResults(list);
  }
  function updateBoard(next) {
    updateResults(next.results);
    latest.current = {
      ...latest.current,
      notes: next.notes || [],
      sections: next.sections || [],
    };
    setNotes(next.notes || []);
    setSections(next.sections || []);
  }
  function commitBoard(next, before = organization()) {
    if (JSON.stringify(before) !== JSON.stringify(organization(next))) {
      history.current.past = [...history.current.past, before].slice(-80);
      history.current.future = [];
      renderHistory((n) => n + 1);
    }
    updateBoard(next);
  }
  function commitResults(list, before = organization()) {
    commitBoard({ ...latest.current, results: list }, before);
  }
  function restoreOrganization(snapshot) {
    const list = snapshot.results
      .map((item) =>
        known.current.has(item.id)
          ? { ...known.current.get(item.id), position: item.position }
          : null,
      )
      .filter(Boolean);
    const next = {
      ...latest.current,
      ...copyBoardValue(snapshot),
      results: list,
    };
    updateBoard(next);
    const available = new Set(boardItems(next).map((item) => item.id));
    setSelection((ids) => ids.filter((id) => available.has(id)));
    setSelected((id) => (available.has(id) ? id : null));
  }
  function undo() {
    finishGesture();
    const previous = history.current.past.pop();
    if (!previous) return;
    history.current.future.push(organization());
    restoreOrganization(previous);
    renderHistory((n) => n + 1);
  }
  function redo() {
    finishGesture();
    const next = history.current.future.pop();
    if (!next) return;
    history.current.past.push(organization());
    restoreOrganization(next);
    renderHistory((n) => n + 1);
  }
  function selectResult(id, event) {
    finishGesture();
    setSelected(id);
    setSelection((ids) =>
      event?.shiftKey
        ? ids.includes(id)
          ? ids.filter((value) => value !== id)
          : [...ids, id]
        : [id],
    );
  }
  function removeSelected() {
    finishGesture();
    if (busy || conflicted) return;
    commitBoard(removeBoardItems(latest.current, selection));
    setSelection([]);
    setSelected(null);
    setReference(null);
    setEditingNote(null);
  }
  function alignSelected(axis) {
    finishGesture();
    if (busy || conflicted) return;
    commitBoard(alignBoardItems(latest.current, selection, axis));
  }
  function updateItem(id, values) {
    finishGesture();
    if (busy || conflicted) return;
    commitBoard({
      ...latest.current,
      notes: latest.current.notes.map((item) =>
        item.id === id ? { ...item, ...values } : item,
      ),
      sections: latest.current.sections.map((item) =>
        item.id === id ? { ...item, ...values } : item,
      ),
    });
  }
  function addNote() {
    finishGesture();
    if (busy || conflicted) return;
    const note = {
      id: uid(),
      text: "",
      position: nextPosition(),
      width: 240,
      height: 200,
      color: "#FFF0B5",
    };
    commitBoard({ ...latest.current, notes: [...latest.current.notes, note] });
    setSelected(note.id);
    setSelection([note.id]);
    setEditingNote(note.id);
    setPanel(null);
    setMobileView("canvas");
    fit([note]);
  }
  function addSection() {
    finishGesture();
    if (busy || conflicted) return;
    const members = boardItems(latest.current).filter(
      (item) => selection.includes(item.id) && item.kind !== "section",
    );
    const minX = members.length
      ? Math.min(...members.map((item) => item.position.x)) - 35
      : nextPosition().x;
    const minY = members.length
      ? Math.min(...members.map((item) => item.position.y)) - 55
      : 0;
    const maxX = members.length
      ? Math.max(
          ...members.map((item) => item.position.x + boardItemSize(item).width),
        ) + 35
      : minX + 560;
    const maxY = members.length
      ? Math.max(
          ...members.map(
            (item) => item.position.y + boardItemSize(item).height,
          ),
        ) + 35
      : minY + 420;
    const section = {
      id: uid(),
      title: "新的分区",
      position: { x: minX, y: minY },
      width: Math.min(20000, Math.max(240, maxX - minX)),
      height: Math.min(20000, Math.max(160, maxY - minY)),
      color: "#CBD8BE",
      itemIds: [],
    };
    const next = assignSectionMembers(
      { ...latest.current, sections: [...latest.current.sections, section] },
      section.id,
      members.map((item) => item.id),
    );
    commitBoard(next);
    setSelected(section.id);
    setSelection([section.id]);
    setPanel(null);
    setMobileView("canvas");
    fit([section]);
  }
  function joinSection(sectionId) {
    finishGesture();
    if (!sectionId || busy || conflicted) return;
    commitBoard(assignSectionMembers(latest.current, sectionId, selection));
    onToast?.("选中内容已加入分区");
  }
  function removeFromSections(ids = selection) {
    finishGesture();
    const removing = new Set(ids);
    commitBoard({
      ...latest.current,
      sections: latest.current.sections.map((section) => ({
        ...section,
        itemIds: section.itemIds.filter((id) => !removing.has(id)),
      })),
    });
  }
  useEffect(() => {
    const onKey = (e) => {
      if (!viewport.current?.getClientRects().length) return;
      if (e.isComposing || e.keyCode === 229) return;
      const editing = e.target.closest?.(
        'input,textarea,select,[contenteditable="true"]',
      );
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (nativeBoard) e.stopImmediatePropagation();
        flush().catch(() => {});
        return;
      }
      if (editing) return;
      if (nativeBoard && (
        ["Escape", "Delete", "Backspace", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key) ||
        ((e.metaKey || e.ctrlKey) && ["a", "z", "d"].includes(e.key.toLowerCase()))
      )) e.stopImmediatePropagation();
      if (e.key === "Escape") {
        finishGesture();
        setPanel(null);
        setPopover(null);
        setShowNew(false);
        setSelection([]);
        setSelected(null);
        setEditingNote(null);
        return;
      }
      if (busy || conflict.current) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a") {
        e.preventDefault();
        finishGesture();
        setSelection(boardItems(latest.current).map((r) => r.id));
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        e.shiftKey ? redo() : undo();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "d") {
        e.preventDefault();
        duplicateSelected();
        return;
      }
      if (["Delete", "Backspace"].includes(e.key) && selection.length) {
        e.preventDefault();
        removeSelected();
        return;
      }
      if (
        ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key) &&
        selection.length
      ) {
        e.preventDefault();
        const amount = e.shiftKey ? 10 : 1;
        finishGesture();
        commitBoard(
          moveBoardItems(
            latest.current,
            selection,
            e.key === "ArrowRight"
              ? amount
              : e.key === "ArrowLeft"
                ? -amount
                : 0,
            e.key === "ArrowDown" ? amount : e.key === "ArrowUp" ? -amount : 0,
          ),
        );
      }
    };
    window.addEventListener("keydown", onKey, nativeBoard);
    return () => window.removeEventListener("keydown", onKey, nativeBoard);
  }, [results, notes, sections, selection, busy]);
  async function leave(action) {
    if (busy || uploading) return;
    try {
      await flush();
      await action?.();
    } catch (failure) {
      setError(failure.message);
    }
  }
  async function openEditor(result) {
    await leave(() => onEdit?.(result));
  }
  function togglePanel(next) {
    setPanel((p) => (p === next ? null : next));
    setPopover(null);
    setMobileView("canvas");
  }
  async function chooseSkill(s) {
    setSkill(s);
    setPopover(null);
    setError("");
    setDraft((v) => v.replace(/\/[\w\u4e00-\u9fa5]*$/, ""));
    const next = [
      s.id || s.name,
      ...recentSkills.filter((id) => id !== (s.id || s.name)),
    ].slice(0, 12);
    try {
      await api("/preferences/studio-skills", { method: "PUT", body: next });
      setRecentSkills(next);
    } catch (failure) {
      setError(failure.message);
    }
    input.current?.focus();
    setMobileView("chat");
  }
  function attachAsset(a) {
    if (attached.some((x) => x.url === a.url)) return;
    setAttached((v) => [...v, a].slice(-4));
    setAssets((v) => (v.some((x) => x.url === a.url) ? v : [...v, a]));
    setDraft((v) => v.replace(/@[^\s]*$/, ""));
    setError("");
    setMobileView("chat");
    input.current?.focus();
  }
  async function upload(e) {
    const files = [...e.target.files];
    e.target.value = "";
    if (!files.length || uploading || busy || conflicted) return;
    setUploading(true);
    setError("");
    try {
      for (const file of files.slice(0, 4)) {
        const uploaded = await uploadAsset(file);
        const asset = {
          ...uploaded,
          id: uploaded.id,
          assetId: uploaded.id,
          name: uploaded.title || file.name,
          url: uploaded.image,
        };
        setAssets((list) => [...list.filter((a) => a.id !== asset.id), asset]);
        setAttached((list) =>
          [...list.filter((a) => a.id !== asset.id), asset].slice(-4),
        );
        await addAssetBoard(asset);
      }
    } catch (failure) {
      setError(failure.message);
      onToast?.(failure.message);
    } finally {
      setUploading(false);
    }
  }
  function fit(list = boardItems(latest.current)) {
    if (!list.length) {
      changeView({ x: 70, y: 140, zoom: 1 });
      return;
    }
    const bounds = viewport.current?.getBoundingClientRect();
    const minX = Math.min(...list.map((r) => r.position.x)),
      minY = Math.min(...list.map((r) => r.position.y));
    const maxX = Math.max(
        ...list.map((r) => r.position.x + boardItemSize(r).width),
      ),
      maxY = Math.max(
        ...list.map((r) => r.position.y + boardItemSize(r).height + 30),
      );
    const w = bounds?.width || 900,
      h = bounds?.height || 700;
    const z = Math.max(
      0.2,
      Math.min(1, (w - 90) / (maxX - minX), (h - 190) / (maxY - minY)),
    );
    changeView({
      x: (w - (maxX - minX) * z) / 2 - minX * z,
      y: 100 - minY * z,
      zoom: z,
    });
  }
  function changeView(next) {
    finishGesture();
    liveView.current = next;
    latest.current = { ...latest.current, view: next };
    setView(next);
  }
  function zoomBy(delta) {
    finishGesture();
    const value = world.current?.getView() || liveView.current;
    const zoom = Math.max(
      0.2,
      Math.min(2, Math.round((value.zoom + delta) * 100) / 100),
    );
    const width = viewport.current?.clientWidth || 800,
      height = viewport.current?.clientHeight || 700;
    changeView({
      zoom,
      x: width / 2 - ((width / 2 - value.x) * zoom) / value.zoom,
      y: height / 2 - ((height / 2 - value.y) * zoom) / value.zoom,
    });
  }
  function generate() {
    setError(
      "AI 生成尚未接入。需求已保留，你可以添加模板、素材或空白画板继续设计。",
    );
  }
  function referenceDesign(r) {
    setSelected(r.id);
    setSelection([r.id]);
    setReference(r.id);
    setPanel(null);
    setMobileView("chat");
    input.current?.focus();
  }
  async function saveDesign(result) {
    try {
      await flush();
      const saved = await onSave?.(result);
      if (saved === false) return;
      if (saved)
        updateResults(
          latest.current.results.map((r) =>
            r.id === result.id
              ? {
                  ...r,
                  ...saved,
                  id: r.id,
                  position: r.position,
                  persisted: true,
                }
              : r,
          ),
        );
      onToast?.("画板已保存");
    } catch (failure) {
      setError(failure.message);
    }
  }
  function startPointer(event, result) {
    if (
      event.button !== 0 ||
      event.target.closest("button,input,textarea,select") ||
      busy ||
      conflicted
    )
      return;
    finishGesture();
    const currentView = world.current?.getView() || liveView.current;
    liveView.current = currentView;
    // Pan capture belongs to the stable viewport: the article under the
    // initial press is allowed to leave overscan and unmount during the pan.
    const captureTarget =
      result && tool === "select"
        ? event.currentTarget
        : viewport.current || event.currentTarget;
    captureTarget.setPointerCapture(event.pointerId);
    const common = {
      x: event.clientX,
      y: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      alt: event.altKey,
      captureTarget,
      pointerId: event.pointerId,
      zoom: currentView.zoom,
      moved: false,
    };
    if (result && tool === "select") {
      const ids = event.shiftKey
        ? selection.includes(result.id)
          ? selection.filter((id) => id !== result.id)
          : [...selection, result.id]
        : selection.includes(result.id)
          ? selection
          : [result.id];
      const expanded = expandSelection(latest.current, ids);
      setSelected(result.id);
      setSelection(ids);
      drag.current = {
        ...common,
        ids: expanded,
        start: organization(),
        startBoard: latest.current,
        pinnedIds:
          world.current?.getMountedIds().filter((id) => expanded.has(id)) || [],
      };
    } else drag.current = { ...common, startView: currentView };
    event.stopPropagation();
  }
  function gestureDelta(gesture) {
    const dx = gesture.lastX - gesture.x,
      dy = gesture.lastY - gesture.y;
    if (gesture.ids) {
      const snap = (value) =>
        gesture.alt ? value : Math.round(value / 10) * 10;
      return { dx: snap(dx / gesture.zoom), dy: snap(dy / gesture.zoom) };
    }
    return { dx, dy };
  }
  function paintGesture() {
    gestureFrame.current = null;
    const gesture = drag.current;
    if (!gesture || !gesture.moved) return;
    if (!viewport.current?.getClientRects().length) {
      finishGesture();
      return;
    }
    const { dx, dy } = gestureDelta(gesture);
    if (gesture.ids)
      world.current?.previewDrag({
        ids: gesture.ids,
        dx,
        dy,
        pinnedIds: gesture.pinnedIds,
      });
    else {
      liveView.current = {
        ...gesture.startView,
        x: gesture.startView.x + dx,
        y: gesture.startView.y + dy,
      };
      world.current?.previewView(liveView.current);
    }
  }
  function movePointer(event) {
    const gesture = drag.current;
    if (!gesture) return;
    gesture.lastX = event.clientX;
    gesture.lastY = event.clientY;
    gesture.alt = event.altKey;
    if (
      Math.abs(gesture.lastX - gesture.x) +
        Math.abs(gesture.lastY - gesture.y) <
        2 &&
      !gesture.moved
    )
      return;
    gesture.moved = true;
    if (gestureFrame.current == null)
      gestureFrame.current = requestAnimationFrame(paintGesture);
  }
  function finishGesture({ render = true } = {}) {
    if (nativeBoard) {
      world.current?.settle?.();
      return;
    }
    if (gestureFrame.current != null)
      cancelAnimationFrame(gestureFrame.current);
    gestureFrame.current = null;
    const gesture = drag.current;
    if (!gesture) return;
    drag.current = null;
    if (gesture.moved) {
      const { dx, dy } = gestureDelta(gesture);
      if (gesture.ids) {
        const next = moveBoardItems(gesture.startBoard, gesture.ids, dx, dy);
        if (render) commitBoard(next, gesture.start);
        else
          latest.current = {
            ...latest.current,
            results: next.results,
            notes: next.notes,
            sections: next.sections,
          };
      } else {
        const next = {
          ...gesture.startView,
          x: gesture.startView.x + dx,
          y: gesture.startView.y + dy,
        };
        liveView.current = next;
        latest.current = { ...latest.current, view: next };
        if (render) {
          world.current?.previewView(next);
          setView(next);
        }
      }
    }
    if (render) world.current?.clearPreview();
    try {
      if (gesture.captureTarget.hasPointerCapture(gesture.pointerId))
        gesture.captureTarget.releasePointerCapture(gesture.pointerId);
    } catch {
      /* The capture target may have unmounted while opening Editor. */
    }
  }
  function endPointer(event) {
    if (event?.type === "pointerup" && drag.current) {
      drag.current.lastX = event.clientX;
      drag.current.lastY = event.clientY;
      drag.current.alt = event.altKey;
    }
    finishGesture();
  }
  function samplePrompt() {
    return (
      SAMPLES.find((s) => s.name === skill?.name)?.prompt ||
      `使用${skill?.name || "营销海报"}，为我的新品设计 3 个简约自然的方案`
    );
  }
  async function createArtboards(
    specifications,
    { record = true, focus = true } = {},
  ) {
    if (busy || conflict.current) return [];
    setBusy(true);
    setError("");
    const created = [];
    try {
      await flush();
      await enqueue(async () => {
        for (const specification of specifications) {
          const baseRevision = revision.current;
          const response = await api(`/projects/${projectId}/artboards`, {
            method: "POST",
            body: specification,
          });
          const { boardRevision, ...artboard } = response;
          created.push(artboard);
          const nextRevision =
            boardRevision ??
            (await api(`/projects/${projectId}/studio`)).revision;
          if (nextRevision !== baseRevision + 1) {
            conflict.current = true;
            setConflicted(true);
            setSaveError("创建期间工作区在其他页面更新，请保留草稿后重新载入");
            throw new Error(
              "工作区版本已变化，已创建画板保存在服务器，请重新载入",
            );
          }
          revision.current = nextRevision;
          const list = [
            ...latest.current.results.filter((r) => r.id !== artboard.id),
            artboard,
          ];
          if (record) commitResults(list);
          else updateResults(list);
        }
      });
      if (created.length && focus) {
        setSelected(created.at(-1).id);
        setSelection(created.map((r) => r.id));
        setPanel(null);
        setMobileView("canvas");
        fit(created);
      }
      return created;
    } catch (failure) {
      setError(failure.message);
      onToast?.(failure.message);
      return created;
    } finally {
      setBusy(false);
    }
  }
  function nextPosition() {
    const list = boardItems(latest.current);
    return {
      x: list.length
        ? Math.max(...list.map((r) => r.position.x + boardItemSize(r).width)) +
          50
        : 0,
      y: 0,
    };
  }
  async function addBlank() {
    const ratios = {
      "1:1": [600, 600],
      "16:9": [960, 540],
      "9:16": [540, 960],
      "4:3": [800, 600],
    };
    const [width, height] = ratios[ratio] || [600, 800];
    await createArtboards([
      {
        title: "自由画板",
        design: { width, height, background: "#ffffff", nodes: [] },
        position: nextPosition(),
      },
    ]);
  }
  async function addTemplate(template) {
    await createArtboards([
      {
        title: template.title,
        design: initialDesign(template),
        position: nextPosition(),
      },
    ]);
  }
  async function addAssetBoard(asset) {
    const width = Math.max(1, Math.min(2000, asset.width || 800)),
      height = Math.max(
        1,
        Math.round((width * (asset.height || 800)) / (asset.width || 800)),
      );
    await createArtboards([
      {
        title: asset.name,
        design: {
          width,
          height,
          background: "#ffffff",
          nodes: [
            {
              id: uid(),
              type: "image",
              src: asset.url,
              assetId: asset.assetId,
              label: asset.name,
              x: 0,
              y: 0,
              w: width,
              h: height,
              opacity: 1,
            },
          ],
        },
        position: nextPosition(),
      },
    ]);
  }
  async function duplicateSelected() {
    finishGesture();
    if (busy || uploading || conflicted || !selection.length) return;
    const before = organization();
    const source = { ...latest.current };
    const ids = expandSelection(source, selection);
    const resultSources = source.results.filter((r) => ids.has(r.id));
    const created = resultSources.length
      ? await createArtboards(
          resultSources.map((r) => ({
            title: `${r.title} · 副本`.slice(0, 200),
            design: r.design,
            position: { x: r.position.x + 40, y: r.position.y + 40 },
          })),
          { record: false, focus: false },
        )
      : [];
    if (conflict.current) return;
    if (created.length !== resultSources.length) {
      // Artboard creation is committed individually by the API. Preserve those
      // returned documents and stop before cloning notes or section membership.
      commitBoard(latest.current, before);
      setSelection(created.map((item) => item.id));
      setSelected(created.at(-1)?.id || null);
      const message = created.length
        ? `复制未完成：已创建 ${created.length} 个画板，便签和分区尚未复制。`
        : "复制未完成，便签和分区尚未复制，请重试。";
      setError(message);
      onToast?.(message);
      return;
    }
    const mapping = new Map(
      created.map((r, index) => [resultSources[index].id, r.id]),
    );
    const newNotes = source.notes
      .filter((n) => ids.has(n.id))
      .map((note) => {
        const id = uid();
        mapping.set(note.id, id);
        return {
          ...copyBoardValue(note),
          id,
          position: { x: note.position.x + 40, y: note.position.y + 40 },
        };
      });
    const newSections = source.sections
      .filter((s) => selection.includes(s.id))
      .map((section) => {
        const id = uid();
        mapping.set(section.id, id);
        return {
          ...copyBoardValue(section),
          id,
          title: `${section.title} · 副本`.slice(0, 120),
          position: { x: section.position.x + 40, y: section.position.y + 40 },
          itemIds: section.itemIds
            .map((itemId) => mapping.get(itemId))
            .filter(Boolean),
        };
      });
    const next = {
      ...latest.current,
      notes: [...latest.current.notes, ...newNotes],
      sections: [...latest.current.sections, ...newSections],
    };
    commitBoard(next, before);
    const copiedSelection = selection
      .map((id) => mapping.get(id))
      .filter(Boolean);
    setSelection(copiedSelection);
    setSelected(copiedSelection.at(-1) || null);
    fit(boardItems(next).filter((item) => copiedSelection.includes(item.id)));
  }
  async function exportPackage() {
    if (busy || uploading || conflicted || exportingPackage) return;
    setExportingPackage(true);
    setExportStatus("正在准备项目包…");
    try {
      await flush();
      const job = await api(`/projects/${projectId}/exports`, {
        method: "POST",
        body: { format: "dxproj" },
      });
      const done = await waitForJob(job.job?.id || job.id, (job) =>
        setExportStatus(
          job.status === "queued" ? "项目包等待导出…" : "正在打包项目…",
        ),
      );
      const id = done.result?.exportId || done.exportId || done.id;
      const anchor = document.createElement("a");
      anchor.href = done.downloadUrl || `/api/exports/${id}/file`;
      anchor.download = "";
      anchor.click();
      setExportStatus("");
      onToast?.("项目包已生成，包含画板、便签和分区");
      window.dispatchEvent(new Event("designx:refresh"));
    } catch (failure) {
      setExportStatus(failure.message);
      onToast?.(failure.message);
    } finally {
      setExportingPackage(false);
    }
  }
  function downloadDraft() {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(latest.current, null, 2)], {
        type: "application/json",
      }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `${title || "工作区"}-未保存草稿.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function reloadRemote() {
    try {
      await chain.current.catch(() => {});
      const remote = await api(`/projects/${projectId}/studio`);
      const snapshot = remote.snapshot;
      revision.current = remote.revision;
      conflict.current = false;
      setConflicted(false);
      setSaveError("");
      setTitle(snapshot.title || "新创作");
      setMessages(snapshot.messages || []);
      updateBoard({
        results: snapshot.results || [],
        notes: snapshot.notes || [],
        sections: snapshot.sections || [],
      });
      setDraft(snapshot.draft || "");
      setSkill(snapshot.skill || null);
      setMode(snapshot.mode || "Agent");
      setAssets(snapshot.assets || []);
      setAttached(snapshot.attached || []);
      setRatio(snapshot.ratio || "自动");
      setCount(snapshot.count || "自动");
      liveView.current = snapshot.view || { x: 70, y: 140, zoom: 1 };
      setView(liveView.current);
      setSelected(snapshot.selected || null);
      setSelection(snapshot.selection || []);
      setReference(snapshot.reference || null);
      history.current = { past: [], future: [] };
      renderHistory((n) => n + 1);
      setError("");
      setSaveState("saved");
      savedJson.current = JSON.stringify(persistedSnapshot(snapshot));
      savedSnapshot.current = null;
    } catch (failure) {
      setSaveError(failure.message);
    }
  }
  const panelTitle = {
    skills: "技能",
    files: "文件",
    history: "创作记录",
    assets: "资产库",
    templates: "模板灵感",
    help: "画布操作",
  }[panel];
  return (
    <div
      className={`ai-studio ${chatHidden ? "st-chat-hidden" : ""} st-mobile-${mobileView}`}
    >
      <aside className="st-chat">
        <header className="st-chat-header">
          <button
            className="st-brand"
            onClick={() => leave(onBack)}
            title="返回首页"
          >
            <span>✳</span>
            <b>
              design<i>x</i>
            </b>
          </button>
          <IconButton label="收起对话区" onClick={() => setChatHidden(true)}>
            <PanelLeftClose size={15} />
          </IconButton>
          <button
            className={
              "st-skill-toggle " + (panel === "skills" ? "active" : "")
            }
            onClick={() => togglePanel("skills")}
          >
            <Sparkles size={13} />
            技能
            <ChevronRight size={12} />
          </button>
        </header>
        <div className="st-task-row">
          <input
            aria-label="当前创作名称"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={40}
          />
          <span>创作空间</span>
          <div>
            <IconButton label="本次文件" onClick={() => togglePanel("files")}>
              <FolderOpen size={15} />
            </IconButton>
            <IconButton label="创作记录" onClick={() => togglePanel("history")}>
              <History size={15} />
            </IconButton>
            <IconButton label="新建创作" onClick={() => setShowNew(true)}>
              <Plus size={16} />
            </IconButton>
          </div>
        </div>
        <div className="st-conversation" ref={chat}>
          {!messages.length ? (
            <div className="st-greeting">
              <span className="st-greeting-symbol">✳</span>
              <h1>你好，让灵感发生。</h1>
              <p>从一个想法，开始一场自由创作</p>
              <div className="st-starters">
                {SAMPLES.map((s) => (
                  <button
                    key={s.name}
                    onClick={() =>
                      chooseSkill(
                        catalog.skills.find((c) => c.name === s.name) || s,
                      )
                    }
                  >
                    <img src={`/assets/${s.image}.jpg`} alt="" />
                    <span>{s.name}</span>
                    <ArrowUpRight size={14} />
                  </button>
                ))}
              </div>
              <button
                className="st-all-skills"
                onClick={() => togglePanel("skills")}
              >
                探索全部技能 <ChevronRight size={14} />
              </button>
            </div>
          ) : (
            <div className="st-messages" aria-live="polite">
              {messages.map((m) => (
                <article
                  className={`st-message st-message-${m.role}`}
                  key={m.id}
                >
                  {m.role === "assistant" && (
                    <div className="st-assistant-label">
                      <span>✳</span>
                      <b>Design X</b>
                      <small>创作助手</small>
                    </div>
                  )}
                  {m.skill && (
                    <div className="st-message-context">
                      <Sparkles size={11} />
                      {m.skill}
                    </div>
                  )}
                  {m.reference && (
                    <div className="st-message-context">↳ {m.reference}</div>
                  )}
                  {m.assets?.length > 0 && (
                    <div className="st-message-images">
                      {m.assets.map((a) => (
                        <img key={a.id} src={a.url} alt={a.name} />
                      ))}
                    </div>
                  )}
                  <p>{m.text}</p>
                  {m.status === "complete" && (
                    <>
                      <button
                        className="st-result-link"
                        onClick={() => {
                          fit(
                            results.filter((r) =>
                              (m.resultIds || []).includes(r.id),
                            ),
                          );
                          setPanel(null);
                          setMobileView("canvas");
                        }}
                      >
                        <Images size={15} />
                        {m.resultIds?.length || 0} 个方案已放入画布
                        <ArrowUpRight size={14} />
                      </button>
                      <small className="st-demo-note">
                        历史方案 · 可精细编辑
                      </small>
                    </>
                  )}
                  {m.retry && (
                    <button
                      className="st-result-link"
                      disabled={true}
                      onClick={() => generate(m.retry, m.context)}
                    >
                      <RotateCcw size={14} />
                      AI 生成尚未开放
                    </button>
                  )}
                </article>
              ))}
            </div>
          )}
        </div>
        <div className="st-composer-area">
          {referenceResult && (
            <div className="st-reference">
              <img src={referenceResult.image} alt="" />
              <span>
                基于此方案继续<small>{referenceResult.title}</small>
              </span>
              <IconButton
                label="取消引用方案"
                onClick={() => setReference(null)}
              >
                <X size={13} />
              </IconButton>
            </div>
          )}
          {skill && !messages.length && (
            <button
              className="st-prompt-suggestion"
              onClick={() => {
                setDraft(samplePrompt());
                input.current?.focus();
              }}
            >
              <WandSparkles size={13} />
              <span>试试：{samplePrompt()}</span>
              <ArrowUpRight size={12} />
            </button>
          )}
          <div className="st-composer">
            {skill && (
              <div className="st-selected-skill">
                <Sparkles size={12} />
                {skill.name}
                <button
                  aria-label="移除当前技能"
                  onClick={() => setSkill(null)}
                >
                  <X size={11} />
                </button>
              </div>
            )}
            {attached.length > 0 && (
              <div className="st-attachments">
                {attached.map((a) => (
                  <div key={a.id}>
                    <img src={a.url} alt={a.name} />
                    <span>{a.name}</span>
                    <button
                      aria-label={`移除素材 ${a.name}`}
                      onClick={() =>
                        setAttached((v) => v.filter((x) => x.id !== a.id))
                      }
                    >
                      <X size={11} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <textarea
              ref={input}
              value={draft}
              maxLength={3000}
              aria-label="告诉 AI 你的设计需求"
              placeholder={
                referenceResult
                  ? "描述你想调整的地方，例如：换成暖色，标题更醒目…"
                  : "描述你的设计想法…\n输入 / 选择技能，@ 引用素材"
              }
              onChange={(e) => {
                const v = e.target.value;
                setDraft(v);
                setError("");
                if (v.endsWith("/")) {
                  setQuery("");
                  setPopover("skills");
                }
                if (v.endsWith("@")) {
                  setPanel("assets");
                  setAssetTab("示例素材");
                  setMobileView("canvas");
                }
              }}
              onKeyDown={(e) => {
                if (
                  e.key === "Enter" &&
                  !e.shiftKey &&
                  !e.nativeEvent.isComposing
                ) {
                  e.preventDefault();
                  generate();
                }
              }}
            />
            <div className="st-composer-options">
              <select
                aria-label="生成比例"
                value={ratio}
                onChange={(e) => setRatio(e.target.value)}
              >
                {["自动", "3:4", "1:1", "16:9", "9:16", "4:3"].map((v) => (
                  <option key={v} value={v}>
                    {v === "自动" ? "比例自动" : v}
                  </option>
                ))}
              </select>
              <select
                aria-label="方案数量"
                value={count}
                onChange={(e) => setCount(e.target.value)}
              >
                <option value="自动">数量自动</option>
                {[1, 2, 3, 4, 6].map((n) => (
                  <option key={n} value={n}>
                    {n} 个方案
                  </option>
                ))}
              </select>
            </div>
            <div className="st-composer-actions">
              <button className="st-add" onClick={() => file.current?.click()}>
                <Plus size={16} />
                添加
              </button>
              <IconButton
                label="引用资产"
                onClick={() => togglePanel("assets")}
              >
                <Library size={16} />
              </IconButton>
              <IconButton
                label="快捷选择技能"
                onClick={() => {
                  setQuery("");
                  setPopover((v) => (v === "skills" ? null : "skills"));
                }}
              >
                <Sparkles size={15} />
              </IconButton>
              <button
                className="st-mode-button"
                aria-label="切换创作模式"
                onClick={() =>
                  setPopover((v) => (v === "mode" ? null : "mode"))
                }
              >
                {mode === "Agent" ? (
                  <Bot size={15} />
                ) : mode === "图片生成" ? (
                  <Images size={15} />
                ) : (
                  <Video size={15} />
                )}
                <span>{mode}</span>
                <ChevronDown size={10} />
              </button>
              <button
                className="st-send"
                disabled={!draft.trim()}
                onClick={generate}
                aria-label="发送设计需求"
                title="AI 生成尚未接入，需求会保留为草稿"
              >
                <ArrowUp size={18} />
              </button>
            </div>
            {popover === "mode" && (
              <div className="st-popover st-mode-popover">
                {[
                  ["Agent", Bot, "自动规划创作"],
                  ["图片生成", Images, "图片与视觉方案"],
                  ["视频生成", Video, "故事分镜预览"],
                ].map(([m, I, t]) => (
                  <button
                    key={m}
                    onClick={() => {
                      setMode(m);
                      setPopover(null);
                    }}
                  >
                    <I size={16} />
                    <span>
                      {m}
                      <small>{t}</small>
                    </span>
                    {mode === m && <Check size={14} />}
                  </button>
                ))}
              </div>
            )}
            {popover === "skills" && (
              <div className="st-popover st-quick-skills">
                <div className="st-quick-search">
                  <Search size={14} />
                  <input
                    aria-label="快捷搜索技能"
                    placeholder="搜索技能"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                  <button
                    onClick={() => {
                      setPanel("skills");
                      setPopover(null);
                      setMobileView("canvas");
                    }}
                  >
                    全部
                    <ChevronRight size={12} />
                  </button>
                </div>
                <div>
                  {catalog.skills
                    .filter((s) => !query || s.name.includes(query))
                    .slice(0, 10)
                    .map((s) => (
                      <button key={s.id} onClick={() => chooseSkill(s)}>
                        <Sparkles size={13} />
                        {s.name}
                        {skill?.name === s.name && <Check size={13} />}
                      </button>
                    ))}
                </div>
              </div>
            )}
          </div>
          {(error || libraryError) && (
            <p className="st-error" role="alert">
              {error || libraryError}
            </p>
          )}
          <div className="st-composer-footnote">
            <span>需求自动保存 · AI 能力稍后开放</span>
            <span>Shift ↵ 换行</span>
          </div>
        </div>
      </aside>
      <main
        className={`st-canvas ${tool === "hand" ? "st-pan" : ""}`}
        data-board-engine={boardEngine}
        ref={viewport}
        onPointerDown={nativeBoard ? undefined : (e) => startPointer(e)}
        onPointerMove={nativeBoard ? undefined : movePointer}
        onPointerUp={nativeBoard ? undefined : endPointer}
        onPointerCancel={nativeBoard ? undefined : endPointer}
        onLostPointerCapture={nativeBoard ? undefined : () => finishGesture()}
      >
        <div className="st-canvas-top">
          <div className="st-canvas-top-left">
            {chatHidden && (
              <IconButton
                label="展开对话区"
                onClick={() => setChatHidden(false)}
              >
                <PanelLeftOpen size={18} />
              </IconButton>
            )}
            <button onClick={() => leave(onBack)} className="st-back">
              <ArrowLeft size={14} />
              工作空间
            </button>
            <span className="st-board-name">{title}</span>
          </div>
          <div className="st-board-actions">
            <span
              className={saveError ? "st-storage-warning" : ""}
              role="status"
            >
              {saveState === "saving"
                ? "正在保存…"
                : saveState === "dirty"
                  ? "有未保存更改"
                  : saveState === "error"
                    ? "保存未完成"
                    : "已保存到工作空间"}
            </span>
            <span className="st-avatar">Y</span>
            <button
              className="st-package-export"
              disabled={busy || uploading || conflicted || exportingPackage}
              onClick={exportPackage}
              aria-label="导出项目包"
            >
              {exportingPackage ? (
                <LoaderCircle size={14} className="st-spinning" />
              ) : (
                <FileArchive size={14} />
              )}
              <span>{exportingPackage ? "打包中…" : "项目包"}</span>
            </button>
            <button
              className="st-export"
              disabled={!selectedResult || busy || uploading || conflicted}
              onClick={() => openEditor(selectedResult)}
            >
              <Download size={14} />
              <span>编辑与导出</span>
            </button>
          </div>
        </div>
        {!results.length && !notes.length && !sections.length && (
          <div className="st-empty-canvas">
            <span className="st-empty-symbol">✳</span>
            <span className="st-overline">A SPACE FOR YOUR IDEAS</span>
            <h2>好想法，自由生长。</h2>
            <p>从模板、素材或空白画板开始，保存你的每一步设计。</p>
            <div>
              <button
                onClick={() => {
                  setPanel("templates");
                  setMobileView("canvas");
                }}
              >
                <span>
                  <Sparkles size={19} />
                </span>
                <b>
                  从模板开始<small>选择版式，加入自己的创意</small>
                </b>
                <ChevronRight size={16} />
              </button>
              <button onClick={() => file.current?.click()}>
                <span>
                  <ImagePlus size={19} />
                </span>
                <b>
                  带上你的素材<small>上传产品图，开始新的创作</small>
                </b>
                <ChevronRight size={16} />
              </button>
            </div>
            <button className="st-blank-link" onClick={addBlank}>
              也可以从自由画板开始 <ArrowUpRight size={12} />
            </button>
          </div>
        )}
        {exportStatus && !saveError && !uploading && !busy && (
          <div
            className="st-export-status"
            role="status"
            onPointerDown={(event) => event.stopPropagation()}
          >
            {exportStatus}
            {!exportingPackage && (
              <button
                aria-label="关闭项目包导出提示"
                onClick={() => setExportStatus("")}
              >
                <X size={13} />
              </button>
            )}
          </div>
        )}
        {(saveError || uploading || busy) && (
          <div
            className="st-save-banner"
            role={saveError ? "alert" : "status"}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <span>
              {saveError ||
                (uploading ? "正在上传素材并加入画布…" : "正在保存画板…")}
            </span>
            {saveError && (
              <div>
                <button onClick={downloadDraft}>下载未保存草稿</button>
                {conflicted ? (
                  <button onClick={reloadRemote}>
                    放弃未保存更改并载入服务器版本
                  </button>
                ) : (
                  <button onClick={() => flush().catch(() => {})}>
                    重试保存
                  </button>
                )}
              </div>
            )}
          </div>
        )}
        <Canvas
          ref={world}
          results={results}
          notes={notes}
          sections={sections}
          view={view}
          viewport={viewport}
          selection={selection}
          selected={selected}
          editingNote={editingNote}
          handlers={handlers}
          tool={tool}
          disabled={busy || uploading || conflicted}
        />
        {selected && !panel && (selectedItem || selectedResult) && (
          <aside
            className="st-item-inspector"
            aria-label="画布内容属性"
            onPointerDown={(event) => event.stopPropagation()}
          >
            <header>
              <strong>
                {selectedNote ? "便签" : selectedSection ? "分区" : "画板分区"}
              </strong>
              <small>
                {selection.length > 1
                  ? `已选 ${selection.length} 项`
                  : "内容属性"}
              </small>
              <IconButton
                label="关闭内容属性"
                onClick={() => {
                  setSelected(null);
                  setSelection([]);
                  setEditingNote(null);
                }}
              >
                <X size={13} />
              </IconButton>
            </header>
            {selectedNote && (
              <label className="st-board-field st-board-text-field">
                <span>内容</span>
                <textarea
                  aria-label="便签内容"
                  maxLength={10000}
                  value={selectedNote.text}
                  placeholder="记下你的想法…"
                  onChange={(event) =>
                    updateItem(selectedNote.id, { text: event.target.value })
                  }
                />
              </label>
            )}
            {selectedSection && (
              <label className="st-board-field st-board-text-field">
                <span>分区名称</span>
                <input
                  aria-label="分区标题"
                  maxLength={120}
                  value={selectedSection.title}
                  onChange={(event) =>
                    updateItem(selectedSection.id, {
                      title: event.target.value,
                    })
                  }
                />
              </label>
            )}
            {selectedItem && (
              <>
                <div className="st-board-dimensions">
                  <BoardSizeField
                    label={`${selectedNote ? "便签" : "分区"}宽度`}
                    value={selectedItem.width}
                    min={selectedNote ? 160 : 240}
                    max={selectedNote ? 2000 : 20000}
                    onCommit={(width) => updateItem(selectedItem.id, { width })}
                  />
                  <BoardSizeField
                    label={`${selectedNote ? "便签" : "分区"}高度`}
                    value={selectedItem.height}
                    min={selectedNote ? 100 : 160}
                    max={selectedNote ? 3000 : 20000}
                    onCommit={(height) =>
                      updateItem(selectedItem.id, { height })
                    }
                  />
                </div>
                <label className="st-board-field st-board-color-field">
                  <span>颜色</span>
                  <input
                    type="color"
                    aria-label={selectedNote ? "便签颜色" : "分区颜色"}
                    value={selectedItem.color}
                    onChange={(event) =>
                      updateItem(selectedItem.id, {
                        color: event.target.value.toUpperCase(),
                      })
                    }
                  />
                  <small>{selectedItem.color}</small>
                </label>
              </>
            )}
            {selectedSection && (
              <div className="st-section-members">
                <span>分区内容 · {selectedSection.itemIds.length}</span>
                {selectedSection.itemIds.map((id) => {
                  const member =
                    results.find((item) => item.id === id) ||
                    notes.find((item) => item.id === id);
                  return (
                    <div key={id}>
                      <span>
                        {member?.title || member?.text?.slice(0, 30) || "便签"}
                      </span>
                      <button
                        aria-label={`从分区移出 ${id}`}
                        title="移出分区"
                        onClick={() => removeFromSections([id])}
                      >
                        <X size={12} />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
            {selection.some(
              (id) =>
                results.some((r) => r.id === id) ||
                notes.some((n) => n.id === id),
            ) && (
              <div className="st-section-membership">
                <button className="st-board-inline-action" onClick={addSection}>
                  <FolderPlus size={13} />
                  用选中内容创建分区
                </button>
                {sections.length > 0 && (
                  <>
                    <label className="st-board-field">
                      <span>目标分区</span>
                      <select
                        aria-label="目标分区"
                        value={
                          sections.some(
                            (section) => section.id === targetSection,
                          )
                            ? targetSection
                            : sections[0].id
                        }
                        onChange={(event) =>
                          setTargetSection(event.target.value)
                        }
                      >
                        {sections.map((section) => (
                          <option key={section.id} value={section.id}>
                            {section.title || "未命名分区"}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button
                      className="st-board-inline-action"
                      onClick={() =>
                        joinSection(
                          sections.some(
                            (section) => section.id === targetSection,
                          )
                            ? targetSection
                            : sections[0].id,
                        )
                      }
                    >
                      加入目标分区
                    </button>
                    <button
                      className="st-board-inline-action st-board-muted-action"
                      onClick={() => removeFromSections()}
                    >
                      从分区移出选中内容
                    </button>
                  </>
                )}
              </div>
            )}
            {selectedSection && (
              <p className="st-section-help">
                拖动分区会带上其中内容。删除分区后，内容仍留在画布上。
              </p>
            )}
          </aside>
        )}
        {selectedResult && !panel && (
          <div className="st-refine-bar">
            <Sparkles size={14} />
            <span>让它更合心意</span>
            {["换成暖色调", "调整为 1:1", "标题更简洁"].map((text) => (
              <button
                key={text}
                onClick={() => {
                  referenceDesign(selectedResult);
                  setDraft(text);
                }}
              >
                {text}
                <ArrowUpRight size={11} />
              </button>
            ))}
          </div>
        )}
        <div className="st-canvas-tools">
          <IconButton
            label="选择与移动方案"
            className={"st-icon " + (tool === "select" ? "active" : "")}
            onClick={() => setTool("select")}
          >
            <MousePointer2 size={17} />
          </IconButton>
          <IconButton
            label="拖动画布"
            className={"st-icon " + (tool === "hand" ? "active" : "")}
            onClick={() => setTool("hand")}
          >
            <Hand size={17} />
          </IconButton>
          <i />
          <IconButton
            label="新建自由画板"
            disabled={busy || uploading || conflicted}
            onClick={addBlank}
          >
            <Plus size={18} />
          </IconButton>
          <IconButton
            label="添加便签"
            disabled={busy || uploading || conflicted}
            onClick={addNote}
          >
            <StickyNote size={18} />
          </IconButton>
          <IconButton
            label="创建分区"
            disabled={busy || uploading || conflicted}
            onClick={addSection}
          >
            <SquareDashed size={18} />
          </IconButton>
          <IconButton
            label="添加设计模板"
            onClick={() => togglePanel("templates")}
          >
            <LayoutTemplate size={18} />
          </IconButton>
          <IconButton
            label="添加图片素材"
            disabled={busy || uploading || conflicted}
            onClick={() => file.current?.click()}
          >
            <ImagePlus size={18} />
          </IconButton>
        </div>
        <div
          className="st-organize-tools"
          onPointerDown={(e) => e.stopPropagation()}
        >
          <IconButton
            label="撤销画布操作"
            disabled={!history.current.past.length || busy || conflicted}
            onClick={undo}
          >
            <Undo2 size={16} />
          </IconButton>
          <IconButton
            label="重做画布操作"
            disabled={!history.current.future.length || busy || conflicted}
            onClick={redo}
          >
            <Redo2 size={16} />
          </IconButton>
          <IconButton
            label="复制选中内容"
            disabled={!selection.length || busy || uploading || conflicted}
            onClick={duplicateSelected}
          >
            <Copy size={16} />
          </IconButton>
          <IconButton
            label="删除选中内容"
            disabled={!selection.length || busy || conflicted}
            onClick={removeSelected}
          >
            <Trash2 size={16} />
          </IconButton>
          <IconButton
            label="选中内容左对齐"
            disabled={selection.length < 2 || busy || conflicted}
            onClick={() => alignSelected("x")}
          >
            <AlignLeft size={16} />
          </IconButton>
          <IconButton
            label="选中内容顶部对齐"
            disabled={selection.length < 2 || busy || conflicted}
            onClick={() => alignSelected("y")}
          >
            <AlignStartVertical size={16} />
          </IconButton>
        </div>
        <div className="st-zoom">
          <IconButton
            label="缩小画布"
            disabled={view.zoom <= 0.2}
            onClick={() => zoomBy(-0.1)}
          >
            <Minus size={15} />
          </IconButton>
          <span>{Math.round(view.zoom * 100)}%</span>
          <IconButton
            label="放大画布"
            disabled={view.zoom >= 2}
            onClick={() => zoomBy(0.1)}
          >
            <Plus size={15} />
          </IconButton>
          <i />
          <IconButton label="适应所有方案" onClick={() => fit()}>
            <Expand size={16} />
          </IconButton>
        </div>
        {(results.length > 0 || notes.length > 0 || sections.length > 0) && (
          <span className="st-canvas-count">
            {results.length} 个画板 · {notes.length} 个便签 · {sections.length}{" "}
            个分区 · Shift 多选
          </span>
        )}
        {panel && (
          <section
            className={`st-panel st-panel-${panel}`}
            aria-label={panelTitle}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <div className="st-panel-heading">
              <h2>
                {panelTitle}
                {panel === "skills" && <small>发现你的下一个可能</small>}
              </h2>
              <IconButton label="关闭侧边面板" onClick={() => setPanel(null)}>
                <X size={18} />
              </IconButton>
            </div>
            {panel === "skills" && (
              <>
                <div className="st-panel-tabs">
                  {CATEGORIES.map((c) => (
                    <button
                      key={c}
                      className={category === c ? "active" : ""}
                      onClick={() => setCategory(c)}
                    >
                      {["电商", "海报", "品牌", "办公"].includes(c)
                        ? c + "设计"
                        : c === "视频"
                          ? "视频创作"
                          : c}
                    </button>
                  ))}
                </div>
                <div className="st-skill-search">
                  <Search size={15} />
                  <input
                    aria-label="搜索工作区技能"
                    placeholder="搜索你想完成的事"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                  {query && (
                    <button
                      aria-label="清空技能搜索"
                      onClick={() => setQuery("")}
                    >
                      <X size={13} />
                    </button>
                  )}
                  <span>{skillList.length} 个技能</span>
                </div>
                <div className="st-panel-scroll">
                  <div className="st-skill-grid">
                    {skillList.map((s, i) => (
                      <button
                        key={s.id || s.name}
                        className={
                          "st-skill-card " +
                          (skill?.name === s.name ? "selected" : "")
                        }
                        onClick={() => chooseSkill(s)}
                      >
                        <div
                          className={`st-skill-art st-skill-art-${s.category}`}
                        >
                          <img
                            src={`/assets/${skillImage(s)}.jpg`}
                            alt=""
                            loading="lazy"
                          />
                          <span className="st-card-editorial">
                            {s.category === "海报"
                              ? "MAKE IT\nMATTER."
                              : s.category === "品牌"
                                ? "A NEW\nIDENTITY."
                                : s.category === "办公"
                                  ? "Ideas,\nin order."
                                  : ""}
                          </span>
                          {i < 2 && <small>精选</small>}
                          <span className="st-card-cta">
                            {skill?.name === s.name ? (
                              <>
                                <Check size={12} />
                                已添加
                              </>
                            ) : (
                              <>
                                添加到对话
                                <Plus size={12} />
                              </>
                            )}
                          </span>
                        </div>
                        <div className="st-skill-info">
                          <strong>{s.name}</strong>
                          <p>{s.description || s.prompt}</p>
                        </div>
                      </button>
                    ))}
                  </div>
                  {!skillList.length && (
                    <div className="st-panel-empty">
                      <Search size={28} />
                      <h3>
                        {category === "最近使用"
                          ? "还没有使用过的技能"
                          : "没有找到这个技能"}
                      </h3>
                      <p>试试推荐技能，或换个关键词</p>
                      <button
                        onClick={() => {
                          setCategory("推荐");
                          setQuery("");
                        }}
                      >
                        查看推荐
                      </button>
                    </div>
                  )}
                  <div className="st-panel-bottom">
                    <span>65 种技能，让创作少一点门槛。</span>
                    <Sparkles size={15} />
                  </div>
                </div>
              </>
            )}
            {panel === "templates" && (
              <div className="st-panel-scroll">
                <div className="st-template-grid">
                  {templates.map((template) => (
                    <button
                      key={template.id}
                      disabled={busy || uploading || conflicted}
                      onClick={() => addTemplate(template)}
                      aria-label={`添加模板 ${template.title}`}
                    >
                      <img src={template.image} alt="" />
                      <b>{template.title}</b>
                      <span>{template.category} · 添加到画布</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
            {(panel === "assets" || panel === "files") && (
              <>
                {panel === "assets" && (
                  <div className="st-panel-tabs">
                    {["示例素材", "本次文件", "我的资产", "创作参考"].map(
                      (t) => (
                        <button
                          key={t}
                          className={assetTab === t ? "active" : ""}
                          onClick={() => setAssetTab(t)}
                        >
                          {t}
                        </button>
                      ),
                    )}
                  </div>
                )}
                <div className="st-panel-scroll">
                  <button
                    className="st-upload-area"
                    disabled={busy || uploading || conflicted}
                    onClick={() => file.current?.click()}
                  >
                    <ImagePlus size={25} />
                    <b>上传素材，给灵感一个参照</b>
                    <span>JPG / PNG / WebP / GIF · 每张不超过 10 MB</span>
                  </button>
                  <div className="st-asset-grid">
                    {(panel === "files" ? assets : library).map((a) => (
                      <div className="st-library-item" key={a.id}>
                        <button onClick={() => attachAsset(a)}>
                          <div>
                            <img src={a.url} alt={a.name} />
                            <span>
                              <Plus size={13} />
                              引用到对话
                            </span>
                          </div>
                          <b>{a.name}</b>
                          {attached.some((x) => x.url === a.url) && (
                            <Check size={13} />
                          )}
                        </button>
                        <button
                          className="st-library-add"
                          disabled={busy || uploading || conflicted}
                          onClick={() => addAssetBoard(a)}
                          aria-label={`将 ${a.name} 加入画布`}
                        >
                          <Plus size={12} />
                          加入画布
                        </button>
                      </div>
                    ))}
                  </div>
                  {!(panel === "files" ? assets : library).length && (
                    <div className="st-panel-empty">
                      <Images size={30} />
                      <h3>这里还没有素材</h3>
                      <p>上传图片后，可以加入画布或保留为需求参考</p>
                    </div>
                  )}
                </div>
              </>
            )}
            {panel === "history" && (
              <div className="st-panel-scroll">
                {messages.filter((m) => m.role === "user").length ? (
                  <div className="st-history-list">
                    {messages
                      .filter((m) => m.role === "user")
                      .map((m, i) => (
                        <button
                          key={m.id}
                          onClick={() => {
                            setDraft(m.text);
                            setPanel(null);
                            setMobileView("chat");
                            input.current?.focus();
                          }}
                        >
                          <span>{String(i + 1).padStart(2, "0")}</span>
                          <div>
                            <b>{m.text}</b>
                            <small>
                              {m.skill || "自由创作"} · 复用这次需求
                            </small>
                          </div>
                          <ArrowUpRight size={15} />
                        </button>
                      ))}
                  </div>
                ) : (
                  <div className="st-panel-empty">
                    <MessageSquare size={34} />
                    <h3>让第一段对话从这里开始</h3>
                    <p>本次创作的每一步，都会留在这里</p>
                  </div>
                )}
              </div>
            )}
          </section>
        )}
      </main>
      <nav className="st-mobile-tabs">
        <button
          className={mobileView === "chat" ? "active" : ""}
          onClick={() => setMobileView("chat")}
        >
          <MessageSquare size={16} />
          对话
        </button>
        <button
          className={mobileView === "canvas" ? "active" : ""}
          onClick={() => setMobileView("canvas")}
        >
          <Images size={16} />
          画布{results.length ? ` · ${results.length}` : ""}
        </button>
      </nav>
      {showNew && (
        <div className="st-dialog-shade">
          <section role="dialog" aria-modal="true" aria-label="开始新的创作">
            <span className="st-greeting-symbol">✳</span>
            <h2>给新的想法，一个空间。</h2>
            <p>当前工作区会保存到我的项目，新创作拥有独立的画布与草稿。</p>
            <button className="st-primary" onClick={() => leave(onNew)}>
              开始新创作 <ArrowUpRight size={16} />
            </button>
            <button onClick={() => setShowNew(false)}>继续当前创作</button>
          </section>
        </div>
      )}
      <input
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        multiple
        hidden
        ref={file}
        onChange={upload}
      />
    </div>
  );
}
