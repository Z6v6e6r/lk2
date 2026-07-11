# Terraform boundary

Terraform owns servers, networks, firewalls, load balancers, DNS, object storage, backup storage, service accounts and monitoring resources. Ansible owns host configuration; GitHub Actions owns application delivery.

No provider has been guessed in this baseline. Before adding one, record an ADR covering region, data residency, managed PostgreSQL/PITR, private networking, S3 compatibility, costs and disaster recovery. Committing placeholder cloud resources would create a false deployable architecture.

Required environment roots:

```text
modules/
staging/
production/
```

State must use an encrypted remote backend with locking. Production and staging use separate state and credentials.
