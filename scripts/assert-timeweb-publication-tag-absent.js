#!/usr/bin/env node

const allowedServices = new Set(['web', 'api', 'worker', 'realtime', 'migrator']);
const shaTagPattern = /^amd64-sha-[0-9a-f]{40}-[1-9][0-9]*-1$/u;
const registryTokenPattern = /^[A-Za-z0-9._~+/-]+=*$/u;
const defaultOrigin = 'https://ghcr.io';
const timeoutMilliseconds = 15_000;

const fail = (marker, details = '') => {
  const suffix = details ? `|${details}` : '';
  console.error(`::error::PHUB_TIMEWEB_TAG_GUARD_${marker}${suffix}`);
  process.exit(1);
};

const parseArguments = () => {
  const values = new Map();
  for (let index = 2; index < process.argv.length; index += 2) {
    const name = process.argv[index];
    const value = process.argv[index + 1];
    if (!name?.startsWith('--') || value === undefined) fail('INVALID_ARGUMENTS');
    values.set(name, value);
  }
  if (values.size !== 2) fail('INVALID_ARGUMENTS');
  return {
    service: values.get('--service'),
    tag: values.get('--tag'),
  };
};

const { service, tag } = parseArguments();
if (!service || !allowedServices.has(service)) fail('INVALID_SERVICE');
if (!tag || !shaTagPattern.test(tag)) fail('INVALID_TAG');

const actor = process.env.GITHUB_ACTOR;
const githubToken = process.env.GITHUB_TOKEN;
if (!actor || !githubToken) fail('MISSING_CREDENTIALS');

const origin = process.env.PHUB_GHCR_TAG_GUARD_ORIGIN ?? defaultOrigin;
let registryOrigin;
try {
  registryOrigin = new URL(origin);
} catch {
  fail('INVALID_REGISTRY_ORIGIN');
}
const isTestOrigin =
  process.env.PHUB_GHCR_TAG_GUARD_TESTING === '1' &&
  registryOrigin.protocol === 'https:' &&
  (registryOrigin.hostname === 'localhost' || registryOrigin.hostname === '127.0.0.1');
if (registryOrigin.origin !== defaultOrigin && !isTestOrigin) fail('INVALID_REGISTRY_ORIGIN');
if (
  registryOrigin.username ||
  registryOrigin.password ||
  registryOrigin.pathname !== '/' ||
  registryOrigin.search ||
  registryOrigin.hash
) {
  fail('INVALID_REGISTRY_ORIGIN');
}

const fetchWithTimeout = async (url, init) => {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMilliseconds) });
  } catch {
    fail('TRANSPORT_FAILURE');
  }
};

const scope = `repository:z6v6e6r/phub-${service}:pull`;
const tokenUrl = new URL('/token', registryOrigin);
tokenUrl.searchParams.set('service', 'ghcr.io');
tokenUrl.searchParams.set('scope', scope);
const tokenResponse = await fetchWithTimeout(tokenUrl, {
  redirect: 'error',
  headers: {
    authorization: `Basic ${Buffer.from(`${actor}:${githubToken}`).toString('base64')}`,
  },
});
if (tokenResponse.status !== 200) fail('TOKEN_REQUEST_REJECTED', `status=${tokenResponse.status}`);

let tokenPayload;
try {
  tokenPayload = await tokenResponse.json();
} catch {
  fail('INVALID_TOKEN_RESPONSE');
}
const registryToken = tokenPayload?.token ?? tokenPayload?.access_token;
if (
  typeof registryToken !== 'string' ||
  registryToken.length === 0 ||
  registryToken.length > 16_384 ||
  !registryTokenPattern.test(registryToken)
) {
  fail('INVALID_TOKEN_RESPONSE');
}

const manifestUrl = new URL(
  `/v2/z6v6e6r/phub-${service}/manifests/${encodeURIComponent(tag)}`,
  registryOrigin,
);
const manifestResponse = await fetchWithTimeout(manifestUrl, {
  redirect: 'error',
  headers: {
    accept: [
      'application/vnd.oci.image.index.v1+json',
      'application/vnd.docker.distribution.manifest.list.v2+json',
      'application/vnd.oci.image.manifest.v1+json',
      'application/vnd.docker.distribution.manifest.v2+json',
    ].join(', '),
    authorization: `Bearer ${registryToken}`,
  },
});

if (manifestResponse.status === 200) {
  await manifestResponse.body?.cancel();
  fail('TAG_ALREADY_EXISTS', `service=${service}`);
}
if (manifestResponse.status !== 404) {
  await manifestResponse.body?.cancel();
  fail('REGISTRY_LOOKUP_INDETERMINATE', `status=${manifestResponse.status}|service=${service}`);
}

let errorPayload;
try {
  errorPayload = await manifestResponse.json();
} catch {
  fail('INVALID_NOT_FOUND_RESPONSE', `service=${service}`);
}
const provesManifestUnknown =
  Array.isArray(errorPayload?.errors) &&
  errorPayload.errors.length === 1 &&
  errorPayload.errors[0]?.code === 'MANIFEST_UNKNOWN';
if (!provesManifestUnknown) fail('UNEXPECTED_NOT_FOUND_RESPONSE', `service=${service}`);

console.error(`PHUB_TIMEWEB_TAG_GUARD_ABSENT|service=${service}`);
