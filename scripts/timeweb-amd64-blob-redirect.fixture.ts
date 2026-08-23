import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { rmSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const statement = JSON.stringify({ predicateType: 'https://slsa.dev/provenance/v1' });
const directory = await mkdtemp(join(tmpdir(), 'phub-timeweb-blob-redirect-'));
const destination = join(directory, 'statement.json');
const requests: string[] = [];
let registryAuthorization: string | undefined;
let blobAuthorization: string | undefined;
let curl: ChildProcessWithoutNullStreams | undefined;

const blobServer = createServer((request, response) => {
  requests.push(`blob:${request.url ?? ''}`);
  blobAuthorization = request.headers.authorization;
  if (request.url === '/signed-blob') {
    response.statusCode = 200;
    response.setHeader('content-type', 'application/json');
    response.end(statement);
    return;
  }
  response.statusCode = 404;
  response.end();
});
const registryServer = createServer((request, response) => {
  requests.push(`registry:${request.url ?? ''}`);
  registryAuthorization = request.headers.authorization;
  if (request.url === '/blob') {
    response.statusCode = 307;
    const address = blobServer.address();
    if (!address || typeof address === 'string') throw new Error('blob server has no TCP port');
    response.setHeader('location', `http://127.0.0.1:${address.port}/signed-blob`);
    response.end();
    return;
  }
  response.statusCode = 404;
  response.end();
});

const stopServer = async (server: Server): Promise<void> => {
  if (!server.listening) return;
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
};

const stopImmediately = (): never => {
  curl?.kill('SIGKILL');
  registryServer.closeAllConnections();
  blobServer.closeAllConnections();
  rmSync(directory, { force: true, recursive: true });
  process.exit(143);
};

process.once('SIGTERM', stopImmediately);
process.once('SIGINT', stopImmediately);

try {
  await new Promise<void>((resolve, reject) => {
    blobServer.once('error', reject);
    blobServer.listen(0, '127.0.0.1', resolve);
  });
  await new Promise<void>((resolve, reject) => {
    registryServer.once('error', reject);
    registryServer.listen(0, '127.0.0.1', resolve);
  });
  const address = registryServer.address();
  if (!address || typeof address === 'string') throw new Error('test server has no TCP port');

  await new Promise<void>((resolve, reject) => {
    curl = spawn('curl', [
      '--fail',
      '--silent',
      '--show-error',
      '--location',
      '--max-redirs',
      '3',
      '--connect-timeout',
      '2',
      '--max-time',
      '5',
      '--proto',
      '=http,https',
      '--proto-redir',
      '=http,https',
      '--config',
      '-',
      `http://127.0.0.1:${address.port}/blob`,
      '--output',
      destination,
    ]);
    let stderr = '';
    curl.stderr.setEncoding('utf8');
    curl.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    curl.once('error', reject);
    curl.once('close', (code) => {
      curl = undefined;
      if (code === 0) resolve();
      else reject(new Error(`curl exited with ${String(code)}: ${stderr}`));
    });
    curl.stdin.end('header = "Authorization: Bearer test-token"\n');
  });

  process.stdout.write(
    JSON.stringify({
      blobAuthorization: blobAuthorization ?? null,
      bytes: await readFile(destination, 'utf8'),
      registryAuthorization,
      requests,
    }),
  );
} finally {
  curl?.kill('SIGKILL');
  await stopServer(registryServer);
  await stopServer(blobServer);
  await rm(directory, { force: true, recursive: true });
}
