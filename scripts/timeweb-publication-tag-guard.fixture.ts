import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer as createHttpsServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:net';

type Scenario =
  | 'absent'
  | 'existing'
  | 'wrong-404'
  | 'mixed-404'
  | 'token-401'
  | 'manifest-401'
  | 'manifest-429'
  | 'manifest-500'
  | 'manifest-redirect'
  | 'transport-reset';

const guard = process.argv[2];
if (!guard) throw new Error('guard path is required');

const directory = await mkdtemp(join(tmpdir(), 'phub-timeweb-tag-guard-'));
const certificate = join(directory, 'certificate.pem');
const key = join(directory, 'key.pem');
const opensslConfig = join(directory, 'openssl.cnf');
const githubToken = 'fixture-github-token';
const registryToken = 'fixture-registry-token';
let scenario: Scenario = 'absent';
let activeChild: ChildProcessWithoutNullStreams | undefined;

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
if (certificateResult.status !== 0) throw new Error(certificateResult.stderr);

const server = createHttpsServer(
  { cert: readFileSync(certificate), key: readFileSync(key) },
  (request, response) => {
    const path = new URL(request.url ?? '/', 'https://fixture.invalid').pathname;
    if (path === '/token') {
      if (scenario === 'token-401') {
        response.statusCode = 401;
        response.end('{}');
        return;
      }
      const expected = `Basic ${Buffer.from(`fixture-actor:${githubToken}`).toString('base64')}`;
      if (request.headers.authorization !== expected) {
        response.statusCode = 401;
        response.end('{}');
        return;
      }
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ token: registryToken }));
      return;
    }
    if (request.headers.authorization !== `Bearer ${registryToken}`) {
      response.statusCode = 401;
      response.end('{}');
      return;
    }
    if (scenario === 'transport-reset') {
      request.socket.destroy();
      return;
    }
    if (scenario === 'manifest-redirect') {
      response.statusCode = 307;
      response.setHeader('location', '/redirected');
      response.end();
      return;
    }
    const statuses: Partial<Record<Scenario, number>> = {
      existing: 200,
      'manifest-401': 401,
      'manifest-429': 429,
      'manifest-500': 500,
    };
    response.statusCode = statuses[scenario] ?? 404;
    response.setHeader('content-type', 'application/json');
    response.end(
      scenario === 'absent'
        ? JSON.stringify({ errors: [{ code: 'MANIFEST_UNKNOWN' }] })
        : scenario === 'mixed-404'
          ? JSON.stringify({ errors: [{ code: 'MANIFEST_UNKNOWN' }, { code: 'DENIED' }] })
          : scenario === 'wrong-404'
            ? JSON.stringify({ errors: [{ code: 'NAME_UNKNOWN' }] })
            : '{}',
    );
  },
);

const listen = (target: Server): Promise<void> =>
  new Promise((resolve, reject) => {
    target.once('error', reject);
    target.listen(0, '127.0.0.1', resolve);
  });
const close = (target: Server): Promise<void> =>
  new Promise((resolve) => target.close(() => resolve()));

const stopImmediately = (): never => {
  activeChild?.kill('SIGKILL');
  server.closeAllConnections();
  rmSync(directory, { force: true, recursive: true });
  process.exit(143);
};
process.once('SIGTERM', stopImmediately);
process.once('SIGINT', stopImmediately);

try {
  await listen(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server port missing');
  const results: Record<string, { status: number | null; leaked: boolean; stderr: string }> = {};
  for (scenario of [
    'absent',
    'existing',
    'wrong-404',
    'mixed-404',
    'token-401',
    'manifest-401',
    'manifest-429',
    'manifest-500',
    'manifest-redirect',
    'transport-reset',
  ]) {
    const result = await new Promise<{ status: number | null; stderr: string; stdout: string }>(
      (resolve, reject) => {
        activeChild = spawn(
          process.execPath,
          [
            guard,
            '--service',
            'web',
            '--tag',
            'amd64-sha-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-12345-1',
          ],
          {
            env: {
              ...process.env,
              GITHUB_ACTOR: 'fixture-actor',
              GITHUB_TOKEN: githubToken,
              NODE_EXTRA_CA_CERTS: certificate,
              PHUB_GHCR_TAG_GUARD_ORIGIN: `https://localhost:${address.port}`,
              PHUB_GHCR_TAG_GUARD_TESTING: '1',
            },
          },
        );
        let stderr = '';
        let stdout = '';
        activeChild.stderr.setEncoding('utf8');
        activeChild.stdout.setEncoding('utf8');
        activeChild.stderr.on('data', (chunk: string) => (stderr += chunk));
        activeChild.stdout.on('data', (chunk: string) => (stdout += chunk));
        activeChild.once('error', reject);
        activeChild.once('close', (status) => {
          activeChild = undefined;
          resolve({ status, stderr, stdout });
        });
      },
    );
    results[scenario] = {
      status: result.status,
      leaked: result.stderr.includes(githubToken) || result.stderr.includes(registryToken),
      stderr: result.stderr,
    };
  }
  process.stdout.write(JSON.stringify(results));
} finally {
  server.closeAllConnections();
  await close(server);
  await rm(directory, { force: true, recursive: true });
}
