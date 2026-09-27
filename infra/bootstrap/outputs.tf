output "foundation" {
  description = "Non-secret infrastructure settings consumed by Cloud Deploy manifest generation and the edge infrastructure root."
  value = {
    name                         = var.name
    network                      = google_compute_network.application.id
    subnetwork                   = google_compute_subnetwork.run.id
    egress_ip                    = google_compute_address.database_egress.address
    assets_bucket                = google_storage_bucket.assets.name
    database_secret_id           = google_secret_manager_secret.database_url.secret_id
    migration_database_secret_id = google_secret_manager_secret.migration_database_url.secret_id
    database_ca_secret_id        = google_secret_manager_secret.database_ca.secret_id
    service_accounts             = { for key, sa in google_service_account.runtime : key => sa.email }
  }
}

output "database" {
  description = "External database setup: allowlist egress_ip and populate secret versions outside Terraform."
  value = {
    secret_id           = google_secret_manager_secret.database_url.secret_id
    migration_secret_id = google_secret_manager_secret.migration_database_url.secret_id
    ca_secret_id        = google_secret_manager_secret.database_ca.secret_id
    egress_ip           = google_compute_address.database_egress.address
  }
}

output "build" {
  value = {
    repository      = google_artifact_registry_repository.containers.repository_id
    service_account = google_service_account.build.email
    source_bucket   = google_storage_bucket.build_source.name
  }
}

output "delivery" {
  description = "Configure the production GitHub environment with these non-secret release settings."
  value = {
    ci_service_account         = google_service_account.ci.email
    execution_service_account  = google_service_account.deploy.email
    workload_identity_provider = google_iam_workload_identity_pool_provider.github.name
    artifact_bucket            = google_storage_bucket.deploy.name
    pipelines                  = { for key, pipeline in google_clouddeploy_delivery_pipeline.production : key => pipeline.name }
    targets                    = { for key, target in google_clouddeploy_target.production : key => target.name }
  }
}
