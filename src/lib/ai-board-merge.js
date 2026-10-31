const COLLECTIONS = ["results", "notes", "sections"];
const MISSING = Symbol("missing");

export class BoardMergeConflict extends Error {
  constructor(path, reason) {
    super(
      `工作区合并冲突（${path}）：${reason}。本地未保存内容已保留，请检查远端版本。`,
    );
    this.name = "BoardMergeConflict";
    this.code = "BOARD_MERGE_CONFLICT";
    this.path = path;
    this.reason = reason;
  }
}

const record = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const keys = (value) =>
  record(value)
    ? Object.keys(value).filter((key) => value[key] !== undefined)
    : [];
const field = (value, key) =>
  Object.hasOwn(value, key) && value[key] !== undefined ? value[key] : MISSING;
const copy = (value) =>
  Array.isArray(value)
    ? value.map(copy)
    : record(value)
      ? Object.fromEntries(keys(value).map((key) => [key, copy(value[key])]))
      : value;

function equal(left, right) {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => equal(value, right[index]))
    );
  }
  if (!record(left) || !record(right)) return false;
  const leftKeys = keys(left),
    rightKeys = keys(right);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) => Object.hasOwn(right, key) && equal(left[key], right[key]),
    )
  );
}

// Objects merge by leaf field; arrays (including itemIds/messages/selection) are
// atomic. A missing field is distinct from null, false, an empty string or [].
function mergeValue(base, local, remote, path) {
  if (equal(local, remote)) return copy(local);
  if (equal(local, base)) return copy(remote);
  if (equal(remote, base)) return copy(local);
  if (local === MISSING || remote === MISSING)
    throw new BoardMergeConflict(path, "delete-modify");
  if (record(local) && record(remote) && (record(base) || base === MISSING)) {
    return mergeFields(base === MISSING ? {} : base, local, remote, path);
  }
  throw new BoardMergeConflict(path, "concurrent-change");
}

function mergeFields(base, local, remote, path, omit = []) {
  const entries = [];
  for (const key of new Set([...keys(base), ...keys(local), ...keys(remote)])) {
    if (omit.includes(key)) continue;
    const value = mergeValue(
      field(base, key),
      field(local, key),
      field(remote, key),
      path ? `${path}.${key}` : key,
    );
    if (value !== MISSING) entries.push([key, value]);
  }
  return Object.fromEntries(entries);
}

function boardFields(item, kind) {
  return Object.fromEntries(
    Object.keys(item)
      .filter(
        (key) => kind !== "results" || (key !== "design" && key !== "revision"),
      )
      .filter((key) => item[key] !== undefined)
      .map((key) => [key, item[key]]),
  );
}

function arrays(snapshot, label) {
  const collections = Object.fromEntries(
    COLLECTIONS.map((kind) => {
      const value = snapshot[kind] === undefined ? [] : snapshot[kind];
      if (!Array.isArray(value))
        throw new BoardMergeConflict(`${label}.${kind}`, "invalid-collection");
      return [kind, value];
    }),
  );
  const ids = new Set();
  for (const kind of COLLECTIONS)
    for (const item of collections[kind]) {
      if (!record(item) || typeof item.id !== "string" || !item.id)
        throw new BoardMergeConflict(`${label}.${kind}`, "invalid-id");
      if (ids.has(item.id))
        throw new BoardMergeConflict(
          `${label}.${kind}[${item.id}]`,
          "duplicate-id",
        );
      ids.add(item.id);
    }
  return collections;
}

// Preserve a unilateral reordering of existing items and each side's insertion
// anchors. Incompatible reorders/cycles are conflicts, never silently discarded.
function mergeOrder(base, local, remote, merged, kind) {
  const baseline = new Set(base.map((item) => item.id));
  const retained = (list) =>
    list.map((item) => item.id).filter((id) => merged.has(id));
  const baseOrder = retained(base);
  const localOrder = retained(local),
    remoteOrder = retained(remote);
  const oldOrder = mergeValue(
    baseOrder,
    localOrder.filter((id) => baseline.has(id)),
    remoteOrder.filter((id) => baseline.has(id)),
    `${kind}.$order`,
  );
  const edges = new Map([...merged.keys()].map((id) => [id, new Set()]));
  const degrees = new Map([...merged.keys()].map((id) => [id, 0]));
  const edge = (from, to) => {
    if (!edges.get(from).has(to)) {
      edges.get(from).add(to);
      degrees.set(to, degrees.get(to) + 1);
    }
  };
  for (let index = 1; index < oldOrder.length; index++)
    edge(oldOrder[index - 1], oldOrder[index]);
  for (const order of [localOrder, remoteOrder]) {
    for (let index = 1; index < order.length; index++) {
      if (!baseline.has(order[index - 1]) || !baseline.has(order[index]))
        edge(order[index - 1], order[index]);
    }
  }
  const priority = new Map(
    [...new Set([...localOrder, ...remoteOrder, ...baseOrder])].map(
      (id, index) => [id, index],
    ),
  );
  const ready = [...merged.keys()].filter((id) => degrees.get(id) === 0),
    result = [];
  while (ready.length) {
    ready.sort((a, b) => priority.get(a) - priority.get(b));
    const id = ready.shift();
    result.push(merged.get(id));
    for (const next of edges.get(id)) {
      degrees.set(next, degrees.get(next) - 1);
      if (degrees.get(next) === 0) ready.push(next);
    }
  }
  if (result.length !== merged.size)
    throw new BoardMergeConflict(`${kind}.$order`, "incompatible-order");
  return result;
}

function mergeCollection(base, local, remote, kind) {
  const byId = (items) => new Map(items.map((item) => [item.id, item]));
  const before = byId(base),
    ours = byId(local),
    theirs = byId(remote),
    merged = new Map();
  for (const id of new Set([
    ...before.keys(),
    ...ours.keys(),
    ...theirs.keys(),
  ])) {
    const path = `${kind}[${id}]`;
    const b = before.has(id) ? boardFields(before.get(id), kind) : MISSING;
    const l = ours.has(id) ? boardFields(ours.get(id), kind) : MISSING;
    const r = theirs.has(id) ? boardFields(theirs.get(id), kind) : MISSING;
    let value;
    if (b === MISSING && l !== MISSING && r !== MISSING) {
      if (!equal(l, r)) throw new BoardMergeConflict(path, "concurrent-create");
      value = copy(l);
    } else value = mergeValue(b, l, r, path);
    if (value === MISSING) continue;
    if (kind === "results") {
      // Documents are authoritative remotely and deliberately never compared or
      // traversed by this Board merge. Keep their immutable references for render
      // memoization. A local-only new result keeps its local document until saved.
      const document = theirs.get(id) || ours.get(id);
      for (const key of ["design", "revision"]) {
        if (Object.hasOwn(document, key)) value[key] = document[key];
      }
    }
    merged.set(id, value);
  }
  return mergeOrder(base, local, remote, merged, kind);
}

function validateMembership(snapshot) {
  const members = new Set(
    [...snapshot.results, ...snapshot.notes].map((item) => item.id),
  );
  const assigned = new Set();
  for (const section of snapshot.sections) {
    if (!Array.isArray(section.itemIds))
      throw new BoardMergeConflict(
        `sections[${section.id}].itemIds`,
        "invalid-membership",
      );
    for (const id of section.itemIds) {
      if (!members.has(id) || assigned.has(id))
        throw new BoardMergeConflict(
          `sections[${section.id}].itemIds`,
          "invalid-membership",
        );
      assigned.add(id);
    }
  }
}

/**
 * Merge a last-acknowledged persistence snapshot, current hydrated local state,
 * and a fresh hydrated GET /studio snapshot. Never changes its inputs.
 *
 * Omitted remote top-level UI fields inherit base; explicit []/null still mean
 * clear. Collection records missing remotely are real deletions. addedResultIds
 * lists incoming result IDs absent from local before this merge. A conflict
 * throws BoardMergeConflict; callers must retain local state and the prior ack.
 */
export function mergeAiBoardSnapshots(base, local, remote) {
  for (const [label, value] of [
    ["base", base],
    ["local", local],
    ["remote", remote],
  ]) {
    if (!record(value)) throw new BoardMergeConflict(label, "invalid-snapshot");
  }
  if (!Array.isArray(remote.results))
    throw new BoardMergeConflict("remote.results", "invalid-collection");
  const normalizedRemote = Object.fromEntries([
    ...keys(base).map((key) => [key, base[key]]),
    ...keys(remote).map((key) => [key, remote[key]]),
  ]);
  const b = arrays(base, "base"),
    l = arrays(local, "local"),
    r = arrays(normalizedRemote, "remote");
  const snapshot = mergeFields(base, local, normalizedRemote, "", COLLECTIONS);
  for (const kind of COLLECTIONS)
    snapshot[kind] = mergeCollection(b[kind], l[kind], r[kind], kind);
  arrays(snapshot, "merged");
  validateMembership(snapshot);
  const localIds = new Set(l.results.map((item) => item.id));
  const mergedIds = new Set(snapshot.results.map((item) => item.id));
  return {
    snapshot,
    addedResultIds: r.results
      .filter((item) => !localIds.has(item.id) && mergedIds.has(item.id))
      .map((item) => item.id),
  };
}

// Server-created artboards are outside local organization undo. Add them to
// every undo/redo checkpoint so undoing a prior drag cannot delete AI results.
// Other remote organization edits invalidate those checkpoints explicitly.
export function rebaseAiBoardHistory(history, base, remote) {
  const organization = (value) => ({
    results: value.results.map(({ id, position }) => ({ id, position })),
    notes: value.notes || [],
    sections: value.sections || [],
  });
  const oldIds = new Set(base.results.map((item) => item.id));
  const additions = remote.results
    .filter((item) => !oldIds.has(item.id))
    .map(({ id, position }) => ({ id, position }));
  const remaining = {
    ...remote,
    results: remote.results.filter((item) => oldIds.has(item.id)),
  };
  if (!equal(organization(base), organization(remaining)))
    return { past: [], future: [] };
  const rebase = (checkpoint) => ({
    ...checkpoint,
    results: [
      ...checkpoint.results,
      ...additions
        .filter(
          (item) =>
            !checkpoint.results.some((existing) => existing.id === item.id),
        )
        .map(copy),
    ],
  });
  return { past: history.past.map(rebase), future: history.future.map(rebase) };
}
