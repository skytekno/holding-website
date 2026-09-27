locals {
  services = toset([
    "artifactregistry.googleapis.com", "cloudbuild.googleapis.com", "clouddeploy.googleapis.com",
    "compute.googleapis.com", "iam.googleapis.com", "iamcredentials.googleapis.com",
    "logging.googleapis.com", "sts.googleapis.com",
    "run.googleapis.com", "secretmanager.googleapis.com",
    "storage.googleapis.com", "cloudresourcemanager.googleapis.com"
  ])
}

resource "google_project_service" "enabled" {
  for_each           = local.services
  service            = each.value
  disable_on_destroy = false
}

resource "google_artifact_registry_repository" "containers" {
  location      = var.region
  repository_id = var.name
  format        = "DOCKER"
  docker_config { immutable_tags = true }
  depends_on = [google_project_service.enabled]
}

resource "google_service_account" "runtime" {
  for_each     = toset(["api", "web", "dashboard", "migrate"])
  account_id   = "${var.name}-${each.key}"
  display_name = "Sky Holding ${each.key} runtime"
  depends_on   = [google_project_service.enabled]
}

resource "google_service_account" "build" {
  account_id   = "${var.name}-build"
  display_name = "Sky Holding container builder"
  depends_on   = [google_project_service.enabled]
}

resource "google_artifact_registry_repository_iam_member" "build_writer" {
  location   = google_artifact_registry_repository.containers.location
  repository = google_artifact_registry_repository.containers.name
  role       = "roles/artifactregistry.writer"
  member     = "serviceAccount:${google_service_account.build.email}"
}

resource "google_project_iam_member" "build_logs" {
  project = var.project_id
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${google_service_account.build.email}"
}

resource "google_storage_bucket" "build_source" {
  name                        = "${var.project_id}-${var.name}-build-source"
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false
  lifecycle_rule {
    condition { age = 7 }
    action { type = "Delete" }
  }
  depends_on = [google_project_service.enabled]
}

resource "google_storage_bucket_iam_member" "build_source_reader" {
  bucket = google_storage_bucket.build_source.name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${google_service_account.build.email}"
}

resource "google_compute_network" "application" {
  name                    = var.name
  auto_create_subnetworks = false
  routing_mode            = "REGIONAL"
  depends_on              = [google_project_service.enabled]
}

resource "google_compute_subnetwork" "run" {
  name                     = "${var.name}-run"
  ip_cidr_range            = "10.40.0.0/24"
  region                   = var.region
  network                  = google_compute_network.application.id
  private_ip_google_access = true
}

# Public cross-cloud PostgreSQL receives connections from one allowlisted address.
# API and migration manifests must route ALL_TRAFFIC through this subnet.
resource "google_compute_address" "database_egress" {
  name         = "${var.name}-database-egress"
  region       = var.region
  address_type = "EXTERNAL"
  network_tier = "PREMIUM"
  depends_on   = [google_project_service.enabled]
}

resource "google_compute_router" "egress" {
  name    = "${var.name}-egress"
  region  = var.region
  network = google_compute_network.application.id
}

resource "google_compute_router_nat" "egress" {
  name                               = "${var.name}-egress"
  router                             = google_compute_router.egress.name
  region                             = var.region
  nat_ip_allocate_option             = "MANUAL_ONLY"
  nat_ips                            = [google_compute_address.database_egress.self_link]
  source_subnetwork_ip_ranges_to_nat = "LIST_OF_SUBNETWORKS"
  subnetwork {
    name                    = google_compute_subnetwork.run.id
    source_ip_ranges_to_nat = ["ALL_IP_RANGES"]
  }
  log_config {
    enable = true
    filter = "ERRORS_ONLY"
  }
}

# External PostgreSQL URLs and optional provider CA are supplied out of band.
# Terraform creates secret shells only, never credentials or certificate payloads.
resource "google_secret_manager_secret" "database_url" {
  secret_id = "${var.name}-database-url"
  replication {
    auto {}
  }
  depends_on = [google_project_service.enabled]
}

resource "google_secret_manager_secret" "migration_database_url" {
  secret_id = "${var.name}-migration-database-url"
  replication {
    auto {}
  }
  depends_on = [google_project_service.enabled]
}

resource "google_secret_manager_secret" "database_ca" {
  secret_id = "${var.name}-database-ca"
  replication {
    auto {}
  }
  depends_on = [google_project_service.enabled]
}

resource "google_secret_manager_secret_iam_member" "api_database" {
  secret_id = google_secret_manager_secret.database_url.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.runtime["api"].email}"
}

resource "google_secret_manager_secret_iam_member" "migration_database" {
  secret_id = google_secret_manager_secret.migration_database_url.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.runtime["migrate"].email}"
}

resource "google_secret_manager_secret_iam_member" "database_ca" {
  for_each  = toset(["api", "migrate"])
  secret_id = google_secret_manager_secret.database_ca.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.runtime[each.key].email}"
}

# Only public, deliberately published website media belongs in this bucket.
resource "google_storage_bucket" "assets" {
  name                        = "${var.project_id}-${var.name}-assets"
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "inherited"
  force_destroy               = false
  versioning { enabled = true }
  lifecycle_rule {
    condition {
      days_since_noncurrent_time = 30
      with_state                 = "ARCHIVED"
    }
    action { type = "Delete" }
  }
  depends_on = [google_project_service.enabled]
}

resource "google_storage_bucket_iam_member" "assets_public_read" {
  bucket = google_storage_bucket.assets.name
  role   = "roles/storage.objectViewer"
  member = "allUsers"
}

resource "google_storage_bucket_iam_member" "api_assets_writer" {
  bucket = google_storage_bucket.assets.name
  role   = "roles/storage.objectUser"
  member = "serviceAccount:${google_service_account.runtime["api"].email}"
}
