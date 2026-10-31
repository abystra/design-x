import { z } from "zod";

const coordinate = z.number().finite().min(-100000).max(100000);
export const NodeSchema = z.object({
  id: z.string().min(1).max(150),
  type: z.enum(["text", "image", "rect", "circle"]),
  x: coordinate,
  y: coordinate,
  w: z.number().positive().max(32768),
  h: z.number().positive().max(32768),
  text: z.string().max(20000).optional(),
  src: z.string().max(4096).optional(),
  color: z.string().max(64).optional(),
  size: z.number().positive().max(2000).optional(),
  weight: z.union([z.number(), z.string().max(20)]).optional(),
  font: z.string().max(200).optional(),
  align: z.enum(["left", "center", "right"]).optional(),
  opacity: z.number().min(0).max(1).optional(),
  rotation: z.number().finite().optional(),
  hidden: z.boolean().optional(),
  locked: z.boolean().optional(),
  label: z.string().max(300).optional(),
  groupId: z.string().max(150).optional(),
  objectPosition: z.string().max(50).optional(),
  fit: z.enum(["cover", "contain", "fill"]).optional(),
});
export const ArtboardSchema = z
  .object({
    width: z.number().int().min(16).max(8192),
    height: z.number().int().min(16).max(8192),
    background: z.string().max(64),
    nodes: z.array(NodeSchema).max(1000),
  })
  .superRefine((d, ctx) => {
    if (new Set(d.nodes.map((n) => n.id)).size !== d.nodes.length)
      ctx.addIssue({ code: "custom", message: "图层 ID 必须唯一" });
  });
export type DesignNode = z.infer<typeof NodeSchema>;
export type Artboard = z.infer<typeof ArtboardSchema>;
export type DocOp =
  | { type: "canvas"; patch: Partial<Omit<Artboard, "nodes">> }
  | { type: "put"; node: DesignNode; index: number }
  | { type: "remove"; id: string }
  | { type: "order"; ids: string[] };

export function applyOps(source: Artboard, ops: DocOp[]): Artboard {
  let doc = structuredClone(source);
  for (const op of ops) {
    if (op.type === "canvas") doc = { ...doc, ...op.patch };
    if (op.type === "remove")
      doc.nodes = doc.nodes.filter((n) => n.id !== op.id);
    if (op.type === "put") {
      doc.nodes = doc.nodes.filter((n) => n.id !== op.node.id);
      doc.nodes.splice(op.index, 0, structuredClone(op.node));
    }
    if (op.type === "order") {
      if (
        op.ids.length !== doc.nodes.length ||
        new Set(op.ids).size !== doc.nodes.length
      )
        throw new Error("Invalid layer ordering");
      doc.nodes = op.ids.map((id) => {
        const n = doc.nodes.find((n) => n.id === id);
        if (!n) throw new Error("Unknown layer");
        return n;
      });
    }
  }
  return ArtboardSchema.parse(doc);
}
export function diffDesign(before: Artboard, after: Artboard): DocOp[] {
  const ops: DocOp[] = [];
  if (
    before.width !== after.width ||
    before.height !== after.height ||
    before.background !== after.background
  )
    ops.push({
      type: "canvas",
      patch: {
        width: after.width,
        height: after.height,
        background: after.background,
      },
    });
  for (const n of before.nodes)
    if (!after.nodes.some((x) => x.id === n.id))
      ops.push({ type: "remove", id: n.id });
  after.nodes.forEach((node, index) => {
    if (
      JSON.stringify(before.nodes.find((n) => n.id === node.id)) !==
      JSON.stringify(node)
    )
      ops.push({ type: "put", node, index });
  });
  if (
    JSON.stringify(before.nodes.map((n) => n.id)) !==
    JSON.stringify(after.nodes.map((n) => n.id))
  )
    ops.push({ type: "order", ids: after.nodes.map((n) => n.id) });
  return ops;
}
export function resizeArtboard(
  doc: Artboard,
  width: number,
  height: number,
): Artboard {
  const sx = width / doc.width,
    sy = height / doc.height;
  return ArtboardSchema.parse({
    ...doc,
    width,
    height,
    nodes: doc.nodes.map((n) => ({
      ...n,
      x: n.x * sx,
      y: n.y * sy,
      w: n.w * sx,
      h: n.h * sy,
      ...(n.size ? { size: n.size * Math.min(sx, sy) } : {}),
    })),
  });
}
export function assetIds(doc: Artboard): string[] {
  return [
    ...new Set(
      doc.nodes.flatMap((n) => {
        const id = n.src?.match(
          /^\/api\/assets\/([^/]+)\/(?:file|thumbnail)/,
        )?.[1];
        return id ? [id] : [];
      }),
    ),
  ];
}
