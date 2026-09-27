#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ "${REQUIRE_FULL_CHECKS:-${CI:-false}}" == true ]]; then
  : "${TEST_DATABASE_URL:?Full checks require a disposable PostgreSQL database}"
  command -v terraform >/dev/null || { echo 'Full checks require Terraform.' >&2; exit 1; }
fi
python3 -m unittest discover -s tests -p 'test_*.py' -v
for script in scripts/*.sh; do bash -n "$script"; done
cargo fmt --manifest-path api/Cargo.toml --check
cargo clippy --manifest-path api/Cargo.toml --all-targets --locked -- -D warnings
cargo test --manifest-path api/Cargo.toml --locked
if [[ -n "${TEST_DATABASE_URL:-}" ]]; then
  cargo test --manifest-path api/Cargo.toml --locked --test postgres_http -- --ignored
else
  echo "PostgreSQL API integration test not run: set TEST_DATABASE_URL to a disposable PostgreSQL database." >&2
fi
npm run lint
npm run typecheck
npm run build
docker compose config --quiet
if command -v terraform >/dev/null 2>&1; then
  terraform fmt -check -recursive infra
  for module in bootstrap migrations application; do
    terraform -chdir="infra/$module" init -backend=false -lockfile=readonly -input=false
    terraform -chdir="infra/$module" validate
  done
else
  echo "Terraform checks not run: terraform is not installed." >&2
fi
