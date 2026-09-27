# Retired root: Cloud Deploy now owns the job. Preserve it on state handoff.
removed {
  from = google_cloud_run_v2_job.migrate
  lifecycle { destroy = false }
}
