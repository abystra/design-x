// The server protocol stays independent of the canvas SDK. In particular,
// tldraw's shape: IDs and page-space camera never leak into Board snapshots.
export const toShapeId = (id) => `shape:${id}`;
export const fromShapeId = (id) =>
  id?.startsWith("shape:") ? id.slice(6) : id;
export const toCamera = ({ x, y, zoom }) => ({
  x: x / zoom,
  y: y / zoom,
  z: zoom,
});
export const fromCamera = ({ x, y, z }) => ({ x: x * z, y: y * z, zoom: z });
export const TYPES = {
  artboard: "dx-artboard",
  note: "dx-note",
  section: "dx-section",
};
export const KIND = Object.fromEntries(
  Object.entries(TYPES).map(([k, v]) => [v, k]),
);
export function boardShapes(board) {
  return [
    ...board.sections.map((item) => ({ item, kind: "section" })),
    ...board.notes.map((item) => ({ item, kind: "note" })),
    ...board.results.map((item) => ({ item, kind: "artboard" })),
  ].map(({ item, kind }) => ({
    id: toShapeId(item.id),
    type: TYPES[kind],
    x: item.position.x,
    y: item.position.y,
    props:
      kind === "artboard"
        ? {
            boardId: item.id,
            w: 260,
            h: (260 * item.design.height) / item.design.width,
          }
        : kind === "note"
          ? {
              boardId: item.id,
              w: item.width,
              h: item.height,
              text: item.text,
              color: item.color,
            }
          : {
              boardId: item.id,
              w: item.width,
              h: item.height,
              title: item.title,
              color: item.color,
              itemIds: item.itemIds,
            },
  }));
}
export function readOrganization(editor, board) {
  const read = (item, kind) => {
    const shape = editor.getShape(toShapeId(item.id));
    if (!shape || shape.type !== TYPES[kind]) return null;
    const next = { ...item, position: { x: shape.x, y: shape.y } };
    if (kind !== "artboard") {
      next.width = shape.props.w;
      next.height = shape.props.h;
      next.color = shape.props.color;
      if (kind === "note") next.text = shape.props.text;
      else {
        next.title = shape.props.title;
        next.itemIds = shape.props.itemIds;
      }
    }
    return next;
  };
  return {
    ...board,
    results: board.results
      .map((item) => read(item, "artboard"))
      .filter(Boolean),
    notes: board.notes.map((item) => read(item, "note")).filter(Boolean),
    sections: board.sections
      .map((item) => read(item, "section"))
      .filter(Boolean),
  };
}
