# Nano TLS ingress

Nano terminates public HTTP/HTTPS in the dedicated `phub-tls-ingress` Caddy
project. Application and management containers remain on private Docker
networks; the infrastructure Nginx and CUP showcase proxy must not publish
ports 80 or 443 directly.

## Public names

All records ultimately resolve to `185.155.18.146`:

- `nano.padlhub.su` redirects to `https://lk.nano.padlhub.su`;
- `lk.nano.padlhub.su` proxies the PadlHub web/API same-origin boundary;
- `api.nano.padlhub.su` proxies the PadlHub API;
- `cup.nano.padlhub.su` proxies the protected, read-only CUP showcase;
- `swagger.nano.padlhub.su` proxies read-only Swagger UI;
- `portainer.nano.padlhub.su` requires Caddy Basic Auth before Portainer auth.

Caddy stores ACME account data, certificates and keys in the persistent
`phub-tls-ingress_caddy_data` volume. Never delete that volume as cache.

## Portainer outer credentials

Create `/opt/phub/tls-ingress/portainer-auth.env` with a Caddy bcrypt hash in
`PORTAINER_AUTH_HASH`. Keep the one-time plaintext credential outside Git in
`/opt/phub/tls-ingress/portainer-credentials.txt`, mode `0600`. The repository
ignores both filenames.

## Deployment checks

1. Confirm every DNS name resolves to the Nano public IPv4.
2. Validate the Caddyfile with the pinned Caddy image and validate every
   changed Compose file with `docker compose config`.
3. Back up the active infrastructure and CUP showcase Compose files.
4. Recreate infrastructure Nginx without host port 80 and CUP showcase proxy
   without host port 443, then start this project.
5. Verify Let’s Encrypt certificates, `/health/ready`, the web manifest and
   assets, Swagger, CUP authentication, and both Portainer auth layers.

The current Viva OAuth redirect URI is still registered as
`http://185.155.18.146/user/api/v1/local-padel/auth/viva/callback`. The legacy
HTTP IP answers that callback with a temporary redirect to the same path and
query on `https://lk.nano.padlhub.su` before the API consumes the one-time OAuth
state. The API still uses the registered IP redirect URI for the token exchange,
but finishes the browser callback and issues its host-only refresh cookie on the
canonical HTTPS domain. Every other IP path permanently redirects to the same
HTTPS LK path. Remove the compatibility callback only after Viva accepts the
HTTPS redirect URI.

OpenWrt dnsmasq must override `nano.padlhub.su` and its subdomains to the Nano
LAN address `192.168.31.100`. This split-DNS rule is required because requests
from LAN clients to the router's public IPv4 otherwise terminate on the OpenWrt
management listener and receive its self-signed certificate. The override was
verified with `lk.nano.padlhub.su` and `portainer.nano.padlhub.su`; clients that
bypass router DNS through DoH need an equivalent local override. Server-local
probes can target `127.0.0.1` while preserving SNI.

## Rollback

Stop the TLS ingress without deleting its volumes, restore the two backed-up
Compose files, and recreate only infrastructure Nginx and the CUP showcase
proxy. Recheck the legacy HTTP root and `/health/ready` after rollback.
