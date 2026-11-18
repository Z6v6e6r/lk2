/** Rehydrate the byte-pinned upstream modules for the composed tests only. */
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';

interface OwnerEngine {
  readonly RESIDENCY_PRODUCT_ID: string;
  readonly createResidencyLifecycle: (dependencies: Record<string, unknown>) => unknown;
}
interface OwnerHttp {
  readonly createResidencyLifecycleApi: (options: {
    readonly createLifecycle: (actor: { tenantId: string; userId: string }) => unknown;
    readonly allowOrigin: string;
  }) => {
    handle(request: {
      readonly method: string;
      readonly path: string;
      readonly headers: Record<string, string>;
      readonly body?: unknown;
      readonly actor: { tenantId: string; userId: string };
    }): Promise<{ readonly statusCode: number; readonly body: unknown }>;
  };
}

interface OwnerClientModule {
  readonly ClientResidencyOwnerClient: new (options: {
    readonly baseUrl: string;
    readonly environment: 'development';
    readonly timeoutMs: number;
    readonly fetchImplementation: typeof fetch;
  }) => object;
}
interface ConsumerRuntimeModule {
  readonly createResidencyOrderRuntime: (options: {
    readonly enabled: boolean;
    readonly productId: string;
    readonly tenantKey: string;
    readonly client: object;
    readonly token: (actor: { readonly userId: string }) => Promise<{
      readonly token: string;
      readonly expiresAt: string;
    }>;
  }) => object;
}
interface ConsumerRoutesModule {
  readonly registerClientResidencyOrderRoutes: (
    app: FastifyInstance,
    options: {
      readonly runtime: object;
      readonly readHandlers: readonly [];
      readonly commandHandlers: readonly [];
    },
  ) => void;
}

function readSnapshot(group: 'owner' | 'consumer') {
  const directory = join(process.cwd(), 'apps/web/test-fixtures/residency', group);
  const lines = readFileSync(join(directory, 'SOURCE.sha256'), 'utf8').trim().split('\n');
  return lines.map((line) => {
    const [digest, name] = line.split(/\s+/);
    if (!name || !/^[a-z][a-z-]+\.(mjs|ts)$/.test(name))
      throw new Error(`Invalid residency fixture name: ${name}`);
    const source = readFileSync(join(directory, name + '.txt'));
    if (createHash('sha256').update(source).digest('hex') !== digest)
      throw new Error(`Residency fixture changed: ${name}`);
    return { name, source };
  });
}

export const verifyOwnerSnapshot = () => readSnapshot('owner').map(({ name }) => name);
export const verifyConsumerSnapshot = () => readSnapshot('consumer').map(({ name }) => name);

export function loadResidencyServerFixtures() {
  const snapshots = [...readSnapshot('owner'), ...readSnapshot('consumer')];
  const dir = mkdtempSync(join(tmpdir(), 'lk2-residency-fixtures-'));
  try {
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
    for (const { name, source } of snapshots) {
      if (name.endsWith('.ts')) {
        const { outputText } = transpileModule(source.toString('utf8'), {
          fileName: name,
          compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 },
        });
        writeFileSync(join(dir, name.replace(/\.ts$/, '.js')), outputText);
      } else {
        writeFileSync(join(dir, name), source);
      }
    }
    const requireFromFixture = createRequire(join(dir, 'package.json'));
    const importModule = <T>(name: string): T => requireFromFixture('./' + name) as T;
    return {
      owner: importModule<OwnerEngine>('residency-lifecycle.mjs'),
      ownerHttp: importModule<OwnerHttp>('residency-lifecycle-http.mjs'),
      consumerClient: importModule<OwnerClientModule>('client-residency-owner-client.js'),
      consumerRuntime: importModule<ConsumerRuntimeModule>('client-residency-order-runtime.js'),
      consumerRoutes: importModule<ConsumerRoutesModule>('client-residency-order-routes.js'),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
