# Repository development rules

Read [CONTRIBUTING.md](CONTRIBUTING.md) and [docs/CI-CD.md](docs/CI-CD.md) before changing development or release behavior.

- Inspect the worktree first and preserve unrelated changes. Work on a short-lived `feature/`, `fix/`, `chore/` or `docs/` branch based on current `main`; use a pull request and squash merge. The initial unpublished baseline is tracked in MAN-57.
- Keep authored TypeScript strict. Both apps and test tooling inherit `tsconfig.base.json`; do not weaken compiler/lint rules, use `any`, silence errors with blanket comments or replace validation with assertions. Validate external JSON at the boundary and handle rejected promises.
- Keep content validation, authorization, publishing, database access and asset writes under `/api`. Preserve SSR public content/SEO and CSR dashboard crawler isolation.
- Run the checks relevant to the change. The full required matrix is `scripts/check.sh` with a disposable `TEST_DATABASE_URL`, Terraform available and `REQUIRE_FULL_CHECKS=true`, followed by the Compose smoke and Playwright suites. Report external or unrun gates accurately.
- Require the exact `CI required` GitHub check before merging. Preserve the PR/main job graph, immutable action/image/artifact references and migration-before-application release order.
- Application releases run through `.github/workflows/ci.yml` on current `main`. Do not bypass release guards, infer a GCP project ID or treat local validation as a successful cloud deployment.
- Initialize Terraform with `-lockfile=readonly`; do not hand-edit provider hashes. Infrastructure changes and application delivery have separate ownership as documented in `infra/README.md`.
