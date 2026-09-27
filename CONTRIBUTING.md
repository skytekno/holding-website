# Development workflow

Use GitHub Flow: start a short-lived branch from current `main`, open a pull request, validate/review it, squash merge, then delete the branch. `main` is the deployable branch. Feature work, fixes and urgent corrections all use the same pull-request path.

```sh
git switch main
git pull --ff-only origin main
git switch -c feature/man-64-homepage
npm ci
# Implement and validate, then commit the intended files.
git push -u origin HEAD
gh pr create --base main
```

Use descriptive `feature/`, `fix/`, `chore/` or `docs/` branch names, preferably with the Linear identifier. Keep pull requests small and use a clear squash-commit title such as `feat(web): add approved homepage`. Open a draft PR early when collaboration is useful. Resolve review threads and update the branch with current `main` before merging. CI validates the final result again on `main` before release.

The project owner is Rohman (`rohman@skyhold.ing`). The checked-in ruleset requires a PR and green checks but has zero mandatory peer approvals while only one owner is assigned; GitHub does not allow authors to approve their own PRs. The owner still reviews the diff, validation and release impact before merging. Once a second maintainer is available, set `required_approving_review_count` to 1 and `require_last_push_approval` to true. Do not invent a CODEOWNERS username from an email address.

## TypeScript rules

Both Next.js apps and the Playwright TypeScript tooling use the shared strict configuration. Keep strict null checks, unchecked-index checks and exact optional properties enabled. Source files are TypeScript; JavaScript config files are limited to build/lint tooling.

Treat external JSON as `unknown` and validate it before use. Handle absent values explicitly. Avoid `any`, non-null assertions, unsafe assertions and unhandled promises. Fix type errors at their source instead of disabling compiler/lint rules or adding blanket suppression comments. Use `import type` for type-only dependencies. Next.js generated declarations and dependency declarations are outside authored-code linting.

```sh
npm run lint
npm run typecheck
npm run build
# Complete native validation, using the disposable local database:
TEST_DATABASE_URL=postgres://skyholding:sky-local-development-only@localhost:54320/skyholding bash scripts/check.sh
# Runtime checks after building the complete local stack:
docker compose up --build -d --wait --wait-timeout 120
python3 scripts/smoke.py
npm run test:e2e
```

Use `npm ci` and committed lockfiles. Include focused tests for changed behavior and run the relevant existing checks. Update UI screenshots for visible changes. Keep secrets, generated output and Terraform state out of commits. Public RSA fixtures under `api/tests/fixtures` are documented test keys.

## Repository policy and release

The `CI required` check gates merges. It succeeds only after native validation and container/browser integration pass. The ruleset also requires current-base validation, resolved review conversations and linear history, and blocks force-pushing/deleting `main`. Squash merging and automatic branch deletion are the repository defaults.

See [CI/CD](docs/CI-CD.md) for the exact job graph, GitHub policy activation, release gates and rollback. See [cloud setup](infra/README.md) for GCP and external PostgreSQL configuration. Feature branches and PRs validate without deployment credentials; successful current-`main` runs release through Cloud Deploy when cloud activation is complete.
