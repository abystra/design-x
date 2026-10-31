import React, {
  forwardRef,
  memo,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Check,
  Expand,
  MessageSquare,
  Save,
  SquareDashed,
  StickyNote,
  WandSparkles,
} from "lucide-react";
import { ArtboardRenderer } from "../../packages/doc-render/src/render";
import {
  buildBoardIndex,
  visibleBoardEntries,
  worldViewport,
} from "./board-spatial";

export const DesignPreview = memo(
  function DesignPreview({ project }) {
    const design = project.design;
    if (!design) return <img src={project.image} alt={project.title} />;
    return (
      <div
        className="st-design"
        style={{
          aspectRatio: `${design.width}/${design.height}`,
          background: design.background,
        }}
      >
        <svg
          viewBox={`0 0 ${design.width} ${design.height}`}
          role="img"
          aria-label={project.title}
        >
          <foreignObject
            x="0"
            y="0"
            width={design.width}
            height={design.height}
          >
            <div xmlns="http://www.w3.org/1999/xhtml">
              <ArtboardRenderer design={design} />
            </div>
          </foreignObject>
        </svg>
      </div>
    );
  },
  (before, after) =>
    before.project.design === after.project.design &&
    before.project.title === after.project.title &&
    before.project.image === after.project.image,
);

function IconButton({ label, children, ...props }) {
  return (
    <button className="st-icon" aria-label={label} title={label} {...props}>
      {children}
    </button>
  );
}

export const BoardItem = memo(function BoardItem({
  entry,
  selected,
  active,
  editing,
  dx,
  dy,
  handlers,
  positioned = true,
}) {
  const item = entry.item,
    index = entry.index;
  const position = {
    left: positioned ? item.position.x : 0,
    top: positioned ? item.position.y : 0,
    transform: dx || dy ? `translate(${dx}px,${dy}px)` : undefined,
  };
  const pointer = (event) => handlers.current.startPointer(event, item);
  const select = (event) => handlers.current.selectResult(item.id, event);
  if (entry.kind === "section")
    return (
      <article
        data-board-id={item.id}
        className={`st-section ${selected ? "is-selected" : ""}`}
        style={{
          ...position,
          width: item.width,
          height: item.height,
          "--item-color": item.color,
        }}
        onPointerDown={pointer}
      >
        <div className="st-section-header">
          <button
            aria-label={`选中分区 ${index + 1} ${item.title}`}
            onClick={select}
          >
            <SquareDashed size={15} />
            <span>{item.title}</span>
          </button>
          <span className="st-section-grip" title="拖动分区及其中内容">
            {item.itemIds.length} 项
          </span>
        </div>
      </article>
    );
  if (entry.kind === "note")
    return (
      <article
        data-board-id={item.id}
        className={`st-note ${selected ? "is-selected" : ""}`}
        style={{
          ...position,
          width: item.width,
          height: item.height,
          background: item.color,
        }}
        onPointerDown={pointer}
      >
        <div className="st-note-header">
          <button aria-label={`选中便签 ${index + 1}`} onClick={select}>
            <StickyNote size={13} />
            便签 {index + 1}
          </button>
          <span title="拖动便签">⠿</span>
        </div>
        {editing ? (
          <textarea
            autoFocus
            aria-label="画布便签内容"
            maxLength={10000}
            value={item.text}
            onChange={(event) =>
              handlers.current.updateItem(item.id, { text: event.target.value })
            }
            onBlur={() => handlers.current.setEditingNote(null)}
            placeholder="记下你的想法…"
          />
        ) : (
          <div
            className={`st-note-content ${!item.text ? "is-placeholder" : ""}`}
            onDoubleClick={(event) => {
              event.stopPropagation();
              handlers.current.selectResult(item.id);
              handlers.current.setEditingNote(item.id);
            }}
          >
            {item.text || "双击记下你的想法…"}
          </div>
        )}
      </article>
    );
  return (
    <article
      data-board-id={item.id}
      className={`st-result ${selected ? "is-selected" : ""}`}
      style={position}
      onPointerDown={pointer}
      onDoubleClick={() => handlers.current.openEditor(item)}
    >
      <div className="st-result-label">
        <span>
          {String(index + 1).padStart(2, "0")} / {item.label || item.title}
        </span>
        <b>V{item.revision || item.version || 1}</b>
      </div>
      <button
        className="st-design-select"
        aria-label={`选中方案 ${index + 1} ${item.title}`}
        onClick={select}
      >
        <DesignPreview project={item} />
      </button>
      <div className="st-result-caption">
        <span>
          {item.ratio || "画板"} · {item.design.width} × {item.design.height}
        </span>
        <IconButton
          label={`引用方案 ${index + 1}`}
          onClick={() => handlers.current.referenceDesign(item)}
        >
          <MessageSquare size={14} />
        </IconButton>
      </div>
      {active && (
        <div className="st-result-actions">
          <button
            onClick={() => handlers.current.referenceDesign(item)}
            title="AI 续改稍后开放，可先记录需求"
          >
            <WandSparkles size={13} />
            继续修改
          </button>
          <button onClick={() => handlers.current.openEditor(item)}>
            <Expand size={13} />
            精细编辑
          </button>
          <IconButton
            label={`保存方案 ${index + 1}`}
            onClick={() => handlers.current.saveDesign(item)}
          >
            {item.persisted ? <Check size={14} /> : <Save size={14} />}
          </IconButton>
        </div>
      )}
    </article>
  );
});

function takeMountBatch(queue) {
  const batch = [];
  let nodes = 0;
  while (queue.length && batch.length < 6) {
    const cost = Math.max(1, queue[0].item.design?.nodes.length || 0);
    if (batch.length && nodes + cost > 400) break;
    batch.push(queue.shift());
    nodes += cost;
  }
  return batch;
}

// A fit operation may reveal thousands of real document nodes at once. Retain
// existing/active content and mount only that large new set in small frames.
// Ordinary pans (at most 24 new artboards) continue to render immediately.
export function useProgressiveEntries(entries, index, priorityIds, center) {
  const mounted = useRef(new Set());
  const [progress, setProgress] = useState(null);
  const targetKey = entries.map((entry) => entry.id).join("|");
  const priorityKey = [...priorityIds].sort().join("|");
  const plan = useMemo(() => {
    const pending = entries.filter(
      (entry) =>
        entry.kind === "artboard" &&
        !mounted.current.has(entry.id) &&
        !priorityIds.has(entry.id),
    );
    if (pending.length <= 24)
      return {
        initial: new Set(entries.map((entry) => entry.id)),
        pending: [],
      };
    const initial = new Set(
      entries
        .filter(
          (entry) =>
            entry.kind !== "artboard" ||
            mounted.current.has(entry.id) ||
            priorityIds.has(entry.id),
        )
        .map((entry) => entry.id),
    );
    const distance = (entry) =>
      (entry.bounds.x + entry.bounds.width / 2 - center.x) ** 2 +
      (entry.bounds.y + entry.bounds.height / 2 - center.y) ** 2;
    pending.sort((a, b) => distance(a) - distance(b));
    for (const entry of takeMountBatch(pending)) initial.add(entry.id);
    return { initial, pending };
    // Equal target IDs during a pan keep the existing queue rather than
    // restarting it each frame. Document/index changes still re-plan safely.
  }, [targetKey, priorityKey, index]);
  useLayoutEffect(() => {
    let active = true,
      frame;
    const queue = [...plan.pending];
    mounted.current = plan.initial;
    setProgress({ plan, ids: plan.initial });
    const advance = () => {
      if (!active) return;
      const next = new Set(mounted.current);
      for (const entry of takeMountBatch(queue)) next.add(entry.id);
      mounted.current = next;
      setProgress({ plan, ids: next });
      if (queue.length) frame = requestAnimationFrame(advance);
    };
    if (queue.length) frame = requestAnimationFrame(advance);
    return () => {
      active = false;
      if (frame != null) cancelAnimationFrame(frame);
    };
  }, [plan]);
  const ids = progress?.plan === plan ? progress.ids : plan.initial;
  return entries.filter((entry) => ids.has(entry.id));
}

// Only this small subtree reconciles during a pointer gesture. Persistent Board
// data and the chat/inspector stay unchanged until the gesture is committed.
const BoardWorld = memo(
  forwardRef(function BoardWorld(
    {
      results,
      notes,
      sections,
      view,
      viewport,
      selection,
      selected,
      editingNote,
      handlers,
    },
    forwardedRef,
  ) {
    const world = useRef(null),
      liveView = useRef(view);
    const [renderView, setRenderView] = useState(view);
    const [size, setSize] = useState({ width: 0, height: 0 });
    const [preview, setPreview] = useState(null);
    const [focused, setFocused] = useState(null);
    const index = useMemo(
      () => buildBoardIndex({ results, notes, sections }),
      [results, notes, sections],
    );
    const selectedIds = useMemo(() => new Set(selection), [selection]);
    useLayoutEffect(() => {
      liveView.current = view;
      setRenderView(view);
    }, [view]);
    useLayoutEffect(() => {
      // Child layout effects run before the ancestor ref is necessarily attached.
      // The mounted world node already has its actual canvas parent at this point.
      const element = viewport.current || world.current?.parentElement;
      if (!element) return;
      const measure = () => {
        const bounds = element.getBoundingClientRect();
        const next = { width: bounds.width, height: bounds.height };
        setSize((prior) =>
          prior.width === next.width && prior.height === next.height
            ? prior
            : next,
        );
        if (!bounds.width || !bounds.height) handlers.current.finishGesture();
      };
      measure();
      const observer = new ResizeObserver(measure);
      observer.observe(element);
      return () => observer.disconnect();
    }, [viewport, handlers]);
    useImperativeHandle(
      forwardedRef,
      () => ({
        previewView(next) {
          liveView.current = next;
          setRenderView(next);
        },
        previewDrag(next) {
          setPreview(next);
        },
        clearPreview() {
          setPreview(null);
        },
        getView() {
          return liveView.current;
        },
        getMountedIds() {
          return [
            ...(world.current?.querySelectorAll("[data-board-id]") || []),
          ].map((element) => element.dataset.boardId);
        },
      }),
      [],
    );
    const entries = useMemo(() => {
      if (!size.width || !size.height) return [];
      const pinnedIds = new Set(preview?.pinnedIds || []);
      if (focused) pinnedIds.add(focused);
      if (editingNote) pinnedIds.add(editingNote);
      return visibleBoardEntries(index, worldViewport(renderView, size), {
        pinnedIds,
        movingIds: preview?.ids,
        dx: preview?.dx,
        dy: preview?.dy,
      });
    }, [index, renderView, size, preview, focused, editingNote]);
    const priorityIds = new Set(
      [selected, focused, editingNote, ...(preview?.pinnedIds || [])].filter(
        Boolean,
      ),
    );
    const displayed = useProgressiveEntries(entries, index, priorityIds, {
      x: (size.width / 2 - renderView.x) / renderView.zoom,
      y: (size.height / 2 - renderView.y) / renderView.zoom,
    });
    const pending = entries.length - displayed.length;
    return (
      <>
        <div
          ref={world}
          className="st-world"
          data-rendered-items={displayed.length}
          data-render-target-count={entries.length}
          data-render-pending={pending}
          style={{
            transform: `translate(${renderView.x}px,${renderView.y}px) scale(${renderView.zoom})`,
          }}
          onFocusCapture={(event) =>
            setFocused(
              event.target.closest("[data-board-id]")?.dataset.boardId || null,
            )
          }
          onBlurCapture={(event) =>
            setFocused(
              event.relatedTarget?.closest?.("[data-board-id]")?.dataset
                .boardId || null,
            )
          }
        >
          {displayed.map((entry) => (
            <BoardItem
              key={entry.id}
              entry={entry}
              selected={selectedIds.has(entry.id)}
              active={selected === entry.id}
              editing={editingNote === entry.id}
              dx={preview?.ids.has(entry.id) ? preview.dx : 0}
              dy={preview?.ids.has(entry.id) ? preview.dy : 0}
              handlers={handlers}
            />
          ))}
        </div>
        {pending > 0 && (
          <div className="st-render-status" role="status">
            正在显示画板…
          </div>
        )}
      </>
    );
  }),
);
export default BoardWorld;
