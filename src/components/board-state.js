// Board history stores organization only; artboard documents remain authoritative
// in the editor/backend and are reattached from the latest known document DTO.
export const copyBoardValue = (value) => JSON.parse(JSON.stringify(value));

export function boardPersistenceSnapshot(snapshot) {
  return {
    ...snapshot,
    results: snapshot.results.map(({ design, revision, ...result }) => result),
  };
}

export function initialPersistenceBaseline(snapshot, serverSnapshot) {
  // These fields may be supplied by the Home/skill handoff or normalized on
  // mount. Compare against what the server actually stored, not that handoff.
  return boardPersistenceSnapshot({
    ...snapshot,
    draft: serverSnapshot.draft || "",
    skill: serverSnapshot.skill || null,
    mode: serverSnapshot.mode || "Agent",
    assets: serverSnapshot.assets || [],
    attached: serverSnapshot.attached || [],
    messages: serverSnapshot.messages || [],
  });
}

export function boardItems(board) {
  return [
    ...(board.results || []).map((item) => ({ ...item, kind: "artboard" })),
    ...(board.notes || []).map((item) => ({ ...item, kind: "note" })),
    ...(board.sections || []).map((item) => ({ ...item, kind: "section" })),
  ];
}

export function organizationSnapshot(board) {
  return copyBoardValue({
    results: board.results.map(({ id, position }) => ({ id, position })),
    notes: board.notes || [],
    sections: board.sections || [],
  });
}

export function boardItemSize(item) {
  return item.kind === "artboard" || item.design
    ? {
        width: 260,
        height: (260 * item.design.height) / item.design.width + 35,
      }
    : { width: item.width, height: item.height };
}

export function expandSelection(board, ids) {
  const expanded = new Set(ids);
  for (const section of board.sections || []) {
    if (expanded.has(section.id))
      section.itemIds.forEach((id) => expanded.add(id));
  }
  return expanded;
}

export function moveBoardItems(board, ids, dx, dy, snap = false) {
  const expanded = expandSelection(board, ids);
  // Snap a shared delta rather than every item's coordinates: group geometry
  // stays intact and explicitly selecting a member cannot move it twice.
  const deltaX = snap ? Math.round(dx / 10) * 10 : dx;
  const deltaY = snap ? Math.round(dy / 10) * 10 : dy;
  const move = (item) =>
    expanded.has(item.id)
      ? {
          ...item,
          position: {
            x: item.position.x + deltaX,
            y: item.position.y + deltaY,
          },
        }
      : item;
  return {
    ...board,
    results: board.results.map(move),
    notes: (board.notes || []).map(move),
    sections: (board.sections || []).map(move),
  };
}

export function removeBoardItems(board, ids) {
  const removed = new Set(ids);
  return {
    ...board,
    results: board.results.filter((item) => !removed.has(item.id)),
    notes: board.notes.filter((item) => !removed.has(item.id)),
    // Removing a section dissolves the frame, never its unselected members.
    sections: board.sections
      .filter((item) => !removed.has(item.id))
      .map((section) => ({
        ...section,
        itemIds: section.itemIds.filter((id) => !removed.has(id)),
      })),
  };
}

export function alignBoardItems(board, ids, axis) {
  const selected = new Set(ids);
  const grouped = new Set(
    board.sections.filter((s) => selected.has(s.id)).flatMap((s) => s.itemIds),
  );
  const topLevel = boardItems(board).filter(
    (item) => selected.has(item.id) && !grouped.has(item.id),
  );
  if (topLevel.length < 2) return board;
  const edge = Math.min(...topLevel.map((item) => item.position[axis]));
  return topLevel.reduce(
    (next, item) =>
      moveBoardItems(
        next,
        [item.id],
        axis === "x" ? edge - item.position.x : 0,
        axis === "y" ? edge - item.position.y : 0,
      ),
    board,
  );
}

export function assignSectionMembers(board, sectionId, itemIds) {
  const valid = new Set(
    [...board.results, ...board.notes].map((item) => item.id),
  );
  const adding = new Set(itemIds.filter((id) => valid.has(id)));
  return {
    ...board,
    sections: board.sections.map((section) => ({
      ...section,
      itemIds:
        section.id === sectionId
          ? [...new Set([...section.itemIds, ...adding])]
          : section.itemIds.filter((id) => !adding.has(id)),
    })),
  };
}
