import type { MetadataRoute } from "next";
import { getPages } from "@/lib/api";
import { pagePath, siteUrl } from "@/lib/site";
export const dynamic = "force-dynamic";
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  return (await getPages()).map((page) => ({
    url: `${siteUrl()}${pagePath(page.slug)}`,
    lastModified: page.updated_at,
    changeFrequency: "weekly",
    priority: page.slug === "home" ? 1 : 0.7,
  }));
}
