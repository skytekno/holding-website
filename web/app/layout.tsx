import type { Metadata } from "next";
import Link from "next/link";
import { getPages } from "@/lib/api";
import { pagePath, safeJson, siteUrl } from "@/lib/site";
import { SiteNavigation } from "@/components/site-navigation";
import { Arrow } from "@/components/arrow";
import "./globals.css";

export const dynamic = "force-dynamic";
export function generateMetadata(): Metadata {
  return {
    metadataBase: new URL(siteUrl()),
    title: { default: "Sky Holding", template: "%s | Sky Holding" },
    description: "The official website of Sky Holding.",
    robots: { index: true, follow: true },
  };
}

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  // Navigation failure must not turn every page into a false 404.
  let navigation: Awaited<ReturnType<typeof getPages>> = [];
  try {
    navigation = await getPages();
  } catch {
    /* Page rendering reports upstream errors. */
  }
  const navigationItems = navigation.map((page) => ({
    href: pagePath(page.slug),
    label: page.slug === "home" ? "Home" : page.title,
  }));
  if (navigation.length === 1 && navigation[0]?.slug === "home") {
    navigationItems.push({ href: "/#introduction", label: "About us" });
  }
  const schema = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "@id": `${siteUrl()}/#organization`,
        name: "Sky Holding",
        url: siteUrl(),
      },
      {
        "@type": "WebSite",
        "@id": `${siteUrl()}/#website`,
        name: "Sky Holding",
        url: siteUrl(),
        publisher: { "@id": `${siteUrl()}/#organization` },
      },
    ],
  };
  return (
    <html lang="en">
      <body>
        <a className="skip-link" href="#main-content">
          Skip to content
        </a>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: safeJson(schema) }}
        />
        <div className="site-header-bar">
          <header className="site-header page-shell">
            <Link className="wordmark" href="/" aria-label="Sky Holding home">
              <span className="brand-symbol" aria-hidden="true"><i /><i /><i /></span>
              <span className="wordmark-text">sky<span>HOLDING</span></span>
            </Link>
            <div className="header-navigation">
              <SiteNavigation items={navigationItems.length ? navigationItems : [{ href: "/", label: "Home" }]} />
            </div>
          </header>
        </div>
        <main id="main-content">{children}</main>
        <footer className="site-footer">
          <div className="page-shell">
            <div className="footer-top">
              <div className="footer-identity">
                <Link className="footer-brand" href="/">Sky Holding<span><Arrow diagonal /></span></Link>
                <p>Official website</p>
              </div>
              <nav aria-label="Footer navigation">
                <Link href="/">Home</Link>
                {navigation.filter((page) => page.slug !== "home").map((page) => (
                  <Link key={page.id} href={pagePath(page.slug)}>{page.title}</Link>
                ))}
              </nav>
            </div>
            <div className="footer-bottom">
              <p>© {new Date().getFullYear()} Sky Holding</p>
              <a href="#main-content">Back to top <span aria-hidden="true">↑</span></a>
            </div>
          </div>
        </footer>
      </body>
    </html>
  );
}
