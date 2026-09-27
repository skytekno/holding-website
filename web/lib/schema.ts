import { z } from "zod";

// The public API is authoritative; validate its wire format before rendering it.
export const pageSchema = z.object({
  id: z.uuid(),
  slug: z.string(),
  title: z.string(),
  description: z.string(),
  body: z.string(),
  status: z.enum(["draft", "published"]),
  created_at: z.iso.datetime({ offset: true }),
  updated_at: z.iso.datetime({ offset: true }),
  published_at: z.iso.datetime({ offset: true }).nullable(),
});

export const pagesSchema = z.array(pageSchema);
export type Page = z.infer<typeof pageSchema>;
