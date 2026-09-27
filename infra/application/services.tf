locals {
  hosts = {
    api       = "api.skyhold.ing"
    web       = "skyhold.ing"
    dashboard = "cms.skyhold.ing"
  }
}

# Cloud Deploy owns service configuration and revisions. This preserves existing
# services when upgrading a state created by the earlier Terraform-owned setup.
removed {
  from = google_cloud_run_v2_service.application
  lifecycle {
    destroy = false
  }
}

# Apply after Cloud Deploy has created the named services. The load balancer uses
# unauthenticated invocation; API application auth protects administrative routes.
# Service manifests restrict ingress to internal traffic and the load balancer.
resource "google_cloud_run_v2_service_iam_member" "public_invocation" {
  for_each = local.hosts
  project  = var.project_id
  location = var.region
  name     = "${var.foundation.name}-${each.key}"
  role     = "roles/run.invoker"
  member   = "allUsers"
}
