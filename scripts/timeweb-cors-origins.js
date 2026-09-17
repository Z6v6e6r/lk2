/**
 * The beta API allows exactly the origins declared by the target contract: its own host and, when the
 * contour is driven from a separately hosted CUP, that CUP origin. The value stays an exact,
 * host-only allow-list (no wildcards, no schemes in the declaration, no duplicates), so the
 * provisioning and deployment-contract checks can compare one canonical string.
 */
const CORS_ORIGIN_HOST_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u;

export function readTimewebCorsOrigins(target) {
  if (typeof target?.hostname !== 'string' || !CORS_ORIGIN_HOST_PATTERN.test(target.hostname)) {
    return { ok: false, reason: 'cup_origins_hostname' };
  }
  const declared = target.cupOrigins;
  if (declared === undefined) return { ok: true, value: `https://${target.hostname}` };
  if (!Array.isArray(declared)) return { ok: false, reason: 'cup_origins_shape' };
  for (const origin of declared) {
    if (typeof origin !== 'string' || !CORS_ORIGIN_HOST_PATTERN.test(origin)) {
      return { ok: false, reason: 'cup_origins_host' };
    }
  }
  const hosts = [target.hostname, ...declared];
  if (new Set(hosts).size !== hosts.length) return { ok: false, reason: 'cup_origins_duplicate' };
  return { ok: true, value: hosts.map((host) => `https://${host}`).join(',') };
}
