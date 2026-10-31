import { z } from "zod";

export const BoardItemIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,150}$/);
const coordinate = z.number().finite().min(-100000).max(100000);
export const BoardPositionSchema = z.object({ x: coordinate, y: coordinate });
const color = z
  .string()
  .regex(/^#[0-9a-f]{6}$/i, "请选择有效的六位十六进制颜色");
export const BoardNoteSchema = z.object({
  id: BoardItemIdSchema,
  text: z.string().max(10000),
  position: BoardPositionSchema,
  width: z.number().finite().min(160).max(2000),
  height: z.number().finite().min(100).max(3000),
  color,
});
export const BoardSectionSchema = z.object({
  id: BoardItemIdSchema,
  title: z.string().max(120),
  position: BoardPositionSchema,
  width: z.number().finite().min(240).max(20000),
  height: z.number().finite().min(160).max(20000),
  color,
  itemIds: z.array(BoardItemIdSchema).max(1500),
});
// Keep the existing Board envelope compatible. New authored objects are typed;
// Artboard contents remain authoritative in their own documents rows.
export const BoardSchema = z
  .object({
    id: BoardItemIdSchema.optional(),
    title: z.string().max(200).optional(),
    results: z
      .array(
        z
          .object({
            id: BoardItemIdSchema,
            position: BoardPositionSchema.default({ x: 0, y: 0 }),
          })
          .passthrough(),
      )
      .max(500)
      .default([]),
    notes: z.array(BoardNoteSchema).max(1000).default([]),
    sections: z.array(BoardSectionSchema).max(200).default([]),
    view: z
      .object({
        x: coordinate,
        y: coordinate,
        zoom: z.number().finite().min(0.1).max(8),
      })
      .optional(),
  })
  .passthrough()
  .superRefine((board, ctx) => {
    const allIds = [...board.results, ...board.notes, ...board.sections].map(
      (item) => item.id,
    );
    if (new Set(allIds).size !== allIds.length)
      ctx.addIssue({
        code: "custom",
        message: "画板、便签和分区的 ID 必须唯一",
      });
    const items = new Set(
      [...board.results, ...board.notes].map((item) => item.id),
    );
    const assigned = new Set<string>();
    board.sections.forEach((section, index) =>
      section.itemIds.forEach((itemId) => {
        if (!items.has(itemId))
          ctx.addIssue({
            code: "custom",
            path: ["sections", index, "itemIds"],
            message: "分区只能包含已有的画板或便签",
          });
        if (assigned.has(itemId))
          ctx.addIssue({
            code: "custom",
            path: ["sections", index, "itemIds"],
            message: "同一内容只能属于一个分区，且不能重复添加",
          });
        assigned.add(itemId);
      }),
    );
  });
export type Board = z.infer<typeof BoardSchema>;
export type BoardNote = z.infer<typeof BoardNoteSchema>;
export type BoardSection = z.infer<typeof BoardSectionSchema>;
