import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Page } from "@/lib/api";
import Link from "next/link";
import { PageSchema } from "@/components/page-schema";

export function ContentPage({ page }: { page: Page }) {
  return (
    <article className="content-page page-shell">
      <PageSchema page={page} />
      <header className="page-heading">
        <p className="eyebrow">
          <Link href="/">Sky Holding</Link> <span aria-hidden="true">/</span>{" "}{page.title}
        </p>
        <h1>{page.title}</h1>
        {page.description && (
          <p className="page-description">{page.description}</p>
        )}
        <div className="heading-rule" aria-hidden="true">
          <span />
        </div>
      </header>
      <div className="prose">
        <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml>
          {page.body}
        </ReactMarkdown>
      </div>
    </article>
  );
}
