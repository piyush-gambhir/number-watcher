terraform {
  required_version = ">= 1.10, < 2.0"
  required_providers {
    aws     = { source = "hashicorp/aws", version = "~> 6.70" }
    archive = { source = "hashicorp/archive", version = "~> 2.7" }
  }
}

provider "aws" {
  region = var.region
  default_tags {
    tags = { Project = var.name, ManagedBy = "terraform" }
  }
}
