variable "project_id" {
  description = "Existing billing-enabled Google Cloud project ID, supplied at activation time."
  type        = string
}

variable "region" {
  description = "Region for Cloud Run, Cloud Deploy, NAT, build storage and asset storage."
  type        = string
  default     = "asia-southeast2"
}

variable "name" {
  type    = string
  default = "skyholding"
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{0,19}$", var.name))
    error_message = "Use a lowercase resource prefix of at most 20 characters."
  }
}

variable "github_repository_id" {
  description = "Immutable numeric GitHub repository ID for skytekno/holding-website, verified by its owner."
  type        = string
  validation {
    condition     = can(regex("^[1-9][0-9]*$", var.github_repository_id))
    error_message = "Provide the real numeric repository ID; a repository name is insufficient."
  }
}

variable "github_owner_id" {
  description = "Immutable numeric GitHub organization ID for skytekno, verified by its owner."
  type        = string
  validation {
    condition     = can(regex("^[1-9][0-9]*$", var.github_owner_id))
    error_message = "Provide the real numeric organization ID; an organization name is insufficient."
  }
}

variable "deletion_protection" {
  description = "Prevent routine Terraform destruction of delivery targets and pipelines."
  type        = bool
  default     = true
}
