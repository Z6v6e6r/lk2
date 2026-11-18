import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// Runs the stand-local direct-HTTP proof as part of CI: document/run provenance survives a new
// epoch, a POST body read, and a late completion.

const stubPath = join(import.meta.dirname, 'stub-lk2-api.js');
const verifierPath = join(import.meta.dirname, 'verify-run-isolation.js');

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('no port'));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

function waitForExit(child: ReturnType<typeof spawn>): Promise<number | null> {
  return new Promise((resolve) => child.on('exit', (code) => resolve(code)));
}

function runNode(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

const children: ReturnType<typeof spawn>[] = [];

afterEach(() => {
  for (const child of children.splice(0)) {
    child.kill('SIGKILL');
  }
});

describe('perf stand run isolation', () => {
  it('keeps request provenance and a frozen snapshot stable', { timeout: 60_000 }, async () => {
    const port = await freePort();
    const dist = mkdtempSync(join(tmpdir(), 'phub-perf-stub-'));
    const stub = spawn(process.execPath, [stubPath, dist], {
      env: { ...process.env, PHUB_STUB_PORT: String(port), PHUB_STUB_LATENCY_MS: '20' },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    children.push(stub);
    let stubErrors = '';
    stub.stderr?.setEncoding('utf8');
    stub.stderr?.on('data', (chunk) => {
      stubErrors += chunk;
    });

    const url = `http://127.0.0.1:${port}`;
    try {
      const started = Date.now();
      let ready = false;
      while (Date.now() - started < 10_000) {
        try {
          const response = await fetch(url + '/__perf/meta');
          if (response.ok) {
            ready = true;
            break;
          }
        } catch {
          // not listening yet
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(ready, `stub did not start: ${stubErrors}`).toBe(true);

      const result = await runNode([verifierPath, url]);
      expect(result.code, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toContain('run isolation verified');
      expect(result.stdout.match(/^ok {2}/gm)?.length ?? 0).toBeGreaterThanOrEqual(15);
    } finally {
      stub.kill('SIGKILL');
      await waitForExit(stub);
      rmSync(dist, { recursive: true, force: true });
    }
  });
});
