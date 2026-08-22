import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const infrastructureSource = readFileSync(
  new URL('../deploy/timeweb/compose.infrastructure.yaml', import.meta.url),
  'utf8',
);
const applicationSource = readFileSync(
  new URL('../deploy/compose.timeweb-staging.yaml', import.meta.url),
  'utf8',
);
const ingressSource = readFileSync(
  new URL('../deploy/timeweb/compose.ingress.yaml', import.meta.url),
  'utf8',
);

type ResourceBoundService = {
  pids_limit?: number;
  logging?: { driver?: string; options?: { 'max-size'?: string; 'max-file'?: string } };
  deploy?: { resources?: { limits?: { cpus?: string; memory?: string } } };
};

describe('Timeweb staging Compose contract', () => {
  it('keeps canonical state private, split by plane, and excludes root-equivalent tools', () => {
    const compose = parse(infrastructureSource) as {
      services: Record<
        string,
        { ports?: string[]; networks?: string[]; volumes?: string[]; group_add?: string[] }
      >;
      networks: Record<string, { external?: boolean; name?: string }>;
      volumes: Record<string, unknown>;
    };

    expect(Object.keys(compose.services)).toEqual([
      'nginx',
      'postgres',
      'redis',
      'rabbitmq',
      'otel-collector',
      'prometheus',
      'grafana',
      'swagger-ui',
      'swagger-editor',
    ]);
    expect(compose.services['minio']).toBeUndefined();
    expect(compose.services['portainer']).toBeUndefined();
    expect(infrastructureSource).not.toContain('/var/run/docker.sock');
    expect(compose.services['postgres']?.ports).toBeUndefined();
    expect(compose.services['redis']?.ports).toBeUndefined();
    expect(compose.services['rabbitmq']?.ports).toEqual(['127.0.0.1:15672:15672']);
    expect(compose.services['otel-collector']?.ports).toEqual(['127.0.0.1:13133:13133']);
    expect(compose.services['nginx']?.networks).toEqual(['ingress']);
    expect(compose.services['postgres']?.networks).toEqual(['data']);
    expect(compose.services['redis']?.networks).toEqual(['data']);
    expect(compose.services['otel-collector']?.networks).toEqual(['telemetry']);
    expect(compose.services['swagger-ui']?.networks).toEqual(['admin']);
    expect(compose.networks).toEqual({
      ingress: { external: true, name: 'phub-ingress' },
      data: { external: true, name: 'phub-data' },
      telemetry: { external: true, name: 'phub-telemetry' },
      admin: { external: true, name: 'phub-admin' },
    });
    expect(Object.keys(compose.volumes)).toEqual([
      'postgres_data',
      'redis_data',
      'rabbitmq_data',
      'prometheus_data',
      'grafana_data',
    ]);
    expect(compose.services['redis']?.volumes).toContain(
      '/etc/phub/redis/users.acl:/usr/local/etc/redis/users.acl:ro',
    );
    expect(compose.services['redis']?.group_add).toEqual([
      '${REDIS_RUNTIME_GID:?REDIS_RUNTIME_GID is required}',
    ]);
  });

  it('pins the exact Timeweb S3 boundary and scopes credentials to API and worker files', () => {
    const compose = parse(applicationSource, { merge: true }) as {
      services: Record<
        string,
        {
          environment?: Record<string, string>;
          env_file?: Array<{ path: string; required?: boolean }>;
          networks?: string[];
          profiles?: string[];
        }
      >;
      networks: Record<string, { external?: boolean; name?: string }>;
    };
    const apiEnvironment = compose.services['api']?.environment;
    const workerEnvironment = compose.services['worker']?.environment;

    expect(apiEnvironment).toMatchObject({
      S3_ENDPOINT: 'https://s3.twcstorage.ru',
      S3_PUBLIC_ENDPOINT: 'https://s3.twcstorage.ru',
      S3_REGION: 'ru-1',
      S3_BUCKET: '5daa8b6b-1f31-4279-8141-bc78e63e53d3',
      S3_FORCE_PATH_STYLE: 'true',
      S3_AUTO_CREATE_BUCKET: 'false',
    });
    expect(workerEnvironment).toEqual(apiEnvironment);
    expect(applicationSource).not.toContain('MINIO_');
    expect(applicationSource).not.toContain('S3_ACCESS_KEY:');
    expect(applicationSource).not.toContain('S3_SECRET_KEY:');
    expect(compose.services['api']?.env_file?.at(-1)?.path).toBe(
      '${API_S3_ENV_FILE:-/etc/phub/staging.api-s3.env}',
    );
    expect(compose.services['worker']?.env_file?.at(-1)?.path).toBe(
      '${WORKER_S3_ENV_FILE:-/etc/phub/staging.worker-s3.env}',
    );
    expect(compose.services['realtime']?.env_file).toEqual([
      { path: '${REALTIME_RUNTIME_ENV_FILE:-/etc/phub/realtime.env}' },
    ]);
    expect(compose.networks['ingress']).toEqual({ external: true, name: 'phub-ingress' });
    expect(compose.networks['data']).toEqual({ external: true, name: 'phub-data' });
    expect(compose.networks['telemetry']).toEqual({ external: true, name: 'phub-telemetry' });
    expect(compose.networks['cup-showcase']).toEqual({
      external: true,
      name: 'phab-showcase_default',
    });
    expect(compose.services['worker']?.networks).toEqual(['data', 'telemetry', 'cup-showcase']);
    expect(compose.services['worker']?.profiles).toEqual(['worker']);
  });

  it('gives migrator only its dedicated DB env file and data network', () => {
    const compose = parse(applicationSource, { merge: true }) as {
      services: Record<
        string,
        {
          env_file?: Array<{ path: string }>;
          environment?: Record<string, string>;
          networks?: string[];
        }
      >;
    };
    const migrator = compose.services['migrator'];

    expect(migrator?.env_file).toEqual([
      { path: '${MIGRATOR_RUNTIME_ENV_FILE:-/etc/phub/staging.migrator.env}' },
    ]);
    expect(migrator?.environment).toBeUndefined();
    expect(migrator?.networks).toEqual(['data']);
    for (const forbidden of ['staging.env', 'staging.auth.env', 'api-s3', 'worker-s3']) {
      expect(JSON.stringify(migrator)).not.toContain(forbidden);
    }
  });

  it('uses a Timeweb Nginx boundary with no MinIO upstream', () => {
    const nginxSource = readFileSync(
      new URL('../deploy/timeweb/nginx/default.conf', import.meta.url),
      'utf8',
    );

    expect(infrastructureSource).toContain('./nginx/default.conf');
    expect(infrastructureSource).not.toContain('../jetson/nginx/default.conf');
    expect(nginxSource).not.toMatch(/minio:9000/u);
    expect(nginxSource).toContain('proxy_set_header X-Forwarded-Proto https;');
    expect(nginxSource).not.toContain('proxy_set_header X-Forwarded-Proto $scheme;');
    expect(nginxSource).toContain('log_format phub_safe');
    expect(nginxSource).toContain('"path":"$uri"');
    for (const sensitiveLogField of ['$request_uri', '$args', 'X-Profile-Photo-Grant']) {
      expect(nginxSource).not.toContain(sensitiveLogField);
    }
    expect(nginxSource).toContain('location ^~ /phub-media/');
    expect(nginxSource).toContain('return 410;');
  });

  it('pins every container image by a required digest and never uses latest', () => {
    for (const source of [infrastructureSource, applicationSource, ingressSource]) {
      expect(source).not.toMatch(/image:\s+[^\n]*:latest(?:@|\s|$)/u);
      for (const line of source.split('\n').filter((value) => value.trim().startsWith('image:'))) {
        expect(line).toContain('@${');
        expect(line).toContain('_DIGEST:?');
      }
    }
  });

  it('bounds CPU and memory for every Timeweb container', () => {
    for (const source of [infrastructureSource, applicationSource, ingressSource]) {
      const compose = parse(source, { merge: true }) as {
        services: Record<string, ResourceBoundService>;
      };
      for (const [service, definition] of Object.entries(compose.services)) {
        expect(definition.deploy?.resources?.limits?.cpus, `${service} cpu limit`).toMatch(
          /^\d+\.\d{2}$/u,
        );
        expect(definition.deploy?.resources?.limits?.memory, `${service} memory limit`).toMatch(
          /^\d+(?:M|G)$/u,
        );
        expect(definition.pids_limit, `${service} pids limit`).toBeGreaterThan(0);
        expect(definition.logging, `${service} logging`).toEqual({
          driver: 'local',
          options: { 'max-size': '10m', 'max-file': '3' },
        });
      }
    }
  });

  it('keeps TLS ingress explicit, digest-pinned and attached only to ingress', () => {
    const compose = parse(ingressSource) as {
      services: Record<
        string,
        {
          image: string;
          ports?: string[];
          networks?: string[];
          volumes?: string[];
          healthcheck?: { test?: string[] };
        }
      >;
      networks: Record<string, { external?: boolean; name?: string }>;
    };

    expect(Object.keys(compose.services)).toEqual(['caddy']);
    expect(compose.services['caddy']?.ports).toEqual(['80:80', '443:443', '443:443/udp']);
    expect(compose.services['caddy']?.networks).toEqual(['ingress']);
    expect(compose.services['caddy']?.volumes).toContain(
      './caddy/Caddyfile:/etc/caddy/Caddyfile:ro',
    );
    expect(compose.services['caddy']?.healthcheck?.test).toEqual([
      'CMD-SHELL',
      'wget -q -O /dev/null http://127.0.0.1:2019/healthz',
    ]);
    expect(compose.networks).toEqual({
      ingress: { external: true, name: 'phub-ingress' },
    });

    const caddySource = readFileSync(
      new URL('../deploy/timeweb/caddy/Caddyfile', import.meta.url),
      'utf8',
    );
    expect(caddySource).not.toMatch(/^\s*log\s*\{/mu);
  });
});
