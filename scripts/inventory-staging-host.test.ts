import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const script = readFileSync(new URL('./inventory-staging-host.sh', import.meta.url), 'utf8');

describe('staging host inventory contract', () => {
  it('is explicitly read-only and never enters data services', () => {
    expect(script).toContain('read_only=true');
    expect(script).toContain('database_access=false');
    expect(script).not.toMatch(
      /docker\s+(compose\s+)?(?:up|start|stop|restart|rm|exec|run|pull|push)\b/,
    );
    expect(script).not.toMatch(/\b(?:psql|pg_dump|pg_restore|redis-cli|rabbitmqctl|mc)\b/);
    expect(script).not.toMatch(/\bsudo\b|\brm\b|\bmv\b|\bcp\b/);
  });

  it('prints only an allowlisted subset of release metadata', () => {
    expect(script).toContain('RELEASE_METADATA');
    expect(script).toContain('(WEB|API|WORKER|REALTIME|MIGRATOR)_IMAGE_DIGEST');
    expect(script).not.toMatch(/cat\s+[^\n]*\.env/);
    expect(script).not.toMatch(/printenv|docker\s+inspect[^\n]*(?:\.Config\.Env|\bEnv\b)/);
    expect(script).toContain('release metadata must not be a symlink');
    expect(script).toContain('release metadata must contain exactly one $key');
    expect(script).toContain('release metadata contains malformed $key');
    expect(script).toContain('REGISTRY must not contain credentials, a port, query or fragment');
    expect(script).toContain(
      'S3_PUBLIC_ENDPOINT must be HTTPS without credentials, query or fragment',
    );
    expect(script).toContain("grep -E '^[0-9a-f]{40}$'");
    expect(script).toContain('RELEASE must be an exact 40-character SHA');
    expect(script).toContain("grep -E '^[0-9]{4}_[A-Za-z0-9._-]+\\.sql$'");
    expect(script).toContain('LATEST_MIGRATION must be a safe SQL basename');
    expect(script).toContain("printf 'REGISTRY_HOST=%s\\n'");
    expect(script).toContain("printf 'S3_PUBLIC_ORIGIN=%s\\n'");
    expect(script).not.toMatch(/^\s*printf '%s\\n' "\$release_metadata"\s*$/mu);
  });

  it('captures the state needed to compare blue and green hosts', () => {
    for (const section of [
      'HOST',
      'DOCKER',
      'RUNTIME_MAPPING',
      'VOLUMES',
      'MOUNTS',
      'NETWORKS',
      'PATH_METADATA',
    ]) {
      expect(script).toContain(`echo "${section}"`);
    }
    expect(script).toContain('blue | green');
    expect(script).toContain('if [ "$#" -ne 1 ]');
    expect(script).toContain('config_image={{.Config.Image}}');
    expect(script).toContain('image_id={{.Image}}');
    expect(script).toContain('platform={{.Platform}}');
    expect(script).toContain('networks={{range $name');
    expect(script).toContain('source={{.Source}}');
    expect(script).toContain('rw={{.RW}}');
    expect(script).toContain('PHUB_STAGING_HOST_INVENTORY_PASSED');
  });
});
