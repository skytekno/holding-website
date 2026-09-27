# Sky Holding website and CMS

An API-owned CMS for Sky Holding, with three independently deployable applications.

| Directory | Production host | Responsibility |
| --- | --- | --- |
| `api/` | `api.skyhold.ing` | Rust Axum + Tokio; authentication, validation, PostgreSQL, publishing and file uploads |
| `web/` | `skyhold.ing` | Next.js App Router; server-rendered published content and search metadata |
| `dashboard/` | `cms.skyhold.ing` | Next.js client-rendered CMS; Google sign-in, page editor and asset library |
| `infra/` | Google Cloud | Cloud Run, Cloud Deploy, Cloud Storage, Secret Manager, HTTPS load balancer and Cloud CDN |

`assets.skyhold.ing` serves public assets from Cloud Storage through Cloud CDN. Only the API has database credentials or permission to write assets. The frontends never connect to PostgreSQL or upload to the bucket directly.

```mermaid
flowchart LR
  Reader[Visitors and crawlers] --> LB[Google HTTPS load balancer]
  Editor[CMS administrators] --> LB
  LB --> Web[skyhold.ing · Next.js SSR]
  LB --> CMS[cms.skyhold.ing · Next.js CSR]
  LB --> API[api.skyhold.ing · Axum]
  Web --> API
  CMS --> API
  API --> DB[(External cloud · PostgreSQL over verified TLS)]
  API --> Bucket[(Cloud Storage · public assets)]
  LB --> CDN[Cloud CDN]
  CDN --> Bucket
  CDN --> Static[Next.js hashed static files]
```

## Run locally

Requirements: Docker with Compose. Native development also needs Rust 1.95+, Node.js 24 LTS and npm 11.

```sh
cp .env.example .env
docker compose up --build -d
docker compose logs -f api
```

Open [the website](http://localhost:3000) and [the CMS](http://localhost:3001). Enter the local `DEV_AUTH_TOKEN` from `.env` into the dashboard's development sign-in form. The checked-in default is a local-only credential; production disables development authentication. Ports bind only to loopback.

PostgreSQL is on `localhost:54320`. Uploaded files and database data survive restarts in named volumes. `docker compose down` stops the services while preserving data.

The migration seeds one published `home` page with the Sky Holding name and a short official-site description. Add verified company content in the CMS. There are no invented subsidiaries, performance claims, addresses or biographies.

## Develop and validate

Follow [GitHub Flow](CONTRIBUTING.md): short-lived branches, pull requests to protected `main`, required CI checks and squash merges. Both frontends and TypeScript test tooling use shared strict compiler settings and type-aware linting. [CI/CD](docs/CI-CD.md) defines the validation/release jobs and repository-policy activation.

```sh
npm ci
docker compose up -d postgres
# In separate terminals, after copying each application's .env.example:
cd api && cargo run
# From the repository root:
npm run dev --workspace web
npm run dev --workspace dashboard
```

Next.js reads each application's `.env.local`; the API reads `api/.env`. Use the connection string and port defaults in those examples. Root `.env` is for Compose interpolation only.

```sh
TEST_DATABASE_URL=postgres://skyholding:sky-local-development-only@localhost:54320/skyholding bash scripts/check.sh
# With the complete stack running:
python3 scripts/smoke.py
npx playwright install chromium
npm run test:e2e
```

The HTTP smoke test creates a temporary page, verifies draft isolation, publishes it, checks rendered HTML/metadata/sitemap, unpublishes it, and deletes it. It also verifies authorization, CORS and a real upload. A one-pixel public test asset remains in the local asset volume.

Browser tests verify readable content with JavaScript disabled, a client-only CMS shell, and the editor's complete draft/publish/unpublish/delete flow. Set `DEV_AUTH_TOKEN` in your shell when testing with a custom local token. CI runs static checks and the Compose integration tests separately.

## Rendering, SEO and AI discovery

The public website renders API content on the server. Titles, descriptions, canonical URLs, Open Graph metadata, semantic Markdown, JSON-LD, `robots.txt` and `sitemap.xml` make published information accessible to crawlers without executing JavaScript. `/llms.txt` is a supplemental index of published pages, not a search ranking mechanism or a guarantee of AI inclusion. Accurate, substantive corporate content and external discovery still matter.

The dashboard renders its CMS application in the browser. Its shell contains no CMS records. It sends bearer tokens directly to the API and has both `noindex` metadata and a disallowing robots policy. Those crawler controls do not replace API authentication.

Public HTML and API data use fresh reads. Google Cloud CDN caches hashed `/_next/static/*` resources and immutable file assets. HTML and React Server Component responses bypass CDN caching, avoiding variants being mixed by the CDN and making publishing visible on the next request without per-instance cache invalidation. If full-page caching is added later, introduce a tested HTML/RSC cache-key strategy and an API-owned invalidation workflow first.

## Authentication and assets

Production uses Google Identity Services. The API verifies token signatures, issuer, audience, expiry and verified email, then checks the administrator allowlist. Tokens stay in dashboard memory and disappear on reload/sign-out; an expired token requires signing in again. Production startup rejects development credentials and local asset storage.

All uploads are **public website assets**, including uploads made while editing a draft. This library is not for confidential documents. The API checks size/type, assigns immutable filenames, stores metadata in PostgreSQL and writes to Cloud Storage using its Cloud Run service account. The bucket is publicly readable for unsigned CDN delivery; writes remain private to the API. If an organization forbids public buckets, use a separate private-asset design with signed delivery URLs before deployment.

This foundation supplies a single administrator role and page-level draft/publish controls. Editorial approval chains, version history, scheduled publishing and private-document storage are future extensions.

## Deploy

See [infra/README.md](infra/README.md) for GitHub CI, Cloud Build, migration-gated Cloud Deploy releases, external PostgreSQL, Google sign-in and DNS setup. GCP project activation is deferred until the project is supplied; validation runs now, and release jobs activate when the repository project variable is configured. Terraform requires an existing billed Google Cloud project. Runtime secrets are stored in Secret Manager. No cloud resources are created by cloning or building this repository.

The deployment accepts your project ID, region, Google OAuth client ID and administrator emails. Domain DNS must point to the generated load-balancer IP, and managed TLS certificates must become active before the domains can serve traffic. PostgreSQL is provisioned separately in another cloud, using a public endpoint with certificate verification. API/migration traffic uses a fixed NAT IP for provider allowlisting. NAT, load balancing and the external database have costs even when Cloud Run scales to zero.

## Stack decisions and references

- Axum 0.8.9 provides the HTTP layer on Tokio/Tower; SQLx provides PostgreSQL access. This is a performance-oriented, established Rust ecosystem, not an unmeasured claim of being the fastest framework for every workload. [Axum documentation](https://docs.rs/axum/latest/axum/)
- Next.js 16.3.6 and React 19.3.0 were the stable npm versions checked when this foundation was created. Exact dependencies are pinned in lockfiles. [Next.js releases](https://nextjs.org/blog)
- The CDN uses Google's supported external Application Load Balancer and serverless NEG arrangement. [Cloud Run and Cloud CDN](https://docs.cloud.google.com/cdn/docs/setting-up-cdn-with-serverless), [Next.js CDN caching](https://nextjs.org/docs/app/guides/cdn-caching)
- Search and AI discovery share core SEO requirements; structured data must match visible content. [Google AI search guidance](https://developers.google.com/search/docs/appearance/ai-features)
