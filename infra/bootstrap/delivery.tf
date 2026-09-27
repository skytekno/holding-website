locals {
  components = toset(["migrate", "api", "web", "dashboard"])
}

resource "google_service_account" "ci" {
  account_id   = "${var.name}-ci"
  display_name = "Sky Holding GitHub release workflow"
  depends_on   = [google_project_service.enabled]
}

resource "google_service_account" "deploy" {
  account_id   = "${var.name}-deploy"
  display_name = "Sky Holding Cloud Deploy execution"
  depends_on   = [google_project_service.enabled]
}

resource "google_storage_bucket" "deploy" {
  name                        = "${var.project_id}-${var.name}-deploy"
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false
  versioning { enabled = true }
  depends_on = [google_project_service.enabled]
}

# Build execution can push images; release CI and deployment execution can only read.
resource "google_artifact_registry_repository_iam_member" "release_reader" {
  for_each = {
    ci     = google_service_account.ci.email
    deploy = google_service_account.deploy.email
  }
  location   = google_artifact_registry_repository.containers.location
  repository = google_artifact_registry_repository.containers.name
  role       = "roles/artifactregistry.reader"
  member     = "serviceAccount:${each.value}"
}

resource "google_project_iam_member" "ci" {
  for_each = toset([
    "roles/cloudbuild.builds.editor",
    "roles/clouddeploy.releaser",
    "roles/logging.viewer",
    "roles/serviceusage.serviceUsageConsumer",
  ])
  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.ci.email}"
}

resource "google_storage_bucket_iam_member" "ci_source" {
  bucket = google_storage_bucket.build_source.name
  role   = "roles/storage.objectUser"
  member = "serviceAccount:${google_service_account.ci.email}"
}

resource "google_storage_bucket_iam_member" "ci_deploy" {
  bucket = google_storage_bucket.deploy.name
  role   = "roles/storage.objectUser"
  member = "serviceAccount:${google_service_account.ci.email}"
}

# gcloud checks that each pre-provisioned source bucket exists before uploading.
# ObjectUser covers uploads/locks, but does not include bucket metadata access.
resource "google_project_iam_custom_role" "source_bucket_metadata" {
  role_id     = "${replace(var.name, "-", "_")}_source_bucket_metadata"
  title       = "Sky Holding source bucket metadata"
  description = "Read metadata for pre-provisioned build and release staging buckets."
  permissions = ["storage.buckets.get"]
  depends_on  = [google_project_service.enabled]
}

resource "google_storage_bucket_iam_member" "ci_source_metadata" {
  for_each = {
    build  = google_storage_bucket.build_source.name
    deploy = google_storage_bucket.deploy.name
  }
  bucket = each.value
  role   = google_project_iam_custom_role.source_bucket_metadata.name
  member = "serviceAccount:${google_service_account.ci.email}"
}

# CI may submit builds and releases under these identities, but cannot act as a
# runtime identity or read database secrets directly.
resource "google_service_account_iam_member" "ci_act_as" {
  for_each = {
    build  = google_service_account.build.name
    deploy = google_service_account.deploy.name
  }
  service_account_id = each.value
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.ci.email}"
}

# The migration job does not exist at bootstrap, and Cloud Run Jobs do not
# support resource-name IAM conditions. Grant only execution at project scope;
# this dedicated website project must not contain unrelated privileged jobs.
resource "google_project_iam_custom_role" "migration_executor" {
  role_id     = "${replace(var.name, "-", "_")}_migration_executor"
  title       = "Sky Holding migration execution"
  description = "Execute Cloud Run jobs in the website project without job mutation or overrides."
  permissions = ["run.jobs.run"]
  depends_on  = [google_project_service.enabled]
}

resource "google_project_iam_member" "ci_migration_execute" {
  project = var.project_id
  role    = google_project_iam_custom_role.migration_executor.name
  member  = "serviceAccount:${google_service_account.ci.email}"
}

resource "google_project_iam_custom_role" "migration_status" {
  role_id     = "${replace(var.name, "-", "_")}_migration_status"
  title       = "Sky Holding migration status"
  description = "Read Cloud Run job execution and operation status so release CI can wait for migration completion."
  permissions = [
    "run.jobs.get", "run.executions.get", "run.executions.list", "run.operations.get",
  ]
  depends_on = [google_project_service.enabled]
}

resource "google_project_iam_member" "ci_migration_status" {
  project = var.project_id
  role    = google_project_iam_custom_role.migration_status.name
  member  = "serviceAccount:${google_service_account.ci.email}"
}

resource "google_project_iam_member" "deploy" {
  for_each = toset(["roles/clouddeploy.jobRunner", "roles/run.developer"])
  project  = var.project_id
  role     = each.value
  member   = "serviceAccount:${google_service_account.deploy.email}"
}

resource "google_storage_bucket_iam_member" "deploy_artifacts" {
  bucket = google_storage_bucket.deploy.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.deploy.email}"
}

resource "google_service_account_iam_member" "deploy_act_as" {
  for_each           = google_service_account.runtime
  service_account_id = each.value.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.deploy.email}"
}

# Native Cloud Deploy supports exactly one Cloud Run resource per target.
# Four independent pipelines allow API/service rollback without rerunning DDL.
# CI serializes their first rollouts and explicitly executes the migration job.
resource "google_clouddeploy_target" "production" {
  for_each         = local.components
  name             = "${var.name}-${each.key}-production"
  location         = var.region
  description      = "Sky Holding production ${each.key}"
  require_approval = false
  deletion_policy  = var.deletion_protection ? "PREVENT" : "DELETE"
  run {
    location = "projects/${var.project_id}/locations/${var.region}"
  }
  execution_configs {
    usages            = ["RENDER", "DEPLOY"]
    service_account   = google_service_account.deploy.email
    artifact_storage  = "gs://${google_storage_bucket.deploy.name}/artifacts/${each.key}"
    execution_timeout = "600s"
  }
  depends_on = [
    google_project_service.enabled,
    google_project_iam_member.deploy,
    google_service_account_iam_member.deploy_act_as,
    google_storage_bucket_iam_member.deploy_artifacts,
  ]
}

resource "google_clouddeploy_delivery_pipeline" "production" {
  for_each        = local.components
  name            = "${var.name}-${each.key}"
  location        = var.region
  description     = "Sky Holding ${each.key}; releases are ordered by CI"
  deletion_policy = var.deletion_protection ? "PREVENT" : "DELETE"
  serial_pipeline {
    stages {
      target_id = google_clouddeploy_target.production[each.key].name
      profiles  = []
      strategy {
        standard {
          verify = false
        }
      }
    }
  }
}
