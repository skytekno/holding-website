import { expect, test } from "@playwright/test";
import { ApiError, request } from "../../dashboard/lib/api";
import {
  assetSchema,
  emptyResponseSchema,
  pageSchema as adminPageSchema,
  pagesSchema as adminPagesSchema,
} from "../../dashboard/lib/types";
import { pageSchema, pagesSchema } from "../../web/lib/schema";

const publishedPage = {
  id: "93f5d411-5783-4310-8575-39e2151b9a82",
  slug: "about",
  title: "About Sky Holding",
  description: "Company introduction.",
  body: "Published content.",
  status: "published",
  created_at: "2026-09-27T00:00:00Z",
  updated_at: "2026-09-27T00:00:00+00:00",
  published_at: "2026-09-27T00:00:00.123456Z",
};

test("public and editor boundaries accept API dates and reject malformed page records", () => {
  for (const schema of [pageSchema, adminPageSchema]) {
    expect(schema.parse(publishedPage)).toEqual(publishedPage);
    expect(schema.safeParse({ ...publishedPage, status: "deleted" }).success).toBe(false);
    expect(schema.safeParse({ ...publishedPage, body: null }).success).toBe(false);
    expect(schema.safeParse({ ...publishedPage, updated_at: "not-a-date" }).success).toBe(false);
    expect(schema.safeParse({ ...publishedPage, id: null }).success).toBe(false);
  }
  for (const schema of [pagesSchema, adminPagesSchema]) {
    expect(schema.safeParse({ pages: [publishedPage] }).success).toBe(false);
    expect(schema.safeParse([publishedPage, null]).success).toBe(false);
  }
});

test("asset responses reject unsafe links and invalid sizes", () => {
  const asset = {
    id: publishedPage.id,
    filename: "illustration.png",
    url: "https://assets.skyhold.ing/illustration.png",
    content_type: "image/png",
    size: 512,
    created_at: publishedPage.created_at,
  };
  expect(assetSchema.parse(asset)).toEqual(asset);
  expect(assetSchema.safeParse({ ...asset, url: "javascript:alert(1)" }).success).toBe(false);
  expect(assetSchema.safeParse({ ...asset, size: "512" }).success).toBe(false);
  expect(assetSchema.safeParse({ ...asset, size: -1 }).success).toBe(false);
});

test("editor requests validate successful responses and empty deletes without exposing invalid payloads", async () => {
  const originalFetch = globalThis.fetch;
  const base = "https://api.example.test";
  try {
    globalThis.fetch = () => Promise.resolve(new Response(null, { status: 204 }));
    await expect(request(base, "test-token", "/page", emptyResponseSchema, { method: "DELETE" })).resolves.toBeUndefined();
    await expect(request(base, "test-token", "/page", adminPageSchema)).rejects.toBeInstanceOf(ApiError);

    globalThis.fetch = () => Promise.resolve(Response.json(publishedPage));
    await expect(request(base, "test-token", "/page", adminPageSchema)).resolves.toEqual(publishedPage);

    globalThis.fetch = () => Promise.resolve(Response.json({ ...publishedPage, title: null }));
    await expect(request(base, "test-token", "/page", adminPageSchema)).rejects.toThrow("The content API returned an invalid response.");

    globalThis.fetch = () => Promise.resolve(new Response("upstream-private-diagnostic"));
    await expect(request(base, "test-token", "/page", adminPageSchema)).rejects.toThrow("The content API returned an invalid response.");

    globalThis.fetch = () => Promise.resolve(new Response("upstream-private-diagnostic", { status: 502 }));
    await expect(request(base, "test-token", "/page", adminPageSchema)).rejects.toThrow("The request failed (502).");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
