import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { pageSchema } from "../../web/lib/schema";
import type { Page, PageInput } from "../../dashboard/lib/types";

const api = process.env["TEST_API_URL"] || "http://localhost:8080";
const web = process.env["TEST_WEB_URL"] || "http://localhost:3000";
const token = process.env["DEV_AUTH_TOKEN"] || "sky-holding-local-development-token-2026-only";
const responsiveWidths = [1440, 1024, 768, 375, 320];

test("homepage keeps CMS content readable across responsive layouts without JavaScript", async ({ browser, request }, testInfo) => {
  const response = await request.get(`${api}/v1/pages/home`);
  expect(response.ok()).toBeTruthy();
  const home = pageSchema.parse(await response.json());
  const context = await browser.newContext({ javaScriptEnabled: false });
  try {
    const page = await context.newPage();
    for (const width of responsiveWidths) {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(web);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(home.title);
      await expect(page.locator(".hero-description")).toHaveText(home.description);
      await expect(page.locator(".introduction-copy")).toBeVisible();
      await expect(page.locator('script[type="application/ld+json"]')).toHaveCount(2);
      await expect(page.locator(".hero-image")).toHaveJSProperty("complete", true);
      expect(await page.locator(".hero-image").evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
      await page.screenshot({ path: testInfo.outputPath(`homepage-${width}.png`), fullPage: true });
    }
    const menu = page.locator(".navigation-disclosure");
    await menu.locator("summary").press("Enter");
    await expect(menu).toHaveAttribute("open", "");
    await expect(menu.getByRole("navigation")).toBeVisible();
  } finally {
    await context.close();
  }
});

test("published page cards and navigation handle long titles without exposing draft content", async ({ browser, request }, testInfo) => {
  const suffix = randomUUID().slice(0, 8);
  const records: Page[] = [];
  const headers = { Authorization: `Bearer ${token}` };
  const context = await browser.newContext({ javaScriptEnabled: false });
  const longTitle = `A long published page title ${"InternationalHoldings".repeat(7)}`;
  const draftSlug = `design-draft-${suffix}`;
  const draftTitle = `Private draft ${suffix}`;

  async function createPage(input: PageInput): Promise<Page> {
    const response = await request.post(`${api}/v1/admin/pages`, { headers, data: input });
    expect(response.status()).toBe(201);
    const record = pageSchema.parse(await response.json());
    records.push(record);
    return record;
  }

  try {
    const page = await context.newPage();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(web);
    const header = page.locator(".site-header-bar");
    await expect(header).toBeVisible();
    const initialHeaderHeight = await header.evaluate((element) => getComputedStyle(element).height);

    const published: Page[] = [];
    for (let index = 0; index < 5; index += 1) {
      published.push(await createPage({
        slug: `design-public-${suffix}-${index}`,
        title: index === 0 ? longTitle : `Published design page ${index} ${suffix}`,
        description: `A temporary CMS page used to verify responsive layout ${index}.`,
        body: "## Public test content\n\nThis temporary page is controlled by the API.",
        status: "published",
      }));
    }
    await createPage({
      slug: draftSlug,
      title: draftTitle,
      description: "This draft must stay out of the public website.",
      body: "Unpublished test content.",
      status: "draft",
    });

    for (const width of responsiveWidths) {
      await page.setViewportSize({ width, height: 1000 });
      const response = await page.goto(web);
      expect(response?.status()).toBe(200);
      if (width === 1440) {
        // A newly published long title must not grow the sticky header over content.
        await expect(header).toHaveCSS("height", initialHeaderHeight);
      }
      await expect(page.locator(".page-grid")).toBeVisible();
      await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
      for (const record of published) {
        const card = page.locator(".page-card").filter({
          has: page.getByRole("heading", { name: record.title, exact: true }),
        });
        await expect(card).toBeVisible();
        await expect(card).toHaveAttribute("href", `/${record.slug}`);
        await expect(card).toContainText(record.description);
      }
      await expect(page.locator(`a[href="/${draftSlug}"]`)).toHaveCount(0);
      await expect(page.getByText(draftTitle, { exact: true })).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
      await page.screenshot({ path: testInfo.outputPath(`published-pages-${width}.png`), fullPage: true });

      // Six published destinations also exercise the desktop overflow disclosure.
      const menu = page.locator(".navigation-disclosure");
      await menu.locator("summary").press("Enter");
      await expect(menu.getByRole("navigation")).toBeVisible();
      for (const record of published) {
        await expect(menu.getByRole("link", { name: record.title, exact: true })).toHaveAttribute("href", `/${record.slug}`);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
    }

    const longPage = published.find((record) => record.title === longTitle);
    if (!longPage) throw new Error("The long-title fixture was not created.");
    await page.goto(`${web}/${longPage.slug}`);
    await expect(page.getByRole("heading", { name: longTitle, exact: true, level: 1 })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Public test content", exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
    expect((await request.get(`${api}/v1/pages/${draftSlug}`)).status()).toBe(404);
  } finally {
    try {
      await context.close();
    } finally {
      const deletions = await Promise.allSettled(records.map(async (record) => {
        const response = await request.delete(`${api}/v1/admin/pages/${record.id}`, { headers });
        expect(response.status(), `Clean up ${record.slug}`).toBe(204);
      }));
      for (const deletion of deletions) {
        if (deletion.status === "rejected") throw deletion.reason;
      }
    }
  }
});

test("mobile navigation closes with Escape and after a destination is selected", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(web);
  const menu = page.locator(".navigation-disclosure");
  const toggle = menu.locator("summary");
  await toggle.click();
  await expect(menu.getByRole("navigation")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).not.toHaveAttribute("open", "");
  await expect(toggle).toBeFocused();
  await toggle.click();
  await menu.getByRole("link", { name: "Home", exact: true }).click();
  await expect(menu).not.toHaveAttribute("open", "");
});
