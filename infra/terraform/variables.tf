variable "region" {
  description = "AWS region. Cost examples use US East (N. Virginia)."
  type        = string
  default     = "us-east-1"
}

variable "name" {
  description = "Prefix for this deployment. Use a different name for each environment."
  type        = string
  default     = "number-watcher"
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,39}$", var.name))
    error_message = "Use 3 to 40 lowercase letters, digits, and hyphens, starting with a letter."
  }
}

variable "credentials_secret_arn" {
  description = "Existing same-region Secrets Manager secret, or null to create an empty secret. Never put credential values in Terraform."
  type        = string
  default     = null
  nullable    = true
}

variable "memory_size" {
  description = "Lambda memory in MB."
  type        = number
  default     = 512
  validation {
    condition     = var.memory_size >= 128 && var.memory_size <= 3008 && var.memory_size % 64 == 0
    error_message = "Use 128 to 3008 MB in increments of 64 MB."
  }
}

variable "log_retention_days" {
  description = "CloudWatch log retention."
  type        = number
  default     = 14
  validation {
    condition     = contains([1, 3, 5, 7, 14, 30, 60, 90], var.log_retention_days)
    error_message = "Use 1, 3, 5, 7, 14, 30, 60, or 90 days."
  }
}
