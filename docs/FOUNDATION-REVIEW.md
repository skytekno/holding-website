# Foundation review — MAN-57

The application baseline was reviewed and published on 27 September 2026 at commit `36aca8d59ee2dff596c732bb33589810b1fd584f`, on `chore/man-57-foundation`. The empty bootstrap commit `9869bf726b7daf2d7cd0995c2e2c548b75e5aec3` establishes `main` as the pull-request base. No application code has been merged into `main` or deployed.

[Review the foundation diff](https://github.com/skytekno/holding-website/compare/main...chore/man-57-foundation) · [MAN-57](https://linear.app/skyholding/issue/MAN-57/review-commit-and-publish-the-existing-cms-foundation) · [MAN-58](https://linear.app/skyholding/issue/MAN-58/verify-hosted-ci-and-enforce-successful-merge-checks)

## Review scope

Separate source reviews covered the API, public website, dashboard, tests, delivery scripts and infrastructure. No new material blocker was found for opening the initial draft PR. The initial 116 tracked files include lockfiles and the documented public RSA test fixtures. Local secrets, dependency/build directories, Terraform state, runtime assets and validation logs are excluded by `.gitignore`.

The Sinar Mas-inspired public design retains API-owned company content and server rendering. The current homepage is neutral seed content; real company content and media still require owner approval.

## Validation evidence

| Check | Result |
| --- | --- |
| Full `scripts/check.sh` with `REQUIRE_FULL_CHECKS=true`, disposable PostgreSQL and Terraform 1.16.4 | Passed |
| Python release/repository-policy tests | 22 passed |
| Rust formatting, Clippy, unit tests and PostgreSQL HTTP integration | Passed; 21 unit tests and 1 database integration test |
| Strict TypeScript, type-aware lint and both Next.js production builds | Passed |
| All three Terraform roots, including readonly lockfile initialization | Passed |
| Complete Compose build and service health checks | Passed |
| HTTP smoke suite | Passed |
| Playwright browser/contract suite | 9 passed |
| Actionlint and shell syntax | Passed |
| Cargo audit and npm production dependency audit | No known vulnerabilities reported |
| Separate clean clone: `npm ci`, lint, type checks, both production builds | Passed; resulting worktree clean |

Local diagnostic logs are retained under ignored `.artifacts/man-57/`. Audit results describe the dependency database available on the review date and should be refreshed for a release commit. They are not evidence of a hosted deployment.

## Outstanding gates

- Open the draft PR and obtain a passing hosted `CI required` check. PR creation returned `Resource not accessible by integration` from the connected GitHub API. The CLI account is not a collaborator. SSH publication succeeded, but it does not confer API permission to create the PR. No workflow run has occurred yet.
- Activate and verify the checked-in GitHub merge rules before normal merges. API administration access needs an appropriately authorized integration or CLI identity.
- Fix the known unsaved editor-content loss on session expiry in MAN-65 before production acceptance. Global identity and navigation controls remain in MAN-62 and MAN-63.
- Complete approved content, real Google sign-in, external PostgreSQL TLS, GCS/CDN and hosted acceptance. GCP project setup remains deferred by the owner.

The foundation branch remains available for review and follow-up commits. Do not treat its publication as approval to merge or launch.
