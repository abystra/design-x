import React, {
  createContext,
  forwardRef,
  memo,
  useContext,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  BaseBoxShapeUtil,
  Box,
  DefaultCanvas,
  defaultOverlayUtils,
  Group2d,
  getIndicesBetween,
  HandTool,
  HTMLContainer,
  Rectangle2d,
  SelectTool,
  SelectionForegroundOverlayUtil,
  T,
  TldrawEditor,
  resizeBox,
  useEditor,
  useValue,
} from "tldraw";
import "tldraw/tldraw.css";
import { BoardItem, useProgressiveEntries } from "./BoardWorld";
import { organizationSnapshot } from "./board-state";
import { intersects } from "./board-spatial";
import {
  TYPES,
  boardShapes,
  fromCamera,
  fromShapeId,
  readOrganization,
  toCamera,
  toShapeId,
} from "./board/tldraw-adapter";
import "./board/tldraw-board.css";

const Context = createContext(null);
const runtimes = new WeakMap();
const commonProps = { boardId: T.string, w: T.number, h: T.number };
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

// Domain history remains the one undo stack exposed by Design-X. Native SDK
// transactions are allowed to finish (they need their marks while interacting),
// then normalized into one domain command and their private history is cleared.
const NativeTranslate = SelectTool.children().find(
  (tool) => tool.id === "translating",
);
const NativeResize = SelectTool.children().find(
  (tool) => tool.id === "resizing",
);
class BoardTranslate extends NativeTranslate {
  static id = "translating";
  onEnter(info) {
    runtimes.get(this.editor)?.begin();
    super.onEnter(info);
  }
  startCloning() {} // Alt preserves Design-X's unsnapped drag, never creates fake documents.
  updateShapes() {
    super.updateShapes();
    runtimes.get(this.editor)?.moveMembers();
  }
  onCancel() {
    this.complete();
  }
  onExit() {
    super.onExit();
    runtimes.get(this.editor)?.commit();
  }
}
class BoardResize extends NativeResize {
  static id = "resizing";
  onEnter(info) {
    runtimes.get(this.editor)?.begin();
    super.onEnter(info);
  }
  onCancel() {
    this.complete();
  }
  onExit() {
    super.onExit();
    runtimes.get(this.editor)?.commit();
  }
}
class BoardSelect extends SelectTool {
  static id = "select";
  static children() {
    return super
      .children()
      .map((tool) =>
        tool.id === "translating"
          ? BoardTranslate
          : tool.id === "resizing"
            ? BoardResize
            : tool,
      );
  }
}

class BoardBox extends BaseBoxShapeUtil {
  getIndicatorPath(shape) {
    const path = new Path2D();
    path.rect(0, 0, shape.props.w, shape.props.h);
    return path;
  }
  canEdit() {
    return false;
  }
  hideRotateHandle() {
    return true;
  }
  canBind() {
    return false;
  }
  onTranslate(initial, current) {
    const snap = (delta) =>
      this.editor.inputs.getAltKey() ? delta : Math.round(delta / 10) * 10;
    return {
      id: current.id,
      type: current.type,
      x: clamp(initial.x + snap(current.x - initial.x), -100000, 100000),
      y: clamp(initial.y + snap(current.y - initial.y), -100000, 100000),
    };
  }
  component(shape) {
    return <ShapeContent shape={shape} />;
  }
}
class ArtboardShape extends BoardBox {
  static type = TYPES.artboard;
  static props = commonProps;
  getDefaultProps() {
    return { boardId: "", w: 260, h: 350 };
  }
  canResize() {
    return false;
  }
  getGeometry(shape) {
    return new Rectangle2d({
      x: 0,
      y: -26,
      width: shape.props.w,
      height: shape.props.h + 61,
      isFilled: true,
    });
  }
}
class NoteShape extends BoardBox {
  static type = TYPES.note;
  static props = { ...commonProps, text: T.string, color: T.string };
  getDefaultProps() {
    return { boardId: "", w: 240, h: 200, text: "", color: "#FFF0B5" };
  }
  onResize(shape, info) {
    const change = resizeBox(shape, info);
    return {
      ...change,
      props: {
        ...change.props,
        w: clamp(change.props.w, 160, 2000),
        h: clamp(change.props.h, 100, 3000),
      },
    };
  }
}
class SectionShape extends BoardBox {
  static type = TYPES.section;
  static props = {
    ...commonProps,
    title: T.string,
    color: T.string,
    itemIds: T.arrayOf(T.string),
  };
  getDefaultProps() {
    return {
      boardId: "",
      w: 560,
      h: 420,
      title: "新的分区",
      color: "#CBD8BE",
      itemIds: [],
    };
  }
  getGeometry(shape) {
    return new Group2d({
      children: [
        new Rectangle2d({
          width: shape.props.w,
          height: shape.props.h,
          isFilled: false,
        }),
        new Rectangle2d({ width: shape.props.w, height: 38, isFilled: true }),
      ],
    });
  }
  onResize(shape, info) {
    const change = resizeBox(shape, info);
    return {
      ...change,
      props: {
        ...change.props,
        w: clamp(change.props.w, 240, 20000),
        h: clamp(change.props.h, 160, 20000),
      },
    };
  }
}
const SHAPES = [ArtboardShape, NoteShape, SectionShape];
const TOOLS = [BoardSelect, HandTool];
// Board has no rotation field; artboards also keep their fixed preview size.
// This tool/overlay adapter is pinned and regression-tested with SDK 5.6.0.
class BoardSelectionOverlay extends SelectionForegroundOverlayUtil {
  _computeSelectionState() {
    const state = super._computeSelectionState();
    if (!state) return state;
    const resizable =
      state.onlyShape && state.onlyShape.type !== TYPES.artboard;
    return {
      ...state,
      showCornerRotateHandles: false,
      showMobileRotateHandle: false,
      showResizeHandles: Boolean(resizable && state.showResizeHandles),
      showHandles: Boolean(resizable && state.showHandles),
    };
  }
}
const OVERLAYS = defaultOverlayUtils.map((util) =>
  util.type === "selection_foreground" ? BoardSelectionOverlay : util,
);
const OPTIONS = {
  maxShapesPerPage: 2000,
  camera: {
    wheelBehavior: "pan",
    zoomSteps: [
      0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6,
      1.7, 1.8, 1.9, 2,
    ],
  },
};
const ASSETS = { fonts: {} }; // Custom shapes use the already self-hosted Design-X fonts.

function createRuntime(latest) {
  const listeners = new Map();
  return {
    latest,
    editor: null,
    gesture: null,
    syncing: false,
    settling: false,
    cameraTimer: null,
    allowed: new Set(),
    pinned: new Set(),
    subscribe(id, callback) {
      if (!listeners.has(id)) listeners.set(id, new Set());
      listeners.get(id).add(callback);
      return () => {
        listeners.get(id)?.delete(callback);
        if (!listeners.get(id)?.size) listeners.delete(id);
      };
    },
    publish(ids) {
      const changed = new Set([...this.allowed, ...ids]);
      for (const id of changed)
        if (this.allowed.has(id) === ids.has(id)) changed.delete(id);
      this.allowed = ids;
      for (const id of changed)
        for (const callback of listeners.get(id) || []) callback();
    },
    begin() {
      if (this.gesture || this.syncing) return;
      const board = this.latest.current.board;
      this.gesture = {
        before: organizationSnapshot(board),
        board,
        selected: new Set(this.editor.getSelectedShapeIds().map(fromShapeId)),
      };
      this.pinned = new Set(
        [...this.allowed].filter((id) => this.gesture.selected.has(id)),
      );
      this.latest.current.handlers.current.canvasInteractionStart?.();
    },
    moveMembers() {
      if (!this.gesture) return;
      const { board, selected } = this.gesture;
      const originals = new Map(
        [...board.results, ...board.notes].map((item) => [item.id, item]),
      );
      const changes = [];
      for (const section of board.sections) {
        if (!selected.has(section.id)) continue;
        const current = this.editor.getShape(toShapeId(section.id));
        if (!current) continue;
        const dx = current.x - section.position.x,
          dy = current.y - section.position.y;
        for (const id of section.itemIds) {
          if (selected.has(id)) continue;
          const original = originals.get(id),
            shape = this.editor.getShape(toShapeId(id));
          if (original && shape)
            changes.push({
              id: shape.id,
              type: shape.type,
              x: clamp(original.position.x + dx, -100000, 100000),
              y: clamp(original.position.y + dy, -100000, 100000),
            });
        }
      }
      if (changes.length)
        this.editor.run(() => this.editor.updateShapes(changes), {
          history: "ignore",
        });
    },
    commit() {
      if (!this.gesture || this.syncing) return;
      const gesture = this.gesture;
      this.gesture = null;
      this.pinned = new Set();
      const next = readOrganization(this.editor, this.latest.current.board);
      this.latest.current.handlers.current.canvasCommit(next, gesture.before);
      // No native undo entry may escape as a second, divergent history.
      queueMicrotask(() => {
        if (this.editor && !this.gesture) this.editor.clearHistory();
      });
    },
    selection() {
      if (this.syncing || !this.editor) return;
      const ids = this.editor.getSelectedShapeIds().map(fromShapeId);
      const current = this.latest.current;
      if (ids.join("|") !== current.selection.join("|")) {
        current.handlers.current.canvasSelection(
          ids,
          ids.includes(current.selected)
            ? current.selected
            : ids.at(-1) || null,
        );
      }
    },
    camera() {
      if (this.syncing || !this.editor) return;
      const next = fromCamera(this.editor.getCamera()),
        prior = this.latest.current.view;
      if (
        Math.abs(next.x - prior.x) > 0.001 ||
        Math.abs(next.y - prior.y) > 0.001 ||
        Math.abs(next.zoom - prior.zoom) > 0.00001
      )
        this.latest.current.handlers.current.canvasView(next);
    },
    settle() {
      if (!this.editor || this.settling || this.syncing) return;
      this.settling = true;
      clearTimeout(this.cameraTimer);
      try {
        this.editor.complete();
        this.commit();
        this.selection();
        this.camera();
        this.editor.clearHistory();
      } finally {
        this.settling = false;
      }
    },
    apply() {
      if (!this.editor || this.gesture) return;
      const editor = this.editor,
        value = this.latest.current;
      this.syncing = true;
      try {
        const shapes = boardShapes(value.board),
          wanted = new Set(shapes.map((shape) => shape.id));
        editor.run(
          () => {
            const removing = editor
              .getCurrentPageShapes()
              .filter((shape) => !wanted.has(shape.id));
            if (removing.length)
              editor.deleteShapes(removing.map((shape) => shape.id));
            const creating = [],
              changing = [];
            for (const shape of shapes) {
              const prior = editor.getShape(shape.id);
              if (!prior) creating.push(shape);
              else if (
                prior.x !== shape.x ||
                prior.y !== shape.y ||
                JSON.stringify(prior.props) !== JSON.stringify(shape.props)
              )
                changing.push(shape);
            }
            if (creating.length) editor.createShapes(creating);
            if (changing.length) editor.updateShapes(changing);
            // Preserve the prototype's section -> note -> artboard paint order,
            // including objects returned asynchronously by the creation API.
            const ordered = editor.getCurrentPageShapesSorted();
            if (
              ordered.length !== shapes.length ||
              ordered.some((shape, index) => shape.id !== shapes[index]?.id)
            ) {
              const indices = getIndicesBetween(null, null, shapes.length);
              editor.updateShapes(
                shapes.map((shape, index) => ({
                  id: shape.id,
                  type: shape.type,
                  index: indices[index],
                })),
              );
            }
            const selected = value.selection
              .map(toShapeId)
              .filter((id) => wanted.has(id));
            if (editor.getSelectedShapeIds().join("|") !== selected.join("|"))
              editor.setSelectedShapes(selected);
          },
          { history: "ignore" },
        );
        editor.clearHistory();
      } finally {
        this.syncing = false;
      }
    },
  };
}

const ShapeContent = memo(function ShapeContent({ shape }) {
  const { runtime, model, selected, editingNote } = useContext(Context);
  const id = shape.props.boardId;
  const subscribe = useMemo(
    () => (callback) => runtime.subscribe(id, callback),
    [runtime, id],
  );
  const shown = useSyncExternalStore(subscribe, () => runtime.allowed.has(id));
  const editor = useEditor();
  const active = useValue(
    "Board selection",
    () => editor.getSelectedShapeIds().includes(shape.id),
    [editor, shape.id],
  );
  if (!shown) return null;
  const entry = model.get(id);
  if (!entry) return null;
  const item = {
    ...entry.item,
    width: shape.props.w,
    height: shape.props.h,
    ...(entry.kind === "note"
      ? { text: shape.props.text, color: shape.props.color }
      : entry.kind === "section"
        ? {
            title: shape.props.title,
            color: shape.props.color,
            itemIds: shape.props.itemIds,
          }
        : {}),
  };
  const handlers = {
    current: { ...runtime.latest.current.handlers.current, startPointer() {} },
  };
  return (
    <HTMLContainer
      className="dx-shape-content"
      style={{
        width: shape.props.w,
        height: shape.props.h,
        pointerEvents: "all",
      }}
      onPointerDown={(event) => {
        if (
          event.target.closest(
            'button,input,textarea,select,[contenteditable="true"]',
          )
        )
          event.stopPropagation();
      }}
    >
      <BoardItem
        entry={{ ...entry, item }}
        selected={active}
        active={selected === id}
        editing={editingNote === id}
        handlers={handlers}
        positioned={false}
      />
    </HTMLContainer>
  );
});

function RenderPolicy() {
  const editor = useEditor();
  const { runtime, model, selected, editingNote } = useContext(Context);
  const geometry = useValue(
    "Board viewport geometry",
    () => {
      const camera = editor.getCamera(),
        viewport = editor.getViewportPageBounds(),
        margin = 240 / camera.z;
      const bounds = {
        x: viewport.x - margin,
        y: viewport.y - margin,
        width: viewport.w + margin * 2,
        height: viewport.h + margin * 2,
      };
      const focused =
        document.activeElement?.closest?.("[data-board-id]")?.dataset.boardId;
      const entries = [];
      const candidates = new Set(
        editor.getShapeIdsInsideBounds(
          new Box(bounds.x, bounds.y, bounds.width, bounds.height),
        ),
      );
      for (const id of [...runtime.pinned, editingNote, focused].filter(
        Boolean,
      ))
        candidates.add(toShapeId(id));
      for (const shapeId of candidates) {
        const shape = editor.getShape(shapeId);
        if (!shape) continue;
        const id = shape.props.boardId,
          source = model.get(id);
        if (!source) continue;
        const box = editor.getShapePageBounds(shape);
        if (!box) continue;
        const itemBounds = { x: box.x, y: box.y, width: box.w, height: box.h };
        if (
          intersects(bounds, itemBounds) ||
          runtime.pinned.has(id) ||
          editingNote === id ||
          focused === id
        )
          entries.push({ ...source, bounds: itemBounds });
      }
      const kindOrder = { section: 0, note: 1, artboard: 2 };
      entries.sort(
        (a, b) => kindOrder[a.kind] - kindOrder[b.kind] || a.index - b.index,
      );
      return {
        entries,
        center: {
          x: viewport.x + viewport.w / 2,
          y: viewport.y + viewport.h / 2,
        },
        camera,
        focused,
      };
    },
    [editor, model, runtime, editingNote],
  );
  const priorities = new Set(
    [selected, editingNote, geometry.focused, ...runtime.pinned].filter(
      Boolean,
    ),
  );
  const displayed = useProgressiveEntries(
    geometry.entries,
    model,
    priorities,
    geometry.center,
  );
  useLayoutEffect(
    () => runtime.publish(new Set(displayed.map((entry) => entry.id))),
    [runtime, displayed],
  );
  const pending = geometry.entries.length - displayed.length;
  return (
    <>
      <div
        className="dx-board-diagnostics"
        data-board-engine="tldraw"
        data-camera-x={geometry.camera.x * geometry.camera.z}
        data-camera-y={geometry.camera.y * geometry.camera.z}
        data-camera-zoom={geometry.camera.z}
        data-rendered-items={displayed.length}
        data-render-target-count={geometry.entries.length}
        data-render-pending={pending}
      />
      {pending > 0 && (
        <div className="st-render-status" role="status">
          正在显示画板…
        </div>
      )}
    </>
  );
}
function BoardCanvas() {
  return (
    <>
      <DefaultCanvas />
      <RenderPolicy />
    </>
  );
}
const COMPONENTS = { Canvas: BoardCanvas };

export default memo(
  forwardRef(function TldrawBoard(
    {
      results,
      notes,
      sections,
      view,
      selection,
      selected,
      editingNote,
      handlers,
      tool,
      disabled,
    },
    ref,
  ) {
    const latest = useRef(null);
    latest.current = {
      board: { results, notes, sections },
      view,
      selection,
      selected,
      editingNote,
      handlers,
    };
    const runtime = useMemo(() => createRuntime(latest), []);
    const [ready, setReady] = useState(false);
    const model = useMemo(
      () =>
        new Map([
          ...sections.map((item, index) => [
            item.id,
            { id: item.id, kind: "section", item, index },
          ]),
          ...notes.map((item, index) => [
            item.id,
            { id: item.id, kind: "note", item, index },
          ]),
          ...results.map((item, index) => [
            item.id,
            { id: item.id, kind: "artboard", item, index },
          ]),
        ]),
      [results, notes, sections],
    );
    const context = useMemo(
      () => ({ runtime, model, selected, editingNote }),
      [runtime, model, selected, editingNote],
    );
    const mount = useMemo(
      () => (editor) => {
        runtime.editor = editor;
        runtimes.set(editor, runtime);
        editor.user.updateUserPreferences({
          isSnapMode: false,
          animationSpeed: 0,
        });
        runtime.apply();
        editor.setCamera(toCamera(latest.current.view));
        editor.setCurrentTool(tool);
        editor.clearHistory();
        const removeListener = editor.store.listen(
          () => {
            if (runtime.syncing) return;
            runtime.selection();
            clearTimeout(runtime.cameraTimer);
            runtime.cameraTimer = setTimeout(() => {
              if (!runtime.gesture) runtime.camera();
            }, 150);
          },
          { source: "user", scope: "session" },
        );
        setReady(true);
        return () => {
          runtime.settle();
          removeListener();
          clearTimeout(runtime.cameraTimer);
          runtimes.delete(editor);
          runtime.editor = null;
        };
      },
      [runtime],
    );
    useLayoutEffect(() => {
      if (ready) runtime.apply();
    }, [ready, runtime, results, notes, sections, selection]);
    useLayoutEffect(() => {
      if (!runtime.editor) return;
      runtime.syncing = true;
      runtime.editor.setCamera(toCamera(view));
      runtime.syncing = false;
    }, [ready, runtime, view]);
    useLayoutEffect(() => {
      if (!runtime.editor) return;
      runtime.settle();
      runtime.editor.updateInstanceState({ isReadonly: disabled });
      runtime.editor.setCurrentTool(tool);
    }, [ready, runtime, tool, disabled]);
    useImperativeHandle(
      ref,
      () => ({
        settle: () => runtime.settle(),
        isInteracting: () =>
          Boolean(runtime.gesture || runtime.editor?.inputs.getIsDragging()),
        getView: () =>
          runtime.editor
            ? fromCamera(runtime.editor.getCamera())
            : latest.current.view,
        getMountedIds: () => [...runtime.allowed],
      }),
      [runtime],
    );
    return (
      <Context.Provider value={context}>
        <div
          className="dx-tldraw-board"
          data-board-engine="tldraw"
          onPointerCancelCapture={() => runtime.settle()}
          onPointerUp={() => {
            queueMicrotask(() => runtime.settle());
          }}
          onContextMenu={(event) => event.preventDefault()}
        >
          <TldrawEditor
            shapeUtils={SHAPES}
            tools={TOOLS}
            overlayUtils={OVERLAYS}
            components={COMPONENTS}
            options={OPTIONS}
            assetUrls={ASSETS}
            initialState="select"
            autoFocus={false}
            onMount={mount}
          />
        </div>
      </Context.Provider>
    );
  }),
);
