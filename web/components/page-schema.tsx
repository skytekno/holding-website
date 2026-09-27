import type { Page } from "@/lib/api";
import { pagePath, safeJson, siteUrl } from "@/lib/site";

export function PageSchema({ page }: { page: Page }) {
  const schema = {
    "@context": "https://schema.org",
    "@type": "WebPage",
    "@id": `${siteUrl()}${pagePath(page.slug)}`,
    name: page.title,
    description: page.description,
    dateModified: page.updated_at,
    ...(page.published_at ? { datePublished: page.published_at } : {}),
    isPartOf: { "@id": `${siteUrl()}/#website` },
  };
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: safeJson(schema) }}
    />
  );
}
