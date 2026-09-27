CREATE TABLE pages (
    id UUID PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug) <= 120),
    title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
    description TEXT NOT NULL CHECK (length(description) <= 320),
    body TEXT NOT NULL CHECK (octet_length(body) <= 200000),
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    published_at TIMESTAMPTZ,
    CHECK ((status = 'published') = (published_at IS NOT NULL))
);
CREATE INDEX pages_published_slug_idx ON pages(slug) WHERE status = 'published';
CREATE TABLE assets (
    id UUID PRIMARY KEY,
    filename TEXT NOT NULL,
    storage_key TEXT NOT NULL UNIQUE,
    url TEXT NOT NULL,
    content_type TEXT NOT NULL,
    size BIGINT NOT NULL CHECK (size > 0 AND size <= 10485760),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO pages (id, slug, title, description, body, status, published_at)
VALUES ('3a053343-fcd0-4573-93c8-157b95b53348', 'home', 'Sky Holding',
        'Official website of Sky Holding.', 'Welcome to the official website of Sky Holding.', 'published', now());
