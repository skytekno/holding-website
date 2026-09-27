# Cloud Run and Cloud Deploy

The API, public website and CMS run as independent Google Cloud Run services. PostgreSQL is provided by another cloud through a public TLS endpoint. This repository does not provision a database. GCP project activation is deferred until the project and provider settings are supplied.

| Host | Backend | CDN policy |
| --- | --- | --- |
| `api.skyhold.ing` | Rust API | Disabled |
| `skyhold.ing` | Next.js SSR website | Hashed `/_next/static/*` only; HTML/RSC bypass cache |
| `cms.skyhold.ing` | Next.js CSR dashboard | Disabled |
| `assets.skyhold.ing` | Public Cloud Storage assets | Origin cache headers |

All services listen on port 8080 with `internal-and-cloud-load-balancing` ingress. The load balancer terminates TLS and redirects HTTP to HTTPS. The website calls `https://api.skyhold.ing` through the load balancer. Uploaded assets are intentionally public, including assets attached to drafts.

## Delivery ownership and order

```text
GitHub strict TypeScript/Rust/Terraform + PostgreSQL/Compose/browser tests
  → CI required: mandatory pull-request/main validation gate
  → Cloud Build: three immutable images in Artifact Registry
  → Cloud Deploy: migration job definition → execute job and wait
  → Cloud Deploy: API rollout → website rollout → dashboard rollout
```

Each Cloud Deploy target handles one service or job, so there are four single-target production pipelines: `skyholding-migrate`, `skyholding-api`, `skyholding-web`, and `skyholding-dashboard`. Target names append `-production`. Both migrations and the API use the same digest. Cloud Deploy deploying a job does not execute it; the release script explicitly executes and waits for it before touching applications. Every rollout must reach `SUCCEEDED`. Production startup does not run migrations.

Terraform owns supporting resources; Cloud Deploy owns the complete Cloud Run service/job specifications. CI never applies Terraform. Application releases cannot change load-balancer or IAM configuration.

- `bootstrap/`: APIs, Artifact Registry, build/deploy source storage, separate CI/build/deploy/runtime identities, GitHub Workload Identity Federation, four delivery pipelines/targets, VPC/subnet, fixed NAT egress IP, empty database/CA secrets and public asset bucket.
- `application/`: invoker IAM, serverless NEGs, load balancer, certificates and CDN. Apply after the first services exist.
- `migrations/`: retired Terraform root with a non-destructive state handoff; new installations do not apply it.
- `scripts/cloud_release.py`: immutable build records, complete service manifests, Cloud Deploy release orchestration and a conditional GCS release lock.

The GitHub workflow serializes main-branch runs and never cancels a live release. A generation-conditional `release.lock` in the deployment bucket also prevents overlapping manual/CI releases from replacing the shared migration job. On any release failure, cancellation or timeout the lock remains for recovery. Database changes must be backward compatible with the currently serving code and rollback revisions. A later application failure can leave a partial service release; the process is ordered, not an atomic four-service transaction.

## One-time activation

Use Terraform 1.16.4, Google Cloud CLI 541+ and Python 3. Provider locks are checked in; always initialize with `-lockfile=readonly`. The setup identity needs infrastructure/IAM administration in the selected billed project. Runtime and CI identities do not receive owner/editor roles. Organization policies must permit public invocation behind the load balancer and a public media bucket.

1. Create/select the billed GCP project and external PostgreSQL database. Default GCP region is Jakarta, `asia-southeast2`; choose it deliberately based on latency to the database provider. Keep project, region, resource prefix and state bucket consistent for every invocation.
2. Create a Google OAuth Web client with `https://cms.skyhold.ing` as an authorized JavaScript origin. Configure consent/access and the explicit CMS administrator allowlist. The browser sign-in flow needs the client ID, not a client secret.
3. Authenticate the setup identity, provide real project and GitHub IDs, then bootstrap:

```bash
gcloud auth login
gcloud auth application-default login
read -r -p 'GCP project ID: ' PROJECT_ID
export PROJECT_ID REGION=asia-southeast2 RESOURCE_NAME=skyholding
export TF_VAR_github_repository_id=$(gh api repos/skytekno/holding-website --jq '.id')
export TF_VAR_github_owner_id=$(gh api repos/skytekno/holding-website --jq '.owner.id')
scripts/deploy.sh bootstrap
```

Run examples in Bash from the repository root. GitHub must grant the operator access to the repository to retrieve those immutable IDs. Do not invent them. Bootstrap plans and immediately applies the selected infrastructure; review the source/project before invoking it. It creates a private, versioned state bucket and uses separate `skyholding/bootstrap` and `skyholding/application` state prefixes.

4. Allowlist the bootstrap `database.egress_ip` at the database provider, then import the external database credentials as described below.
5. Configure the repository variables and `production` GitHub environment in the next section. Publish the reviewed source and run the workflow from `main` to deploy the migration job and three services.
6. Run `scripts/deploy.sh routing` using the setup identity, then `scripts/deploy.sh outputs`. Apply the resulting four DNS A records and wait for the Google-managed certificate to become `ACTIVE`.
7. Complete live auth, DB TLS, content, CDN, monitoring and recovery acceptance before enabling public discovery. Successful Cloud Deploy rollouts prove container startup; they do not prove DNS, Google login or business acceptance.

## External PostgreSQL

API and migration traffic uses Direct VPC egress with `all-traffic`, through Cloud NAT with a reserved IPv4 address. Only that IP needs to be allowlisted at the public database endpoint. Web/dashboard have no database secrets or VPC configuration. There is no Cloud SQL instance or connector.

Both production paths require `sslmode=verify-full`: the TLS chain and hostname must validate. Use the provider's DNS hostname and URL-encode credentials. The URL must contain exactly one canonical `sslmode` parameter, no `host`/`hostaddr` override, no Unix socket and no fragment. A provider requiring a custom CA can use the optional mounted PEM certificate, exposed through `PGSSLROOTCERT`. SQLx uses its bundled trusted roots plus that certificate; do not rely on changing the OS trust store.

Provision the database and users at the chosen provider. Keep schema-changing migration privileges separate from the runtime account. The runtime role needs access to the CMS tables/sequences; configure default privileges for future migrations. Set a suitable `search_path`. If the provider uses a transaction pooler for runtime traffic, use a direct/session-capable endpoint for migrations, because SQLx migrations use session-level advisory locks. Validate provider compatibility before launch.

Create local owner-only files containing the complete URLs outside the repository, using a secret manager or secure editor. Do not paste passwords into commands, GitHub variables or Linear. Then import them:

```bash
read -r -p 'Runtime URL file path: ' DATABASE_URL_FILE
read -r -p 'Migration URL file path: ' MIGRATION_DATABASE_URL_FILE
export DATABASE_URL_FILE MIGRATION_DATABASE_URL_FILE
# If needed, also export DATABASE_CA_FILE to an owner-only provider PEM file.
scripts/deploy.sh database
```

The importer requires mode 0600 files, validates both URLs before writing, and passes payloads to Secret Manager over stdin. It creates new versions of `skyholding-database-url`, `skyholding-migration-database-url`, and optionally `skyholding-database-ca`; it never creates users or changes provider passwords. It prints only version numbers. Reruns intentionally add versions. If an API failure interrupts import, inspect the reported versions before retrying; updates to separate secrets are not atomic.

Pin the returned numeric versions in GitHub variables. `latest` is rejected. Rotation means updating the provider credentials, importing the corresponding URL version, then deploying new revisions with that version. Retain compatible old versions until rollback requirements are met. The API pool is five connections per instance and each revision allows up to five instances; allow capacity for simultaneous old/new revisions and migrations. Measure cross-cloud latency and reconnection behavior before increasing limits.

## GitHub configuration

The workflow validates pull requests targeting `main` and pushes to `main`. Build/deploy remain inactive until the **repository-level** variable `GCP_PROJECT_ID` is set. This is intentional while the GCP project is deferred. Deployment only runs from this repository's current `main` after the `CI required` aggregate gate confirms both validation jobs passed. `workflow_dispatch` on `main` reruns the same checks. WIF restricts immutable repository/owner IDs, repository name, branch, the `production` environment subject, the exact `ci.yml` workflow and push/manual events. No service-account JSON key is used. See [CI/CD](../docs/CI-CD.md) for GitHub Flow policy installation and the full job graph.

Create the `production` GitHub environment with a `main` deployment branch restriction. If your organization requires a human release gate, configure required reviewers there; Cloud Deploy targets themselves are automatic after the CI gates. The build and deployment jobs both use this environment, so configure its rules with that in mind.

| Repository/environment variable | Value |
| --- | --- |
| `GCP_PROJECT_ID` | Real project ID; set at repository level to activate the jobs |
| `GCP_REGION` | Selected region; defaults to `asia-southeast2` |
| `GCP_RESOURCE_NAME` | Resource prefix; defaults to `skyholding` |
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | Bootstrap `delivery.workload_identity_provider` |
| `GCP_CI_SERVICE_ACCOUNT` | Bootstrap `delivery.ci_service_account` |
| `GOOGLE_CLIENT_ID` | Google OAuth Web client ID |
| `ADMIN_EMAILS` | Comma-separated CMS allowlist |
| `DATABASE_SECRET_VERSION` | Numeric runtime URL secret version |
| `MIGRATION_DATABASE_SECRET_VERSION` | Numeric migration URL secret version |
| `DATABASE_CA_SECRET_VERSION` | Numeric CA version, or empty for bundled roots |

The workflow creates a unique `r-RUN_ID-ATTEMPT` release and immutable image tags, records all three digests and the full commit SHA, and checks that provenance before deployment. Cloud Deploy receives only generated manifests and Skaffold configuration. The build context excludes GitHub-generated credential files. CI does not read database secret payloads; API/migration identities retrieve their respective pinned secrets at runtime. CI remains a privileged code-release identity because it can publish code executed under those identities. Its migration-execution role permits run.jobs.run in this dedicated project, without job mutation or execution overrides; Cloud Run Jobs do not support the resource IAM condition needed to restrict a project grant to a job that does not yet exist. Use a dedicated project, or add job-level IAM through a separately controlled activation step when stronger isolation is required.

For a manual retry, run `gh workflow run ci.yml --repo skytekno/holding-website --ref main`. This repeats validation and releases only the current `main` commit. Local `scripts/deploy.sh deploy` is disabled; the release module also checks the trusted workflow context, passing CI result, clean checkout and current remote `main`. Setup commands (`bootstrap`, `database`, `routing`, `outputs`) remain separate. An old workflow rerun is rejected instead of rolling the application back implicitly.

## Failure recovery and rollback

A failed render/rollout or migration halts later releases. Open Cloud Deploy and the migration job execution, identify whether a cloud operation is still active, and resolve the cause. Do not clear the release lock while any rollout/execution from that release is running. After all are terminal and no other deployment is active, inspect the lock and deliberately remove it:

```bash
gcloud storage cat "gs://${PROJECT_ID}-${RESOURCE_NAME}-deploy/release.lock" --project="$PROJECT_ID"
gcloud storage rm "gs://${PROJECT_ID}-${RESOURCE_NAME}-deploy/release.lock" --project="$PROJECT_ID"
```

Rerun the workflow to create a fresh release ID and tag. Migration bookkeeping makes already-applied successful migrations a no-op; a failed migration requires inspection before retry. Do not attempt to reuse an immutable image tag.

For application rollback, use the relevant Cloud Deploy pipeline's target rollback to its previous successful release, monitor that rollout and verify the hosted behavior. Roll back dependent frontends/API in an order compatible with their contracts. Retain release sources, images and pinned secret versions needed for that rollback. Do **not** roll back or execute the migration pipeline as part of an application rollback, and do not automatically reverse database migrations. A database restore or incompatible schema change requires a provider-specific recovery plan.

An older Terraform deployment needs a deliberate state handoff. The `removed` blocks preserve old Cloud SQL resources and Cloud Run services/jobs without destroying them. Review/apply the retired migration root once using its original backend if it has state, then stop applying it. Cloud Deploy must target the same service/job names. Migrate existing database contents to the external provider and verify backups before switching secrets. Preserved Cloud SQL resources remain billed until separately decommissioned; this setup never deletes them automatically.

## DNS, verification and operations

The routing output lists `skyhold.ing`, `api.skyhold.ing`, `cms.skyhold.ing` and `assets.skyhold.ing`, all pointing at the load balancer IPv4 address. Remove conflicting DNS A/AAAA records; use DNS-only records if a DNS provider offers a proxy. Wait for all managed certificate domain statuses to be `ACTIVE`.

```bash
gcloud compute ssl-certificates describe "${RESOURCE_NAME}-https" \
  --project="$PROJECT_ID" --global --format='yaml(managed.status,managed.domainStatus)'
curl --fail https://api.skyhold.ing/health/ready
curl --fail https://skyhold.ing/health
curl --fail https://cms.skyhold.ing/health
```

Then verify real Google login, denied non-admin access, publish/unpublish, draft exclusion, media upload/CDN delivery, static-only caching, and recovery from temporary database loss. Test database TLS rejection with an untrusted certificate/incorrect hostname in an isolated environment. Run provider backup/restore drills and measure cross-cloud latency, egress, capacity and connection limits. GCP activation, provider availability, DNS/TLS and these hosted checks are external release gates, not covered by local tests.

Cloud Run can scale to zero, but NAT, reserved IPs, load balancing, storage, Cloud Build/Deploy, CDN traffic and the external provider have their own charges. Configure alerts, budgets and RPO/RTO. Preserve deployment artifacts for rollback and establish retention after the required rollback horizon is agreed.

Local checks (no deployment):

```bash
python3 -m unittest discover -s tests -p 'test_deployment.py' -v
bash -n scripts/deploy.sh
terraform fmt -check -recursive infra
for component in bootstrap migrations application; do
  terraform -chdir="infra/$component" init -backend=false -lockfile=readonly
  terraform -chdir="infra/$component" validate
done
```

References: [Cloud Deploy Cloud Run constraints and revision behavior](https://docs.cloud.google.com/deploy/docs/run-targets), [Cloud Run YAML schema](https://docs.cloud.google.com/run/docs/reference/yaml/v1), [static outbound IP](https://docs.cloud.google.com/run/docs/configuring/static-outbound-ip), [GitHub Workload Identity Federation](https://github.com/google-github-actions/auth), [Cloud Run secret references](https://docs.cloud.google.com/run/docs/configuring/services/secrets), [Cloud CDN](https://docs.cloud.google.com/cdn/docs/caching).
