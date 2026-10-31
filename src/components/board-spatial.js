// World-space bounds contain only geometry. Building/querying the index never
// traverses or serializes artboard nodes.
const CELL_SIZE = 512;
const MAX_ITEM_CELLS = 256;
const MAX_QUERY_CELLS = 4096;

export function intersects(a, b) {
  return (
    a.x <= b.x + b.width &&
    a.x + a.width >= b.x &&
    a.y <= b.y + b.height &&
    a.y + a.height >= b.y
  );
}

export function worldViewport(view, size, overscan = 240) {
  const zoom = Math.max(0.01, view.zoom);
  return {
    x: (-view.x - overscan) / zoom,
    y: (-view.y - overscan) / zoom,
    width: (Math.max(0, size.width) + overscan * 2) / zoom,
    height: (Math.max(0, size.height) + overscan * 2) / zoom,
  };
}

export function itemBounds(item, kind) {
  const { x = 0, y = 0 } = item.position || {};
  if (kind === "artboard") {
    const width = 260;
    const height =
      (width * (item.design?.height || 800)) / (item.design?.width || 600);
    // Include title above and caption/actions below the document itself.
    return { x: x - 6, y: y - 30, width: width + 12, height: height + 100 };
  }
  return {
    x: x - 6,
    y: y - 6,
    width: item.width + 12,
    height: item.height + 12,
  };
}

function cellRange(bounds, cellSize) {
  const x0 = Math.floor(bounds.x / cellSize),
    y0 = Math.floor(bounds.y / cellSize);
  const x1 = Math.floor((bounds.x + bounds.width) / cellSize);
  const y1 = Math.floor((bounds.y + bounds.height) / cellSize);
  return { x0, y0, x1, y1, count: (x1 - x0 + 1) * (y1 - y0 + 1) };
}

export function buildBoardIndex(board, cellSize = CELL_SIZE) {
  const entries = new Map(),
    cells = new Map(),
    large = [];
  let order = 0;
  for (const [key, kind] of [
    ["sections", "section"],
    ["notes", "note"],
    ["results", "artboard"],
  ]) {
    (board[key] || []).forEach((item, index) => {
      const entry = {
        id: item.id,
        kind,
        index,
        order: order++,
        item,
        bounds: itemBounds(item, kind),
      };
      entries.set(item.id, entry);
      const range = cellRange(entry.bounds, cellSize);
      // A huge section must not allocate thousands of otherwise empty cells.
      if (range.count > MAX_ITEM_CELLS) {
        large.push(entry.id);
        return;
      }
      for (let x = range.x0; x <= range.x1; x++)
        for (let y = range.y0; y <= range.y1; y++) {
          const key = `${x}:${y}`;
          if (!cells.has(key)) cells.set(key, new Set());
          cells.get(key).add(entry.id);
        }
    });
  }
  function query(bounds) {
    const range = cellRange(bounds, cellSize);
    const candidates = new Set(large);
    if (range.count > MAX_QUERY_CELLS) {
      for (const id of entries.keys()) candidates.add(id);
    } else {
      for (let x = range.x0; x <= range.x1; x++)
        for (let y = range.y0; y <= range.y1; y++) {
          for (const id of cells.get(`${x}:${y}`) || []) candidates.add(id);
        }
    }
    return [...candidates]
      .map((id) => entries.get(id))
      .filter((entry) => intersects(entry.bounds, bounds));
  }
  return { entries, query, cellCount: cells.size };
}

/**
 * @param {ReturnType<typeof buildBoardIndex>} index
 * @param {{x: number, y: number, width: number, height: number}} bounds
 * @param {{pinnedIds?: Iterable<string>, movingIds?: Set<string>, dx?: number, dy?: number}} [options]
 */
export function visibleBoardEntries(
  index,
  bounds,
  options = {},
) {
  const { pinnedIds = [], movingIds, dx = 0, dy = 0 } = options;
  const visible = new Map();
  for (const entry of index.query(bounds)) {
    if (!movingIds?.has(entry.id)) visible.set(entry.id, entry);
  }
  if (movingIds?.size) {
    // Query the immutable index in the inverse drag direction, then retain
    // only moving items. Offscreen group members entering the viewport appear
    // without rebuilding the index or mounting every member of the group.
    const movedBounds = { ...bounds, x: bounds.x - dx, y: bounds.y - dy };
    for (const entry of index.query(movedBounds)) {
      if (movingIds.has(entry.id)) visible.set(entry.id, entry);
    }
  }
  for (const id of pinnedIds) {
    const entry = index.entries.get(id);
    if (entry) visible.set(id, entry);
  }
  return [...visible.values()].sort((a, b) => a.order - b.order);
}
