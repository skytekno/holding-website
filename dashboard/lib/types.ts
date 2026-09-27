import { z } from "zod";

export type RuntimeConfig = {
  apiUrl: string;
  siteUrl: string;
  googleClientId: string;
  development: boolean;
};
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
export type PageInput = Pick<
  Page,
  "slug" | "title" | "description" | "body" | "status"
>;
export const assetSchema = z.object({
  id: z.uuid(),
  filename: z.string(),
  url: z.url({ protocol: /^https?$/ }),
  content_type: z.string(),
  size: z.number().int().nonnegative(),
  created_at: z.iso.datetime({ offset: true }),
});
export const assetsSchema = z.array(assetSchema);
export const emptyResponseSchema = z.undefined();
export const tokenExpirySchema = z.object({ exp: z.number().int().nonnegative() });
export type Asset = z.infer<typeof assetSchema>;
