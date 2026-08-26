#!/usr/bin/env node
import { lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseDocument } from 'yaml';

import { parseStrictJson } from './strict-json.js';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const DEFAULT_PATHS = Object.freeze({
  target: resolve(repositoryRoot, 'deploy/timeweb/target.json'),
  caddyfile: resolve(repositoryRoot, 'deploy/timeweb/Caddyfile'),
  ingress: resolve(repositoryRoot, 'deploy/timeweb/compose.ingress.yaml'),
  application: resolve(repositoryRoot, 'deploy/timeweb/compose.beta.yaml'),
  runtime: resolve(repositoryRoot, 'deploy/timeweb/runtime-environment.contract.json'),
  runbook: resolve(repositoryRoot, 'docs/runbooks/timeweb-lk2-beta.md'),
});
const SERVICES = Object.freeze(['web', 'api', 'realtime', 'worker', 'migrator']);
const ENV_SERVICES = Object.freeze(['api', 'worker', 'realtime', 'migrator']);
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const SSH_FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{43}$/u;
const HISTORICAL_INPUT_ROLES = Object.freeze([
  'releaseDirectory',
  'composeWorkingDirectory',
  'caddyWorkingDirectory',
  'activationInput',
  'futureRollbackInput',
  'secretsSource',
  'mountSource',
]);

export class TimewebDeploymentContractError extends Error {
  constructor(code) {
    super(code);
    this.name = 'TimewebDeploymentContractError';
    this.code = code;
  }
}

function reject(code) {
  throw new TimewebDeploymentContractError(code);
}

function object(value, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) reject(code);
  return value;
}

function exactKeys(value, expected, code) {
  const actual = Object.keys(object(value, code)).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) reject(code);
}

function exactArray(value, expected, code) {
  if (!Array.isArray(value) || JSON.stringify(value) !== JSON.stringify(expected)) reject(code);
}

function uniqueStrings(value, code) {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== 'string' || entry.length === 0) ||
    new Set(value).size !== value.length
  )
    reject(code);
  return value;
}

function strictJsonFile(path, code) {
  try {
    return parseStrictJson(readFileSync(path));
  } catch {
    reject(code);
  }
}

function strictYaml(contents, code) {
  const document = parseDocument(contents, { merge: true, uniqueKeys: true });
  if (document.errors.length > 0 || document.warnings.length > 0) reject(code);
  const value = document.toJS({ mapAsMap: false });
  return object(value, code);
}

export function validateTargetContract(target) {
  exactKeys(
    target,
    [
      'schema',
      'hostname',
      'ipv4',
      'dns',
      'platform',
      'provider',
      'management',
      'network',
      'ingress',
      'release',
    ],
    'target_keys',
  );
  if (target.schema !== 'PHUB_TIMEWEB_TARGET_V1') reject('target_schema');
  if (target.hostname !== 'lk2.padlhub.su') reject('target_hostname');
  if (target.ipv4 !== '103.88.243.171') reject('target_ipv4');

  exactKeys(target.dns, ['aExpected', 'aaaaExpected', 'cnameExpected', 'ttl'], 'target_dns');
  if (
    target.dns.aExpected !== true ||
    target.dns.aaaaExpected !== false ||
    target.dns.cnameExpected !== false ||
    target.dns.ttl !== 300
  )
    reject('target_dns');

  exactKeys(target.platform, ['os', 'architecture', 'hostArchitecture'], 'target_platform');
  if (
    target.platform.os !== 'linux' ||
    target.platform.architecture !== 'amd64' ||
    target.platform.hostArchitecture !== 'x86_64'
  )
    reject('target_platform');

  exactKeys(target.provider, ['name', 'serverName', 'serverId', 'projectId'], 'target_provider');
  if (
    target.provider.name !== 'Timeweb' ||
    target.provider.serverName !== 'Cute Hoopoe' ||
    target.provider.serverId !== 8886471 ||
    target.provider.projectId !== 262717
  )
    reject('target_provider');

  exactKeys(target.management, ['requiredInterface', 'ssh'], 'target_management');
  if (target.management.requiredInterface !== 'tailscale0') reject('target_management_interface');
  exactKeys(target.management.ssh, ['hostKeyAlgorithm', 'pinnedFingerprint'], 'target_ssh');
  if (
    target.management.ssh.hostKeyAlgorithm !== 'ssh-ed25519' ||
    target.management.ssh.pinnedFingerprint !==
      'SHA256:zjTqV+Aj8BvvdK1/HZ8TmMs6OO3zdoORiB96uODoRUw' ||
    !SSH_FINGERPRINT.test(target.management.ssh.pinnedFingerprint)
  )
    reject('target_ssh_fingerprint');

  exactKeys(
    target.network,
    ['name', 'external', 'subnet', 'ingressAddress', 'applicationAddresses'],
    'target_network',
  );
  if (target.network.name !== 'phub-timeweb-beta' || target.network.external !== true)
    reject('target_network_name');
  if (target.network.subnet !== '172.30.26.0/24') reject('target_network_subnet');
  if (target.network.ingressAddress !== '172.30.26.10') reject('target_ingress_address');
  exactKeys(target.network.applicationAddresses, SERVICES, 'target_application_addresses');
  const expectedAddresses = {
    web: '172.30.26.11',
    api: '172.30.26.12',
    realtime: '172.30.26.13',
    worker: '172.30.26.14',
    migrator: '172.30.26.15',
  };
  for (const service of SERVICES) {
    if (target.network.applicationAddresses[service] !== expectedAddresses[service])
      reject('target_application_addresses');
  }
  if (
    new Set([target.network.ingressAddress, ...Object.values(target.network.applicationAddresses)])
      .size !== 6
  )
    reject('target_duplicate_address');

  exactKeys(target.ingress, ['ports', 'onlyIngressMayBindHostPorts', 'caddy'], 'target_ingress');
  exactArray(target.ingress.ports, [80, 443], 'target_ingress_ports');
  if (target.ingress.onlyIngressMayBindHostPorts !== true) reject('target_ingress_ports');
  exactKeys(
    target.ingress.caddy,
    [
      'repository',
      'indexDigest',
      'linuxAmd64ManifestDigest',
      'linuxAmd64ConfigDigest',
      'version',
      'adaptedJsonSha256',
    ],
    'target_caddy',
  );
  if (
    target.ingress.caddy.repository !== 'caddy' ||
    target.ingress.caddy.indexDigest !==
      'sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648' ||
    target.ingress.caddy.linuxAmd64ManifestDigest !==
      'sha256:98eb57d882ccd5213d1688764db10c1ca2c58a1ca3a6717a3411ad798f7a423a' ||
    target.ingress.caddy.linuxAmd64ConfigDigest !==
      'sha256:af555904a0961945f16bb323a501457b13a4f7e9bde969b145b97da80b38ecbe' ||
    target.ingress.caddy.version !== 'v2.11.4' ||
    target.ingress.caddy.adaptedJsonSha256 !==
      'afdc50d2324f94760c2630f78e5da0ade3f72589efbdec7e175cf476d516f21b' ||
    !DIGEST.test(target.ingress.caddy.indexDigest) ||
    !DIGEST.test(target.ingress.caddy.linuxAmd64ManifestDigest) ||
    !DIGEST.test(target.ingress.caddy.linuxAmd64ConfigDigest)
  )
    reject('target_caddy');

  exactKeys(target.release, ['root', 'historicalEvidence'], 'target_release');
  if (target.release.root !== '/opt/phub/timeweb-beta/releases') reject('target_release_root');
  if (
    !Array.isArray(target.release.historicalEvidence) ||
    target.release.historicalEvidence.length !== 2
  )
    reject('target_historical_evidence');
  const expectedEvidence = [
    '/opt/phub/timeweb-beta/staging/ac8f0aad-contract5004571-20260826T133721Z',
    '/opt/phub/timeweb-beta/rollback/ac8f0aad-contract5004571-20260826T133721Z',
  ];
  for (const [index, entry] of target.release.historicalEvidence.entries()) {
    exactKeys(
      entry,
      [
        'path',
        'immutableEvidence',
        'validReleaseDirectory',
        'validActivationInput',
        'validRollbackInputForFutureRelease',
      ],
      'target_historical_evidence',
    );
    if (
      entry.path !== expectedEvidence[index] ||
      entry.immutableEvidence !== true ||
      entry.validReleaseDirectory !== false ||
      entry.validActivationInput !== false ||
      entry.validRollbackInputForFutureRelease !== false
    )
      reject('target_historical_evidence');
  }
  return target;
}

function isSameOrDescendant(root, candidate) {
  const pathFromRoot = relative(resolve(root), resolve(candidate));
  return pathFromRoot === '' || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== '..');
}

function resolveThroughExistingAncestor(candidate) {
  const original = resolve(candidate);
  let cursor = original;
  const suffix = [];
  while (true) {
    try {
      return resolve(realpathSync(cursor), ...suffix.reverse());
    } catch {
      const parent = dirname(cursor);
      if (parent === cursor) return original;
      suffix.push(basename(cursor));
      cursor = parent;
    }
  }
}

export function validateHistoricalEvidenceInput(target, candidate, role) {
  if (typeof candidate !== 'string' || !HISTORICAL_INPUT_ROLES.includes(role))
    reject('historical_evidence_input');
  const resolvedCandidate = resolve(candidate);
  const canonicalCandidate = resolveThroughExistingAncestor(candidate);
  if (canonicalCandidate !== resolvedCandidate) reject('filesystem_alias_input');
  for (const { path } of target.release.historicalEvidence) {
    for (const historicalRoot of [resolve(path), resolveThroughExistingAncestor(path)]) {
      if (
        isSameOrDescendant(historicalRoot, resolvedCandidate) ||
        isSameOrDescendant(historicalRoot, canonicalCandidate)
      )
        reject('historical_evidence_input');
    }
  }
  return candidate;
}

export function validateFutureReleaseDirectory(target, candidate) {
  validateHistoricalEvidenceInput(target, candidate, 'releaseDirectory');
  const prefix = `${target.release.root}/`;
  if (
    typeof candidate !== 'string' ||
    !candidate.startsWith(prefix) ||
    !/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(candidate.slice(prefix.length))
  )
    reject('future_release_directory');
  return candidate;
}

export function validateCaddyfile(contents, target) {
  if (!/^\{[\s\S]*?\badmin off\b[\s\S]*?output stdout[\s\S]*?format json[\s\S]*?\}/u.test(contents))
    reject('caddy_global');
  if (!contents.includes(`\n${target.hostname} {`)) reject('caddy_hostname');
  if (/\{\$LK2_BETA_HOST\}|https?:\/\/|\badmin\s+(?:localhost|0\.0\.0\.0|:)/u.test(contents))
    reject('caddy_host_or_admin');
  for (const required of [
    'encode zstd gzip',
    'Strict-Transport-Security "max-age=31536000"',
    'X-Content-Type-Options "nosniff"',
    'X-Frame-Options "SAMEORIGIN"',
    'Referrer-Policy "same-origin"',
    '-Server',
    '@api path /health/* /public/api/* /user/api/*',
    'reverse_proxy api:3000',
    'handle /realtime/health/live',
    'handle /realtime/health/ready',
    'handle /realtime/*',
    'reverse_proxy realtime:3001',
    'reverse_proxy web:8080',
  ]) {
    if (!contents.includes(required)) reject('caddy_required_contract');
  }
  if (/\/(?:internal|admin)\/api|Authorization|Cookie|X-Api-Key/iu.test(contents))
    reject('caddy_exposure_or_secret');
  const siteAddresses = [...contents.matchAll(/^([^\s{}][^{}]*)\s*\{$/gmu)].map((match) =>
    match[1].trim(),
  );
  exactArray(siteAddresses, [target.hostname], 'caddy_unrelated_site');
  const namedMatchers = [...contents.matchAll(/^\s*(@\w+\s+.+)$/gmu)].map((match) =>
    match[1].trim(),
  );
  exactArray(namedMatchers, ['@api path /health/* /public/api/* /user/api/*'], 'caddy_matchers');
  const selectors = [...contents.matchAll(/^\s*handle(?:\s+([^\s{]+))?\s*\{/gmu)].map(
    (match) => match[1] ?? '<default>',
  );
  exactArray(
    selectors,
    ['@api', '/realtime/health/live', '/realtime/health/ready', '/realtime/*', '<default>'],
    'caddy_unexpected_route',
  );
}

function validateLogging(logging, expectedSize, expectedFiles, code) {
  exactKeys(logging, ['driver', 'options'], code);
  exactKeys(logging.options, ['max-size', 'max-file'], code);
  if (
    logging.driver !== 'local' ||
    logging.options['max-size'] !== expectedSize ||
    logging.options['max-file'] !== expectedFiles
  )
    reject(code);
}

export function validateIngressCompose(contents, target) {
  const compose = strictYaml(contents, 'ingress_yaml');
  exactKeys(compose, ['name', 'services', 'networks', 'volumes'], 'ingress_top_level');
  if (compose.name !== 'phub-timeweb-beta-ingress') reject('ingress_name');
  exactKeys(compose.services, ['caddy'], 'ingress_services');
  const caddy = object(compose.services.caddy, 'ingress_caddy');
  const ingressKeys = ['image', 'restart', 'ports', 'volumes', 'networks', 'logging'];
  if (JSON.stringify(Object.keys(caddy).sort()) !== JSON.stringify([...ingressKeys].sort()))
    reject('ingress_escape');
  const expectedImage = `${target.ingress.caddy.repository}@${target.ingress.caddy.indexDigest}`;
  if (caddy.image !== expectedImage || !/@sha256:[0-9a-f]{64}$/u.test(caddy.image))
    reject('ingress_image');
  if (caddy.restart !== 'unless-stopped') reject('ingress_restart');
  exactArray(caddy.ports, ['0.0.0.0:80:80/tcp', '0.0.0.0:443:443/tcp'], 'ingress_ports');
  if (JSON.stringify(caddy).includes('/var/run/docker.sock')) reject('ingress_socket');
  exactArray(
    caddy.volumes,
    ['./Caddyfile:/etc/caddy/Caddyfile:ro', 'caddy_data:/data', 'caddy_config:/config'],
    'ingress_volumes',
  );
  exactKeys(compose.volumes, ['caddy_data', 'caddy_config'], 'ingress_named_volumes');
  exactKeys(compose.volumes.caddy_data, ['name'], 'ingress_named_volumes');
  exactKeys(compose.volumes.caddy_config, ['name'], 'ingress_named_volumes');
  if (
    compose.volumes.caddy_data.name !== 'phub-timeweb-beta-caddy-data' ||
    compose.volumes.caddy_config.name !== 'phub-timeweb-beta-caddy-config'
  )
    reject('ingress_named_volumes');
  exactKeys(compose.networks, ['beta'], 'ingress_network');
  exactKeys(compose.networks.beta, ['external', 'name'], 'ingress_network');
  exactKeys(caddy.networks, ['beta'], 'ingress_network');
  exactKeys(caddy.networks.beta, ['ipv4_address'], 'ingress_network');
  if (
    compose.networks.beta.external !== true ||
    compose.networks.beta.name !== target.network.name ||
    caddy.networks?.beta?.ipv4_address !== target.network.ingressAddress
  )
    reject('ingress_network');
  validateLogging(caddy.logging, '10m', '3', 'ingress_logging');
  return compose;
}

export function validateApplicationCompose(contents, target) {
  const compose = strictYaml(contents, 'application_yaml');
  exactKeys(compose, ['name', 'x-runtime', 'services', 'networks'], 'application_top_level');
  if (compose.name !== 'phub-timeweb-beta') reject('application_name');
  exactKeys(compose.services, SERVICES, 'application_services');
  exactKeys(compose.networks, ['beta'], 'application_network');
  exactKeys(compose.networks.beta, ['external', 'name'], 'application_network');
  if (compose.networks.beta.external !== true || compose.networks.beta.name !== target.network.name)
    reject('application_network');
  exactKeys(compose['x-runtime'], ['restart', 'networks', 'logging'], 'application_runtime');
  if (compose['x-runtime'].restart !== 'unless-stopped') reject('application_runtime');
  exactKeys(compose['x-runtime'].networks, ['beta'], 'application_runtime');
  if (compose['x-runtime'].networks.beta !== null) reject('application_runtime');
  validateLogging(compose['x-runtime'].logging, '20m', '5', 'application_runtime');
  const images = [];
  const addresses = [];
  for (const serviceName of SERVICES) {
    const service = object(compose.services[serviceName], 'application_service');
    if (serviceName === 'worker' && !Object.hasOwn(service, 'profiles'))
      reject('application_worker_profile');
    if (serviceName === 'migrator' && !Object.hasOwn(service, 'profiles'))
      reject('application_migrator_profile');
    const dependencyNames = Array.isArray(service.depends_on)
      ? service.depends_on
      : Object.keys(service.depends_on ?? {});
    if (dependencyNames.includes('worker') || dependencyNames.includes('migrator'))
      reject('application_default_dependency');
    if (
      serviceName !== 'web' &&
      (!Array.isArray(service.env_file) || service.env_file.length !== 1)
    )
      reject('application_env_file');
    const expectedKeys = {
      web: ['restart', 'networks', 'logging', 'image', 'healthcheck'],
      api: [
        'restart',
        'networks',
        'logging',
        'image',
        'env_file',
        'healthcheck',
        'stop_grace_period',
      ],
      realtime: [
        'restart',
        'networks',
        'logging',
        'image',
        'env_file',
        'healthcheck',
        'stop_grace_period',
      ],
      worker: [
        'restart',
        'networks',
        'logging',
        'profiles',
        'image',
        'env_file',
        'healthcheck',
        'stop_grace_period',
      ],
      migrator: ['image', 'restart', 'profiles', 'env_file', 'healthcheck', 'networks'],
    };
    if (Object.hasOwn(service, 'environment')) reject('application_secret_literal');
    if (
      JSON.stringify(Object.keys(service).sort()) !==
      JSON.stringify([...expectedKeys[serviceName]].sort())
    )
      reject('application_escape');
    const variable = `${serviceName.toUpperCase()}_IMAGE_DIGEST`;
    const expected = `ghcr.io/z6v6e6r/phub-${serviceName}@\${${variable}:?${variable} is required}`;
    if (service.image !== expected) reject('application_image');
    images.push(service.image);
    const address = service.networks?.beta?.ipv4_address;
    exactKeys(service.networks, ['beta'], 'application_network');
    exactKeys(service.networks.beta, ['ipv4_address'], 'application_network');
    if (address !== target.network.applicationAddresses[serviceName]) reject('application_address');
    addresses.push(address);
    const expectedHealthchecks = {
      web: ['CMD-SHELL', 'wget -q -O /dev/null http://127.0.0.1:8080/healthz'],
      api: [
        'CMD',
        'node',
        '-e',
        "fetch('http://127.0.0.1:3000/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))",
      ],
      realtime: [
        'CMD',
        'node',
        '-e',
        "fetch('http://127.0.0.1:3001/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))",
      ],
      worker: [
        'CMD',
        'node',
        '-e',
        "fetch('http://127.0.0.1:3002/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))",
      ],
      migrator: [
        'CMD',
        'node',
        '-e',
        "require('node:fs').accessSync('/app/apps/migrator/dist/main.js')",
      ],
    };
    if (
      !service.healthcheck ||
      JSON.stringify(service.healthcheck.test) !== JSON.stringify(expectedHealthchecks[serviceName])
    )
      reject('application_healthcheck');
    const expectedHealthcheckKeys =
      serviceName === 'migrator'
        ? ['test', 'interval', 'timeout', 'retries']
        : ['test', 'interval', 'timeout', 'retries', 'start_period'];
    exactKeys(service.healthcheck, expectedHealthcheckKeys, 'application_healthcheck');
    if (
      service.healthcheck.interval !== (serviceName === 'migrator' ? '30s' : '10s') ||
      service.healthcheck.timeout !== '5s' ||
      service.healthcheck.retries !== (serviceName === 'migrator' ? 1 : 5) ||
      (serviceName !== 'migrator' &&
        service.healthcheck.start_period !== (serviceName === 'web' ? '10s' : '30s'))
    )
      reject('application_healthcheck');
    if (serviceName !== 'web') {
      const expectedPath = `\${TIMEWEB_RUNTIME_ENV_ROOT:?TIMEWEB_RUNTIME_ENV_ROOT is required}/${serviceName}.env`;
      if (Array.isArray(service.env_file) && service.env_file.length === 1)
        exactKeys(service.env_file[0], ['path', 'required'], 'application_env_file');
      if (
        !Array.isArray(service.env_file) ||
        service.env_file.length !== 1 ||
        service.env_file[0]?.path !== expectedPath ||
        service.env_file[0]?.required !== true
      )
        reject('application_env_file');
    }
    if (serviceName !== 'migrator') {
      if (service.restart !== 'unless-stopped') reject('application_restart');
      validateLogging(service.logging, '20m', '5', 'application_logging');
    } else if (service.restart !== 'no') reject('application_restart');
    if (serviceName === 'api' || serviceName === 'realtime') {
      if (service.stop_grace_period !== '30s') reject('application_stop_grace_period');
    }
    if (serviceName === 'worker' && service.stop_grace_period !== '60s')
      reject('application_stop_grace_period');
  }
  if (new Set(images).size !== SERVICES.length) reject('application_duplicate_image');
  if (new Set(addresses).size !== SERVICES.length) reject('application_duplicate_address');
  exactArray(compose.services.worker.profiles, ['background'], 'application_worker_profile');
  exactArray(compose.services.migrator.profiles, ['migration'], 'application_migrator_profile');
  if (
    Object.hasOwn(compose.services.web, 'profiles') ||
    Object.hasOwn(compose.services.api, 'profiles')
  )
    reject('application_default_profiles');
  if (Object.hasOwn(compose.services.realtime, 'profiles')) reject('application_default_profiles');
  if (
    /\blatest\b|image:\s*\$\{|(?:JWT|PASSWORD|SECRET|TOKEN|API_KEY)[A-Z0-9_]*\s*:/iu.test(contents)
  )
    reject('application_mutable_or_secret');
  return compose;
}

export function validateRuntimeContract(contract) {
  exactKeys(
    contract,
    ['schema', 'rootOnlyDirectory', 'identityFields', 'dependencySchemes', 'services'],
    'runtime_contract_keys',
  );
  if (contract.schema !== 'PHUB_TIMEWEB_RUNTIME_ENV_V1') reject('runtime_contract_schema');
  if (contract.rootOnlyDirectory !== '/etc/phub/timeweb-beta') reject('runtime_contract_root');
  exactArray(contract.identityFields, ['LK2_BETA_HOST', 'TENANT_KEY'], 'runtime_identity_fields');
  exactKeys(
    contract.dependencySchemes,
    ['DATABASE_URL', 'REDIS_URL', 'RABBITMQ_URL'],
    'runtime_schemes',
  );
  exactArray(
    contract.dependencySchemes.DATABASE_URL,
    ['postgres', 'postgresql'],
    'runtime_schemes',
  );
  exactArray(contract.dependencySchemes.REDIS_URL, ['redis', 'rediss'], 'runtime_schemes');
  exactArray(contract.dependencySchemes.RABBITMQ_URL, ['amqp', 'amqps'], 'runtime_schemes');
  exactKeys(contract.services, ENV_SERVICES, 'runtime_services');
  for (const serviceName of ENV_SERVICES) {
    const service = object(contract.services[serviceName], 'runtime_service');
    exactKeys(
      service,
      [
        'required',
        'allowed',
        'forbidden',
        'requiredTrueFlags',
        'requiredFalseFlags',
        'requiredDisabledModes',
        'requiredOffModes',
      ],
      'runtime_service_keys',
    );
    const required = uniqueStrings(service.required, 'runtime_required');
    const allowed = new Set(uniqueStrings(service.allowed, 'runtime_allowed'));
    const forbidden = new Set(uniqueStrings(service.forbidden, 'runtime_forbidden'));
    for (const key of required) if (!allowed.has(key)) reject('runtime_required_not_allowed');
    for (const key of forbidden) if (allowed.has(key)) reject('runtime_forbidden_allowed');
    for (const group of [
      service.requiredTrueFlags,
      service.requiredFalseFlags,
      service.requiredDisabledModes,
      service.requiredOffModes,
    ]) {
      for (const key of uniqueStrings(group, 'runtime_state_keys')) {
        if (!required.includes(key)) reject('runtime_state_not_required');
      }
    }
  }
  return contract;
}

export function parseEnvironment(contents) {
  const environment = Object.create(null);
  for (const rawLine of contents.split('\n')) {
    if (rawLine === '' || rawLine.startsWith('#')) continue;
    const match = rawLine.match(/^([A-Z][A-Z0-9_]*)=(.*)$/u);
    if (!match) reject('env_format');
    const [, key, value] = match;
    if (Object.hasOwn(environment, key)) reject('env_duplicate');
    if (value.length === 0 || /[\r\0]/u.test(value)) reject('env_empty_value');
    environment[key] = value;
  }
  return environment;
}

function dependencyIdentity(key, value, schemes) {
  let url;
  try {
    url = new URL(value);
  } catch {
    reject(`env_${key}_url`);
  }
  if (!schemes.includes(url.protocol.slice(0, -1)) || !url.hostname) reject(`env_${key}_scheme`);
  url.username = '';
  url.password = '';
  return url.toString();
}

export function validateRuntimeEnvironments(environments, contract, target) {
  for (const serviceName of ENV_SERVICES) {
    const values = object(environments[serviceName], 'env_service');
    const service = contract.services[serviceName];
    for (const forbidden of service.forbidden) {
      if (Object.hasOwn(values, forbidden)) reject(`env_${serviceName}_forbidden_key`);
    }
    for (const key of Object.keys(values)) {
      if (!service.allowed.includes(key)) {
        if (key.endsWith('_ENABLED') && values[key] === 'true')
          reject(`env_${serviceName}_unknown_enabled_flag`);
        reject(`env_${serviceName}_unknown_key`);
      }
      if (values[key].length === 0) reject(`env_${serviceName}_empty_value`);
    }
    for (const required of service.required) {
      if (!Object.hasOwn(values, required)) reject(`env_${serviceName}_missing_key`);
    }
    for (const key of service.requiredTrueFlags)
      if (values[key] !== 'true') reject(`env_${serviceName}_flag`);
    for (const key of service.requiredFalseFlags)
      if (values[key] !== 'false') reject(`env_${serviceName}_flag`);
    for (const key of service.requiredDisabledModes)
      if (values[key] !== 'disabled') reject(`env_${serviceName}_mode`);
    for (const key of service.requiredOffModes)
      if (values[key] !== 'OFF') reject(`env_${serviceName}_mode`);
  }
  for (const name of ['api', 'worker', 'realtime']) {
    if (environments[name].APP_ENV !== 'staging') reject(`env_${name}_app_env`);
  }
  if (
    environments.api.LK2_BETA_HOST !== target.hostname ||
    environments.api.CORS_ORIGINS !== `https://${target.hostname}` ||
    environments.api.TRUSTED_PROXY_CIDRS !== `${target.network.ingressAddress}/32` ||
    environments.api.AUTH_COOKIE_SECURE !== 'true' ||
    environments.api.VIVA_MODE !== 'production'
  )
    reject('env_api_target');
  for (const key of [
    'JWT_ACCESS_SECRET',
    'JWT_REFRESH_SECRET',
    'JWT_REALTIME_SECRET',
    'VIVA_DELEGATION_ENCRYPTION_KEY',
  ]) {
    if (environments.api[key].length < 32) reject('env_api_key_material');
  }
  if (
    new Set([
      environments.api.JWT_ACCESS_SECRET,
      environments.api.JWT_REFRESH_SECRET,
      environments.api.JWT_REALTIME_SECRET,
      environments.api.VIVA_DELEGATION_ENCRYPTION_KEY,
    ]).size !== 4
  )
    reject('env_api_key_separation');
  const tenantKey = environments.api.TENANT_KEY;
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/u.test(tenantKey) || environments.worker.TENANT_KEY !== tenantKey)
    reject('env_tenant_identity');
  if (
    environments.api.VIVA_OAUTH_REDIRECT_URI !==
      `https://${target.hostname}/user/api/v1/${tenantKey}/auth/viva/callback` ||
    environments.api.VIVA_OAUTH_SUCCESS_REDIRECT_URL !== `https://${target.hostname}/`
  )
    reject('env_oauth_target');
  if (
    environments.worker.OUTBOX_PUBLISH_MODE !== 'leased' ||
    environments.worker.WORKER_RUNTIME_SECRET_ISOLATION_REQUIRED !== 'true'
  )
    reject('env_worker_initial_contour');
  for (const key of Object.keys(contract.dependencySchemes)) {
    const identities = ['api', 'worker', 'realtime'].map((name) =>
      dependencyIdentity(key, environments[name][key], contract.dependencySchemes[key]),
    );
    if (new Set(identities).size !== 1) reject(`env_${key}_contour`);
  }
  if (
    dependencyIdentity(
      'DATABASE_URL',
      environments.migrator.DATABASE_URL,
      contract.dependencySchemes.DATABASE_URL,
    ) !==
    dependencyIdentity(
      'DATABASE_URL',
      environments.api.DATABASE_URL,
      contract.dependencySchemes.DATABASE_URL,
    )
  )
    reject('env_migrator_DATABASE_URL_contour');
  for (const key of ['JWT_ISSUER', 'JWT_AUDIENCE']) {
    if (
      environments.api[key] !== environments.worker[key] ||
      environments.api[key] !== environments.realtime[key]
    )
      reject(`env_${key}_identity`);
  }
  if (
    environments.api.JWT_REALTIME_AUDIENCE !== environments.realtime.JWT_REALTIME_AUDIENCE ||
    environments.api.JWT_REALTIME_SECRET !== environments.realtime.JWT_REALTIME_SECRET
  )
    reject('env_realtime_ticket_identity');
  if (
    new Set(
      ['api', 'worker', 'realtime'].map(
        (serviceName) => environments[serviceName].OTEL_SERVICE_INSTANCE_ID,
      ),
    ).size !== 3
  )
    reject('env_instance_identity');
}

export function validateRunbook(contents, target) {
  for (const evidence of target.release.historicalEvidence) {
    if (!contents.includes(evidence.path)) reject('runbook_historical_evidence');
  }
  for (const required of [
    'DNS preflight: READY',
    'VPS ingress preflight: READY',
    'source-only',
    'does not authorize deployment',
    'immutable historical evidence',
    'not an activation input',
    'firewall remains unchanged',
  ]) {
    if (!contents.includes(required)) reject('runbook_preflight_contract');
  }
  if (
    /docker(?:\s+--context\s+\S+)?\s+compose\s+[^\n]*(?:up|create|run)\b/iu.test(contents) ||
    /docker(?:\s+--context\s+\S+)?\s+(?:network|volume)\s+create\b/iu.test(contents) ||
    /\b(?:compose_beta|compose_ingress)\s+(?:up|create|run)\b/iu.test(contents)
  )
    reject('runbook_activation_command');
}

export function validateRuntimeEnvironmentRoot(target, runtime, candidate) {
  const root = resolve(candidate);
  if (target.release.historicalEvidence.some(({ path }) => isSameOrDescendant(path, root)))
    reject('historical_evidence_input');
  const runnerTemp = process.env.RUNNER_TEMP ? resolve(process.env.RUNNER_TEMP) : undefined;
  const canonicalRuntimeRoot = resolve(runtime.rootOnlyDirectory);
  const syntheticRunnerRoot =
    runnerTemp && root !== runnerTemp && isSameOrDescendant(runnerTemp, root);
  if (root !== canonicalRuntimeRoot && !syntheticRunnerRoot) reject('env_root_contract');
  try {
    if (lstatSync(root).isSymbolicLink() || realpathSync(root) !== root) reject('env_root_symlink');
  } catch (error) {
    if (error instanceof TimewebDeploymentContractError) throw error;
    reject('env_root_unavailable');
  }
  validateHistoricalEvidenceInput(target, root, 'secretsSource');
  validateHistoricalEvidenceInput(target, root, 'mountSource');
  validateHistoricalEvidenceInput(target, realpathSync(root), 'secretsSource');
  return root;
}

export function validateDeploymentInputPaths(target, runtime, paths) {
  for (const [candidate, roles] of [
    [paths.target, ['activationInput']],
    [paths.runtime, ['secretsSource']],
    [paths.caddyfile, ['mountSource']],
    [dirname(paths.caddyfile), ['caddyWorkingDirectory']],
    [paths.ingress, ['activationInput']],
    [dirname(paths.ingress), ['composeWorkingDirectory']],
    [paths.application, ['activationInput']],
    [dirname(paths.application), ['composeWorkingDirectory']],
    [paths.runbook, ['activationInput']],
  ]) {
    for (const role of roles) validateHistoricalEvidenceInput(target, candidate, role);
  }
  if (paths.envRoot) validateRuntimeEnvironmentRoot(target, runtime, paths.envRoot);
}

function validateEnvironmentFile(target, envRoot, service) {
  const candidate = resolve(envRoot, `${service}.env`);
  try {
    if (lstatSync(candidate).isSymbolicLink()) reject('env_file_symlink');
    const canonical = realpathSync(candidate);
    if (canonical !== candidate || dirname(canonical) !== envRoot) reject('env_file_symlink');
    validateHistoricalEvidenceInput(target, canonical, 'secretsSource');
  } catch (error) {
    if (error instanceof TimewebDeploymentContractError) throw error;
    reject('env_file_unavailable');
  }
  validateHistoricalEvidenceInput(target, candidate, 'secretsSource');
  return candidate;
}

function parseArguments(argv) {
  const result = { ...DEFAULT_PATHS, diagnostic: undefined, envRoot: undefined };
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!value) reject('arguments');
    const key = {
      '--target': 'target',
      '--caddyfile': 'caddyfile',
      '--ingress': 'ingress',
      '--application': 'application',
      '--runtime-contract': 'runtime',
      '--runbook': 'runbook',
      '--diagnostic': 'diagnostic',
      '--env-root': 'envRoot',
    }[flag];
    if (!key) reject('arguments');
    result[key] = resolve(value);
  }
  return result;
}

function writeDiagnostic(path, diagnostic) {
  if (!process.env.RUNNER_TEMP) reject('diagnostic_runner_temp');
  const runnerTemp = resolve(process.env.RUNNER_TEMP);
  const destination = resolve(path);
  const pathFromRunner = relative(runnerTemp, destination);
  if (
    pathFromRunner.startsWith(`..${sep}`) ||
    pathFromRunner === '..' ||
    isAbsolute(pathFromRunner)
  )
    reject('diagnostic_path');
  writeFileSync(destination, `${JSON.stringify(diagnostic)}\n`, { flag: 'wx', mode: 0o600 });
}

export function verifyDeploymentContract(paths = DEFAULT_PATHS) {
  const target = validateTargetContract(strictJsonFile(paths.target, 'target_json'));
  const runtime = validateRuntimeContract(strictJsonFile(paths.runtime, 'runtime_json'));
  validateDeploymentInputPaths(target, runtime, paths);
  validateCaddyfile(readFileSync(paths.caddyfile, 'utf8'), target);
  validateIngressCompose(readFileSync(paths.ingress, 'utf8'), target);
  validateApplicationCompose(readFileSync(paths.application, 'utf8'), target);
  validateRunbook(readFileSync(paths.runbook, 'utf8'), target);
  validateFutureReleaseDirectory(target, `${target.release.root}/future-release-id`);
  if (paths.envRoot) {
    const envRoot = validateRuntimeEnvironmentRoot(target, runtime, paths.envRoot);
    const environments = Object.fromEntries(
      ENV_SERVICES.map((service) => [
        service,
        parseEnvironment(readFileSync(validateEnvironmentFile(target, envRoot, service), 'utf8')),
      ]),
    );
    validateRuntimeEnvironments(environments, runtime, target);
  }
  return {
    schema: 'PHUB_TIMEWEB_DEPLOYMENT_DIAGNOSTIC_V1',
    status: 'pass',
    target: target.hostname,
    network: target.network.name,
    applicationServices: SERVICES,
    historicalEvidenceExcluded: target.release.historicalEvidence.length,
  };
}

function main() {
  const paths = parseArguments(process.argv.slice(2));
  const diagnostic = verifyDeploymentContract(paths);
  if (paths.diagnostic) writeDiagnostic(paths.diagnostic, diagnostic);
  process.stdout.write(`${JSON.stringify(diagnostic)}\n`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    const code = error instanceof TimewebDeploymentContractError ? error.code : 'unexpected_error';
    process.stderr.write(`${JSON.stringify({ status: 'fail', code })}\n`);
    process.exitCode = 1;
  }
}
