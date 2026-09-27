resource "google_iam_workload_identity_pool" "github" {
  workload_identity_pool_id = "${var.name}-github"
  display_name              = "Sky Holding GitHub"
  description               = "Keyless identity for the owned website repository's production release workflow."
  depends_on                = [google_project_service.enabled]
}

resource "google_iam_workload_identity_pool_provider" "github" {
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "github-actions"
  display_name                       = "Holding Website production"
  attribute_mapping = {
    "google.subject"                = "assertion.sub"
    "attribute.repository"          = "assertion.repository"
    "attribute.repository_id"       = "assertion.repository_id"
    "attribute.repository_owner_id" = "assertion.repository_owner_id"
    "attribute.ref"                 = "assertion.ref"
  }
  # Numeric IDs prevent a deleted repository/organization name from being reused
  # to assume this identity. Restrict issuance to the release workflow on main,
  # its production environment, and the two intentional release events.
  attribute_condition = join(" && ", [
    "assertion.repository_id == '${var.github_repository_id}'",
    "assertion.repository_owner_id == '${var.github_owner_id}'",
    "assertion.repository == 'skytekno/holding-website'",
    "assertion.ref == 'refs/heads/main'",
    "assertion.sub == 'repo:skytekno/holding-website:environment:production'",
    "assertion.workflow_ref == 'skytekno/holding-website/.github/workflows/ci.yml@refs/heads/main'",
    "assertion.event_name in ['push', 'workflow_dispatch']",
  ])
  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

resource "google_service_account_iam_member" "github_ci" {
  service_account_id = google_service_account.ci.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository_id/${var.github_repository_id}"
}
