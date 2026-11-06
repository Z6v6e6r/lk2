// Drives deploy/timeweb/lk2-beta-lane.sh against fake docker/curl/id/flock binaries, so the
// plan -> promote -> smoke -> automatic rollback and manual rollback paths run without a host.
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = resolve('deploy/timeweb/lk2-beta-lane.sh');
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SERVICES = ['api', 'realtime', 'web', 'worker'];
const OLD = (svc: string) => `ghcr.io/z6v6e6r/phub-${svc}@sha256:${'0'.repeat(63)}${svc.length}`;
const digestFor = (sha: string, image: string) =>
  `sha256:${sha.slice(0, 1).repeat(56)}${image
    .padEnd(8, 'x')
    .slice(0, 8)
    .replace(/[^0-9a-f]/g, 'e')}`;

let root: string;
let fake: string;

// Fake containers live in $fake/c/<id> as "service project image running".
const DOCKER = (state: string) => `#!/usr/bin/env bash
F='${state}'
C="$F/c"
echo "$*" >> "$F/calls"
field() { awk -v n="$2" '{print $n}' "$C/$1"; }
set_field() { awk -v n="$2" -v v="$3" '{ $n = v; print }' "$C/$1" > "$C/$1.tmp" && mv "$C/$1.tmp" "$C/$1"; }
digest() { printf 'sha256:%s%s' "$(printf "%056d" 0 | tr 0 "\${2:0:1}")" "$(printf '%-8s' "$1" | tr ' ' x | cut -c1-8 | tr -c '0-9a-f\\n' e)"; }
case $1 in
  ps)
    svc=$(sed -nE 's/.*label=com.docker.compose.service=([a-z]+).*/\\1/p' <<<"$*")
    if [[ -z $svc ]]; then echo pgid; exit 0; fi
    for f in "$C"/*; do
      [[ -f $f ]] || continue; id=$(basename "$f")
      [[ $(field "$id" 1) == "$svc" && $(field "$id" 4) == true ]] && echo "$id"
    done ;;
  inspect)
    shift; fmt=""; [[ $1 == -f ]] && { fmt=$2; shift 2; }
    id=$1
    if [[ $id == pgid ]]; then
      [[ $fmt == *IPAddress* ]] && echo 172.30.26.20 || echo /phub-timeweb-beta-postgres
      exit 0
    fi
    [[ -f $C/$id ]] || exit 1
    case $fmt in
      *Health*) [[ $(field "$id" 4) == true ]] && echo healthy || echo exited ;;
      *Config.Image*) field "$id" 3 ;;
      *compose.project*) field "$id" 2 ;;
      *Mounts*) echo /etc/phub/fcm.json ;;
    esac ;;
  exec)
    shift; [[ $1 == -i ]] && shift; shift
    case "$*" in
      "printenv POSTGRES_USER") echo phub_beta ;;
      "printenv POSTGRES_PASSWORD") echo 'p@ss/word' ;;
      printenv*) exit 1 ;;
      *pg_database_size*) echo 1000 ;;
      *schema_migrations*) echo "$(cat "$F/ledger") applied" ;;
      pg_dump*) [[ -f $F/dump-fails ]] && exit 1; echo DUMP ;;
      pg_restore*) cat >/dev/null ;;
    esac ;;
  pull) [[ -f $F/pull-fails ]] && exit 1; echo pulled ;;
  image)
    ref=\${!#}; image=$(sed -E 's#.*/phub-([a-z]+):.*#\\1#' <<<"$ref"); sha=\${ref##*:}
    [[ -f $F/repushed ]] && sha=c
    echo "ghcr.io/z6v6e6r/phub-$image@$(digest "$image" "$sha")" ;;
  run)
    [[ -f $F/migrate-fails && " $* " == *" --lk2-beta-lane "* ]] && exit 1
    [[ " $* " == *" --lk2-beta-lane "* ]] && echo 119 > "$F/ledger"
    echo '{"schema":"PHUB_LK2_BETA_LANE_MIGRATION_PLAN_V1"}' ;;
  stop) id=\${!#}; [[ -f $C/$id ]] && set_field "$id" 4 false; exit 0 ;;
  start) id=\${!#}; [[ -f $C/$id ]] || exit 1; set_field "$id" 4 true ;;
  rm) rm -f "$C/\${!#}" ;;
  logs) echo "api log line" ;;
  compose)
    env_file=""; args=("$@")
    for ((i = 0; i < \${#args[@]}; i++)); do [[ \${args[i]} == --env-file ]] && env_file=\${args[i+1]}; done
    svc=\${!#}; key=$(tr a-z A-Z <<<"$svc")_IMAGE_DIGEST
    d=$(grep "^$key=" "$env_file" | cut -d= -f2)
    echo "$svc phub-timeweb-beta ghcr.io/z6v6e6r/phub-$svc@$d true" > "$C/phub-timeweb-beta-$svc-1"
    grep -q "^PHUB_RELEASE_ID=lk2-beta-" "$env_file" && [[ -f $F/up-fails ]] && exit 1
    exit 0 ;;
esac
exit 0
`;

function setup(project: string, ids: (svc: string) => string) {
  const bin = join(root, 'bin');
  mkdirSync(join(fake, 'c'), { recursive: true });
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(root, 'env'), { recursive: true });
  for (const svc of ['api', 'realtime', 'worker'])
    writeFileSync(join(root, 'env', `${svc}.env`), 'X=1\n');
  for (const svc of SERVICES)
    writeFileSync(join(fake, 'c', ids(svc)), `${svc} ${project} ${OLD(svc)} true\n`);
  writeFileSync(join(fake, 'ledger'), '105');
  const write = (name: string, body: string) => {
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  };
  write('docker', DOCKER(fake));
  write('id', '#!/bin/sh\necho 0\n');
  write('flock', '#!/bin/sh\nexit 0\n');
  write('sleep', '#!/bin/sh\nexit 0\n');
  write(
    'curl',
    `#!/bin/sh\nif [ -f '${fake}/smoke-fails' ]; then printf 503; else printf 200; fi\n`,
  );
}

function run(...args: string[]) {
  const result = spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: {
      PATH: `${join(root, 'bin')}:/usr/bin:/bin:/usr/sbin:/sbin`,
      LK2_BETA_LANE_STATE: join(root, 'state'),
      TIMEWEB_RUNTIME_ENV_ROOT: join(root, 'env'),
      LK2_BETA_PUBLIC_ORIGIN: 'https://lk2.example.test',
    },
  });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}
const container = (id: string) =>
  readFileSync(join(fake, 'c', id), 'utf8')
    .trim()
    .split(' ');
const canonical = (svc: string) => `phub-timeweb-beta-${svc}-1`;
const calls = () => readFileSync(join(fake, 'calls'), 'utf8');
const promote = (sha: string) => {
  const plan = run('plan', sha);
  expect(plan.code, plan.out).toBe(0);
  writeFileSync(join(fake, 'calls'), '');
  return run('promote', sha);
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lk2-beta-lane-'));
  fake = join(root, 'fake');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('lk2-beta-lane.sh on the canonical project', { timeout: 60_000 }, () => {
  beforeEach(() => setup('phub-timeweb-beta', canonical));

  it('rejects anything but a full commit SHA and a promote without a plan', () => {
    expect(run('promote', 'abc').code).not.toBe(0);
    expect(run('plan', 'main').out).toContain('full 40-character main commit sha');
    expect(run('promote', SHA_A).out).toContain(`run '`);
  });

  it('plan records digests and shows the migration plan without writes', () => {
    const { code, out } = run('plan', SHA_A);
    expect(code, out).toBe(0);
    expect(out).toContain('PLAN ONLY');
    expect(calls()).toContain('--lk2-beta-lane-plan');
    expect(calls()).not.toMatch(/ --lk2-beta-lane( |$)/m);
    expect(calls()).not.toMatch(/^(compose|stop|start|rm)/m);
    expect(readFileSync(join(root, 'state', 'plans', SHA_A), 'utf8')).toContain(
      `phub-api@${digestFor(SHA_A, 'api')}`,
    );
    expect(existsSync(join(root, 'state', 'current'))).toBe(false);
  });

  it('promote refuses when the tag points at a different digest than the plan', () => {
    expect(run('plan', SHA_A).code).toBe(0);
    writeFileSync(join(fake, 'repushed'), '');
    const { code, out } = run('promote', SHA_A);
    expect(code).not.toBe(0);
    expect(out).toContain('changed since plan');
    expect(calls()).not.toContain('pg_dump');
  });

  it('promote backs up, migrates, starts the exact digests and records the release', () => {
    const { code, out } = promote(SHA_A);
    expect(out).toContain(`OK: ${SHA_A} is live`);
    expect(code).toBe(0);
    const order = calls();
    expect(order.search(/^stop /m)).toBeGreaterThan(-1);
    expect(order.indexOf('pg_dump')).toBeGreaterThan(-1);
    expect(order.indexOf('pg_dump')).toBeLessThan(order.indexOf(' --lk2-beta-lane\n'));
    expect(order.search(/^stop /m)).toBeLessThan(order.indexOf(' --lk2-beta-lane\n'));
    expect(order.indexOf(' --lk2-beta-lane\n')).toBeLessThan(order.search(/^compose /m));
    expect(readFileSync(join(fake, 'ledger'), 'utf8').trim()).toBe('119');
    for (const svc of SERVICES)
      expect(container(canonical(svc))).toEqual([
        svc,
        'phub-timeweb-beta',
        `ghcr.io/z6v6e6r/phub-${svc}@${digestFor(SHA_A, svc)}`,
        'true',
      ]);
    const release = readFileSync(join(root, 'state', 'releases', `${SHA_A}.env`), 'utf8');
    expect(release).toContain('PHUB_RELEASE_ID=lk2-beta-aaaaaaaaaaaa');
    expect(release).toContain('TIMEWEB_FCM_CREDENTIAL_SOURCE=/etc/phub/fcm.json');
    expect(release).not.toMatch(/pass|word|DATABASE_URL/i);
    // The superuser credential file never outlives the run.
    expect(execFileSync('ls', ['-A', join(root, 'state')], { encoding: 'utf8' })).not.toContain(
      '.tmp',
    );
  });

  it('a failed backup leaves no partial file and changes nothing', () => {
    writeFileSync(join(fake, 'dump-fails'), '');
    const { code, out } = promote(SHA_A);
    expect(code).not.toBe(0);
    expect(out).toContain('backup failed');
    expect(execFileSync('ls', ['-A', join(root, 'state', 'backups')], { encoding: 'utf8' })).toBe(
      '',
    );
    expect(calls()).not.toMatch(/ --lk2-beta-lane$/m);
  });

  it('a failed migration stops before any application change and restarts the worker', () => {
    writeFileSync(join(fake, 'migrate-fails'), '');
    const { code, out } = promote(SHA_A);
    expect(code).not.toBe(0);
    expect(out).toContain('stopped before any application change');
    expect(calls()).not.toMatch(/^compose/m);
    expect(container(canonical('worker'))[3]).toBe('true');
    expect(container(canonical('api'))[2]).toBe(OLD('api'));
  });

  it('a failed start rolls the application back to the baseline images', () => {
    writeFileSync(join(fake, 'up-fails'), '');
    const { code, out } = promote(SHA_A);
    expect(code).not.toBe(0);
    expect(out).toContain('application restored to baseline');
    for (const svc of SERVICES) expect(container(canonical(svc))[2]).toBe(OLD(svc));
    expect(existsSync(join(root, 'state', 'current'))).toBe(false);
  });

  it('rollback pops the stack: previous lane release, then baseline', () => {
    expect(promote(SHA_A).code).toBe(0);
    expect(promote(SHA_B).code).toBe(0);
    expect(container(canonical('api'))[2]).toContain(digestFor(SHA_B, 'api'));
    const first = run('rollback');
    expect(first.out).toContain(`OK: rolled back to ${SHA_A}`);
    expect(container(canonical('api'))[2]).toContain(digestFor(SHA_A, 'api'));
    expect(run('rollback').out).toContain('OK: rolled back to baseline');
    expect(container(canonical('api'))[2]).toBe(OLD('api'));
    expect(run('rollback').out).toContain('nothing to roll back');
  });
});

describe('lk2-beta-lane.sh on a legacy Compose project', { timeout: 60_000 }, () => {
  const legacy = (svc: string) => `legacy-${svc}`;
  beforeEach(() => setup('phub-timeweb-beta-apps', legacy));

  it('requires an explicit env root for a legacy project', () => {
    const result = spawnSync('bash', [SCRIPT, 'plan', SHA_A], {
      encoding: 'utf8',
      env: {
        PATH: `${join(root, 'bin')}:/usr/bin:/bin:/usr/sbin:/sbin`,
        LK2_BETA_LANE_STATE: join(root, 'state'),
      },
    });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('set TIMEWEB_RUNTIME_ENV_ROOT');
  });

  it('refuses two running containers of one service', () => {
    writeFileSync(join(fake, 'c', canonical('api')), `api phub-timeweb-beta ${OLD('api')} true\n`);
    const { code, out } = run('plan', SHA_A);
    expect(code).not.toBe(0);
    expect(out).toContain('more than one running api container');
  });

  it('promote stops (never removes) the legacy containers and rollback restarts them', () => {
    const { code, out } = promote(SHA_A);
    expect(code, out).toBe(0);
    for (const svc of SERVICES) {
      expect(container(legacy(svc))[3]).toBe('false');
      expect(container(canonical(svc))[3]).toBe('true');
    }
    const back = run('rollback');
    expect(back.out).toContain('OK: rolled back to baseline');
    for (const svc of SERVICES) {
      expect(container(legacy(svc))).toEqual([svc, 'phub-timeweb-beta-apps', OLD(svc), 'true']);
      expect(existsSync(join(fake, 'c', canonical(svc)))).toBe(false);
    }
  });

  it('a failed start restores the legacy containers automatically', () => {
    writeFileSync(join(fake, 'up-fails'), '');
    const { code, out } = promote(SHA_A);
    expect(code).not.toBe(0);
    expect(out).toContain('application restored to baseline');
    expect(container(legacy('api'))[3]).toBe('true');
    expect(existsSync(join(fake, 'c', canonical('api')))).toBe(false);
  });
});
