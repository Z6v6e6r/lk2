import { readFileSync } from 'node:fs';

import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const appCompose = readFileSync('deploy/timeweb/compose.beta.yaml', 'utf8');
const ingressCompose = readFileSync('deploy/timeweb/compose.ingress.yaml', 'utf8');
const caddyfile = readFileSync('deploy/timeweb/Caddyfile', 'utf8');
const runbook = readFileSync('docs/runbooks/timeweb-lk2-beta.md', 'utf8');

interface ComposeService {
  readonly image: string;
  readonly ports?: readonly string[];
  readonly profiles?: readonly string[];
  readonly env_file?: readonly { readonly path: string }[];
}

interface ComposeDocument {
  readonly services: Record<string, ComposeService>;
  readonly volumes?: Record<string, { readonly name?: string }>;
}

describe('Timeweb beta deployment contract', () => {
  it('defines exactly five digest-pinned application components without host ports', () => {
    const compose = parse(appCompose) as ComposeDocument;
    expect(Object.keys(compose.services).sort()).toEqual(
      ['api', 'migrator', 'realtime', 'web', 'worker'].sort(),
    );
    for (const service of Object.values(compose.services)) {
      expect(service.image).toMatch(/@\$\{[A-Z]+_IMAGE_DIGEST:/u);
      expect(service).not.toHaveProperty('ports');
    }
    const migrator = compose.services.migrator!;
    const api = compose.services.api!;
    const worker = compose.services.worker!;
    const realtime = compose.services.realtime!;
    expect(migrator.profiles).toEqual(['migration']);
    expect(worker.profiles).toEqual(['background']);
    expect(api.env_file?.[0]?.path).toBe('/etc/phub/timeweb-beta/api.env');
    expect(worker.env_file?.[0]?.path).toBe('/etc/phub/timeweb-beta/worker.env');
    expect(realtime.env_file?.[0]?.path).toBe('/etc/phub/timeweb-beta/realtime.env');
    expect(migrator.env_file?.[0]?.path).toBe('/etc/phub/timeweb-beta/migrator.env');
    expect(appCompose).not.toContain('TIMEWEB_');
    expect(appCompose).not.toContain('MIGRATOR_DATABASE_URL');
  });

  it('exposes only the pinned TLS ingress on ports 80 and 443', () => {
    const compose = parse(ingressCompose) as ComposeDocument;
    expect(Object.keys(compose.services)).toEqual(['caddy']);
    const caddy = compose.services.caddy!;
    expect(caddy.image).toMatch(/^caddy@sha256:[a-f0-9]{64}$/u);
    expect(caddy.ports).toEqual(['80:80', '443:443']);
    expect(compose.volumes?.caddy_data?.name).toContain('CADDY_DATA_VOLUME');
    expect(compose.volumes?.caddy_config?.name).toContain('CADDY_CONFIG_VOLUME');
    expect(caddyfile).toContain('admin off');
    expect(caddyfile).toContain('reverse_proxy api:3000');
    expect(caddyfile).toContain('reverse_proxy realtime:3001');
    expect(caddyfile).toContain('reverse_proxy web:8080');
    expect(caddyfile).not.toContain('/internal/api');
    expect(caddyfile).not.toContain('/admin/api');
  });

  it('scrubs ambient Compose overrides and verifies the effective image set twice', () => {
    expect(runbook).toContain('env -i PATH=/usr/local/sbin:');
    expect(runbook.match(/verify-timeweb-beta-compose-images\.js/gu)).toHaveLength(2);
    expect(runbook).not.toContain('TIMEWEB_API_ENV_FILE');
    expect(runbook).not.toContain('MIGRATOR_DATABASE_URL');
    expect(runbook).toContain('up -d api realtime web');
    expect(runbook.match(/source-freshness gate/gu)).toHaveLength(2);
    expect(runbook).toContain('git ls-remote origin refs/heads/main');
    expect(runbook).toContain('restoring it would be a second live write');
    expect(runbook).toContain('unix:///var/run/docker.sock');
    expect(runbook.match(/docker --context default/gu)).toHaveLength(4);
  });
});
