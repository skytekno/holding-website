import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { pageSchema, pagesSchema } from "../../dashboard/lib/types";

const api = process.env["TEST_API_URL"] || "http://localhost:8080";
const web = process.env["TEST_WEB_URL"] || "http://localhost:3000";
const cms = process.env["TEST_CMS_URL"] || "http://localhost:3001";
const token = process.env["DEV_AUTH_TOKEN"] || "sky-holding-local-development-token-2026-only";

test("published content and SEO are readable without JavaScript", async ({ browser, request }) => {
  const slug = `browser-${randomUUID().slice(0, 8)}`;
  const response = await request.post(`${api}/v1/admin/pages`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { slug, title: "Browser verification", description: "A public page from the CMS.",
      body: "## Readable content\n\nWorks without client JavaScript.\n\n<script>alert('unsafe')</script>", status: "published" },
  });
  expect(response.status()).toBe(201);
  const record = pageSchema.parse(await response.json());
  const context = await browser.newContext({ javaScriptEnabled: false });
  try {
    const page = await context.newPage();
    await page.goto(`${web}/${slug}`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Browser verification");
    await expect(page.getByRole("heading", { name: "Readable content" })).toBeVisible();
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", `${web}/${slug}`);
    await expect(page.locator('meta[name="description"]')).toHaveAttribute("content", "A public page from the CMS.");
    await expect(page.locator('script[type="application/ld+json"]')).toHaveCount(2);
    await expect(page.locator(".prose script")).toHaveCount(0);
    await page.setViewportSize({ width: 375, height: 812 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  } finally {
    await context.close();
    const deleted = await request.delete(`${api}/v1/admin/pages/${record.id}`, { headers: { Authorization: `Bearer ${token}` } });
    expect(deleted.status()).toBe(204);
  }
});

test("dashboard shell excludes CMS records and disallows indexing", async ({ browser, request }) => {
  const response = await request.get(cms);
  const html = await response.text();
  expect(html).toContain("noindex");
  expect(html).not.toContain("Welcome to the official website of Sky Holding.");
  const context = await browser.newContext({ javaScriptEnabled: false });
  try {
    const page = await context.newPage();
    await page.goto(cms);
    await expect(page.getByRole("textbox")).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("an administrator can draft, publish, unpublish and delete a page", async ({ page, request }) => {
  const slug = `editor-${randomUUID().slice(0, 8)}`;
  const title = `Editor test ${slug}`;
  let id: string | undefined;
  try {
    await page.goto(cms);
    await page.getByLabel("Development API token").fill(token);
    await page.getByRole("button", { name: "Open studio" }).click();
    await page.getByRole("button", { name: "New page" }).click();
    await page.getByLabel("Page title").fill(title);
    await page.getByLabel("Page address").fill(slug);
    await page.getByLabel("Search description").fill("Verified through the CMS interface.");
    await page.getByLabel("Page content").fill("## Editor-created content\n\nControlled by the API.");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText("Draft saved. This page is not public.")).toBeVisible();
    const records = await request.get(`${api}/v1/admin/pages`, { headers: { Authorization: `Bearer ${token}` } });
    id = pagesSchema.parse(await records.json()).find((record) => record.slug === slug)?.id;
    expect(id).toBeTruthy();
    expect((await request.get(`${api}/v1/pages/${slug}`)).status()).toBe(404);
    await page.getByRole("button", { name: "Publish", exact: true }).click();
    await expect(page.getByRole("button", { name: "Unpublish", exact: true })).toBeVisible();
    expect((await request.get(`${web}/${slug}`)).status()).toBe(200);
    await page.getByRole("button", { name: "Unpublish", exact: true }).click();
    await expect(page.getByRole("button", { name: "Publish", exact: true })).toBeVisible();
    expect((await request.get(`${api}/v1/pages/${slug}`)).status()).toBe(404);
    page.once("dialog", dialog => dialog.accept());
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(page.getByText("Page deleted.")).toBeVisible();
    expect(await page.evaluate(() => Object.keys(localStorage).length)).toBe(0);
    expect(await page.evaluate(() => Object.keys(sessionStorage).length)).toBe(0);
  } finally {
    if (id) await request.delete(`${api}/v1/admin/pages/${id}`, { headers: { Authorization: `Bearer ${token}` } });
  }
});
