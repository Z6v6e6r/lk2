# Timeweb LK2 beta source contract

This runbook records the canonical, source-only deployment contract for the LK2 beta contour. It
does not authorize deployment, publication, activation, provider mutation, secret provisioning,
migration, worker activation, firewall changes, or any live write. All volatile facts must be
re-read before a separately authorized activation.

## Canonical target

`deploy/timeweb/target.json` is the authoritative `PHUB_TIMEWEB_TARGET_V1` contract. Its canonical
identity is:

- hostname `lk2.padlhub.su`;
- IPv4 `103.88.243.171`;
- Linux/AMD64 on an `x86_64` host;
- Timeweb server `Cute Hoopoe`, server ID `8886471`, project ID `262717`;
- management only through `tailscale0` with pinned ED25519 fingerprint
  `SHA256:zjTqV+Aj8BvvdK1/HZ8TmMs6OO3zdoORiB96uODoRUw`;
- external Docker network `phub-timeweb-beta`, subnet `172.30.26.0/24`;
- future release root `/opt/phub/timeweb-beta/releases`.

The JSON contract, not this prose, is the machine-readable source of truth. Compose and the source
verifier must match it exactly.

## Confirmed preflight evidence

### DNS preflight: READY

The confirmed preflight was `lk2.padlhub.su` A `103.88.243.171`, TTL 300, with no AAAA and no
CNAME. Authoritative DNS, Cloudflare, Google, and Quad9 returned the same result. These observations
are preflight facts only; they do not authorize deployment and must be confirmed again immediately
before any future activation.

### VPS ingress preflight: READY

The confirmed target was Timeweb `Cute Hoopoe` (server ID `8886471`, project `262717`), Ubuntu
26.04 LTS, `x86_64`, Docker 29.7.2, and Compose 5.5.0. The read-only inventory observed
approximately 90 GB free disk and 11 GiB RAM, ports 80/443 free, no ingress or application
containers, no application network, and no conflict with `172.30.26.0/24`. Management was through
`tailscale0` only and the pinned ED25519 fingerprint matched.

No SSH or host mutation was performed by this source task. The firewall remains unchanged; ports
remain unopened. Disk, RAM, package versions, listener state, containers, networks, routes, and
host-key identity are volatile and must all be read back before activation.

## Immutable historical evidence

These directories are immutable historical evidence and not an activation input, release
directory, Compose/Caddy working directory, secrets source, mount source, or future rollback input:

- `/opt/phub/timeweb-beta/staging/ac8f0aad-contract5004571-20260826T133721Z`
- `/opt/phub/timeweb-beta/rollback/ac8f0aad-contract5004571-20260826T133721Z`

They must never be deleted, renamed, modified, moved, copied over, mounted, or activated. A future
accepted release must use a new single-segment directory below
`/opt/phub/timeweb-beta/releases/<future-release-id>`.

## Source-only validation

The deterministic verifier checks the target, Caddy routes and headers, ingress/application
Compose, runtime environment contract, profile gates, static addresses, immutable images, and the
historical-evidence exclusion:

```sh
node scripts/verify-timeweb-deployment-contract.js
```

Exact-head CI validates and adapts Caddy with the digest-pinned Caddy 2.11.4 Linux/AMD64 image in a
container with `--network none`. It records the adapted JSON SHA-256 and compares it with the
historical and current hash
`afdc50d2324f94760c2630f78e5da0ade3f72589efbdec7e175cf476d516f21b`. The earlier handoff
value containing 66 hexadecimal characters was not a valid SHA-256; direct adaptation of both the
historical and current Caddyfiles produced the same valid 64-character hash recorded here.
It also renders both Compose models using synthetic non-secret environment files and digest values.
These checks do not start Caddy or an application service, do not bind ports, and do not create a
Docker network, volume, package, or VPS resource.

## Runtime and activation boundary

`deploy/timeweb/runtime-environment.contract.json` names required, allowed, and forbidden keys per
service without containing credential values. API, worker, realtime, and migrator use separate
required env files. Worker receives no API/provider/signing key set; realtime receives no API
access/refresh signing secret or provider credential. Initial write-capable flags remain disabled.

The default application model contains only web, API, and realtime. Worker is gated by profile
`background`; migrator is gated by profile `migration`; neither is a dependency of a default
service. Only ingress may bind host ports. Publication, deployment, Caddy activation, migration,
worker activation, OAuth/provider changes, and any live write each require a later explicit gate.
