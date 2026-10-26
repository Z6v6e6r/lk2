/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return -- asymmetric matchers (expect.stringMatching/arrayContaining) are intentionally untyped */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const packetPath = resolve(root, 'scripts/control-timeweb-location-photo-acl.py');
const forward = readFileSync(resolve(root, 'deploy/timeweb/location-photo-acl-normalize-0102.sql'));
const recover = readFileSync(
  resolve(root, 'deploy/timeweb/location-photo-acl-normalize-recover-0102.sql'),
);
const pgTest = readFileSync(
  resolve(root, 'scripts/timeweb-location-photo-acl-normalize.pg.test.ts'),
);
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

// The exact 105-row pre-0102 ledger, as the reviewed forward SQL recomputes it.
const ledger = readdirSync(resolve(root, 'packages/database/migrations'))
  .filter((name) => name.endsWith('.sql') && name <= '0101_notification_lifecycle_channels.sql')
  .sort()
  .map((name) => [name, sha256(readFileSync(resolve(root, 'packages/database/migrations', name)))]);

const FIXTURE = String.raw`
import json
NOW = 1790000000.0
REVISION = 'a' * 40
RELEASE = REVISION + '-400-1'
DEFAULT_OPERATION_ID = '2f1c1e2a-6a3d-4a3b-9c1d-5e6f7a8b9c0d'

def encoded(value):
    return packet.encoded(value)

def ok(value):
    return {'rc': 0, 'stdout': json.dumps(value, separators=(',', ':')).encode(), 'stderr': b''}

def failed(rc=3, stderr=b'psql: error'):
    return {'rc': rc, 'stdout': b'', 'stderr': stderr}

def db_preimage(schema_acl=None, **changes):
    value = {
        'database': {
            'name': 'phub_beta',
            'systemIdentifier': '7679125609183186977',
            'owner': 'phub_beta',
            'currentUser': 'phub_beta',
            'sessionUser': 'phub_beta',
            'roleSetting': 'none',
            'operatorSafe': True,
        },
        'ledger': LEDGER,
        'schemaAcl': packet.PRE_ACL if schema_acl is None else schema_acl,
        'roles': {
            'attributes': [
                ['phub_beta', True, True, True, True, True, False, True],
                ['phub_migrator', False, True, False, False, True, False, False],
                ['phub_runtime', False, True, False, False, True, False, False],
            ],
            'members': [],
            'safe': True,
        },
        'eventTriggers': [['photo_acl_guard', 'D']],
        'hazards': {'migrationLockHeld': False, 'longTransactions': 0, 'conflictingLocks': 0},
        'photo': {'exists': False, 'relation': '', 'rowCount': 0},
        'unrelated': {
            'schemas': [[1, 'pg_catalog', 10, None]],
            'relations': [[1, 10, None, False, False]],
            'columns': [],
            'defaults': [],
            'roles': [[10, 'phub_beta', True, True, True, True, True, False, True]],
            'members': [],
        },
    }
    value.update(changes)
    return value

def post_preimage(**changes):
    return db_preimage(schema_acl=packet.POST_ACL, **changes)

def container(service, healthy=True, restarts=0, revision=REVISION):
    repository = 'docker.io/library/postgres' if service == 'postgres' else 'ghcr.io/z6v6e6r/phub-' + service
    image_id = 'sha256:' + ('2' if service == 'postgres' else '1') * 64
    labels = {}
    if service != 'postgres':
        labels['org.opencontainers.image.revision'] = revision
    if service in ('api', 'web'):
        labels['phub.release-id'] = REVISION + '-400-1'
    return {
        'Id': {'api': 'a', 'web': 'b', 'worker': 'c', 'realtime': 'd', 'postgres': 'e'}[service] * 64,
        'Image': image_id,
        'Config': {'Image': repository + '@' + image_id, 'Labels': labels},
        'State': {
            'Status': 'running',
            'StartedAt': '2026-10-27T00:00:00.123456789Z',
            'Health': {'Status': 'healthy' if healthy else 'unhealthy'},
        },
        'RestartCount': restarts if service == 'api' else 0,
    }

def containers(**changes):
    values = {service: container(service) for service in ('api', 'web', 'worker', 'realtime', 'postgres')}
    for service, change in changes.items():
        values[service] = container(service, **change)
    return values

def installed_descriptor():
    lines = [
        'API_IMAGE_DIGEST=sha256:' + '1' * 64,
        'PHUB_COMPONENT_ROLLOUT_KIND=API_WEB',
        'PHUB_RELEASE_ID=' + RELEASE,
        'PHUB_RUNTIME_SECRET_SET_RELEASE_ID=' + RELEASE,
        'PHUB_TIMEWEB_RELEASE_ENV_SCHEMA=PHUB_TIMEWEB_INSTALLED_COMPONENT_ENV_V1',
    ]
    return ('\n'.join(lines) + '\n').encode()

def base_files():
    return {
        str(packet.CONFIG): packet.encoded(
            {'schema': 1, 'enabled': True, 'owner': 'authorized-owner', 'controllerSha': REVISION}
        ),
        str(packet.SOURCE / packet.FORWARD_SQL_PATH): FORWARD,
        str(packet.SOURCE / packet.RECOVER_SQL_PATH): RECOVER,
        str(packet.SOURCE / packet.PG_TEST_PATH): PG_TEST,
        str(packet.ROOT / 'releases' / RELEASE / 'installed-components.env'): installed_descriptor(),
    }

def git_map(revision=REVISION, tree='b' * 40, dirty=''):
    return {
        'rev-parse --show-toplevel': str(packet.SOURCE),
        'rev-parse --absolute-git-dir': str(packet.SOURCE / '.git'),
        'rev-parse --path-format=absolute --git-common-dir': str(packet.SOURCE / '.git'),
        'rev-parse HEAD': revision,
        'rev-parse HEAD^{tree}': tree,
        'status --porcelain --untracked-files=all': dirty,
    }

class FakeRt:
    def __init__(self, files=None, psql=None, inspect=None, git=None, now=NOW, euid=0, present=None, busy_lock=False):
        self.files = dict(files or base_files())
        self.psql_outputs = list(psql or [])
        self.psql_calls = []
        self.inspect_map = dict(inspect or containers())
        self.git_map = dict(git or git_map())
        self.git_calls = []
        self.now_value = now
        self.euid_value = euid
        self.present_extra = set(present or ())
        self.writes = []
        self.busy_lock = busy_lock
        self.lock_held = False

    def euid(self):
        return self.euid_value

    def now(self):
        return self.now_value

    def umask(self):
        return None

    def secure(self, path, kind='file', mode=None):
        return object()

    def read(self, path, mode=0o600):
        key = str(path)
        if key not in self.files:
            raise packet.Stop('LOCATION_PHOTO_ACL_READ')
        return self.files[key]

    def present(self, path):
        return str(path) in self.files or str(path) in self.present_extra

    def write_exclusive(self, path, data):
        key = str(path)
        if key in self.files:
            raise packet.Stop('LOCATION_PHOTO_ACL_WRITE_EXISTS')
        self.files[key] = data
        self.writes.append(key)

    def acquire_packet_lock(self, marker):
        if self.busy_lock or self.lock_held:
            raise packet.Stop('LOCATION_PHOTO_ACL_PACKET_BUSY')
        self.lock_held = True
        return object()

    def release_packet_lock(self, fd):
        self.lock_held = False

    def git(self, args):
        self.git_calls.append(list(args))
        key = ' '.join(args)
        if key not in self.git_map:
            raise packet.Stop('LOCATION_PHOTO_ACL_GIT')
        return self.git_map[key]

    def inspect(self, service):
        if service not in self.inspect_map:
            raise packet.Stop('LOCATION_PHOTO_ACL_DOCKER')
        return self.inspect_map[service]

    def psql(self, sql, read_only):
        self.psql_calls.append((bytes(sql), bool(read_only)))
        if not self.psql_outputs:
            raise packet.Stop('LOCATION_PHOTO_ACL_PSQL')
        return self.psql_outputs.pop(0)

def full_preimage(pre_value=None, inspect=None):
    rt = FakeRt(files=base_files(), psql=[ok(pre_value or db_preimage())], inspect=inspect or containers())
    return packet.capture_preimage(rt)

def preimage_hash(pre_value=None, inspect=None):
    return packet.digest(packet.canonical(full_preimage(pre_value, inspect)))

def make_op(preimage_sha, **changes):
    operation = {
        'schema': packet.SCHEMA,
        'operationId': DEFAULT_OPERATION_ID,
        'target': {'databaseName': 'phub_beta', 'systemIdentifier': '7679125609183186977'},
        'controllerSha': REVISION,
        'controllerTree': 'b' * 40,
        'controllerSourceCiRunId': '40300000001',
        'forwardSqlSha256': packet.FORWARD_SQL_SHA256,
        'recoverSqlSha256': packet.RECOVER_SQL_SHA256,
        'expectedLedgerSha256': packet.EXPECTED_LEDGER_SHA256,
        'expectedPreimageSha256': preimage_sha,
        'pgTestEvidence': {
            'testPath': packet.PG_TEST_PATH,
            'testSha256': packet.PG_TEST_SHA256,
            'ciRunId': '40300000002',
            'conclusion': 'success',
        },
        'expiresAt': packet.now_iso(NOW + 1800),
        'confirmation': packet.CONFIRMATION,
    }
    operation.update(changes)
    return operation

def sealed_host(preimage=None, inspect=None, psql=None, git=None, files=None, present=None, operation=None):
    captured = full_preimage(preimage, inspect)
    operation = operation or make_op(packet.digest(packet.canonical(captured)))
    guard = packet.derive_guard(FORWARD)
    request = packet.encoded(operation)
    intent = {
        'schema': packet.INTENT_SCHEMA,
        'operationId': operation['operationId'],
        'requestSha256': packet.digest(request),
        'preimageSha256': operation['expectedPreimageSha256'],
        'guardSqlSha256': packet.digest(guard),
        'guardAck': {
            'schema': packet.GUARD_SCHEMA,
            'exitCode': 0,
            'stdoutSha256': packet.digest(b''),
            'stdoutBytes': 0,
            'stderrSha256': packet.digest(b''),
            'stderrBytes': 0,
        },
        'preparedAt': packet.now_iso(NOW - 60),
    }
    merged = dict(base_files())
    merged[str(packet.REQUEST)] = request
    merged[str(packet.PREIMAGE)] = packet.canonical(captured)
    merged[str(packet.INTENT)] = packet.encoded(intent)
    merged.update(files or {})
    rt = FakeRt(
        files=merged,
        psql=list(psql if psql is not None else [ok(preimage or db_preimage())]),
        inspect=inspect or containers(),
        git=git or git_map(),
        present=present,
    )
    return rt, operation, intent, request

def outcome(thunk):
    try:
        return {'threw': False, 'value': thunk()}
    except packet.Stop as error:
        return {'threw': True, 'code': str(error)}
`;

function prelude(): string {
  return `
import importlib.util
import json
import sys

spec = importlib.util.spec_from_file_location('acl_packet', ${JSON.stringify(packetPath)})
packet = importlib.util.module_from_spec(spec)
spec.loader.exec_module(packet)
FORWARD = ${JSON.stringify(forward.toString('base64'))}
RECOVER = ${JSON.stringify(recover.toString('base64'))}
PG_TEST = ${JSON.stringify(pgTest.toString('base64'))}
FORWARD = __import__('base64').b64decode(FORWARD)
RECOVER = __import__('base64').b64decode(RECOVER)
PG_TEST = __import__('base64').b64decode(PG_TEST)
LEDGER = json.loads(${JSON.stringify(JSON.stringify(ledger))})
${FIXTURE}
`;
}

function run(body: string) {
  const result = spawnSync('python3', ['-I', '-B', '-c', `${prelude()}${body}`], {
    encoding: 'utf8',
    cwd: root,
    timeout: 120000,
  });
  expect(result.status, result.stderr).toBe(0);
  const lines = result.stdout.trim().split('\n');
  return JSON.parse(lines[lines.length - 1] ?? 'null') as unknown;
}

describe('reviewed inputs stay pinned', () => {
  it('pins both SQL files and the disposable PG proof to their reviewed digests', () => {
    expect(sha256(forward)).toBe(
      '2973fb9305c8f2610165cfb61b92e65127bebcccaf42afc4a2930686fa5f4b9e',
    );
    expect(sha256(recover)).toBe(
      '4c2d2c3c259d76f8e47468e547786452296d5afcafa0f748a9c4575fdc84addc',
    );
    expect(sha256(pgTest)).toBe('6835bb05a790676eff191ef957bfe19a7ce25473376cd5209450103f4594bdea');
    const digest = createHash('sha256')
      .update(JSON.stringify(ledger).replaceAll(' ', '') + '\n')
      .digest('hex');
    expect(digest).toBe('7bd0476427e40967f4531972829a86f578d0e9d844ab9e92f16637b868e207fd');
  });
});

describe('bounded reads', () => {
  it('accepts the real >64 KiB canonical preimage read (host measured ~89 KiB)', () => {
    const value = run(`
value = {'big': 'x' * (100 * 1024), 'unrelated': {'members': []}}
outcome = packet.read_psql_json({'rc': 0, 'stdout': json.dumps(value).encode(), 'stderr': b''}, 'PREIMAGE_READ')
print(json.dumps({'big': len(outcome['big'])}))
`);
    expect(value).toEqual({ big: 102400 });
  });
});

describe('request authority', () => {
  it('admits the exact beta normalization request', () => {
    expect(
      run(`
pre = preimage_hash()
operation = make_op(pre)
value = packet.validate_operation(operation, NOW, FakeRt())
print(json.dumps({'schema': value['schema'], 'confirmation': value['confirmation'], 'expiry': value['expiresAt']}))
`),
    ).toEqual({
      schema: 'PHUB_TIMEWEB_LOCATION_PHOTO_ACL_NORMALIZE_V1',
      confirmation:
        'NORMALIZE_LOCATION_PHOTO_ACL_105_TWO_SCHEMA_GRANTS_KEEP_EDITOR_ACL_NO_MIGRATION',
      expiry: '2026-09-21T14:43:20.000Z',
    });
  });
  it('rejects every changed authority field, expiry window, target and confirmation', () => {
    const mutations = [
      ['schema', 'OTHER'],
      ['operationId', 'not-a-uuid'],
      ['target', { databaseName: 'other', systemIdentifier: '7679125609183186977' }],
      ['target', { databaseName: 'phub_beta', systemIdentifier: '1' }],
      ['controllerSha', 'main'],
      ['controllerTree', 'b'.repeat(39)],
      ['controllerSourceCiRunId', '01'],
      ['forwardSqlSha256', '0'.repeat(64)],
      ['recoverSqlSha256', '0'.repeat(64)],
      ['expectedLedgerSha256', '0'.repeat(64)],
      ['expectedPreimageSha256', 'short'],
      [
        'pgTestEvidence',
        {
          testPath: 'scripts/other.ts',
          testSha256: '0'.repeat(64),
          ciRunId: '1',
          conclusion: 'success',
        },
      ],
      [
        'pgTestEvidence',
        {
          testPath: 'scripts/timeweb-location-photo-acl-normalize.pg.test.ts',
          testSha256: '6835bb05a790676eff191ef957bfe19a7ce25473376cd5209450103f4594bdea',
          ciRunId: '1',
          conclusion: 'failure',
        },
      ],
      ['expiresAt', '2026-09-21T14:32:20.000Z'],
      ['expiresAt', '2026-09-21T15:44:20.000Z'],
      ['expiresAt', '2026-09-21T14:43:20Z'],
      ['confirmation', 'NORMALIZE'],
    ];
    const encodedMutations = JSON.stringify(mutations);
    expect(
      run(`
pre = preimage_hash()
operation = make_op(pre)
results = []
for field, value in json.loads(${JSON.stringify(encodedMutations)}):
    changed = dict(operation)
    changed[field] = value
    results.append(outcome(lambda: packet.validate_operation(changed, NOW, FakeRt()))['code'])
print(json.dumps(results))
`),
    ).toEqual(mutations.map(() => expect.stringMatching(/^LOCATION_PHOTO_ACL_/)));
  });
  it('rejects unknown, missing and duplicate keys', () => {
    expect(
      run(`
pre = preimage_hash()
operation = make_op(pre)
unknown = dict(operation, extra=True)
missing = {key: value for key, value in operation.items() if key != 'target'}
raw = b'{"duplicate":1,"duplicate":2}\\n'
results = [
    outcome(lambda: packet.validate_operation(unknown, NOW, FakeRt()))['code'],
    outcome(lambda: packet.validate_operation(missing, NOW, FakeRt()))['code'],
    outcome(lambda: packet.strict(raw))['code'],
]
print(json.dumps(results))
`),
    ).toEqual([
      'LOCATION_PHOTO_ACL_FIELDS',
      'LOCATION_PHOTO_ACL_FIELDS',
      'LOCATION_PHOTO_ACL_DUPLICATE_JSON_KEY',
    ]);
  });
  it('refuses a non-root caller and any other request path', () => {
    expect(
      run(`
pre = preimage_hash()
operation = make_op(pre)
rt = FakeRt(files=dict(base_files(), **{str(packet.REQUEST): packet.encoded(operation)}), euid=1000)
results = [
    outcome(lambda: packet.prepare(packet.REQUEST, rt))['code'],
    outcome(lambda: packet.prepare('/tmp/request.json', FakeRt()))['code'],
]
print(json.dumps(results))
`),
    ).toEqual(['LOCATION_PHOTO_ACL_NOT_ROOT', 'LOCATION_PHOTO_ACL_REQUEST_PATH']);
  });
});

describe('guard derivation', () => {
  it('keeps every pre-effect assertion, drops both ACL statements and ends with rollback', () => {
    expect(
      run(`
guard = packet.derive_guard(FORWARD).decode()
print(json.dumps({
    'locator': 'pg_try_advisory_xact_lock(7140221)' in guard,
    'preimage': 'LOCATION_PHOTO_ACL_SCHEMA_PREIMAGE' in guard,
    'ledger': 'LOCATION_PHOTO_ACL_LEDGER' in guard,
    'hazard': 'LOCATION_PHOTO_ACL_HAZARD' in guard,
    'roles': 'LOCATION_PHOTO_ACL_ROLES' in guard,
    'rollback': guard.rstrip().endswith('rollback;'),
    'grant': 'grant usage on schema locations to phub_migrator;' in guard,
    'revoke': 'revoke create on schema public from phub_migrator restrict;' in guard,
    'commit': 'commit;' in guard,
}))
`),
    ).toEqual({
      locator: true,
      preimage: true,
      ledger: true,
      hazard: true,
      roles: true,
      rollback: true,
      grant: false,
      revoke: false,
      commit: false,
    });
  });
  it('fails closed when the reviewed statements are absent or duplicated', () => {
    expect(
      run(`
statement = b'grant usage on schema locations to phub_migrator;'
results = [
    outcome(lambda: packet.derive_guard(FORWARD.replace(statement, b'grant usage on schema locations to phub_runtime;')))['code'],
    outcome(lambda: packet.derive_guard(FORWARD + statement + b'\\n'))['code'],
]
print(json.dumps(results))
`),
    ).toEqual(['LOCATION_PHOTO_ACL_GUARD_SQL', 'LOCATION_PHOTO_ACL_GUARD_SQL']);
  });
});

describe('preimage canonicalization and validation', () => {
  it('canonicalizes deterministically regardless of insertion order', () => {
    expect(
      run(`
first = db_preimage()
second = dict(reversed(list(db_preimage().items())))
print(json.dumps({
    'equal': packet.canonical(first) == packet.canonical(second),
    'sorted': list(json.loads(packet.canonical(first)).keys()) == sorted(first),
    'newline': packet.canonical(first).endswith(b'\\n'),
}))
`),
    ).toEqual({ equal: true, sorted: true, newline: true });
  });
  it('rejects wrong target, ledger, preimage ACL, roles, hazards and photo presence', () => {
    expect(
      run(`
base = full_preimage()
cases = []
for pre in [
    dict(base, database=dict(base['database'], name='other')),
    dict(base, database=dict(base['database'], owner='other')),
    dict(base, ledger=base['ledger'][:-1]),
    dict(base, ledger=[list(reversed(row)) for row in base['ledger']]),
    dict(base, schemaAcl=[]),
    dict(base, roles=dict(base['roles'], safe=False)),
    dict(base, hazards=dict(base['hazards'], migrationLockHeld=True)),
    dict(base, hazards=dict(base['hazards'], longTransactions=1)),
    dict(base, photo={'exists': True, 'relation': 'locations.recommendation_card_photos', 'rowCount': 0}),
    dict(base, eventTriggers=[['photo_acl_guard', 'O']]),
]:
    cases.append(outcome(lambda pre=pre: packet.validate_preimage(dict(pre)))['code'])
print(json.dumps(cases))
`),
    ).toEqual([
      'LOCATION_PHOTO_ACL_PREIMAGE_TARGET',
      'LOCATION_PHOTO_ACL_PREIMAGE_TARGET',
      'LOCATION_PHOTO_ACL_LEDGER',
      'LOCATION_PHOTO_ACL_LEDGER',
      'LOCATION_PHOTO_ACL_PREIMAGE_SCHEMA_ACL',
      'LOCATION_PHOTO_ACL_PREIMAGE_ROLES',
      'LOCATION_PHOTO_ACL_PREIMAGE_HAZARD',
      'LOCATION_PHOTO_ACL_PREIMAGE_HAZARD',
      'LOCATION_PHOTO_ACL_PREIMAGE_PHOTO',
      'LOCATION_PHOTO_ACL_PREIMAGE_HAZARD',
    ]);
  });
  it('rejects drifted or unhealthy runtime readbacks and missing installed envelopes', () => {
    expect(
      run(`
operation = make_op(preimage_hash())
rt = FakeRt(
    files=dict(base_files(), **{str(packet.REQUEST): packet.encoded(operation)}),
    psql=[ok(db_preimage())],
    inspect=containers(web={'healthy': False}),
)
print(json.dumps(outcome(lambda: packet.prepare(packet.REQUEST, rt))['code']))
`),
    ).toBe('LOCATION_PHOTO_ACL_RUNTIME');
    expect(
      run(`
pre = preimage_hash()
operation = make_op(pre)
files = dict(base_files(), **{str(packet.REQUEST): packet.encoded(operation)})
files[str(packet.ROOT / 'releases' / RELEASE / 'installed-components.env')] = b'PHUB_RELEASE_ID=' + RELEASE.encode() + b'\\n'
rt = FakeRt(files=files, psql=[ok(db_preimage())])
print(json.dumps(outcome(lambda: packet.prepare(packet.REQUEST, rt))['code']))
`),
    ).toBe('LOCATION_PHOTO_ACL_INSTALLED');
  });
});

describe('prepare mode', () => {
  it('refuses a post-normalization snapshot as the guarded PRE baseline', () => {
    expect(
      run(`
pre = post_preimage()
sha = preimage_hash(pre)
operation = make_op(sha)
rt = FakeRt(
    files=dict(base_files(), **{str(packet.REQUEST): packet.encoded(operation)}),
    psql=[ok(pre), ok({})],
)
print(json.dumps({**outcome(lambda: packet.prepare(packet.REQUEST, rt)), 'psqlCalls': len(rt.psql_calls)}))
`),
    ).toEqual({ threw: true, code: 'LOCATION_PHOTO_ACL_PREIMAGE_SCHEMA_ACL', psqlCalls: 1 });
  });

  it('seals preimage, runs exactly one read-only guard psql and writes intent', () => {
    expect(
      run(`
pre = db_preimage()
sha = preimage_hash(pre)
operation = make_op(sha)
rt = FakeRt(
    files=dict(base_files(), **{str(packet.REQUEST): packet.encoded(operation)}),
    psql=[ok(pre), ok({})],
)
intent = packet.prepare(packet.REQUEST, rt)
print(json.dumps({
    'intent': intent['schema'],
    'operationId': intent['operationId'],
    'requestSha256': intent['requestSha256'],
    'preimageSha256': intent['preimageSha256'],
    'guardSqlSha256': intent['guardSqlSha256'],
    'psqlCalls': len(rt.psql_calls),
    'readOnly': rt.psql_calls[1][1],
    'guardHasGrant': b'grant usage on schema locations to phub_migrator;' in rt.psql_calls[1][0],
    'guardEndsRollback': rt.psql_calls[1][0].decode().rstrip().endswith('rollback;'),
    'files': sorted(name for name in rt.files if '/operator/location-photo-acl' in name),
    'preimage': packet.digest(rt.files[str(packet.PREIMAGE)]),
}))
`),
    ).toEqual({
      intent: 'PHUB_TIMEWEB_LOCATION_PHOTO_ACL_NORMALIZE_INTENT_V1',
      operationId: '2f1c1e2a-6a3d-4a3b-9c1d-5e6f7a8b9c0d',
      requestSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      preimageSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      guardSqlSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      psqlCalls: 2,
      readOnly: true,
      guardHasGrant: false,
      guardEndsRollback: true,
      files: expect.arrayContaining([
        expect.stringContaining('location-photo-acl-normalize.preimage.json'),
        expect.stringContaining('location-photo-acl-normalize.intent.json'),
        expect.stringContaining('location-photo-acl-normalize.guard.log'),
      ]),
      preimage: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });
  it('refuses a preimage hash mismatch before running the guard', () => {
    expect(
      run(`
operation = make_op('0' * 64)
rt = FakeRt(
    files=dict(base_files(), **{str(packet.REQUEST): packet.encoded(operation)}),
    psql=[ok(db_preimage()), ok({})],
)
print(json.dumps({**outcome(lambda: packet.prepare(packet.REQUEST, rt)), 'psqlCalls': len(rt.psql_calls)}))
`),
    ).toEqual({
      threw: true,
      code: 'LOCATION_PHOTO_ACL_PREIMAGE',
      psqlCalls: 1,
    });
  });
  it('reuses an identical sealed intent without a second guard attempt', () => {
    expect(
      run(`
pre = db_preimage()
sha = preimage_hash(pre)
operation = make_op(sha)
rt = FakeRt(
    files=dict(base_files(), **{str(packet.REQUEST): packet.encoded(operation)}),
    psql=[ok(pre), ok({})],
)
first = packet.prepare(packet.REQUEST, rt)
rt.psql_calls.clear()
second = packet.prepare(packet.REQUEST, rt)
print(json.dumps({
    'identical': first == second,
    'psqlCalls': len(rt.psql_calls),
}))
`),
    ).toEqual({ identical: true, psqlCalls: 0 });
  });
  it('refuses custody while another migration owner holds the standard lock', () => {
    expect(
      run(`
pre = db_preimage()
sha = preimage_hash(pre)
operation = make_op(sha)
rt = FakeRt(
    files=dict(base_files(), **{str(packet.REQUEST): packet.encoded(operation)}),
    psql=[ok(pre), ok({})],
    present={str(packet.CUSTODY_LOCK)},
)
print(json.dumps({**outcome(lambda: packet.prepare(packet.REQUEST, rt)), 'psqlCalls': len(rt.psql_calls)}))
`),
    ).toEqual({ threw: true, code: 'LOCATION_PHOTO_ACL_CUSTODY', psqlCalls: 1 });
  });
  it('fails closed when the guard acknowledgement is lost or errored', () => {
    expect(
      run(`
pre = db_preimage()
sha = preimage_hash(pre)
operation = make_op(sha)
rt = FakeRt(
    files=dict(base_files(), **{str(packet.REQUEST): packet.encoded(operation)}),
    psql=[ok(pre), failed()],
)
print(json.dumps(outcome(lambda: packet.prepare(packet.REQUEST, rt))['code']))
`),
    ).toBe('LOCATION_PHOTO_ACL_GUARD_EXEC');
  });
});

describe('execute and reconcile state machine', () => {
  it('applies the reviewed SQL exactly once by stdin and verifies the exact postimage', () => {
    expect(
      run(`
rt, operation, intent, request = sealed_host()
rt.psql_outputs = [ok(db_preimage()), ok({}), ok(post_preimage())]
receipt = packet.execute(packet.REQUEST, rt)
applies = [call for call in rt.psql_calls if not call[1]]
print(json.dumps({
    'status': receipt['status'],
    'receipt': receipt['schema'],
    'applyCount': len(applies),
    'stdinSql': applies[0][0] == FORWARD,
    'readOnly': applies[0][1],
    'retired': rt.present(packet.RETIRED),
    'receiptWritten': rt.present(packet.RECEIPT),
    'postcheck': isinstance(receipt['postcheckSha256'], str),
}))
`),
    ).toEqual({
      status: 'APPLIED_VERIFIED',
      receipt: 'PHUB_TIMEWEB_LOCATION_PHOTO_ACL_NORMALIZE_RECEIPT_V1',
      applyCount: 1,
      stdinSql: true,
      readOnly: false,
      retired: true,
      receiptWritten: true,
      postcheck: true,
    });
  });
  it('refuses a second apply for the same operationId without any SQL', () => {
    expect(
      run(`
rt, operation, intent, request = sealed_host()
rt.files[str(packet.RECEIPT)] = packet.encoded({
    'schema': packet.RECEIPT_SCHEMA, 'status': 'APPLIED_VERIFIED',
    'operationId': operation['operationId'], 'requestSha256': 'a' * 64,
    'preimageSha256': 'b' * 64, 'guardSqlSha256': 'c' * 64,
    'postcheckSha256': 'd' * 64, 'observedPreimageSha256': 'e' * 64,
    'classifiedAt': packet.now_iso(NOW), 'appliedAt': packet.now_iso(NOW),
})
rt.psql_outputs = []
print(json.dumps({**outcome(lambda: packet.execute(packet.REQUEST, rt)), 'psqlCalls': len(rt.psql_calls)}))
`),
    ).toEqual({ threw: true, code: 'LOCATION_PHOTO_ACL_OPERATION_RETIRED', psqlCalls: 0 });
  });
  it('refuses execute while an advisory lock or long transaction is held', () => {
    expect(
      run(`
results = []
for hazard in ({'migrationLockHeld': True, 'longTransactions': 0, 'conflictingLocks': 0},
               {'migrationLockHeld': False, 'longTransactions': 1, 'conflictingLocks': 0}):
    rt, operation, intent, request = sealed_host()
    locked = db_preimage(hazards=hazard)
    rt.psql_outputs = [ok(locked)]
    results.append({
        'code': outcome(lambda: packet.execute(packet.REQUEST, rt)).get('code'),
        'applyCount': len([call for call in rt.psql_calls if not call[1]]),
    })
print(json.dumps(results))
`),
    ).toEqual([
      { code: 'LOCATION_PHOTO_ACL_CUSTODY', applyCount: 0 },
      { code: 'LOCATION_PHOTO_ACL_CUSTODY', applyCount: 0 },
    ]);
  });
  it('refuses a preimage that drifted before the single apply attempt', () => {
    expect(
      run(`
rt, operation, intent, request = sealed_host()
drifted = db_preimage()
drifted['unrelated']['relations'] = [[9, 10, None, False, False]]
rt.psql_outputs = [ok(drifted)]
receipt = packet.execute(packet.REQUEST, rt)
print(json.dumps({
    'status': receipt['status'],
    'applyCount': len([call for call in rt.psql_calls if not call[1]]),
    'retired': rt.present(packet.RETIRED),
}))
`),
    ).toEqual({ status: 'UNKNOWN', applyCount: 0, retired: false });
  });
  it.each([
    ['PRE', 'ABORTED', 3],
    ['POST', 'APPLIED_RECONCILED', 3],
    ['UNKNOWN', 'UNKNOWN', 3],
  ])('classifies a failed apply readback %s as %s without any retry', (state, status, rc) => {
    expect(
      run(`
rt, operation, intent, request = sealed_host()
observed = db_preimage() if '${state}' == 'PRE' else (post_preimage() if '${state}' == 'POST' else db_preimage(database=dict(db_preimage()['database'], owner='other')))
rt.psql_outputs = [ok(db_preimage()), failed(rc=${rc}), ok(observed)]
receipt = packet.execute(packet.REQUEST, rt)
print(json.dumps({
    'status': receipt['status'],
    'applyCount': len([call for call in rt.psql_calls if not call[1]]),
    'retired': rt.present(packet.RETIRED),
}))
`),
    ).toEqual({ status, applyCount: 1, retired: status === 'APPLIED_RECONCILED' });
  });
  it('reconciles read-only into ABORTED, APPLIED_RECONCILED or UNKNOWN', () => {
    expect(
      run(`
results = []
for state in ('PRE', 'POST', 'UNKNOWN'):
    rt, operation, intent, request = sealed_host()
    observed = db_preimage() if state == 'PRE' else (post_preimage() if state == 'POST' else db_preimage(database=dict(db_preimage()['database'], owner='other')))
    rt.psql_outputs = [ok(observed)]
    receipt = packet.reconcile(packet.REQUEST, rt)
    results.append({
        'status': receipt['status'],
        'applyCount': len([call for call in rt.psql_calls if not call[1]]),
    })
print(json.dumps(results))
`),
    ).toEqual([
      { status: 'ABORTED', applyCount: 0 },
      { status: 'APPLIED_RECONCILED', applyCount: 0 },
      { status: 'UNKNOWN', applyCount: 0 },
    ]);
  });
  it('reconciles after expiry but never applies SQL', () => {
    expect(
      run(`
rt, operation, intent, request = sealed_host()
rt.now_value = NOW + 86400
rt.psql_outputs = [ok(db_preimage())]
receipt = packet.reconcile(packet.REQUEST, rt)
print(json.dumps({
    'status': receipt['status'],
    'applyCount': len([call for call in rt.psql_calls if not call[1]]),
    'readCalls': len(rt.psql_calls),
}))
`),
    ).toEqual({ status: 'ABORTED', applyCount: 0, readCalls: 1 });
  });
  it('refuses execute after expiry and refuses a missing intent', () => {
    expect(
      run(`
rt, operation, intent, request = sealed_host()
rt.now_value = NOW + 3600
results = [outcome(lambda: packet.execute(packet.REQUEST, rt))['code']]
rt2, operation2, intent2, request2 = sealed_host()
rt2.files.pop(str(packet.INTENT))
results.append(outcome(lambda: packet.execute(packet.REQUEST, rt2))['code'])
print(json.dumps(results))
`),
    ).toEqual(['LOCATION_PHOTO_ACL_EXPIRY', 'LOCATION_PHOTO_ACL_INTENT_MISSING']);
  });
});

describe('production runtime container discovery (B1)', () => {
  const RUNTIME_FIXTURE = `
import types

def runtime_run(truncated=False, foreign=False):
    calls = []
    seen = {}

    def run(args, input_data=None):
        calls.append(list(args))
        if args[0:2] == ['/usr/bin/docker', 'exec']:
            return types.SimpleNamespace(returncode=0, stdout=b'1', stderr=b'')
        if args[1] == 'ps':
            project = args[5].rsplit('=', 1)[1]
            service = args[7].rsplit('=', 1)[1]
            identifier = {'api': 'a', 'web': 'b', 'worker': 'c', 'realtime': 'd', 'postgres': 'e'}[service] * 64
            if truncated:
                identifier = identifier[:12]
            seen[identifier] = (project, service)
            return types.SimpleNamespace(returncode=0, stdout=(identifier + '\\n').encode(), stderr=b'')
        identifier = args[2]
        project, service = seen[identifier]
        if foreign:
            project = 'other-project'
        return types.SimpleNamespace(
            returncode=0,
            stderr=b'',
            stdout=json.dumps([{
                'Id': identifier,
                'Config': {
                    'Image': ('ghcr.io/z6v6e6r/phub-' if service != 'postgres' else 'docker.io/library/postgres@') + service,
                    'Labels': {
                        'com.docker.compose.project': project,
                        'com.docker.compose.service': service,
                    },
                },
                'Image': 'sha256:' + '1' * 64,
                'RestartCount': 0,
                'State': {
                    'Status': 'running',
                    'StartedAt': '2026-10-27T00:00:00.123456789Z',
                    'Health': {'Status': 'healthy'},
                },
            }]).encode(),
        )

    return run, calls
`;
  it('passes --no-trunc and resolves postgres in the dependencies project', () => {
    expect(
      run(`
${RUNTIME_FIXTURE}
run, calls = runtime_run()
runtime = packet.Runtime(run=run)
api = runtime.inspect('api')
postgres = runtime.inspect('postgres')
psql = runtime.psql('select 1', True)
ps_calls = [call for call in calls if call[1] == 'ps']
psql_calls = [call for call in calls if call[0] == '/usr/bin/docker' and 'psql' in call]
print(json.dumps({
    'noTrunc': all('--no-trunc' in call for call in ps_calls),
    'apiProject': ps_calls[0][5],
    'postgresProject': ps_calls[1][5],
    'apiId': api['Id'],
    'postgresId': postgres['Id'],
    'psqlQuiet': bool(psql_calls) and all('--quiet' in call for call in psql_calls),
    'psqlRc': psql['rc'],
}))
`),
    ).toEqual({
      noTrunc: true,
      apiProject: 'label=com.docker.compose.project=phub-timeweb-beta',
      postgresProject: 'label=com.docker.compose.project=phub-timeweb-beta-dependencies',
      apiId: 'a'.repeat(64),
      postgresId: 'e'.repeat(64),
      psqlQuiet: true,
      psqlRc: 0,
    });
  });
  it('fails closed on a truncated id or a foreign compose identity', () => {
    expect(
      run(`
${RUNTIME_FIXTURE}
truncated, _ = runtime_run(truncated=True)
foreign, _ = runtime_run(foreign=True)
print(json.dumps([
    outcome(lambda: packet.Runtime(run=truncated).inspect('api'))['code'],
    outcome(lambda: packet.Runtime(run=foreign).inspect('api'))['code'],
]))
`),
    ).toEqual(['LOCATION_PHOTO_ACL_DOCKER', 'LOCATION_PHOTO_ACL_DOCKER']);
  });
});

describe('sealed evidence and concurrent invocation (B3, nits)', () => {
  it('refuses a stale or re-minted request in reconcile without writing a receipt', () => {
    expect(
      run(`
results = []
for change in (
    {'operationId': '11111111-1111-4111-8111-111111111111'},
    {'expectedPreimageSha256': 'f' * 64},
):
    rt, operation, intent, request = sealed_host()
    stale = dict(operation)
    stale.update(change)
    rt.files[str(packet.REQUEST)] = packet.encoded(stale)
    results.append({
        **outcome(lambda: packet.reconcile(packet.REQUEST, rt)),
        'receipt': rt.present(packet.RECEIPT),
        'lockHeld': rt.lock_held,
    })
print(json.dumps(results))
`),
    ).toEqual([
      { threw: true, code: 'LOCATION_PHOTO_ACL_INTENT', receipt: false, lockHeld: false },
      { threw: true, code: 'LOCATION_PHOTO_ACL_INTENT', receipt: false, lockHeld: false },
    ]);
  });
  it('fails closed when a concurrent packet invocation holds the lock', () => {
    expect(
      run(`
pre = db_preimage()
operation = make_op(preimage_hash(pre))
rt = FakeRt(
    files=dict(base_files(), **{str(packet.REQUEST): packet.encoded(operation)}),
    psql=[ok(pre), ok({})],
    busy_lock=True,
)
print(json.dumps({**outcome(lambda: packet.prepare(packet.REQUEST, rt)), 'psqlCalls': len(rt.psql_calls)}))
`),
    ).toEqual({ threw: true, code: 'LOCATION_PHOTO_ACL_PACKET_BUSY', psqlCalls: 0 });
  });
  it('resumes a preimage/guard crash without overwriting evidence or running the guard twice', () => {
    expect(
      run(`
pre = db_preimage()
sha = preimage_hash(pre)
operation = make_op(sha)
captured = full_preimage(pre)
guard = packet.derive_guard(FORWARD)
ack = {'schema': packet.GUARD_SCHEMA, 'exitCode': 0, 'stdoutSha256': packet.digest(b''),
       'stdoutBytes': 0, 'stderrSha256': packet.digest(b''), 'stderrBytes': 0}
log = packet.guard_log(operation, packet.digest(guard), ack, NOW - 120)
files = dict(base_files(), **{
    str(packet.REQUEST): packet.encoded(operation),
    str(packet.PREIMAGE): packet.canonical(captured),
    str(packet.GUARD_LOG): log,
})
rt = FakeRt(files=files, psql=[ok(pre)])
intent = packet.prepare(packet.REQUEST, rt)
print(json.dumps({
    'intent': intent['schema'],
    'psqlCalls': len(rt.psql_calls),
    'guardAckReused': intent['guardAck'] == ack,
    'lockReleased': not rt.lock_held,
}))
`),
    ).toEqual({
      intent: 'PHUB_TIMEWEB_LOCATION_PHOTO_ACL_NORMALIZE_INTENT_V1',
      psqlCalls: 1,
      guardAckReused: true,
      lockReleased: true,
    });
  });
  it('refuses a different crash-resume preimage instead of overwriting it', () => {
    expect(
      run(`
pre = db_preimage()
sha = preimage_hash(pre)
operation = make_op(sha)
drifted = full_preimage(pre)
drifted['unrelated']['relations'] = [[9, 10, None, False, False]]
rt = FakeRt(
    files=dict(base_files(), **{
        str(packet.REQUEST): packet.encoded(operation),
        str(packet.PREIMAGE): packet.canonical(drifted),
    }),
    psql=[ok(pre), ok({})],
)
print(json.dumps({**outcome(lambda: packet.prepare(packet.REQUEST, rt)), 'psqlCalls': len(rt.psql_calls)}))
`),
    ).toEqual({ threw: true, code: 'LOCATION_PHOTO_ACL_PREIMAGE_CONFLICT', psqlCalls: 1 });
  });
});

describe('crash-safe kernel packet lock (B1 re-review)', () => {
  const LOCK_FIXTURE = `
import os
import pathlib
import subprocess
import sys
import tempfile

PACKET_PATH = ${JSON.stringify(packetPath)}

def child_source(body):
    return (
        "import importlib.util,sys,os\\n"
        "spec=importlib.util.spec_from_file_location('p',sys.argv[2])\\n"
        "p=importlib.util.module_from_spec(spec);spec.loader.exec_module(p)\\n"
        "lock=sys.argv[1]\\n"
        + body
    )

def run_child(body, timeout=60):
    return subprocess.run(
        [sys.executable, '-I', '-B', '-c', child_source(body), lock_path, PACKET_PATH],
        capture_output=True,
        text=True,
        timeout=timeout,
    )
`;
  it('rejects a concurrently held kernel lock and acquires after release', () => {
    expect(
      run(`
${LOCK_FIXTURE}
lock_path = tempfile.mkstemp(prefix='acl-lock-')[1]
os.unlink(lock_path)
runtime = packet.Runtime(lock_path=lock_path)
fd = runtime.acquire_packet_lock(b'holder')
held = run_child(
    "r=p.Runtime(lock_path=lock)\\n"
    "try:\\n"
    " r.acquire_packet_lock(b'second'); print('ACQUIRED')\\n"
    "except p.Stop as error: print(str(error))\\n"
)
runtime.release_packet_lock(fd)
assert os.path.exists(lock_path)
fd = runtime.acquire_packet_lock(b'next')
runtime.release_packet_lock(fd)
print(json.dumps({
    'busy': held.stdout.strip(),
    'fileKept': True,
    'reacquired': True,
}))
`),
    ).toEqual({
      busy: 'LOCATION_PHOTO_ACL_PACKET_BUSY',
      fileKept: true,
      reacquired: true,
    });
  });
  it('lets reconcile proceed after a holder is killed without releasing', () => {
    expect(
      run(`
${LOCK_FIXTURE}
lock_path = tempfile.mkstemp(prefix='acl-lock-')[1]
os.unlink(lock_path)
crashed = subprocess.Popen(
    [sys.executable, '-I', '-B', '-c', child_source(
        "r=p.Runtime(lock_path=lock)\\n"
        "r.acquire_packet_lock(b'crashed')\\n"
        "print('HELD',flush=True)\\n"
        "os._exit(9)\\n"
    ), lock_path, PACKET_PATH],
    stdout=subprocess.PIPE,
    text=True,
)
try:
    assert crashed.stdout.readline().strip() == 'HELD'
finally:
    crashed.wait(timeout=60)
assert os.path.exists(lock_path)
real = packet.Runtime(lock_path=lock_path)
fd = real.acquire_packet_lock(b'after-crash')
real.release_packet_lock(fd)
rt, operation, intent, request = sealed_host()
rt.acquire_packet_lock = real.acquire_packet_lock
rt.release_packet_lock = real.release_packet_lock
rt.psql_outputs = [ok(db_preimage())]
receipt = packet.reconcile(packet.REQUEST, rt)
fd = real.acquire_packet_lock(b'after-reconcile')
real.release_packet_lock(fd)
print(json.dumps({
    'status': receipt['status'],
    'lockFileKept': os.path.exists(lock_path),
    'reacquired': True,
}))
`),
    ).toEqual({
      status: 'ABORTED',
      lockFileKept: true,
      reacquired: true,
    });
  });
});

describe('CLI entry', () => {
  it('refuses any other argument shape and non-root execution', () => {
    const result = spawnSync(
      'python3',
      ['-I', '-B', resolve(root, 'scripts/control-timeweb-location-photo-acl.py'), '--prepare'],
      { encoding: 'utf8', cwd: root, timeout: 120000 },
    );
    expect(result.status).toBe(1);
    expect(result.stdout.trim()).toBe(
      '{"status":"STOP","code":"LOCATION_PHOTO_ACL_ENTRY","replayAllowed":false}',
    );
  });
});
