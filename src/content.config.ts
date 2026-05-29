import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { z } from "astro:schema";

// One JSON file per entry under /data → one collection entry. The loader's id
// is the path sans extension (e.g. "terminal-osc/133"), which equals the
// entry's own canonical `id` by design.
const entries = defineCollection({
  // Use the entry's own canonical `id` ("family/slug"). The default glob id is
  // just the filename stem, which collapses e.g. http-status/200 + cbor-tag/200.
  loader: glob({
    pattern: "**/*.json",
    base: "./data",
    generateId: ({ data }) => (data as { id: string }).id,
  }),
  schema: z
    .object({
      id: z.string(),
      family: z.string(),
      namespace: z.string().optional(),
      slug: z.string(),
      title: z.string(),
      summary: z.string(),
      kind: z.string(),
      aliases: z.array(z.string()).optional(),
      status: z.string(),
      verification: z.enum(["verified", "unverified", "contested"]),
      tier: z.string(),
      source_url: z.string(),
      source_version: z.string(),
      retrieved_date: z.string(),
      attribution: z
        .array(
          z.object({
            claim_ref: z.string().optional(),
            source_url: z.string(),
            source_version: z.string().optional(),
            note: z.string().optional(),
          }),
        )
        .optional(),
      see_also: z.array(z.string()).optional(),
      ext_type: z.string(),
      ext: z.record(z.string(), z.any()).default({}),
      updated: z.string(),
    })
    .passthrough(),
});

export const collections = { entries };
