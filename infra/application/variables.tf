variable "project_id" {
  description = "Existing Google Cloud project containing the Cloud Deploy services."
  type        = string
}

variable "region" {
  description = "Region containing the Cloud Run services and serverless NEGs."
  type        = string
  default     = "asia-southeast2"
}

variable "foundation" {
  description = "Non-secret foundation output from infra/bootstrap. Runtime configuration is owned by Cloud Deploy."
  type = object({
    name             = string
    assets_bucket    = string
    service_accounts = map(string)
  })
}
