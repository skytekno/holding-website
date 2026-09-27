import type { Metadata } from "next";
import type { Page } from "@/lib/api";

export function siteUrl(): string {
  return (process.env["SITE_URL"] || "https://skyhold.ing").replace(/\/$/, "");
}
export function pagePath(slug: string): string {
  return slug === "home" ? "/" : `/${encodeURIComponent(slug)}`;
}
export function pageMetadata(page: Page): Metadata {
  const url = `${siteUrl()}${pagePath(page.slug)}`;
  return {
    title: page.slug === "home" ? { absolute: page.title } : page.title,
    description: page.description,
    alternates: { canonical: url },
    openGraph: {
      title: page.title,
      description: page.description,
      url,
      type: "website",
      siteName: "Sky Holding",
    },
    twitter: {
      card: "summary",
      title: page.title,
      description: page.description,
    },
  };
}
export function safeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
}
