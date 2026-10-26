#!/usr/bin/env python3
"""Reviewed one-attempt execution packet for the 0102 location-photo ACL normalization.

The reviewed forward SQL (`deploy/timeweb/location-photo-acl-normalize-0102.sql`) already carries
every pre-effect assertion, the exact preimage, the two ACL changes and the post-effect assertions
in one transaction. This packet does not weaken, rewrite or bypass it: it seals the request, a
canonical read-only preimage, a guard-only transaction and exactly one apply attempt, then records
verify/reconcile evidence. No INSERT/UPDATE/DELETE/DDL, no container restart, no publication, no
automatic inverse execution.
"""
import datetime
from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import time

ROOT = Path('/opt/phub/timeweb-beta')
SOURCE = ROOT / 'standard/source'
CONFIG = Path('/etc/phub/timeweb-beta-standard-delivery.json')
REQUEST = ROOT / 'operator/location-photo-acl-normalize.json'
PREIMAGE = ROOT / 'operator/location-photo-acl-normalize.preimage.json'
INTENT = ROOT / 'operator/location-photo-acl-normalize.intent.json'
GUARD_LOG = ROOT / 'operator/location-photo-acl-normalize.guard.log'
RECEIPT = ROOT / 'operator/location-photo-acl-normalize.receipt.json'
RETIRED = ROOT / 'operator/location-photo-acl-normalize.retired.json'
PACKET_LOCK = ROOT / 'operator/location-photo-acl-normalize.lock'
CUSTODY_LOCK = ROOT / 'standard/active'

SCHEMA = 'PHUB_TIMEWEB_LOCATION_PHOTO_ACL_NORMALIZE_V1'
PREIMAGE_SCHEMA = 'PHUB_TIMEWEB_LOCATION_PHOTO_ACL_PREIMAGE_V1'
INTENT_SCHEMA = 'PHUB_TIMEWEB_LOCATION_PHOTO_ACL_NORMALIZE_INTENT_V1'
RECEIPT_SCHEMA = 'PHUB_TIMEWEB_LOCATION_PHOTO_ACL_NORMALIZE_RECEIPT_V1'
RETIRED_SCHEMA = 'PHUB_TIMEWEB_LOCATION_PHOTO_ACL_NORMALIZE_RETIRED_V1'
PACKET_SCHEMA = 'PHUB_TIMEWEB_LOCATION_PHOTO_ACL_PACKET_LOCK_V1'
GUARD_SCHEMA = 'PHUB_TIMEWEB_LOCATION_PHOTO_ACL_GUARD_ACK_V1'

FORWARD_SQL_PATH = 'deploy/timeweb/location-photo-acl-normalize-0102.sql'
RECOVER_SQL_PATH = 'deploy/timeweb/location-photo-acl-normalize-recover-0102.sql'
PG_TEST_PATH = 'scripts/timeweb-location-photo-acl-normalize.pg.test.ts'

# Pinned reviewed inputs; recomputed and enforced against the enrolled controller source.
FORWARD_SQL_SHA256 = '2973fb9305c8f2610165cfb61b92e65127bebcccaf42afc4a2930686fa5f4b9e'
RECOVER_SQL_SHA256 = '4c2d2c3c259d76f8e47468e547786452296d5afcafa0f748a9c4575fdc84addc'
PG_TEST_SHA256 = '6835bb05a790676eff191ef957bfe19a7ce25473376cd5209450103f4594bdea'
EXPECTED_LEDGER_SHA256 = '7bd0476427e40967f4531972829a86f578d0e9d844ab9e92f16637b868e207fd'
EXPECTED_LEDGER_COUNT = 105
LEDGER_LAST = '0101_notification_lifecycle_channels.sql'
DATABASE_TARGET = {'databaseName': 'phub_beta', 'systemIdentifier': '7679125609183186977'}
CONFIRMATION = (
    'NORMALIZE_LOCATION_PHOTO_ACL_105_TWO_SCHEMA_GRANTS_KEEP_EDITOR_ACL_NO_MIGRATION'
)

OPERATION_FIELDS = [
    'schema',
    'operationId',
    'target',
    'controllerSha',
    'controllerTree',
    'controllerSourceCiRunId',
    'forwardSqlSha256',
    'recoverSqlSha256',
    'expectedLedgerSha256',
    'expectedPreimageSha256',
    'pgTestEvidence',
    'expiresAt',
    'confirmation',
]
PG_EVIDENCE_FIELDS = ['testPath', 'testSha256', 'ciRunId', 'conclusion']
PREIMAGE_FIELDS = [
    'schema',
    'database',
    'ledger',
    'schemaAcl',
    'roles',
    'eventTriggers',
    'hazards',
    'photo',
    'unrelated',
    'runtime',
    'installed',
]
INTENT_FIELDS = [
    'schema',
    'operationId',
    'requestSha256',
    'preimageSha256',
    'guardSqlSha256',
    'guardAck',
    'preparedAt',
]
GUARD_ACK_FIELDS = ['schema', 'exitCode', 'stdoutSha256', 'stdoutBytes', 'stderrSha256', 'stderrBytes']
RECEIPT_FIELDS = [
    'schema',
    'status',
    'operationId',
    'planSha256',
    'requestSha256',
    'preimageSha256',
    'guardSqlSha256',
    'postcheckSha256',
    'observedPreimageSha256',
    'classifiedAt',
    'appliedAt',
]
RECEIPT_STATUSES = ['APPLIED_VERIFIED', 'APPLIED_RECONCILED', 'ABORTED', 'UNKNOWN']

# Canonical two-schema ACL snapshots named by the reviewed forward SQL, in its exact order.
PRE_ACL = [
    {
        'schema': 'locations',
        'owner': 'phub_beta',
        'acl': [
            {'grantor': 'phub_beta', 'grantee': 'phub_beta', 'privilege': 'CREATE', 'grantable': False},
            {'grantor': 'phub_beta', 'grantee': 'phub_beta', 'privilege': 'USAGE', 'grantable': False},
            {'grantor': 'phub_beta', 'grantee': 'phub_runtime', 'privilege': 'USAGE', 'grantable': False},
        ],
    },
    {
        'schema': 'public',
        'owner': 'pg_database_owner',
        'acl': [
            {'grantor': 'pg_database_owner', 'grantee': 'PUBLIC', 'privilege': 'USAGE', 'grantable': False},
            {'grantor': 'pg_database_owner', 'grantee': 'pg_database_owner', 'privilege': 'CREATE', 'grantable': False},
            {'grantor': 'pg_database_owner', 'grantee': 'pg_database_owner', 'privilege': 'USAGE', 'grantable': False},
            {'grantor': 'pg_database_owner', 'grantee': 'phub_migrator', 'privilege': 'CREATE', 'grantable': False},
            {'grantor': 'pg_database_owner', 'grantee': 'phub_migrator', 'privilege': 'USAGE', 'grantable': False},
            {'grantor': 'pg_database_owner', 'grantee': 'phub_runtime', 'privilege': 'USAGE', 'grantable': False},
        ],
    },
]
POST_ACL = [
    {
        'schema': 'locations',
        'owner': 'phub_beta',
        'acl': [
            {'grantor': 'phub_beta', 'grantee': 'phub_beta', 'privilege': 'CREATE', 'grantable': False},
            {'grantor': 'phub_beta', 'grantee': 'phub_beta', 'privilege': 'USAGE', 'grantable': False},
            {'grantor': 'phub_beta', 'grantee': 'phub_migrator', 'privilege': 'USAGE', 'grantable': False},
            {'grantor': 'phub_beta', 'grantee': 'phub_runtime', 'privilege': 'USAGE', 'grantable': False},
        ],
    },
    {
        'schema': 'public',
        'owner': 'pg_database_owner',
        'acl': [
            {'grantor': 'pg_database_owner', 'grantee': 'PUBLIC', 'privilege': 'USAGE', 'grantable': False},
            {'grantor': 'pg_database_owner', 'grantee': 'pg_database_owner', 'privilege': 'CREATE', 'grantable': False},
            {'grantor': 'pg_database_owner', 'grantee': 'pg_database_owner', 'privilege': 'USAGE', 'grantable': False},
            {'grantor': 'pg_database_owner', 'grantee': 'phub_migrator', 'privilege': 'USAGE', 'grantable': False},
            {'grantor': 'pg_database_owner', 'grantee': 'phub_runtime', 'privilege': 'USAGE', 'grantable': False},
        ],
    },
]

FORWARD_ACL_STATEMENTS = [
    'grant usage on schema locations to phub_migrator;',
    'revoke create on schema public from phub_migrator restrict;',
]
GUARD_TAIL = 'end\n$photo_acl$;\nrollback;\n'

ENV = {
    'PATH': '/usr/bin:/bin',
    'HOME': '/root',
    'LANG': 'C.UTF-8',
    'LC_ALL': 'C.UTF-8',
    'DOCKER_HOST': 'unix:///var/run/docker.sock',
    'DOCKER_CONFIG': '/proc/self/phub-nonexistent-docker-config',
    'GIT_CONFIG_NOSYSTEM': '1',
    'GIT_CONFIG_GLOBAL': '/dev/null',
    'GIT_OPTIONAL_LOCKS': '0',
    'GIT_NO_REPLACE_OBJECTS': '1',
    'GIT_NO_LAZY_FETCH': '1',
    'GIT_NO_PROMISOR_FETCH': '1',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES': '',
}
MAX_REQUEST = 256 * 1024
MAX_SQL = 512 * 1024
MAX_OUTPUT = 4 * 1024 ** 2
MAX_GUARD_OUTPUT = 4096
SHA = re.compile(r'[a-f0-9]{40}\Z')
HASH = re.compile(r'[a-f0-9]{64}\Z')
DIGEST = re.compile(r'sha256:[a-f0-9]{64}\Z')
RELEASE = re.compile(r'([a-f0-9]{40})-([1-9][0-9]{0,19})-1\Z')
NUMBER = re.compile(r'[1-9][0-9]*\Z')
UUID = re.compile(r'[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\Z')
MILLIS = re.compile(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\Z')
ENV_LINE = re.compile(r'([A-Z_0-9]+)=([a-zA-Z0-9_./:@-]*)\Z')


class Stop(RuntimeError):
    pass


def stop(code):
    raise Stop('LOCATION_PHOTO_ACL_' + code)


def need(condition, code):
    if not condition:
        stop(code)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def encoded(value):
    return (json.dumps(value, separators=(',', ':'), ensure_ascii=True) + '\n').encode()


def canonical(value):
    # Deterministic preimage bytes: recursively sorted keys, no formatting whitespace.
    return (json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True) + '\n').encode()


def canonical_hash(value):
    return digest(canonical(value))


def strict(data):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                stop('DUPLICATE_JSON_KEY')
            result[key] = value
        return result

    def reject_constant(_):
        stop('JSON_CONSTANT')

    try:
        value = json.loads(data, object_pairs_hook=pairs, parse_constant=reject_constant)
    except (ValueError, UnicodeError, TypeError):
        stop('INVALID_JSON')
    return value


def exact(value, fields):
    need(isinstance(value, dict) and set(value) == set(fields), 'FIELDS')


def utc(value):
    need(isinstance(value, str) and bool(MILLIS.fullmatch(value)), 'TIMESTAMP')
    try:
        parsed = datetime.datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError:
        stop('TIMESTAMP')
    need(
        parsed.isoformat(timespec='milliseconds').replace('+00:00', 'Z') == value,
        'TIMESTAMP',
    )
    return parsed.timestamp()


def now_iso(at):
    return (
        datetime.datetime.fromtimestamp(at, datetime.timezone.utc)
        .isoformat(timespec='milliseconds')
        .replace('+00:00', 'Z')
    )


def env_values(data):
    values = {}
    for line in data.decode('utf-8', 'strict').rstrip('\n').split('\n'):
        match = ENV_LINE.fullmatch(line)
        need(match and match.group(1) not in values, 'NONCANONICAL_ENV')
        values[match.group(1)] = match.group(2)
    return values


def sha_ok(value):
    return isinstance(value, str) and bool(SHA.fullmatch(value))


def hash_ok(value):
    return isinstance(value, str) and bool(HASH.fullmatch(value))


def digest_ok(value):
    return isinstance(value, str) and bool(DIGEST.fullmatch(value))


# --- runtime seams -------------------------------------------------------------------------------
class Runtime:
    """Real host runtime. Every external effect in this module goes through these methods."""

    def __init__(self, run=None, lock_path=None):
        # Only unit tests inject a runner or a private lock path; the CLI entry always builds the
        # real subprocess runner against the fixed root-only packet lock.
        self._run_override = run
        self._lock_path = lock_path

    def euid(self):
        return os.getuid()

    def now(self):
        return time.time()

    def umask(self):
        os.umask(0o077)

    def secure(self, path, kind='file', mode=None):
        path = Path(path)
        info = path.lstat()
        if not (info.st_uid == info.st_gid == 0 and not stat.S_ISLNK(info.st_mode)
                and not info.st_mode & 0o022):
            stop('PATH_CUSTODY')
        if kind == 'dir':
            need(stat.S_ISDIR(info.st_mode), 'PATH_TYPE')
        else:
            need(stat.S_ISREG(info.st_mode) and info.st_nlink == 1, 'PATH_TYPE')
        if mode is not None:
            need(stat.S_IMODE(info.st_mode) == mode, 'PATH_MODE')
        if path != Path('/'):
            self.secure(path.parent, 'dir')
        return info

    def read(self, path, mode=0o600):
        path = Path(path)
        before = self.secure(path, mode=mode)
        need(0 < before.st_size <= MAX_SQL, 'READ_SIZE')
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            opened = os.fstat(fd)
            need((before.st_dev, before.st_ino) == (opened.st_dev, opened.st_ino), 'READ_RACE')
            with os.fdopen(os.dup(fd), 'rb') as stream:
                data = stream.read()
            need(
                (opened.st_dev, opened.st_ino, opened.st_size, opened.st_mtime_ns)
                == (os.fstat(fd).st_dev, os.fstat(fd).st_ino, os.fstat(fd).st_size, os.fstat(fd).st_mtime_ns),
                'READ_CHANGED',
            )
            return data
        finally:
            os.close(fd)

    def present(self, path):
        try:
            Path(path).lstat()
            return True
        except FileNotFoundError:
            return False

    def _sync(self, path):
        fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)

    def write_exclusive(self, path, data):
        path = Path(path)
        self.secure(path.parent, 'dir')
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        try:
            with os.fdopen(os.dup(fd), 'wb') as stream:
                stream.write(data)
                stream.flush()
            os.fsync(fd)
        finally:
            os.close(fd)
        self._sync(path.parent)
        need(self.read(path) == data, 'WRITE_READBACK')

    def _run(self, args, stdin=None, input_data=None, timeout=120):
        if self._run_override is not None:
            return self._run_override(args, input_data)
        try:
            result = subprocess.run(
                args,
                stdin=stdin,
                input=input_data,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=timeout,
                env=ENV,
                cwd=str(SOURCE),
            )
        except (OSError, subprocess.SubprocessError):
            stop('COMMAND')
        return result

    def acquire_packet_lock(self, marker):
        # A kernel advisory lock released by process exit: a SIGHUP/SIGKILL cannot wedge the next
        # invocation and the lock file is never deleted (deleting it would split the lock inode).
        path = Path(self._lock_path) if self._lock_path is not None else PACKET_LOCK
        if self._lock_path is None:
            self.secure(path.parent, 'dir')
        fd = None
        try:
            fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
            info = os.fstat(fd)
            need(
                stat.S_ISREG(info.st_mode)
                and info.st_nlink == 1
                and stat.S_IMODE(info.st_mode) == 0o600
                and (self.euid() != 0 or info.st_uid == info.st_gid == 0)
                and not info.st_mode & 0o022,
                'PACKET_LOCK',
            )
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                os.close(fd)
                fd = None
                stop('PACKET_BUSY')
            os.ftruncate(fd, 0)
            os.write(fd, marker)
            os.fsync(fd)
            return fd
        except Stop:
            if fd is not None:
                os.close(fd)
            raise
        except OSError:
            if fd is not None:
                os.close(fd)
            stop('PACKET_LOCK')

    def release_packet_lock(self, fd):
        # Closing the descriptor releases the kernel lock; the file stays for the next run.
        try:
            fcntl.flock(fd, fcntl.LOCK_UN)
        finally:
            os.close(fd)

    def git(self, args):
        result = self._run(
            ['/usr/bin/git', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', *args]
        )
        need(result.returncode == 0, 'GIT')
        need(len(result.stdout) <= MAX_OUTPUT, 'GIT_OUTPUT')
        return result.stdout.decode('utf-8', 'strict').strip()

    def inspect(self, service):
        # Docker `ps -q` prints 12-character ids unless --no-trunc is passed; the postgres service
        # lives in the dependencies Compose project, never in the application project.
        project = (
            'phub-timeweb-beta-dependencies'
            if service == 'postgres'
            else 'phub-timeweb-beta'
        )
        result = self._run(
            [
                '/usr/bin/docker',
                'ps',
                '-q',
                '--no-trunc',
                '--filter',
                f'label=com.docker.compose.project={project}',
                '--filter',
                f'label=com.docker.compose.service={service}',
            ]
        )
        need(result.returncode == 0, 'DOCKER')
        ids = result.stdout.decode('ascii', 'strict').split()
        need(len(ids) == 1 and re.fullmatch(r'[a-f0-9]{64}', ids[0]), 'DOCKER')
        container_id = ids[0]
        result = self._run(['/usr/bin/docker', 'inspect', container_id])
        need(result.returncode == 0 and len(result.stdout) <= MAX_OUTPUT, 'DOCKER')
        values = strict(result.stdout)
        need(isinstance(values, list) and len(values) == 1, 'DOCKER')
        value = values[0]
        labels = (value.get('Config') or {}).get('Labels') or {}
        need(
            value.get('Id') == container_id
            and labels.get('com.docker.compose.project') == project
            and labels.get('com.docker.compose.service') == service,
            'DOCKER',
        )
        return value

    def psql(self, sql, read_only):
        postgres = self.inspect('postgres')
        container = postgres.get('Id')
        need(isinstance(container, str) and re.fullmatch(r'[a-f0-9]{64}', container), 'POSTGRES')
        options = (
            '-c default_transaction_read_only=on -c statement_timeout=15000 -c lock_timeout=2000'
            if read_only
            else '-c statement_timeout=60000 -c lock_timeout=5000'
        )
        result = self._run(
            [
                '/usr/bin/docker',
                'exec',
                '-i',
                '-e',
                'PGOPTIONS=' + options,
                container,
                'psql',
                '-X',
                '--no-psqlrc',
                '--no-password',
                '--username=phub_beta',
                '--dbname=phub_beta',
                '--set=ON_ERROR_STOP=1',
                '--tuples-only',
                '--no-align',
            ],
            input_data=sql,
        )
        return {
            'rc': result.returncode,
            'stdout': result.stdout,
            'stderr': result.stderr,
        }


# --- request validation --------------------------------------------------------------------------
def read_request(rt):
    need(rt.present(REQUEST), 'REQUEST_MISSING')
    raw = rt.read(REQUEST)
    need(0 < len(raw) <= MAX_REQUEST, 'REQUEST_SIZE')
    return raw, strict(raw)


def validate_operation(value, at, rt):
    exact(value, OPERATION_FIELDS)
    need(value['schema'] == SCHEMA, 'SCHEMA')
    need(isinstance(value['operationId'], str) and UUID.fullmatch(value['operationId']), 'OPERATION_ID')
    exact(value['target'], ['databaseName', 'systemIdentifier'])
    need(value['target'] == DATABASE_TARGET, 'TARGET')
    need(sha_ok(value['controllerSha']) and sha_ok(value['controllerTree']), 'CONTROLLER')
    need(isinstance(value['controllerSourceCiRunId'], str) and NUMBER.fullmatch(value['controllerSourceCiRunId']), 'CONTROLLER')
    need(value['forwardSqlSha256'] == FORWARD_SQL_SHA256, 'FORWARD_SQL')
    need(value['recoverSqlSha256'] == RECOVER_SQL_SHA256, 'RECOVER_SQL')
    need(value['expectedLedgerSha256'] == EXPECTED_LEDGER_SHA256, 'LEDGER')
    need(hash_ok(value['expectedPreimageSha256']), 'PREIMAGE')
    exact(value['pgTestEvidence'], PG_EVIDENCE_FIELDS)
    evidence = value['pgTestEvidence']
    need(
        evidence['testPath'] == PG_TEST_PATH
        and evidence['testSha256'] == PG_TEST_SHA256
        and isinstance(evidence['ciRunId'], str)
        and NUMBER.fullmatch(evidence['ciRunId'])
        and evidence['conclusion'] == 'success',
        'PG_EVIDENCE',
    )
    expires = utc(value['expiresAt'])
    need(20 * 60 <= expires - at <= 60 * 60, 'EXPIRY')
    need(value['confirmation'] == CONFIRMATION, 'CONFIRMATION')
    return value


def validate_allow_expired(value, at, rt):
    exact(value, OPERATION_FIELDS)
    need(value['schema'] == SCHEMA, 'SCHEMA')
    need(isinstance(value['operationId'], str) and UUID.fullmatch(value['operationId']), 'OPERATION_ID')
    need(value['target'] == DATABASE_TARGET, 'TARGET')
    need(value['forwardSqlSha256'] == FORWARD_SQL_SHA256, 'FORWARD_SQL')
    need(value['recoverSqlSha256'] == RECOVER_SQL_SHA256, 'RECOVER_SQL')
    need(value['expectedLedgerSha256'] == EXPECTED_LEDGER_SHA256, 'LEDGER')
    need(hash_ok(value['expectedPreimageSha256']), 'PREIMAGE')
    need(value['confirmation'] == CONFIRMATION, 'CONFIRMATION')
    need(sha_ok(value['controllerSha']) and sha_ok(value['controllerTree']), 'CONTROLLER')
    return value


def verify_controller_source(operation, rt):
    source = SOURCE
    need(rt.secure(source, 'dir', 0o700) is not None, 'SOURCE')
    need(rt.secure(source / '.git', 'dir') is not None, 'SOURCE')
    need(rt.read(CONFIG) is not None, 'CONFIG')
    config = strict(rt.read(CONFIG))
    need(
        isinstance(config, dict)
        and set(config) == {'schema', 'enabled', 'owner', 'controllerSha'}
        and config['schema'] == 1
        and config['enabled'] is True
        and isinstance(config['owner'], str)
        and config['owner'].strip()
        and config['controllerSha'] == operation['controllerSha'],
        'CONFIG',
    )
    need(rt.git(['rev-parse', '--show-toplevel']) == str(source), 'SOURCE')
    need(rt.git(['rev-parse', '--absolute-git-dir']) == str(source / '.git'), 'SOURCE')
    need(
        rt.git(['rev-parse', '--path-format=absolute', '--git-common-dir']) == str(source / '.git'),
        'SOURCE',
    )
    need(rt.git(['rev-parse', 'HEAD']) == operation['controllerSha'], 'CONTROLLER')
    need(rt.git(['rev-parse', 'HEAD^{tree}']) == operation['controllerTree'], 'CONTROLLER')
    need(rt.git(['status', '--porcelain', '--untracked-files=all']) == '', 'SOURCE')
    need(not rt.present(source / '.git/objects/info/alternates'), 'SOURCE')
    need(not rt.present(source / '.git/shallow'), 'SOURCE')
    forward = rt.read(source / FORWARD_SQL_PATH, 0o644)
    recover = rt.read(source / RECOVER_SQL_PATH, 0o644)
    test_evidence = rt.read(source / PG_TEST_PATH, 0o644)
    need(
        digest(forward) == operation['forwardSqlSha256'] == FORWARD_SQL_SHA256, 'FORWARD_SQL'
    )
    need(
        digest(recover) == operation['recoverSqlSha256'] == RECOVER_SQL_SHA256, 'RECOVER_SQL'
    )
    need(digest(test_evidence) == operation['pgTestEvidence']['testSha256'] == PG_TEST_SHA256, 'PG_EVIDENCE')
    return forward, recover, test_evidence


# --- guard derivation ----------------------------------------------------------------------------
def derive_guard(forward):
    text = forward.decode('utf-8', 'strict')
    lines = text.splitlines(keepends=True)
    positions = []
    for item in FORWARD_ACL_STATEMENTS:
        matches = [index for index, line in enumerate(lines) if line.strip().lower() == item]
        need(len(matches) == 1, 'GUARD_SQL')
        positions.append(matches[0])
    need(positions == sorted(positions) and positions[1] == positions[0] + 1, 'GUARD_SQL')
    acl_lines = [line for line in lines if re.match(r'^\s*(grant|revoke)\s', line, re.I)]
    need(len(acl_lines) == 2, 'GUARD_SQL')
    offset = sum(len(line) for line in lines[: positions[0]])
    head = text[:offset]
    need(head.rstrip().endswith('into security_before;'), 'GUARD_SQL')
    need('commit;' not in head.lower(), 'GUARD_SQL')
    guard = head + GUARD_TAIL
    lowered = guard.lower()
    for item in FORWARD_ACL_STATEMENTS:
        need(item not in lowered, 'GUARD_SQL')
    need(lowered.rstrip().endswith('rollback;'), 'GUARD_SQL')
    need('pg_try_advisory_xact_lock(7140221)' in lowered, 'GUARD_SQL')
    return guard.encode()


# --- preimage capture and validation -------------------------------------------------------------
PREIMAGE_SQL = r"""
begin isolation level repeatable read read only;
set local search_path='pg_catalog';set local statement_timeout='15s';set local lock_timeout='2s';
select jsonb_build_object(
 'database',jsonb_build_object(
   'name',current_database(),
   'systemIdentifier',(select system_identifier::text from pg_control_system()),
   'owner',(select pg_get_userbyid(datdba) from pg_database where datname=current_database()),
   'currentUser',current_user,'sessionUser',session_user,
   'roleSetting',current_setting('role'),
   'operatorSafe',exists(select 1 from pg_roles where rolname=current_user and rolsuper and rolbypassrls and rolcanlogin)),
 'ledger',(select coalesce(jsonb_agg(jsonb_build_array(filename,checksum) order by filename),'[]'::jsonb) from public.schema_migrations),
 'schemaAcl',(select coalesce(jsonb_agg(s.value order by s.name collate "C"),'[]'::jsonb)
   from (select n.nspname name,jsonb_build_object('schema',n.nspname,
     'owner',pg_get_userbyid(n.nspowner),'acl',
     (select coalesce(jsonb_agg(jsonb_build_object('grantor',pg_get_userbyid(a.grantor),
       'grantee',case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end,
       'privilege',a.privilege_type,'grantable',a.is_grantable)
       order by (case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end) collate "C",
         pg_get_userbyid(a.grantor) collate "C",a.privilege_type collate "C",a.is_grantable),'[]'::jsonb)
       from aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) a)) value
   from pg_namespace n where n.nspname in ('locations','public')) s),
 'roles',(select jsonb_build_object(
   'attributes',(select coalesce(jsonb_agg(jsonb_build_array(rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls) order by rolname),'[]'::jsonb)
     from pg_roles where rolname in ('phub_beta','phub_migrator','phub_runtime')),
   'members',(select coalesce(jsonb_agg(jsonb_build_array(roleid,member,grantor,admin_option) order by roleid,member),'[]'::jsonb)
     from pg_auth_members where roleid in(select oid from pg_roles where rolname in('phub_beta','phub_migrator','phub_runtime'))
       or member in(select oid from pg_roles where rolname in('phub_beta','phub_migrator','phub_runtime'))),
   'safe',(select count(*)=2 and bool_and(rolcanlogin and not(rolsuper or rolbypassrls or rolcreaterole or rolcreatedb or rolreplication))
     from pg_roles where rolname in('phub_migrator','phub_runtime'))
     and not exists(select 1 from pg_auth_members where roleid in('phub_migrator'::regrole,'phub_runtime'::regrole)
       or member in('phub_migrator'::regrole,'phub_runtime'::regrole)))),
 'eventTriggers',(select coalesce(jsonb_agg(jsonb_build_array(evtname,evtenabled) order by evtname),'[]'::jsonb) from pg_event_trigger),
 'hazards',jsonb_build_object(
   'migrationLockHeld',exists(select 1 from pg_locks where locktype='advisory' and database=(select oid from pg_database where datname=current_database())
     and classid=0 and objid=7140221 and objsubid=1 and granted),
   'longTransactions',(select count(*)::int from pg_stat_activity where datid=(select oid from pg_database where datname=current_database())
     and pid<>pg_backend_pid() and xact_start is not null and state<>'idle' and xact_start<clock_timestamp()-interval '30 seconds'),
   'conflictingLocks',(select count(*)::int from pg_locks where pid is distinct from pg_backend_pid()
     and relation in ('public.schema_migrations'::regclass,'locations.profiles'::regclass,'locations.media_assets'::regclass)
     and (not granted or mode in ('RowExclusiveLock','ShareUpdateExclusiveLock','ShareLock','ShareRowExclusiveLock','ExclusiveLock','AccessExclusiveLock')))),
 'photo',jsonb_build_object(
   'exists',to_regclass('locations.recommendation_card_photos') is not null,
   'relation',coalesce(to_regclass('locations.recommendation_card_photos')::text,''),
   'rowCount',0),
 'unrelated',jsonb_build_object(
   'schemas',(select coalesce(jsonb_agg(jsonb_build_array(oid,nspname,nspowner,nspacl::text) order by oid),'[]'::jsonb) from pg_namespace where nspname not in ('locations','public')),
   'relations',(select coalesce(jsonb_agg(jsonb_build_array(oid,relowner,relacl::text,relrowsecurity,relforcerowsecurity) order by oid),'[]'::jsonb) from pg_class),
   'columns',(select coalesce(jsonb_agg(jsonb_build_array(attrelid,attnum,attacl::text) order by attrelid,attnum),'[]'::jsonb) from pg_attribute where attacl is not null),
   'defaults',(select coalesce(jsonb_agg(jsonb_build_array(oid,defaclrole,defaclnamespace,defaclobjtype,defaclacl::text) order by oid),'[]'::jsonb) from pg_default_acl),
   'roles',(select coalesce(jsonb_agg(jsonb_build_array(oid,rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls) order by oid),'[]'::jsonb) from pg_roles where rolname in ('phub_beta','phub_migrator','phub_runtime')),
   'members',(select coalesce(jsonb_agg(jsonb_build_array(roleid,member,grantor,admin_option) order by roleid,member),'[]'::jsonb) from pg_auth_members where roleid in (select oid from pg_roles where rolname in ('phub_beta','phub_migrator','phub_runtime')) or member in (select oid from pg_roles where rolname in ('phub_beta','phub_migrator','phub_runtime'))))
)::text;
rollback;
""".encode()


def read_psql_json(result, code):
    need(result['rc'] == 0, code)
    need(0 < len(result['stdout']) <= MAX_OUTPUT, code)
    try:
        return strict(result['stdout'])
    except Stop:
        stop(code)


def inspect_container(rt, service):
    value = rt.inspect(service)
    need(isinstance(value, dict), 'RUNTIME')
    config = value.get('Config') or {}
    state = value.get('State') or {}
    health = (state.get('Health') or {}).get('Status')
    labels = config.get('Labels') or {}
    repository = 'docker.io/library/postgres' if service == 'postgres' else f'ghcr.io/z6v6e6r/phub-{service}'
    image_id = value.get('Image')
    identity = {
        'id': value.get('Id'),
        'image': config.get('Image'),
        'imageId': image_id,
        'releaseId': labels.get('phub.release-id'),
        'revision': labels.get('org.opencontainers.image.revision'),
        'restarts': value.get('RestartCount'),
        'startedAt': state.get('StartedAt'),
        'status': state.get('Status'),
        'health': health,
    }
    need(
        isinstance(identity['id'], str)
        and re.fullmatch(r'[a-f0-9]{64}', identity['id'])
        and digest_ok(identity['imageId'])
        and identity['image'] == f'{repository}@{identity["imageId"]}'
        and identity['restarts'] == 0
        and identity['status'] == 'running'
        and (service == 'postgres' or health == 'healthy')
        and isinstance(identity['startedAt'], str)
        and identity['startedAt']
        and (identity['releaseId'] is None or isinstance(identity['releaseId'], str)),
        'RUNTIME',
    )
    if service in ('api', 'web'):
        need(
            sha_ok(identity['revision'])
            and isinstance(identity['releaseId'], str)
            and RELEASE.fullmatch(identity['releaseId'])
            and identity['releaseId'].startswith(identity['revision']),
            'RUNTIME',
        )
    elif service in ('worker', 'realtime'):
        need(sha_ok(identity['revision']) and identity['releaseId'] is None, 'RUNTIME')
    else:
        need(identity['revision'] is None and identity['releaseId'] is None, 'RUNTIME')
    return identity


def capture_installed(rt, api):
    release_id = api['releaseId']
    need(isinstance(release_id, str) and RELEASE.fullmatch(release_id), 'INSTALLED')
    descriptor_path = ROOT / 'releases' / release_id / 'installed-components.env'
    need(rt.present(descriptor_path), 'INSTALLED')
    bytes_ = rt.read(descriptor_path)
    values = env_values(bytes_)
    need(values.get('PHUB_RELEASE_ID') == release_id, 'INSTALLED')
    kind = values.get('PHUB_COMPONENT_ROLLOUT_KIND')
    need(
        kind == 'API_WEB'
        or kind == 'ADOPTED_MANUAL_FULL'
        or (isinstance(kind, str) and kind.startswith('API_WORKER')),
        'INSTALLED',
    )
    need(values.get('PHUB_TIMEWEB_RELEASE_ENV_SCHEMA') == 'PHUB_TIMEWEB_INSTALLED_COMPONENT_ENV_V1', 'INSTALLED')
    secret_set = values.get('PHUB_RUNTIME_SECRET_SET_RELEASE_ID')
    need(isinstance(secret_set, str) and RELEASE.fullmatch(secret_set), 'INSTALLED')
    return {
        'releaseId': release_id,
        'descriptorSha256': digest(bytes_),
        'secretSetReleaseId': secret_set,
        'kind': kind,
    }


def capture_preimage(rt, verify=True):
    result = rt.psql(PREIMAGE_SQL, True)
    value = read_psql_json(result, 'PREIMAGE_READ')
    exact(value, ['database', 'ledger', 'schemaAcl', 'roles', 'eventTriggers', 'hazards', 'photo', 'unrelated'])
    runtime = {service: inspect_container(rt, service) for service in ('api', 'web', 'worker', 'realtime')}
    installed = capture_installed(rt, runtime['api'])
    preimage = {
        'schema': PREIMAGE_SCHEMA,
        'database': value['database'],
        'ledger': value['ledger'],
        'schemaAcl': value['schemaAcl'],
        'roles': value['roles'],
        'eventTriggers': value['eventTriggers'],
        'hazards': value['hazards'],
        'photo': value['photo'],
        'unrelated': value['unrelated'],
        'runtime': runtime,
        'installed': installed,
    }
    if verify:
        validate_preimage(preimage)
    return preimage


def classification_capture(rt):
    # A third/mixed state is exactly what reconciliation must be able to observe, so the read-only
    # classifier tolerates a structurally unexpected snapshot and reports UNKNOWN instead of stopping.
    try:
        return capture_preimage(rt, verify=False)
    except Stop:
        return None


def validate_ledger(rows):
    need(isinstance(rows, list) and len(rows) == EXPECTED_LEDGER_COUNT, 'LEDGER')
    previous = ''
    for row in rows:
        need(isinstance(row, list) and len(row) == 2, 'LEDGER')
        filename, checksum = row
        need(
            isinstance(filename, str)
            and re.fullmatch(r'[0-9]{4}_[a-z0-9_]+\.sql', filename)
            and isinstance(checksum, str)
            and HASH.fullmatch(checksum)
            and filename > previous,
            'LEDGER',
        )
        previous = filename
    need(rows[-1][0] == LEDGER_LAST, 'LEDGER')
    text = json.dumps(rows, separators=(',', ':'), ensure_ascii=True).replace(' ', '') + '\n'
    need(digest(text.encode()) == EXPECTED_LEDGER_SHA256, 'LEDGER')


def validate_preimage(preimage):
    exact(preimage, PREIMAGE_FIELDS)
    need(preimage['schema'] == PREIMAGE_SCHEMA, 'PREIMAGE')
    exact(preimage['database'], ['name', 'systemIdentifier', 'owner', 'currentUser', 'sessionUser', 'roleSetting', 'operatorSafe'])
    database = preimage['database']
    need(
        database == {
            'name': DATABASE_TARGET['databaseName'],
            'systemIdentifier': DATABASE_TARGET['systemIdentifier'],
            'owner': 'phub_beta',
            'currentUser': 'phub_beta',
            'sessionUser': 'phub_beta',
            'roleSetting': 'none',
            'operatorSafe': True,
        },
        'PREIMAGE_TARGET',
    )
    validate_ledger(preimage['ledger'])
    need(preimage['schemaAcl'] in (PRE_ACL, POST_ACL), 'PREIMAGE_SCHEMA_ACL')
    exact(preimage['roles'], ['attributes', 'members', 'safe'])
    need(preimage['roles']['safe'] is True, 'PREIMAGE_ROLES')
    need(preimage['roles']['members'] == [], 'PREIMAGE_ROLES')
    attributes = {row[0]: row for row in preimage['roles']['attributes'] if isinstance(row, list) and row}
    need(set(attributes) == {'phub_beta', 'phub_migrator', 'phub_runtime'}, 'PREIMAGE_ROLES')
    operator = attributes['phub_beta']
    need(
        isinstance(operator, list)
        and len(operator) == 8
        and operator[0] == 'phub_beta'
        and operator[1] is True
        and operator[5] is True
        and operator[7] is True,
        'PREIMAGE_ROLES',
    )
    for role in ('phub_migrator', 'phub_runtime'):
        row = attributes[role]
        need(
            isinstance(row, list)
            and len(row) == 8
            and row[0] == role
            and row[1] is False
            and row[3] is False
            and row[4] is False
            and row[5] is True
            and row[6] is False
            and row[7] is False,
            'PREIMAGE_ROLES',
        )
    need(
        all(
            isinstance(row, list)
            and len(row) == 2
            and isinstance(row[1], str)
            and row[1] == 'D'
            for row in preimage['eventTriggers']
        ),
        'PREIMAGE_HAZARD',
    )
    exact(preimage['hazards'], ['migrationLockHeld', 'longTransactions', 'conflictingLocks'])
    need(
        preimage['hazards'] == {
            'migrationLockHeld': False,
            'longTransactions': 0,
            'conflictingLocks': 0,
        },
        'PREIMAGE_HAZARD',
    )
    exact(preimage['photo'], ['exists', 'relation', 'rowCount'])
    need(
        preimage['photo'] == {'exists': False, 'relation': '', 'rowCount': 0},
        'PREIMAGE_PHOTO',
    )
    exact(preimage['unrelated'], ['schemas', 'relations', 'columns', 'defaults', 'roles', 'members'])
    need(all(isinstance(preimage['unrelated'][key], list) for key in preimage['unrelated']), 'PREIMAGE')
    exact(preimage['runtime'], ['api', 'web', 'worker', 'realtime'])
    for service in ('api', 'web', 'worker', 'realtime'):
        need(isinstance(preimage['runtime'][service], dict), 'RUNTIME')
    exact(preimage['installed'], ['releaseId', 'descriptorSha256', 'secretSetReleaseId', 'kind'])
    return preimage


def core_preimage(preimage):
    return {key: preimage[key] for key in PREIMAGE_FIELDS if key != 'schemaAcl'}


def classify(sealed, current):
    if not isinstance(current, dict):
        return 'UNKNOWN'
    try:
        if canonical(current) == canonical(sealed):
            return 'PRE'
        if (
            current.get('schemaAcl') == POST_ACL
            and set(current) == set(PREIMAGE_FIELDS)
            and canonical(core_preimage(current)) == canonical(core_preimage(sealed))
        ):
            return 'POST'
    except (KeyError, TypeError, ValueError):
        return 'UNKNOWN'
    return 'UNKNOWN'


# --- evidence helpers ----------------------------------------------------------------------------
def write_once(rt, path, data, code):
    # Crash-safe resume: an identical artifact from the same operation is reused, a different one is
    # a hard conflict. Never silently overwrite sealed evidence.
    if rt.present(path):
        need(rt.read(path) == data, code)
        return
    rt.write_exclusive(path, data)


@contextmanager
def packet_custody(rt, operation, mode):
    # Serializes prepare/execute/reconcile for the one normalization operation. A second concurrent
    # invocation fails closed before it can read or write partial evidence.
    marker = encoded({
        'schema': PACKET_SCHEMA,
        'operationId': operation['operationId'],
        'mode': mode,
        'startedAt': now_iso(rt.now()),
    })
    fd = rt.acquire_packet_lock(marker)
    try:
        yield
    finally:
        rt.release_packet_lock(fd)


def terminal_write(rt, path, data, code):
    if rt.present(path):
        need(rt.read(path) == data, code)
        return
    rt.write_exclusive(path, data)


def existing_receipt(rt):
    if not rt.present(RECEIPT):
        return None
    value = strict(rt.read(RECEIPT))
    need(isinstance(value, dict), 'RECEIPT')
    return value


def existing_intent(rt):
    if not rt.present(INTENT):
        return None
    value = strict(rt.read(INTENT))
    exact(value, INTENT_FIELDS)
    return value


def retirement(rt):
    if not rt.present(RETIRED):
        return None
    value = strict(rt.read(RETIRED))
    need(isinstance(value, dict), 'RETIRED')
    return value


def receipt_bytes(receipt):
    exact(receipt, RECEIPT_FIELDS)
    need(receipt['status'] in RECEIPT_STATUSES, 'RECEIPT')
    return encoded(receipt)


def make_receipt(operation, plan_sha, request_sha, preimage_sha, guard_sha, at, status, observed, postcheck=None, applied_at=None):
    return {
        'schema': RECEIPT_SCHEMA,
        'status': status,
        'operationId': operation['operationId'],
        'planSha256': plan_sha,
        'requestSha256': request_sha,
        'preimageSha256': preimage_sha,
        'guardSqlSha256': guard_sha,
        'postcheckSha256': postcheck,
        'observedPreimageSha256': observed,
        'classifiedAt': now_iso(at),
        'appliedAt': applied_at,
    }


def write_terminal_receipt(rt, receipt):
    terminal_write(rt, RECEIPT, receipt_bytes(receipt), 'RECEIPT_CONFLICT')
    return receipt


def defend_duplicate(rt, operation):
    receipt = existing_receipt(rt)
    if receipt is not None:
        need(receipt.get('operationId') != operation['operationId'], 'OPERATION_RETIRED')
    marker = retirement(rt)
    if marker is not None:
        need(marker.get('operationId') != operation['operationId'], 'OPERATION_RETIRED')


def write_retirement(rt, operation, receipt):
    marker = {
        'schema': RETIRED_SCHEMA,
        'operationId': operation['operationId'],
        'receiptSha256': digest(receipt_bytes(receipt)),
        'retiredAt': receipt['appliedAt'] or receipt['classifiedAt'],
    }
    marker_bytes = encoded(marker)
    if rt.present(RETIRED):
        need(rt.read(RETIRED) == marker_bytes, 'RETIRED_CONFLICT')
        return
    rt.write_exclusive(RETIRED, marker_bytes)


def check_custody(rt):
    need(not rt.present(CUSTODY_LOCK), 'CUSTODY')


def check_preimage_guard_baseline(rt, sealed):
    need(sealed['schemaAcl'] == PRE_ACL, 'PREIMAGE_SCHEMA_ACL')
    need(sealed['hazards'] == {'migrationLockHeld': False, 'longTransactions': 0, 'conflictingLocks': 0}, 'PREIMAGE_HAZARD')
    check_custody(rt)


def guard_ack(result):
    need(result['rc'] == 0, 'GUARD_EXEC')
    stdout = result['stdout']
    stderr = result['stderr']
    need(
        isinstance(stdout, bytes) and isinstance(stderr, bytes)
        and len(stdout) <= MAX_GUARD_OUTPUT and len(stderr) <= MAX_GUARD_OUTPUT,
        'GUARD_EXEC',
    )
    return {
        'schema': GUARD_SCHEMA,
        'exitCode': result['rc'],
        'stdoutSha256': digest(stdout),
        'stdoutBytes': len(stdout),
        'stderrSha256': digest(stderr),
        'stderrBytes': len(stderr),
    }


def guard_log(operation, guard_sha, ack, at):
    return encoded({
        'schema': GUARD_SCHEMA,
        'operationId': operation['operationId'],
        'guardSqlSha256': guard_sha,
        'exitCode': ack['exitCode'],
        'stdoutSha256': ack['stdoutSha256'],
        'stdoutBytes': ack['stdoutBytes'],
        'stderrSha256': ack['stderrSha256'],
        'stderrBytes': ack['stderrBytes'],
        'preparedAt': now_iso(at),
    })


# --- modes ---------------------------------------------------------------------------------------
def prepare(request_path=REQUEST, rt=None):
    rt = rt or Runtime()
    need(rt.euid() == 0, 'NOT_ROOT')
    need(str(request_path) == str(REQUEST), 'REQUEST_PATH')
    at = rt.now()
    raw, operation = read_request(rt)
    operation = validate_operation(operation, at, rt)
    with packet_custody(rt, operation, '--prepare'):
        return prepare_locked(rt, raw, operation, at)


def prepare_locked(rt, raw, operation, at):
    forward, _recover, _test = verify_controller_source(operation, rt)
    request_sha = digest(raw)
    sealed = existing_intent(rt)
    if sealed is not None:
        need(
            sealed['operationId'] == operation['operationId']
            and sealed['requestSha256'] == request_sha
            and sealed['preimageSha256'] == operation['expectedPreimageSha256'],
            'INTENT_CONFLICT',
        )
        need(rt.present(PREIMAGE) and digest(rt.read(PREIMAGE)) == sealed['preimageSha256'], 'PREIMAGE')
        return sealed
    preimage = capture_preimage(rt)
    preimage_bytes = canonical(preimage)
    preimage_sha = digest(preimage_bytes)
    need(preimage_sha == operation['expectedPreimageSha256'], 'PREIMAGE')
    check_preimage_guard_baseline(rt, preimage)
    guard = derive_guard(forward)
    guard_sha = digest(guard)
    write_once(rt, PREIMAGE, preimage_bytes, 'PREIMAGE_CONFLICT')
    if rt.present(GUARD_LOG):
        log = strict(rt.read(GUARD_LOG))
        need(
            isinstance(log, dict)
            and log.get('schema') == GUARD_SCHEMA
            and log.get('operationId') == operation['operationId']
            and log.get('guardSqlSha256') == guard_sha
            and log.get('exitCode') == 0
            and all(key in log for key in GUARD_ACK_FIELDS),
            'GUARD_CONFLICT',
        )
        ack = {key: log[key] for key in GUARD_ACK_FIELDS}
    else:
        ack = guard_ack(rt.psql(guard, True))
        write_once(rt, GUARD_LOG, guard_log(operation, guard_sha, ack, at), 'GUARD_CONFLICT')
    intent = {
        'schema': INTENT_SCHEMA,
        'operationId': operation['operationId'],
        'requestSha256': request_sha,
        'preimageSha256': preimage_sha,
        'guardSqlSha256': guard_sha,
        'guardAck': ack,
        'preparedAt': now_iso(at),
    }
    intent_bytes = encoded(intent)
    rt.write_exclusive(INTENT, intent_bytes)
    return strict(intent_bytes)


def load_sealed(rt, operation, request_sha):
    intent = existing_intent(rt)
    need(intent is not None, 'INTENT_MISSING')
    need(intent['schema'] == INTENT_SCHEMA and intent['operationId'] == operation['operationId'], 'INTENT')
    need(intent['requestSha256'] == request_sha, 'INTENT')
    need(intent['preimageSha256'] == operation['expectedPreimageSha256'], 'INTENT')
    exact(intent['guardAck'], GUARD_ACK_FIELDS)
    need(intent['guardAck']['schema'] == GUARD_SCHEMA and intent['guardAck']['exitCode'] == 0, 'INTENT')
    utc(intent['preparedAt'])
    need(rt.present(PREIMAGE), 'PREIMAGE_MISSING')
    preimage_bytes = rt.read(PREIMAGE)
    need(len(preimage_bytes) <= MAX_REQUEST, 'PREIMAGE')
    preimage = strict(preimage_bytes)
    validate_preimage(preimage)
    need(digest(preimage_bytes) == intent['preimageSha256'] == operation['expectedPreimageSha256'], 'PREIMAGE')
    need(canonical(preimage) == preimage_bytes, 'PREIMAGE')
    return intent, preimage, preimage_bytes


def execute(request_path=REQUEST, rt=None):
    rt = rt or Runtime()
    need(rt.euid() == 0, 'NOT_ROOT')
    need(str(request_path) == str(REQUEST), 'REQUEST_PATH')
    at = rt.now()
    raw, operation = read_request(rt)
    operation = validate_operation(operation, at, rt)
    need(at < utc(operation['expiresAt']), 'EXPIRY')
    with packet_custody(rt, operation, '--execute'):
        return execute_locked(rt, raw, operation, at)


def execute_locked(rt, raw, operation, at):
    request_sha = digest(raw)
    intent, sealed, _sealed_bytes = load_sealed(rt, operation, request_sha)
    plan_sha = digest(encoded(intent))
    defend_duplicate(rt, operation)
    forward, _recover, _test = verify_controller_source(operation, rt)
    guard = derive_guard(forward)
    need(digest(guard) == intent['guardSqlSha256'], 'INTENT')
    check_custody(rt)
    current = classification_capture(rt)
    if isinstance(current, dict) and isinstance(current.get('hazards'), dict):
        need(
            current['hazards']
            == {'migrationLockHeld': False, 'longTransactions': 0, 'conflictingLocks': 0},
            'CUSTODY',
        )
    check_custody(rt)
    state = classify(sealed, current)
    if state == 'POST':
        receipt = make_receipt(
            operation, plan_sha, request_sha, intent['preimageSha256'], intent['guardSqlSha256'], at,
            'APPLIED_RECONCILED', canonical_hash(current),
        )
        write_terminal_receipt(rt, receipt)
        write_retirement(rt, operation, receipt)
        return receipt
    if state != 'PRE':
        observed_sha = canonical_hash(current) if isinstance(current, dict) else None
        receipt = make_receipt(
            operation, plan_sha, request_sha, intent['preimageSha256'], intent['guardSqlSha256'], at,
            'UNKNOWN', observed_sha,
        )
        write_terminal_receipt(rt, receipt)
        return receipt
    result = rt.psql(forward, False)
    observed = classification_capture(rt)
    if (
        result['rc'] == 0
        and isinstance(observed, dict)
        and observed.get('schemaAcl') == POST_ACL
        and set(observed) == set(PREIMAGE_FIELDS)
        and canonical(core_preimage(observed)) == canonical(core_preimage(sealed))
    ):
        receipt = make_receipt(
            operation, plan_sha, request_sha, intent['preimageSha256'], intent['guardSqlSha256'], at,
            'APPLIED_VERIFIED', canonical_hash(observed), canonical_hash(observed), now_iso(at),
        )
        write_terminal_receipt(rt, receipt)
        write_retirement(rt, operation, receipt)
        return receipt
    terminal = classify(sealed, observed)
    need(terminal != 'PRE' or result['rc'] != 0, 'POSTCHECK')
    status = 'APPLIED_RECONCILED' if terminal == 'POST' else ('ABORTED' if terminal == 'PRE' else 'UNKNOWN')
    observed_sha = canonical_hash(observed) if isinstance(observed, dict) else None
    receipt = make_receipt(
        operation, plan_sha, request_sha, intent['preimageSha256'], intent['guardSqlSha256'], at,
        status, observed_sha,
        observed_sha if status == 'APPLIED_RECONCILED' else None,
        now_iso(at) if status == 'APPLIED_RECONCILED' else None,
    )
    write_terminal_receipt(rt, receipt)
    if status == 'APPLIED_RECONCILED':
        write_retirement(rt, operation, receipt)
    return receipt


def reconcile(request_path=REQUEST, rt=None):
    rt = rt or Runtime()
    need(rt.euid() == 0, 'NOT_ROOT')
    need(str(request_path) == str(REQUEST), 'REQUEST_PATH')
    at = rt.now()
    raw, operation = read_request(rt)
    operation = validate_allow_expired(operation, at, rt)
    with packet_custody(rt, operation, '--reconcile'):
        return reconcile_locked(rt, raw, operation, at)


def reconcile_locked(rt, raw, operation, at):
    # Bind the request to the sealed intent before any classification or terminal receipt write:
    # operationId, requestSha256 and preimageSha256 must match the prepared evidence exactly.
    request_sha = digest(raw)
    intent, sealed, _sealed_bytes = load_sealed(rt, operation, request_sha)
    guard_sha = intent['guardSqlSha256']
    plan_sha = digest(encoded(intent))
    current = classification_capture(rt)
    state = classify(sealed, current)
    status = {'PRE': 'ABORTED', 'POST': 'APPLIED_RECONCILED', 'UNKNOWN': 'UNKNOWN'}[state]
    observed_sha = canonical_hash(current) if isinstance(current, dict) else None
    receipt = make_receipt(
        operation, plan_sha, request_sha, operation['expectedPreimageSha256'], guard_sha, at, status,
        observed_sha,
        observed_sha if status == 'APPLIED_RECONCILED' else None,
        now_iso(at) if status == 'APPLIED_RECONCILED' else None,
    )
    write_terminal_receipt(rt, receipt)
    if status == 'APPLIED_RECONCILED':
        write_retirement(rt, operation, receipt)
    return receipt


MODES = {'--prepare': prepare, '--execute': execute, '--reconcile': reconcile}


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    need(
        len(argv) == 2 and argv[0] in MODES and argv[1] == str(REQUEST),
        'ENTRY',
    )
    need(sys.flags.isolated == 1 and sys.flags.optimize == 0, 'PYTHON_FLAGS')
    need(os.getuid() == 0, 'NOT_ROOT')
    os.umask(0o077)
    result = MODES[argv[0]](argv[1], Runtime())
    print(json.dumps(result, separators=(',', ':')))
    if result['status'] in ('ABORTED', 'UNKNOWN'):
        sys.exit(1)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        code = str(error) if isinstance(error, Stop) else 'LOCATION_PHOTO_ACL_UNEXPECTED'
        print(json.dumps({'status': 'STOP', 'code': code, 'replayAllowed': False}, separators=(',', ':')))
        sys.exit(1)
