import "server-only";
import { cache } from "react";
import { pageSchema, pagesSchema, type Page } from "@/lib/schema";
export type { Page } from "@/lib/schema";

function apiUrl(path: string): string {
  return `${(process.env["API_URL"] || "http://localhost:8080").replace(/\/$/, "")}${path}`;
}

export class ApiError extends Error {
  constructor(public readonly status: number) {
    super(`Content API returned ${status}`);
    this.name = "ApiError";
  }
}

export const getPages = cache(async (): Promise<Page[]> => {
  const response = await fetch(apiUrl("/v1/pages"), {
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new ApiError(response.status);
  const pages = pagesSchema.parse(await response.json());
  return pages.filter((page) => page.status === "published");
});

export const getPage = cache(async (slug: string): Promise<Page | null> => {
  const response = await fetch(
    apiUrl(`/v1/pages/${encodeURIComponent(slug)}`),
    { cache: "no-store", signal: AbortSignal.timeout(10_000) },
  );
  if (response.status === 404) return null;
  if (!response.ok) throw new ApiError(response.status);
  const page = pageSchema.parse(await response.json());
  return page.status === "published" ? page : null;
});
