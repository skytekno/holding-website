"use client";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ApiError, request } from "@/lib/api";
import type { Asset, Page, PageInput, RuntimeConfig } from "@/lib/types";
import { assetSchema, assetsSchema, emptyResponseSchema, pageSchema, pagesSchema, tokenExpirySchema } from "@/lib/types";
import { SignIn } from "./sign-in";

const emptyPage = (): PageInput => ({
  title: "",
  slug: "",
  description: "",
  body: "",
  status: "draft",
});
const toInput = (page: Page): PageInput => ({
  title: page.title,
  slug: page.slug,
  description: page.description,
  body: page.body,
  status: page.status,
});
const dateLabel = (value: string) =>
  new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
    new Date(value),
  );
const readableSize = (size: number) =>
  size < 1024 * 1024
    ? `${Math.ceil(size / 1024)} KB`
    : `${(size / (1024 * 1024)).toFixed(1)} MB`;

export default function Dashboard({ config }: { config: RuntimeConfig }) {
  const [token, setToken] = useState("");
  const [pages, setPages] = useState<Page[]>([]);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [section, setSection] = useState<"pages" | "assets">("pages");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [form, setForm] = useState<PageInput>(emptyPage);
  const [savedForm, setSavedForm] = useState<PageInput>(emptyPage);
  const [editing, setEditing] = useState(false);
  const [preview, setPreview] = useState(false);
  const [search, setSearch] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const uploadRef = useRef<HTMLInputElement>(null);
  const dirty = editing && JSON.stringify(form) !== JSON.stringify(savedForm);

  const signOut = useCallback(() => {
    setToken("");
    setPages([]);
    setAssets([]);
    setSelectedId(null);
    setEditing(false);
    setForm(emptyPage());
    setSavedForm(emptyPage());
    setNotice("");
    window.google?.accounts.id.disableAutoSelect();
  }, []);

  useEffect(() => {
    if (!dirty) return undefined;
    const preventExit = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", preventExit);
    return () => window.removeEventListener("beforeunload", preventExit);
  }, [dirty]);

  // Expiry is only a UI convenience; authorization is always enforced by the API.
  useEffect(() => {
    if (!token || config.development) return undefined;
    try {
      const segment = token.split(".")[1];
      if (!segment) return undefined;
      const payload = tokenExpirySchema.safeParse(JSON.parse(
        atob(segment.replace(/-/g, "+").replace(/_/g, "/")),
      ));
      if (!payload.success) return undefined;
      const timeout = window.setTimeout(
        () => {
          signOut();
          setError("Your session expired. Sign in again to continue.");
        },
        Math.max(0, payload.data.exp * 1000 - Date.now()),
      );
      return () => window.clearTimeout(timeout);
    } catch {
      /* The API validates the credential. */
    }
    return undefined;
  }, [token, config.development, signOut]);

  function reportError(cause: unknown) {
    if (cause instanceof ApiError && cause.status === 401) signOut();
    setError(
      cause instanceof Error
        ? cause.message
        : "Something went wrong. Please try again.",
    );
  }
  async function signIn(credential: string) {
    setPending(true);
    setError("");
    try {
      const [newPages, newAssets] = await Promise.all([
        request(config.apiUrl, credential, "/v1/admin/pages", pagesSchema),
        request(config.apiUrl, credential, "/v1/admin/assets", assetsSchema),
      ]);
      setToken(credential);
      setPages(newPages);
      setAssets(newAssets);
    } catch (cause) {
      reportError(cause);
    } finally {
      setPending(false);
    }
  }
  function allowDiscard() {
    return !dirty || window.confirm("Discard your unsaved changes?");
  }
  function selectPage(page?: Page) {
    if (!allowDiscard()) return;
    const next = page ? toInput(page) : emptyPage();
    setSelectedId(page?.id || null);
    setForm(next);
    setSavedForm(next);
    setEditing(true);
    setPreview(false);
    setNotice("");
    setError("");
  }
  function switchSection(next: "pages" | "assets") {
    if (!allowDiscard()) return;
    setSection(next);
    setEditing(false);
    setNotice("");
    setError("");
  }
  async function savePage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const submitter = event.nativeEvent instanceof SubmitEvent ? event.nativeEvent.submitter : null;
    const requestedStatus = submitter?.getAttribute("data-status");
    const payload = {
      ...form,
      ...(requestedStatus === "published" || requestedStatus === "draft"
        ? { status: requestedStatus }
        : {}),
    };
    setPending(true);
    setError("");
    setNotice("");
    try {
      const page = await request(
        config.apiUrl,
        token,
        selectedId ? `/v1/admin/pages/${selectedId}` : "/v1/admin/pages",
        pageSchema,
        { method: selectedId ? "PUT" : "POST", body: JSON.stringify(payload) },
      );
      setPages((current) => [
        page,
        ...current.filter((item) => item.id !== page.id),
      ]);
      setSelectedId(page.id);
      setForm(toInput(page));
      setSavedForm(toInput(page));
      setNotice(
        page.status === "published"
          ? "Page saved and published."
          : "Draft saved. This page is not public.",
      );
    } catch (cause) {
      reportError(cause);
    } finally {
      setPending(false);
    }
  }
  async function deletePage() {
    if (
      !selectedId ||
      !window.confirm(
        `Permanently delete “${form.title}”? This cannot be undone.`,
      )
    )
      return;
    setPending(true);
    setError("");
    setNotice("");
    try {
      await request(
        config.apiUrl,
        token,
        `/v1/admin/pages/${selectedId}`,
        emptyResponseSchema,
        { method: "DELETE" },
      );
      setPages((current) => current.filter((page) => page.id !== selectedId));
      setSelectedId(null);
      setEditing(false);
      setNotice("Page deleted.");
    } catch (cause) {
      reportError(cause);
    } finally {
      setPending(false);
    }
  }
  async function uploadAsset(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const file = uploadRef.current?.files?.[0];
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) {
      setError("Choose a file no larger than 10 MB.");
      return;
    }
    const data = new FormData();
    data.append("file", file);
    setPending(true);
    setError("");
    setNotice("");
    try {
      const asset = await request(
        config.apiUrl,
        token,
        "/v1/admin/assets",
        assetSchema,
        { method: "POST", body: data },
      );
      setAssets((current) => [asset, ...current]);
      if (uploadRef.current) uploadRef.current.value = "";
      setNotice("Asset uploaded. Copy its Markdown link to add it to a page.");
    } catch (cause) {
      reportError(cause);
    } finally {
      setPending(false);
    }
  }
  async function copyAsset(asset: Asset) {
    const label = asset.filename.replace(/[\[\]\\]/g, "");
    const markdown = `${asset.content_type.startsWith("image/") ? "!" : ""}[${label}](${asset.url.replace(/\(/g, "%28").replace(/\)/g, "%29")})`;
    try {
      await navigator.clipboard.writeText(markdown);
      setNotice("Markdown link copied.");
    } catch {
      setError(
        "Could not copy automatically. Open the asset and copy its URL.",
      );
    }
  }

  if (!token)
    return (
      <SignIn
        config={config}
        onToken={(credential) => void signIn(credential)}
        pending={pending}
        error={error}
      />
    );
  const filteredPages = pages.filter((page) =>
    `${page.title} ${page.slug}`.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <div className="studio-shell">
      <a className="skip-link" href="#studio-main">
        Skip to content
      </a>
      <aside className="sidebar">
        <a
          href={config.siteUrl}
          target="_blank"
          rel="noreferrer"
          className="brand-lockup"
        >
          <span className="brand-symbol" aria-hidden="true">
            S
          </span>
          <span>
            SKY HOLDING<small>CONTENT STUDIO</small>
          </span>
        </a>
        <p className="sidebar-caption">WORKSPACE</p>
        <nav aria-label="Studio navigation">
          <button
            aria-current={section === "pages" ? "page" : undefined}
            onClick={() => switchSection("pages")}
            disabled={pending}
          >
            <span aria-hidden="true">▤</span> Pages{" "}
            <span className="count">{pages.length}</span>
          </button>
          <button
            aria-current={section === "assets" ? "page" : undefined}
            onClick={() => switchSection("assets")}
            disabled={pending}
          >
            <span aria-hidden="true">▧</span> Media library{" "}
            <span className="count">{assets.length}</span>
          </button>
        </nav>
        <div className="sidebar-bottom">
          <a href={config.siteUrl} target="_blank" rel="noreferrer">
            Visit website <span aria-hidden="true">↗</span>
          </a>
          <button
            onClick={() => {
              if (allowDiscard()) {
                setError("");
                signOut();
              }
            }}
            disabled={pending}
          >
            Sign out <span aria-hidden="true">↗</span>
          </button>
        </div>
      </aside>
      <main id="studio-main" className="studio-main">
        <header className="studio-header">
          <div>
            <p className="eyebrow">Sky Holding / Website</p>
            <h1>{section === "pages" ? "Pages" : "Media library"}</h1>
          </div>
          {section === "pages" && (
            <button
              className="button primary"
              disabled={pending}
              onClick={() => selectPage()}
            >
              <span aria-hidden="true">+</span> New page
            </button>
          )}
        </header>
        <div aria-live="polite" aria-atomic="true">
          {notice && <p className="notice success">{notice}</p>}
        </div>
        {error && (
          <p className="notice error" role="alert">
            {error}
          </p>
        )}
        {section === "pages" ? (
          <div
            className={
              editing ? "page-workspace with-editor" : "page-workspace"
            }
          >
            <section className="page-list" aria-label="Website pages">
              <div className="list-heading">
                <label className="sr-only" htmlFor="page-search">
                  Search pages
                </label>
                <input
                  id="page-search"
                  type="search"
                  placeholder="Search pages…"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
                <p>
                  {pages.filter((page) => page.status === "published").length}{" "}
                  published ·{" "}
                  {pages.filter((page) => page.status === "draft").length}{" "}
                  drafts
                </p>
              </div>
              {filteredPages.length ? (
                <ul>
                  {filteredPages.map((page) => (
                    <li key={page.id}>
                      <button
                        disabled={pending}
                        className={
                          page.id === selectedId && editing
                            ? "page-row selected"
                            : "page-row"
                        }
                        onClick={() => selectPage(page)}
                      >
                        <span className="page-row-title">
                          {page.title}
                          <small>
                            /{page.slug === "home" ? "" : page.slug}
                          </small>
                        </span>
                        <span className="page-row-meta">
                          <span className={`status ${page.status}`}>
                            {page.status}
                          </span>
                          <small>{dateLabel(page.updated_at)}</small>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="empty-state">
                  <span aria-hidden="true">▤</span>
                  <h2>
                    {search ? "No matching pages" : "Your website starts here."}
                  </h2>
                  <p>
                    {search
                      ? "Try another title or page address."
                      : "Create your first page. Use the address “home” for the website homepage."}
                  </p>
                </div>
              )}
            </section>
            {editing && (
              <section className="editor" aria-label="Page editor">
                <form onSubmit={(event) => void savePage(event)}>
                  <div className="editor-heading">
                    <h2>{selectedId ? "Edit page" : "Create a page"}</h2>
                    <span className={`status ${form.status}`}>
                      {form.status}
                    </span>
                  </div>
                  <fieldset disabled={pending}>
                    <label htmlFor="page-title">Page title</label>
                    <input
                      id="page-title"
                      required
                      maxLength={200}
                      value={form.title}
                      onChange={(event) =>
                        setForm({ ...form, title: event.target.value })
                      }
                      placeholder="A clear, descriptive title"
                    />
                    <label htmlFor="page-slug">Page address</label>
                    <div className="slug-field">
                      <span>/</span>
                      <input
                        id="page-slug"
                        required
                        pattern="[a-z0-9]+(-[a-z0-9]+)*"
                        maxLength={120}
                        value={form.slug}
                        onChange={(event) =>
                          setForm({ ...form, slug: event.target.value })
                        }
                        placeholder="about-us"
                        aria-describedby="slug-help"
                      />
                    </div>
                    <p className="field-help" id="slug-help">
                      Lowercase letters, numbers and hyphens. Use “home” for the
                      homepage.
                    </p>
                    <label htmlFor="page-description">Search description</label>
                    <textarea
                      id="page-description"
                      rows={3}
                      maxLength={320}
                      value={form.description}
                      onChange={(event) =>
                        setForm({ ...form, description: event.target.value })
                      }
                      placeholder="A concise summary for search results and link previews."
                    />
                    <p className="field-help">
                      {form.description.length}/320 characters
                    </p>
                    <div className="body-heading">
                      <label htmlFor="page-body">Page content</label>
                      <div className="segmented">
                        <button
                          type="button"
                          aria-pressed={!preview}
                          onClick={() => setPreview(false)}
                        >
                          Write
                        </button>
                        <button
                          type="button"
                          aria-pressed={preview}
                          onClick={() => setPreview(true)}
                        >
                          Preview
                        </button>
                      </div>
                    </div>
                    {preview ? (
                      <div className="markdown-preview">
                        <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml>
                          {form.body || "Nothing to preview yet."}
                        </ReactMarkdown>
                      </div>
                    ) : (
                      <textarea
                        id="page-body"
                        className="body-input"
                        rows={16}
                        value={form.body}
                        onChange={(event) =>
                          setForm({ ...form, body: event.target.value })
                        }
                        placeholder="Write with Markdown: headings, paragraphs, links and images."
                      />
                    )}
                    <p className="field-help">
                      Markdown supported. Copy asset links from the media
                      library. HTML is not rendered.
                    </p>
                    <label htmlFor="page-status">Visibility</label>
                    <select
                      id="page-status"
                      value={form.status}
                      onChange={(event) => {
                        const status = event.target.value;
                        if (status === "draft" || status === "published") {
                          setForm({ ...form, status });
                        }
                      }}
                    >
                      <option value="draft">
                        Draft — only visible in the studio
                      </option>
                      <option value="published">
                        Published — visible on the website
                      </option>
                    </select>
                    <div className="editor-actions">
                      <button className="button primary" type="submit">
                        {pending ? "Saving…" : "Save changes"}
                      </button>
                      {form.status === "draft" ? (
                        <button
                          className="button secondary"
                          type="submit"
                          data-status="published"
                        >
                          Publish
                        </button>
                      ) : (
                        <button
                          className="button secondary"
                          type="submit"
                          data-status="draft"
                        >
                          Unpublish
                        </button>
                      )}
                      {selectedId && (
                        <button
                          type="button"
                          className="button danger"
                          onClick={() => void deletePage()}
                        >
                          Delete
                        </button>
                      )}
                    </div>
                    {selectedId && form.status === "published" && (
                      <a
                        className="view-page"
                        href={`${config.siteUrl.replace(/\/$/, "")}/${form.slug === "home" ? "" : encodeURIComponent(form.slug)}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        View published page ↗
                      </a>
                    )}
                  </fieldset>
                </form>
              </section>
            )}
          </div>
        ) : (
          <section className="media-workspace">
            <form onSubmit={(event) => void uploadAsset(event)} className="upload-panel">
              <div>
                <h2>Add to your library</h2>
                <p>PNG, JPEG, GIF, WebP or PDF, up to 10 MB.</p>
                <p>
                  Files in this library are public, including uploads for draft
                  pages.
                </p>
              </div>
              <div className="upload-controls">
                <label className="sr-only" htmlFor="asset-file">
                  Choose a file
                </label>
                <input
                  ref={uploadRef}
                  id="asset-file"
                  type="file"
                  accept="image/png,image/jpeg,image/gif,image/webp,application/pdf"
                  required
                  disabled={pending}
                />
                <button
                  className="button primary"
                  disabled={pending}
                  type="submit"
                >
                  {pending ? "Uploading…" : "Upload file"}
                </button>
              </div>
            </form>
            {assets.length ? (
              <ul className="asset-list">
                {assets.map((asset) => (
                  <li key={asset.id} className="asset-card">
                    <div className="asset-icon" aria-hidden="true">
                      {asset.content_type.startsWith("image/") ? "▧" : "▤"}
                    </div>
                    <div className="asset-detail">
                      <a href={asset.url} target="_blank" rel="noreferrer">
                        {asset.filename} ↗
                      </a>
                      <p>
                        {asset.content_type} · {readableSize(asset.size)} ·{" "}
                        {dateLabel(asset.created_at)}
                      </p>
                    </div>
                    <button
                      className="button secondary"
                      onClick={() => void copyAsset(asset)}
                    >
                      Copy Markdown
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="empty-state">
                <span aria-hidden="true">▧</span>
                <h2>Make room for your story.</h2>
                <p>Your uploaded images and documents will appear here.</p>
              </div>
            )}
          </section>
        )}
        <footer className="studio-footer">
          <span>Sky Holding · Content studio</span>
          <span>
            {pending
              ? "Working…"
              : dirty
                ? "Unsaved changes"
                : "All changes saved"}
          </span>
        </footer>
      </main>
    </div>
  );
}
