terraform {
  required_version = ">= 1.8.0"

  required_providers {
    # The cloud provider is intentionally selected by ADR after hosting, region,
    # managed PostgreSQL, PITR and object-storage requirements are approved.
  }
}
