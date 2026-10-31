import { z } from "zod";
import { ArtboardSchema } from "../../doc-core/src/index.js";

export const ManifestSchema = z
  .object({
    version: z.literal(1),
    summary: z.string().min(1).max(2000),
    artboards: z
      .array(
        z
          .object({
            title: z.string().min(1).max(200),
            design: ArtboardSchema,
          })
          .strict(),
      )
      .min(1)
      .max(3),
  })
  .strict();
export type CreativeManifest = z.infer<typeof ManifestSchema>;

export function validateManifest(
  value: unknown,
  count?: number,
): CreativeManifest {
  const manifest = ManifestSchema.parse(value);
  if (count !== undefined && manifest.artboards.length !== count)
    throw new Error(
      `Expected ${count} artboards, received ${manifest.artboards.length}`,
    );
  if (manifest.artboards.some((a) => !a.design.nodes.length))
    throw new Error("A generated design must contain editable layers");
  return manifest;
}
