#!/usr/bin/env bash
# Operator setup; CI uses cloud_release.py and never applies Terraform.
set -euo pipefail
umask 077
stage=${1:-help}
case "$stage" in
  help|-h|--help)
    cat <<'USAGE'
Usage: scripts/deploy.sh bootstrap|database|deploy|routing|outputs

Required: PROJECT_ID. Optional REGION=asia-southeast2, RESOURCE_NAME=skyholding,
STATE_BUCKET=<project>-skyholding-tfstate, TERRAFORM_BIN=terraform.
bootstrap: provision GCP foundation/Cloud Deploy/WIF; requires TF_VAR_github_repository_id
           and TF_VAR_github_owner_id (numeric immutable GitHub IDs).
database:  import external DB URL files into Secret Manager (never create a database).
           Required DATABASE_URL_FILE and MIGRATION_DATABASE_URL_FILE; optional DATABASE_CA_FILE.
deploy:    disabled locally; merge a PR to main or dispatch the CI workflow on main.
           CI validates the source before Cloud Build and the migration-gated release.
routing:   apply HTTPS/CDN/invoker IAM AFTER the first successful Cloud Deploy release.
outputs:   print foundation/delivery/routing setup values (no secret payloads).

GCP project and database provisioning are operator setup. See infra/README.md.
USAGE
    exit 0 ;;
  bootstrap|database|deploy|routing|outputs) ;;
  *) printf 'Unknown stage: %s\n' "$stage" >&2; exit 2 ;;
esac
: "${PROJECT_ID:?Set PROJECT_ID}"
export REGION=${REGION:-asia-southeast2}
export RESOURCE_NAME=${RESOURCE_NAME:-skyholding}
export STATE_BUCKET=${STATE_BUCKET:-${PROJECT_ID}-skyholding-tfstate}
export TF_VAR_project_id=$PROJECT_ID TF_VAR_region=$REGION TF_VAR_name=$RESOURCE_NAME
repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
if [[ "$stage" == database ]]; then
  exec python3 "$repo_root/scripts/import_database.py"
fi
if [[ "$stage" == deploy ]]; then
  printf 'Production releases run only through .github/workflows/ci.yml on current main.\nMerge a PR or dispatch that workflow on main after repository/GCP setup.\n' >&2
  exit 1
fi
TERRAFORM_BIN=${TERRAFORM_BIN:-terraform}
for command_name in "$TERRAFORM_BIN" gcloud python3; do
  command -v "$command_name" >/dev/null || { printf 'Missing executable: %s\n' "$command_name" >&2; exit 1; }
done
work_dir=$(mktemp -d "${TMPDIR:-/tmp}/skyholding-setup.XXXXXX")
trap 'rm -rf "$work_dir"' EXIT
terraform_at() { "$TERRAFORM_BIN" "-chdir=$repo_root/infra/$1" "${@:2}"; }
init() {
  terraform_at "$1" init -input=false -lockfile=readonly \
    "-backend-config=bucket=$STATE_BUCKET" "-backend-config=prefix=skyholding/$1"
}
apply() {
  local root=$1
  shift
  terraform_at "$root" plan -input=false -out="$work_dir/$root.tfplan" "$@"
  terraform_at "$root" apply -input=false "$work_dir/$root.tfplan"
}
if [[ "$stage" == bootstrap ]]; then
  : "${TF_VAR_github_repository_id:?Set the numeric GitHub repository ID}"
  : "${TF_VAR_github_owner_id:?Set the numeric GitHub owner ID}"
  gcloud services enable serviceusage.googleapis.com storage.googleapis.com \
    cloudresourcemanager.googleapis.com --project="$PROJECT_ID"
  if ! gcloud storage buckets describe "gs://$STATE_BUCKET" --project="$PROJECT_ID" >/dev/null 2>&1; then
    gcloud storage buckets create "gs://$STATE_BUCKET" --project="$PROJECT_ID" \
      --location="$REGION" --uniform-bucket-level-access --public-access-prevention
  fi
  gcloud storage buckets update "gs://$STATE_BUCKET" --project="$PROJECT_ID" --versioning
  init bootstrap
  apply bootstrap
  terraform_at bootstrap output
  exit 0
fi
init bootstrap
if [[ "$stage" == outputs ]]; then
  terraform_at bootstrap output
  init application
  terraform_at application output
  exit 0
fi
# Routing/IAM never updates Cloud Deploy-managed revision specs.
terraform_at bootstrap output -json foundation > "$work_dir/foundation.json"
python3 - "$work_dir" <<'PY'
import json, pathlib, sys
folder = pathlib.Path(sys.argv[1])
(folder / 'application.tfvars.json').write_text(json.dumps({
    'foundation': json.loads((folder / 'foundation.json').read_text())}))
PY
init application
apply application "-var-file=$work_dir/application.tfvars.json"
terraform_at application output
