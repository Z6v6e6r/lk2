import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:net';

type Scenario =
  | 'direct'
  | 'one-relative-redirect'
  | 'three-redirects'
  | 'redirect-loop'
  | 'too-many-redirects'
  | 'missing-location'
  | 'invalid-location'
  | 'https-downgrade'
  | 'cross-origin-signed'
  | 'reset'
  | 'timeout'
  | 'slow-body'
  | 'oversized'
  | 'empty'
  | 'html'
  | 'invalid-json'
  | 'digest-mismatch'
  | `status-${401 | 403 | 404 | 429 | 500 | 503}`;

interface RequestObservation {
  readonly authorization: string | null;
  readonly cookie: string | null;
  readonly hasExpiryQuery: boolean;
  readonly hasSignatureQuery: boolean;
  readonly path: string;
  readonly server: 'blob' | 'registry';
}

interface ScenarioResult {
  readonly bytesMatch: boolean;
  readonly destinationExists: boolean;
  readonly leakedSignature: boolean;
  readonly leakedToken: boolean;
  readonly markers: readonly string[];
  readonly requests: readonly RequestObservation[];
  readonly status: number | null;
}

const helper = process.argv[2];
if (!helper) throw new Error('helper path is required');

const token = 'fixture-registry-token';
const signature = 'fixture-sensitive-signature';
const statement = JSON.stringify({
  _type: 'https://in-toto.io/Statement/v1',
  predicateType: 'https://slsa.dev/provenance/v1',
});
const directory = await mkdtemp(join(tmpdir(), 'phub-timeweb-blob-fetch-'));
const certificate = join(directory, 'certificate.pem');
const key = join(directory, 'key.pem');
const opensslConfig = join(directory, 'openssl.cnf');
let activeScenario: Scenario = 'direct';
let activeBody = statement;
let activeChild: ChildProcessWithoutNullStreams | undefined;
let requests: RequestObservation[] = [];

await writeFile(
  opensslConfig,
  `[req]
distinguished_name = distinguished_name
x509_extensions = extensions
prompt = no

[distinguished_name]
CN = localhost

[extensions]
subjectAltName = DNS:localhost,IP:127.0.0.1
keyUsage = critical,digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth
`,
);
const certificateResult = spawnSync(
  'openssl',
  [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-sha256',
    '-nodes',
    '-days',
    '1',
    '-config',
    opensslConfig,
    '-keyout',
    key,
    '-out',
    certificate,
  ],
  { encoding: 'utf8' },
);
if (certificateResult.status !== 0) {
  throw new Error(`openssl failed: ${certificateResult.stderr}`);
}

const sha256 = (value: string): string =>
  `sha256:${createHash('sha256').update(value).digest('hex')}`;

const observe = (
  server: RequestObservation['server'],
  requestUrl: string | undefined,
  authorization: string | undefined,
  cookie: string | undefined,
): void => {
  const parsed = new URL(requestUrl ?? '/', 'https://fixture.invalid');
  requests.push({
    authorization: authorization ?? null,
    cookie: cookie ?? null,
    hasExpiryQuery: parsed.searchParams.has('se'),
    hasSignatureQuery: parsed.searchParams.has('sig'),
    path: parsed.pathname,
    server,
  });
};

const respondWithStatement = (
  response: ServerResponse,
  contentType = 'application/vnd.in-toto+json',
): void => {
  response.statusCode = 200;
  response.setHeader('content-type', contentType);
  response.end(activeBody);
};

const blobServer = createHttpsServer(
  { cert: readFileSync(certificate), key: readFileSync(key) },
  (request, response) => {
    observe('blob', request.url, request.headers.authorization, request.headers.cookie);
    respondWithStatement(response, 'application/octet-stream');
  },
);

const downgradeServer = createHttpServer((_request, response) => {
  respondWithStatement(response, 'application/octet-stream');
});

const registryServer = createHttpsServer(
  { cert: readFileSync(certificate), key: readFileSync(key) },
  (request, response) => {
    observe('registry', request.url, request.headers.authorization, request.headers.cookie);
    const path = new URL(request.url ?? '/', 'https://fixture.invalid').pathname;
    const blobAddress = blobServer.address();
    const downgradeAddress = downgradeServer.address();
    if (!blobAddress || typeof blobAddress === 'string') throw new Error('blob port missing');
    if (!downgradeAddress || typeof downgradeAddress === 'string') {
      throw new Error('downgrade port missing');
    }

    if (activeScenario.startsWith('status-')) {
      response.statusCode = Number(activeScenario.slice('status-'.length));
      response.setHeader('content-type', 'application/json');
      response.end('{}');
      return;
    }
    if (activeScenario === 'reset') {
      request.socket.destroy();
      return;
    }
    if (activeScenario === 'timeout') return;
    if (activeScenario === 'slow-body') {
      response.statusCode = 200;
      response.setHeader('content-type', 'application/vnd.in-toto+json');
      response.write('{');
      return;
    }
    if (activeScenario === 'missing-location') {
      response.statusCode = 307;
      response.end();
      return;
    }
    if (activeScenario === 'invalid-location') {
      response.statusCode = 307;
      response.setHeader('location', 'https://[invalid');
      response.end();
      return;
    }
    if (activeScenario === 'https-downgrade') {
      response.statusCode = 307;
      response.setHeader('location', `http://127.0.0.1:${downgradeAddress.port}/signed`);
      response.end();
      return;
    }
    if (activeScenario === 'cross-origin-signed') {
      response.statusCode = 307;
      response.setHeader(
        'location',
        `https://127.0.0.1:${blobAddress.port}/signed?sig=${signature}&se=2099-01-01`,
      );
      response.end();
      return;
    }
    if (activeScenario === 'redirect-loop') {
      response.statusCode = 307;
      response.setHeader('location', '/loop');
      response.end();
      return;
    }
    if (activeScenario === 'one-relative-redirect') {
      if (path === '/signed') {
        respondWithStatement(response);
      } else {
        response.statusCode = 307;
        response.setHeader('location', '/signed?sig=retained&se=2099-01-01');
        response.end();
      }
      return;
    }
    if (activeScenario === 'three-redirects' || activeScenario === 'too-many-redirects') {
      const maximumHop = activeScenario === 'three-redirects' ? 3 : 4;
      const match = path.match(/^\/hop-(\d+)$/u);
      const hop = match ? Number(match[1]) : 0;
      if (hop === maximumHop) {
        respondWithStatement(response);
      } else {
        response.statusCode = 307;
        response.setHeader('location', `/hop-${hop + 1}?sig=retained&se=2099-01-01`);
        response.end();
      }
      return;
    }
    if (activeScenario === 'empty') activeBody = '';
    if (activeScenario === 'html') {
      respondWithStatement(response, 'text/html');
      return;
    }
    respondWithStatement(response);
  },
);

const listen = (server: Server, host: string): Promise<void> =>
  new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, resolve);
  });

const close = (server: Server): Promise<void> => {
  if (!server.listening) return Promise.resolve();
  const closeAllConnections = (server as Server & { readonly closeAllConnections?: () => void })
    .closeAllConnections;
  closeAllConnections?.call(server);
  return new Promise((resolve) => server.close(() => resolve()));
};

const run = async (
  scenario: Scenario,
  options: {
    readonly body?: string;
    readonly expectedDigest?: string;
    readonly expectedSize?: number;
  } = {},
): Promise<ScenarioResult> => {
  activeScenario = scenario;
  activeBody = options.body ?? statement;
  requests = [];
  const expectedDigest = options.expectedDigest ?? sha256(activeBody);
  const expectedSize = options.expectedSize ?? Buffer.byteLength(activeBody);
  const destination = join(directory, `${scenario}-${Date.now()}-${Math.random()}.json`);
  const registryAddress = registryServer.address();
  if (!registryAddress || typeof registryAddress === 'string')
    throw new Error('registry port missing');

  const result = await new Promise<{
    readonly status: number | null;
    readonly stderr: string;
    readonly stdout: string;
  }>((resolve, reject) => {
    activeChild = spawn(
      'bash',
      [
        '-c',
        'source "$1"; phub_ghcr_custody_fetch_exact_statement_blob "$2" "$3" "$4" "$5" "$PHUB_TEST_TOKEN" "$6"',
        'fixture',
        helper,
        'web',
        expectedDigest,
        String(expectedSize),
        'application/vnd.in-toto+json',
        destination,
      ],
      {
        env: {
          ...process.env,
          CURL_CA_BUNDLE: certificate,
          PHUB_GHCR_CUSTODY_CONNECT_TIMEOUT_SECONDS: '1',
          PHUB_GHCR_CUSTODY_LOW_SPEED_LIMIT_BYTES: '1',
          PHUB_GHCR_CUSTODY_LOW_SPEED_TIME_SECONDS: '1',
          PHUB_GHCR_CUSTODY_MAX_TIME_SECONDS:
            scenario === 'timeout' || scenario === 'slow-body' ? '1' : '5',
          PHUB_GHCR_CUSTODY_REGISTRY_ORIGIN: `https://localhost:${registryAddress.port}`,
          PHUB_GHCR_CUSTODY_TESTING: '1',
          PHUB_TEST_TOKEN: token,
        },
      },
    );
    let stderr = '';
    let stdout = '';
    const timer = setTimeout(() => activeChild?.kill('SIGKILL'), 10_000);
    activeChild.stdout.setEncoding('utf8');
    activeChild.stderr.setEncoding('utf8');
    activeChild.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    activeChild.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    activeChild.once('error', reject);
    activeChild.once('close', (status) => {
      clearTimeout(timer);
      activeChild = undefined;
      resolve({ status, stderr, stdout });
    });
  });
  let bytes = '';
  try {
    bytes = await readFile(destination, 'utf8');
  } catch {
    // Failed downloads must not leave a destination.
  }
  await rm(destination, { force: true });
  return {
    bytesMatch: bytes === activeBody,
    destinationExists: bytes.length > 0,
    leakedSignature: result.stderr.includes(signature) || result.stdout.includes(signature),
    leakedToken: result.stderr.includes(token) || result.stdout.includes(token),
    markers: [...result.stderr.matchAll(/PHUB_GHCR_CUSTODY_[A-Z0-9_]+/gu)].map((match) => match[0]),
    requests,
    status: result.status,
  };
};

const stopImmediately = (): never => {
  activeChild?.kill('SIGKILL');
  registryServer.closeAllConnections();
  blobServer.closeAllConnections();
  downgradeServer.closeAllConnections();
  rmSync(directory, { force: true, recursive: true });
  process.exit(143);
};
process.once('SIGTERM', stopImmediately);
process.once('SIGINT', stopImmediately);

try {
  await listen(blobServer, '127.0.0.1');
  await listen(downgradeServer, '127.0.0.1');
  await listen(registryServer, '127.0.0.1');

  const results: Record<string, ScenarioResult | readonly ScenarioResult[]> = {};
  for (const scenario of [
    'direct',
    'one-relative-redirect',
    'three-redirects',
    'redirect-loop',
    'too-many-redirects',
    'missing-location',
    'invalid-location',
    'https-downgrade',
    'cross-origin-signed',
    'status-401',
    'status-403',
    'status-404',
    'status-429',
    'status-500',
    'status-503',
    'reset',
    'timeout',
    'slow-body',
  ] as const) {
    results[scenario] = await run(scenario);
  }
  results.empty = await run('empty', { body: '', expectedSize: 1 });
  results.html = await run('html', { body: '<html>not an attestation</html>' });
  results['invalid-json'] = await run('invalid-json', { body: '{not-json' });
  results['digest-mismatch'] = await run('digest-mismatch', {
    body: statement,
    expectedDigest: `sha256:${'0'.repeat(64)}`,
  });
  results.oversized = await run('oversized', {
    body: JSON.stringify({ payload: 'x'.repeat(4096) }),
    expectedSize: 128,
  });
  results.repeated = [await run('direct'), await run('direct')];
  process.stdout.write(JSON.stringify(results));
} finally {
  activeChild?.kill('SIGKILL');
  await close(registryServer);
  await close(blobServer);
  await close(downgradeServer);
  await rm(directory, { force: true, recursive: true });
}
