// Drives deploy/timeweb/lk2-beta-lane.sh against fake docker/curl/id/flock binaries, so the
// promote -> smoke -> automatic rollback and manual rollback paths run without a host.
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = resolve('deploy/timeweb/lk2-beta-lane.sh');
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const OLD = (svc: string) => `ghcr.io/z6v6e6r/phub-${svc}@sha256:${'0'.repeat(63)}${svc.length}`;
const digestFor = (sha: string, image: string) =>
  `sha256:${sha.slice(0, 1).repeat(56)}${image
    .padEnd(8, 'x')
    .slice(0, 8)
    .replace(/[^0-9a-f]/g, 'e')}`;

let root: string;

function fakeBinaries(): string {
  const bin = join(root, 'bin');
  const fake = join(root, 'fake');
  execFileSync('mkdir', ['-p', bin, fake, join(root, 'env')]);
  writeFileSync(join(root, 'env', 'api.env'), 'X=1\n');
  for (const svc of ['api', 'realtime', 'web', 'worker']) {
    writeFileSync(join(fake, `${svc}.image`), OLD(svc));
    writeFileSync(join(fake, `${svc}.running`), 'true');
  }
  writeFileSync(join(fake, 'ledger'), '105');
  const docker = `#!/usr/bin/env bash
F='${fake}'
log() { echo "$*" >> "$F/calls"; }
svc_of() { sed -E 's/^phub-timeweb-beta-(.*)-1$/\\1/' <<<"$1"; }
digest() { local i=$1 s=$2; printf 'sha256:%s%s' "$(printf "%056d" 0 | tr 0 "\${s:0:1}")" "$(printf '%-8s' "$i" | tr ' ' x | cut -c1-8 | tr -c '0-9a-f\\n' e)"; }
log "$*"
case $1 in
  ps) echo pgid ;;
  inspect)
    shift; fmt=""; [[ $1 == -f ]] && { fmt=$2; shift 2; }
    name=$1
    if [[ $name == pgid ]]; then
      [[ $fmt == *IPAddress* ]] && echo 172.30.26.20 || echo /phub-timeweb-beta-postgres
      exit 0
    fi
    svc=$(svc_of "$name"); [[ -f $F/$svc.image ]] || exit 1
    case $fmt in
      *State.Running*) cat "$F/$svc.running" ;;
      *Config.Image*) cat "$F/$svc.image" ;;
      *Mounts*) echo /etc/phub/fcm.json ;;
      *) echo '{}' ;;
    esac ;;
  exec)
    shift; [[ $1 == -i ]] && shift; shift
    case "$*" in
      "printenv POSTGRES_USER") echo phub_beta ;;
      "printenv POSTGRES_PASSWORD") echo 'p@ss/word' ;;
      printenv*) exit 1 ;;
      *pg_database_size*) echo 1000 ;;
      *schema_migrations*) echo "$(cat "$F/ledger") applied" ;;
      pg_dump*) echo DUMP ;;
      pg_restore*) cat >/dev/null ;;
    esac ;;
  pull) [[ -f $F/pull-fails ]] && exit 1; echo pulled ;;
  image)
    ref=\${!#}; image=$(sed -E 's#.*/phub-([a-z]+):.*#\\1#' <<<"$ref"); sha=\${ref##*:}
    echo "ghcr.io/z6v6e6r/phub-$image@$(digest "$image" "$sha")" ;;
  run)
    [[ -f $F/migrate-fails && " $* " == *" --lk2-beta-lane "* ]] && exit 1
    [[ " $* " == *" --lk2-beta-lane "* ]] && echo 119 > "$F/ledger"
    echo '{"schema":"PHUB_LK2_BETA_LANE_MIGRATION_PLAN_V1"}' ;;
  stop) echo false > "$F/$(svc_of "\${!#}").running" ;;
  start) echo true > "$F/$(svc_of "\${!#}").running" ;;
  logs) echo "api log line" ;;
  compose)
    env_file=""; args=("$@")
    for ((i = 0; i < \${#args[@]}; i++)); do [[ \${args[i]} == --env-file ]] && env_file=\${args[i+1]}; done
    svc=\${!#}; key=$(tr a-z A-Z <<<"$svc")_IMAGE_DIGEST
    d=$(grep "^$key=" "$env_file" | cut -d= -f2)
    echo "ghcr.io/z6v6e6r/phub-$svc@$d" > "$F/$svc.image"; echo true > "$F/$svc.running"
    grep -q "^PHUB_RELEASE_ID=lk2-beta-" "$env_file" && [[ -f $F/up-fails ]] && exit 1
    exit 0 ;;
esac
`;
  const write = (name: string, body: string) => {
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  };
  write('docker', docker);
  write('id', '#!/bin/sh\necho 0\n');
  write('flock', '#!/bin/sh\nexit 0\n');
  write(
    'curl',
    `#!/bin/sh\nif [ -f '${fake}/smoke-fails' ]; then printf 503; else printf 200; fi\n`,
  );
  return bin;
}

function run(...args: string[]) {
  const bin = join(root, 'bin');
  const result = spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: {
      PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
      LK2_BETA_LANE_STATE: join(root, 'state'),
      TIMEWEB_RUNTIME_ENV_ROOT: join(root, 'env'),
      LK2_BETA_PUBLIC_ORIGIN: 'https://lk2.example.test',
    },
  });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}
const fake = (name: string) => readFileSync(join(root, 'fake', name), 'utf8').trim();
const calls = () => readFileSync(join(root, 'fake', 'calls'), 'utf8');

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lk2-beta-lane-'));
  fakeBinaries();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('lk2-beta-lane.sh', () => {
  it('rejects anything but a full commit SHA', () => {
    expect(run('promote', 'abc').code).not.toBe(0);
    expect(run('plan', 'main').out).toContain('full 40-character main commit sha');
  });

  it('plan pulls images and shows the migration plan without writes', () => {
    const { code, out } = run('plan', SHA_A);
    expect(code).toBe(0);
    expect(out).toContain('PLAN ONLY');
    expect(calls()).toContain('--lk2-beta-lane-plan');
    expect(calls()).not.toMatch(/ --lk2-beta-lane( |$)/m);
    expect(calls()).not.toMatch(/^(compose|stop|start)/m);
    expect(existsSync(join(root, 'state', 'current'))).toBe(false);
  });

  it('promote backs up, migrates, starts the exact digests and records the release', () => {
    const { code, out } = run('promote', SHA_A);
    expect(out).toContain(`OK: ${SHA_A} is live`);
    expect(code).toBe(0);
    const order = calls();
    expect(order.indexOf('pg_dump')).toBeLessThan(order.indexOf(' --lk2-beta-lane'));
    expect(order.indexOf('stop')).toBeLessThan(order.indexOf(' --lk2-beta-lane'));
    expect(order.indexOf(' --lk2-beta-lane')).toBeLessThan(order.indexOf('compose'));
    expect(fake('ledger')).toBe('119');
    for (const svc of ['api', 'realtime', 'web', 'worker'])
      expect(fake(`${svc}.image`)).toBe(`ghcr.io/z6v6e6r/phub-${svc}@${digestFor(SHA_A, svc)}`);
    const release = readFileSync(join(root, 'state', 'releases', `${SHA_A}.env`), 'utf8');
    expect(release).toContain('PHUB_RELEASE_ID=lk2-beta-aaaaaaaaaaaa');
    expect(release).toContain('TIMEWEB_FCM_CREDENTIAL_SOURCE=/etc/phub/fcm.json');
    expect(release).not.toMatch(/pass|word|DATABASE_URL/i);
    expect(readFileSync(join(root, 'state', 'releases', 'baseline.env'), 'utf8')).toContain(
      `API_IMAGE_DIGEST=sha256:${'0'.repeat(63)}3`,
    );
    expect(fake('worker.running')).toBe('true');
    // The superuser credential file never outlives the run.
    expect(execFileSync('ls', ['-A', join(root, 'state')], { encoding: 'utf8' })).not.toContain(
      '.tmp',
    );
  });

  it('a failed migration stops before any application change and restarts the worker', () => {
    writeFileSync(join(root, 'fake', 'migrate-fails'), '');
    const { code, out } = run('promote', SHA_A);
    expect(code).not.toBe(0);
    expect(out).toContain('stopped before any application change');
    expect(calls()).not.toMatch(/^compose/m);
    expect(fake('worker.running')).toBe('true');
    expect(fake('api.image')).toBe(OLD('api'));
  });

  it('a failed start rolls the application back to the previous images', () => {
    writeFileSync(join(root, 'fake', 'up-fails'), '');
    const { code, out } = run('promote', SHA_A);
    expect(code).not.toBe(0);
    expect(out).toContain('application restored to baseline');
    expect(fake('api.image')).toBe(OLD('api'));
    expect(existsSync(join(root, 'state', 'current'))).toBe(false);
  });

  it('rollback restores the previous lane release', () => {
    expect(run('promote', SHA_A).code).toBe(0);
    expect(run('promote', SHA_B).code).toBe(0);
    expect(fake('api.image')).toContain(digestFor(SHA_B, 'api'));
    const { code, out } = run('rollback');
    expect(out).toContain(`OK: rolled back to ${SHA_A}`);
    expect(code).toBe(0);
    expect(fake('api.image')).toContain(digestFor(SHA_A, 'api'));
    expect(run('rollback').out).toContain('OK: rolled back to baseline');
    expect(fake('api.image')).toBe(OLD('api'));
  });
});
