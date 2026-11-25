import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { isIPv4 } from 'node:net';
import { fileURLToPath } from 'node:url';

const [side, scope] = process.argv.slice(2);
if (!['cup', 'timeweb'].includes(side) || !['stand', 'private'].includes(scope)) {
  throw new Error('Usage: node validate-config.mjs <timeweb|cup> <stand|private>');
}
const env = { ...process.env };
const read = (name, accepts) => {
  const key = `LK2_CUP_PILOT_${name}`;
  const value = env[key];
  if (!value || !accepts(value)) throw new Error(`INVALID_PILOT_CONFIG: ${key}`);
  return value;
};
const privateAddress = (addr) => {
  if (!isIPv4(addr)) return false;
  if (scope === 'stand') return addr === '127.0.0.1';
  const [a, b] = addr.split('.').map(Number);
  return (
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
};
const port = (value) =>
  /^[1-9]\d{3,4}$/.test(value) && Number(value) >= 1024 && Number(value) <= 65535;
const endpoint = (acceptsHost) => (value) => {
  const [host, service, extra] = value.split(':');
  return extra === undefined && acceptsHost(host) && port(service);
};
const file = (value) => /^\/[\w./-]+$/.test(value);
const host = read('HOST', (value) =>
  /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*$/.test(value),
);
let listener;
let upstream;
if (side === 'timeweb') {
  listener = `${read('BIND', privateAddress)}:${read('PORT', port)}`;
  upstream = read(
    'API_UPSTREAM',
    endpoint((host) => host === (scope === 'stand' ? '127.0.0.1' : 'api-pilot')),
  );
  for (const name of ['SERVER_CERT', 'SERVER_KEY', 'CLIENT_CA']) read(name, file);
} else {
  listener = `127.0.0.1:${read('LOOPBACK_PORT', port)}`;
  upstream = read('PRIVATE_UPSTREAM', endpoint(privateAddress));
  for (const name of ['SERVER_CA', 'CLIENT_CERT', 'CLIENT_KEY']) read(name, file);
}
if (listener === upstream) throw new Error('INVALID_PILOT_CONFIG: listener equals upstream');

const config = fileURLToPath(new URL(`Caddyfile.${side}`, import.meta.url));
const result = spawnSync(
  env.CADDY_BIN || 'caddy',
  ['adapt', '--validate', '--config', config, '--adapter', 'caddyfile'],
  { env, encoding: 'utf8' },
);
if (result.error) throw result.error;
if (result.stderr) process.stderr.write(result.stderr);
if (result.status !== 0) throw new Error('PILOT_CADDY_VALIDATION_FAILED');
const adapted = JSON.parse(result.stdout);
const servers = Object.values(adapted.apps?.http?.servers ?? {});
const server = servers[0];
if (
  adapted.admin?.disabled !== true ||
  servers.length !== 1 ||
  JSON.stringify(server.listen) !== JSON.stringify([listener])
) {
  throw new Error('PILOT_CADDY_LISTENER_DRIFT');
}
const handlers = (routes) =>
  (routes ?? []).flatMap((route) =>
    (route.handle ?? []).flatMap((handler) => [handler, ...handlers(handler.routes)]),
  );
const proxies = handlers(server.routes).filter((handler) => handler.handler === 'reverse_proxy');
if (
  proxies.length !== 1 ||
  proxies[0].upstreams?.length !== 1 ||
  proxies[0].upstreams[0].dial !== upstream
) {
  throw new Error('PILOT_CADDY_UPSTREAM_DRIFT');
}
if (side === 'cup' && proxies[0].transport?.tls?.server_name !== host) {
  throw new Error('PILOT_CADDY_TLS_IDENTITY_DRIFT');
}
if (
  side === 'timeweb' &&
  (server.strict_sni_host !== true ||
    !server.tls_connection_policies?.some(
      (policy) =>
        policy.match?.sni?.includes(host) &&
        policy.client_authentication?.mode === 'require_and_verify',
    ))
) {
  throw new Error('PILOT_CADDY_CLIENT_AUTH_DRIFT');
}
process.stdout.write(
  JSON.stringify({
    side,
    scope,
    host,
    listener,
    upstream,
    adaptedSha256: createHash('sha256').update(result.stdout).digest('hex'),
  }) + '\n',
);
