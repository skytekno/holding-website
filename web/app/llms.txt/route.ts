import { getPages } from "@/lib/api";
import { pagePath, siteUrl } from "@/lib/site";
export const dynamic = "force-dynamic";
function singleLine(value: string): string {
  return value.replace(/[\r\n\[\]<>]/g, " ").trim();
}
export async function GET() {
  try {
    const pages = await getPages();
    const text = [
      "# Sky Holding",
      "",
      "> The official website of Sky Holding.",
      "",
      "## Published pages",
      "",
      ...pages.map(
        (page) =>
          `- [${singleLine(page.title)}](${siteUrl()}${pagePath(page.slug)}): ${singleLine(page.description)}`,
      ),
      "",
      `Sitemap: ${siteUrl()}/sitemap.xml`,
      "",
    ].join("\n");
    return new Response(text, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return new Response("Content is temporarily unavailable.\n", {
      status: 503,
      headers: { "Retry-After": "60", "Cache-Control": "no-store" },
    });
  }
}
