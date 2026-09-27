import Image from "next/image";
import Link from "next/link";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Page } from "@/lib/api";
import { pagePath } from "@/lib/site";
import { Arrow } from "@/components/arrow";
import { PageSchema } from "@/components/page-schema";
import landscape from "@/public/images/sky-landscape.png";

export function HomePage({ page, pages }: { page: Page; pages: Page[] }) {
  const publishedPages = pages.filter((item) => item.slug !== "home");

  return (
    <article className="home-page">
      <PageSchema page={page} />
      <header className="home-hero">
        <div className="hero-art" aria-hidden="true">
          <Image
            src={landscape}
            alt=""
            fill
            sizes="100vw"
            preload
            className="hero-image"
          />
        </div>
        <div className="hero-copy page-shell">
          <p className="eyebrow">Welcome to</p>
          <h1>{page.title}</h1>
          {page.description && <p className="hero-description">{page.description}</p>}
          <a className="hero-link" href="#introduction">
            Discover more <Arrow />
          </a>
        </div>
        <div className="hero-caption page-shell">
          <span>Sky Holding</span>
          <a href="#introduction">Explore our website <span aria-hidden="true">↓</span></a>
        </div>
      </header>

      <section className="introduction" id="introduction" aria-labelledby="introduction-title">
        <div className="page-shell">
          <header className="section-heading">
            <p className="eyebrow">Get to know us</p>
            <h2 id="introduction-title">About Sky Holding</h2>
            <span className="section-rule" />
          </header>
          <div className="prose introduction-copy">
            <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml>{page.body}</ReactMarkdown>
          </div>
        </div>
      </section>

      {publishedPages.length > 0 && (
        <section className="explore-section" aria-labelledby="explore-title">
          <div className="page-shell">
            <header className="section-heading">
              <p className="eyebrow">Explore</p>
              <h2 id="explore-title">More from Sky Holding</h2>
              <span className="section-rule" />
            </header>
            <div className="page-grid">
              {publishedPages.map((item) => (
                <Link className="page-card" key={item.id} href={pagePath(item.slug)}>
                  <h3>{item.title}</h3>
                  {item.description && <p>{item.description}</p>}
                  <span className="card-link">Discover more <Arrow /></span>
                </Link>
              ))}
            </div>
          </div>
        </section>
      )}
    </article>
  );
}
