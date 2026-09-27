# Sky Holding API

Axum 0.8.9, Tokio, SQLx 0.9 and PostgreSQL. This service owns all publishing, authorization, persistence and file writes for `skyhold.ing` and `cms.skyhold.ing`.

## Run locally

Start PostgreSQL with the repository Compose file, then:

```sh
cd api
cp .env.example .env
cargo run --locked
```

The binary loads `.env` from the working directory (existing environment variables win), listens on `0.0.0.0:$PORT`, and applies SQLx migrations automatically **only in development**. `GET http://localhost:8080/health/ready` checks database/schema availability. The initial published `home` page contains only Sky Holding's name and a neutral welcome.

## HTTP contract

Successful responses are direct JSON objects/arrays. Domain errors return `{"error":"message"}`; malformed JSON/UUID/multipart requests can return Axum's HTTP 400/422 rejection text. No SQL or internal errors are returned to clients. All API and health responses use `Cache-Control: private, no-store`.

| Method | Endpoint | Authorization | Result |
| --- | --- | --- | --- |
| GET | `/health/live` | Public | Process health |
| GET | `/health/ready` | Public | PostgreSQL/schema health; 503 when unavailable |
| GET | `/v1/pages` | Public | Published `Page[]`, ordered by slug |
| GET | `/v1/pages/{slug}` | Public | Published page, otherwise 404 |
| GET | `/v1/admin/pages` | Admin bearer | All pages, most recently changed first |
| POST | `/v1/admin/pages` | Admin bearer | Create page; 201, 409 for duplicate slug |
| PUT | `/v1/admin/pages/{id}` | Admin bearer | Replace editable page fields |
| DELETE | `/v1/admin/pages/{id}` | Admin bearer | Delete page; 204, or 404 |
| GET | `/v1/admin/assets` | Admin bearer | Uploaded `Asset[]`, newest first |
| POST | `/v1/admin/assets` | Admin bearer | One multipart `file`; 201 |
| GET | `/assets/{key}` | Public, development local storage | Immutable asset bytes |

A `Page` has `id` (UUID), `slug`, `title`, `description`, `body` (Markdown), `status` (`draft` or `published`), `created_at`, `updated_at`, and nullable `published_at`. Timestamps are RFC 3339 UTC strings. Create/update accepts exactly `{slug,title,description,body,status}`. Slugs use lowercase letters/digits and single hyphens, up to 120 bytes; `health`, `api`, `assets`, and `v1` are reserved. Title: 1–200 characters; description: up to 320 characters; body: up to 200,000 bytes. Page JSON bodies are limited to 256 KiB. The API preserves Markdown; public rendering must disable raw HTML and unsafe links.

`home` maps to the public website root. Administrators can unpublish or delete any page, including `home`; public reads immediately return 404 afterward. Publishing assigns `published_at`; updates keep its first publication time until unpublishing resets it. Publishing is immediately visible in API reads; web/CDN caching can delay the public site by its configured cache TTL.

An `Asset` has `id`, original sanitized `filename`, immutable public `url`, detected `content_type`, `size` in bytes, and `created_at`. Uploads allow PNG/JPEG/WebP/GIF/PDF signatures only, up to 10 MiB, regardless of the client MIME type or filename. Signature validation is not malware scanning or full image decoding. SVG/HTML are rejected. Objects use generated UUID keys and correct detected extensions, with a one-year immutable cache policy. PDFs are served as attachments. Files uploaded through this CMS are public; do not upload confidential documents. GCS uses a separate asset CDN host. Local assets are a development convenience and are forbidden in production.

## Authentication

Admin routes accept `Authorization: Bearer <Google Identity Services ID token>`. Tokens must use Google's RS256 signature, issuer and configured client audience, and must not be expired. Google JWKS are cached using `Cache-Control` and refreshed for rotation; unknown key refreshes are limited to once per minute. The API checks verified email ownership (`@gmail.com`, or a Google Workspace `hd` claim) and exact membership in the case-insensitive `ADMIN_EMAILS` allowlist. An optional `azp` must also match the configured client. Consumer Google accounts using external email without Workspace are rejected because Google is not authoritative for current ownership.

The dashboard retains ID tokens in browser memory and sends them directly to the API. There are no API passwords, cookies, refresh tokens or browser token persistence. GIS tokens expire; sign in again to obtain a new token. CORS allows only the exact configured origins and the required methods/headers; it is not a substitute for authentication.

Development authentication requires both `APP_ENV=development` and a `DEV_AUTH_TOKEN` at least 32 characters long. Production defaults fail closed: development tokens are rejected at startup, Google auth plus an administrator allowlist are mandatory, GCS storage is mandatory, and CORS/asset URLs must use HTTPS.

## Configuration

| Variable | Meaning |
| --- | --- |
| `APP_ENV` | `production` (default) or explicit `development` |
| `PORT` | HTTP listen port, default `8080` |
| `DATABASE_URL` | PostgreSQL connection string; production requires exactly one `sslmode=verify-full` parameter; use Secret Manager |
| `DATABASE_MAX_CONNECTIONS` | Per-instance pool, default `5`, allowed 1–100 |
| `PGSSLROOTCERT` | Optional provider CA PEM file path; mount the CA for both API and migration job when the provider uses a private CA |
| `CORS_ORIGINS` | Required comma-separated exact browser origins, no trailing slash; production HTTPS |
| `GOOGLE_CLIENT_ID` | GIS OAuth web application client ID, identical to dashboard setting |
| `ADMIN_EMAILS` | Comma-separated administrator emails, checked server-side |
| `DEV_AUTH_TOKEN` | Development only, optional if Google auth is configured |
| `STORAGE_BACKEND` | `gcs` (default) or `local` (development only) |
| `GCS_BUCKET` | Required for `gcs`; bucket name only |
| `ASSETS_BASE_URL` | Required public asset base URL, e.g. `https://assets.skyhold.ing` |
| `LOCAL_ASSET_PATH` | Local development asset directory, default `./var/assets` |
| `RUST_LOG` | Tracing filter; default API/Tower info logs |

The GCS backend uses the Cloud Run service account's metadata-server access token, caches it before expiry, and uses no service-account JSON key. Grant the runtime account object creation and deletion in this bucket; deletion compensates if a subsequent database insert fails. Objects are created with `ifGenerationMatch=0`. An interrupted process between storage upload and database persistence can leave an orphan; storage inventory can identify keys absent from the `assets` table.

## Migrations and Cloud Run

Build the image from `api/` with its committed Cargo lockfile. Runtime is a non-root Debian image, includes CA certificates and curl, listens on Cloud Run's injected `PORT`, and handles SIGTERM gracefully. Use PostgreSQL connection limits together with the Cloud Run maximum instance count.

Both service startup and migration jobs retry initial database connectivity for up to 180 seconds, allowing Direct VPC networking to become available. Retries back off from one second to a maximum ten-second pause; the deadline also bounds an in-progress attempt. Each pool connection acquisition, including ordinary API requests after startup, still has a five-second timeout. Startup logs report attempt counts, elapsed time and error categories without logging the database URL or credentials. Invalid connection-string syntax fails immediately. Configure the Cloud Run startup probe and migration job timeout to allow this startup window.

The API supports PostgreSQL hosted outside Google Cloud. In production, both service startup and `--migrate` enforce authenticated TLS with `sslmode=verify-full`, which verifies the server certificate chain and the database hostname. `require` only encrypts the connection and is rejected, along with weaker modes. Use the provider's DNS hostname that matches its certificate; raw IP endpoints require a certificate containing that IP address.

Production URLs must start with `postgres://` or `postgresql://`, include a nonempty hostname in the URL authority, contain exactly one `sslmode=verify-full` query parameter, and contain no fragment. The `ssl-mode` alias, duplicate `sslmode` parameters, and query `host`/`hostaddr` overrides are rejected to keep the verified endpoint unambiguous. Unix sockets, including sockets supplied through an encoded hostname or PostgreSQL environment variables, are rejected. Other supported SQLx URL parameters remain available. URL parameter names and values are evaluated after percent decoding. Invalid production settings fail before connection attempts or retries. Explicit `APP_ENV=development` retains the existing local PostgreSQL behavior.

The SQLx Rustls backend uses its bundled WebPKI trust roots; the image's operating-system CA package does not change SQLx's PostgreSQL trust store. For a provider-specific CA, mount its PEM bundle read-only at `/var/run/secrets/postgres/ca.pem` and set `PGSSLROOTCERT` to that path on **both** the API service and migration job. The runtime UID `10001` must be able to read it. SQLx also accepts a file path through the `sslrootcert` URL parameter, which takes precedence over `PGSSLROOTCERT`. The custom CA augments the driver's public trust roots; it does not disable hostname checks. Keep certificate and database secret versions coordinated when promoting or rolling back a Cloud Deploy release. No database credentials or CA private keys belong in the image.

Run migrations as a Cloud Run job **before** updating the API service:

```sh
sky-holding-api --migrate
```

Migration mode requires `DATABASE_URL` and defaults to the production TLS policy when `APP_ENV` is absent. For a local non-TLS database, explicitly set `APP_ENV=development`. It uses one connection, applies embedded SQLx migrations with PostgreSQL's migration locking, closes the pool and exits. It does not require web/auth/storage config. Production service startup does not migrate. Development startup migrates automatically. New production instances report ready only once the pages schema is available. Database backup and migration rollback planning remain release responsibilities; the initial schema migration is forward-only.

## Verify

```sh
cargo fmt --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
TEST_DATABASE_URL=postgres://skyholding:sky-local-development-only@localhost:54320/skyholding \
  cargo test --locked --test postgres_http -- --ignored
```

The PostgreSQL integration test creates an isolated random schema, verifies auth, draft/public isolation, CRUD, duplicate slugs, publication timestamps, CORS, MIME detection, asset bytes/cache headers, and cleans up that schema. RSA fixtures under `tests/fixtures` are public test keys, never application credentials. Real Google login, GCS metadata credentials, external PostgreSQL TLS connectivity and CDN behavior require the deployed environment.

Sources: [Axum](https://docs.rs/axum/0.8.9/axum/), [SQLx PostgreSQL connection and TLS options](https://docs.rs/sqlx/latest/sqlx/postgres/struct.PgConnectOptions.html), [Google ID token validation](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token), [GCS multipart uploads](https://cloud.google.com/storage/docs/json_api/v1/how-tos/multipart-upload).
