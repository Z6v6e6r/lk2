#!/usr/bin/env python3
"""Explicit, standalone Timeweb dump/isolated-restore producer; never a deploy entry."""
import datetime
import base64
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import re
import resource
import signal
import stat
import subprocess
import sys
import time

ROOT = Path('/opt/phub/timeweb-beta')
REQUEST = ROOT / 'operator/database-backup-restore.json'
LOCK = ROOT / 'standard/active'
BASELINE = '0d6078be7a50ed3f5761d66071527be003bd568f-37038298584-1'
API_WORKER_CANDIDATE = '11954ffd6d7bf7bd9b198e7e68d2123011f091c1-38144582876-1'  # gitleaks:allow public Git/OCI release identity
# This is the canonical JSON tuple digest, not the textual migration-manifest digest.
API_WORKER_LEDGER_SHA256 = '34e0fb1115e0066733c6ede34ab1d9fb8fcc2842f2df192fbaefc03a97ce1c2d'
API_WORKER_PRE_LEDGER_SHA256 = '025c5ee129bd583131192439d991f0dbbba4fbd19c31c1215bca5adcee9ce17c'
MIGRATION_BASE_SHA = '72ca7789b2a4cd93537b442f75c1b8258fce13a0'
MIGRATION_BASE_TREE = '8a79178d7e340c4ce7008bbf2c0b2b411e704572'
API_WORKER_MIGRATION_CONTROLLER_FILES = frozenset([
    'scripts/control-timeweb-database-backup.py', 'scripts/control-timeweb-database-backup.test.ts',
    'scripts/test-timeweb-database-backup.py', 'scripts/timeweb-api-worker-migration.d.ts',
    'scripts/timeweb-api-worker-migration.js', 'scripts/timeweb-api-worker-migration.test.ts',
    'scripts/timeweb-api-worker-migration.adapter.test.ts', 'scripts/timeweb-api-worker-migration-role.js',
    'scripts/timeweb-api-worker-migration-role.d.ts', 'scripts/timeweb-api-worker-migration-role.test.ts',
    'scripts/timeweb-api-worker-contract.js', 'scripts/run-timeweb-standard-delivery.js',
    'docs/runbooks/timeweb-standard-delivery.md', 'docs/runbooks/android-chats-fcm.md',
])
PG_ID = 'fe614a3312e446e8036243be3781590bfe90b5da037b83580abd410d4514e84c'
PG_IMAGE = 'docker.io/library/postgres@sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685'
API_BASELINE = {'id': '6f7197c220269281e0268f1fbe9881a3cb6fa863c3a5a928ca2d47ef363132c0',
                'image': 'ghcr.io/z6v6e6r/phub-api@sha256:a2563721aa46a7785d9ad00d98f002040cbd884446761bb5d7bbdf18a7a43c69',
                'imageId': 'sha256:a2563721aa46a7785d9ad00d98f002040cbd884446761bb5d7bbdf18a7a43c69',
                'releaseId': BASELINE, 'revision': BASELINE[:40], 'restarts': 0,
                'startedAt': '2026-10-05T14:35:52.357218294Z'}
PG_BASELINE = {'id': PG_ID, 'image': PG_IMAGE, 'imageId': PG_IMAGE.split('@')[1],
               'releaseId': None, 'revision': None, 'restarts': 0,
               'startedAt': '2026-08-28T16:49:17.916395698Z'}
TARGET = {'hostname': 'lk2.padlhub.su', 'serverId': 8886471, 'projectId': 262717}
ENV = {'PATH': '/usr/bin:/bin', 'HOME': '/root', 'LANG': 'C.UTF-8', 'LC_ALL': 'C.UTF-8',
       'DOCKER_HOST': 'unix:///var/run/docker.sock', 'DOCKER_CONFIG': '/proc/self/phub-nonexistent-docker-config',
       'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_OPTIONAL_LOCKS': '0',
       'GIT_NO_REPLACE_OBJECTS': '1', 'GIT_NO_LAZY_FETCH': '1', 'GIT_NO_PROMISOR_FETCH': '1',
       'GIT_ALTERNATE_OBJECT_DIRECTORIES': ''}
MAX_DUMP = 64 * 1024 ** 3
SHA = re.compile(r'[a-f0-9]{40}\Z')
HASH = re.compile(r'[a-f0-9]{64}\Z')
RELEASE = re.compile(r'([a-f0-9]{40})-([1-9][0-9]{0,19})-1\Z')
LEDGER_SQL = "select coalesce(json_agg(json_build_array(filename, checksum) order by filename), '[]'::json)::text from public.schema_migrations"
READ_ONLY = "export PGOPTIONS='-c default_transaction_read_only=on -c lock_timeout=2000'; "
SOURCE_LEDGER = READ_ONLY + 'exec psql -X --no-password --username="$POSTGRES_USER" --dbname="${POSTGRES_DB:-$POSTGRES_USER}" --no-psqlrc --tuples-only --no-align --set=ON_ERROR_STOP=1 --command=' + "'" + LEDGER_SQL + "'"
SOURCE_SIZE = READ_ONLY + 'exec psql -X --no-password --username="$POSTGRES_USER" --dbname="${POSTGRES_DB:-$POSTGRES_USER}" --no-psqlrc --tuples-only --no-align --set=ON_ERROR_STOP=1 --command=\'select pg_database_size(current_database())\''
SOURCE_DUMP = READ_ONLY + 'exec pg_dump --no-password --username="$POSTGRES_USER" --dbname="${POSTGRES_DB:-$POSTGRES_USER}" --format=custom --serializable-deferrable --no-owner --no-acl'
INSPECT_FORMAT = '{"Id":{{json .Id}},"Image":{{json .Image}},"Config":{"Image":{{json .Config.Image}},"Labels":{{json .Config.Labels}}},"RestartCount":{{json .RestartCount}},"State":{"Status":{{json .State.Status}},"StartedAt":{{json .State.StartedAt}},"Health":{"Status":{{if .State.Health}}{{json .State.Health.Status}}{{else}}null{{end}}}}}'
RESTORE_FORMAT = '{"Id":{{json .Id}},"Config":{"Image":{{json .Config.Image}},"User":{{json .Config.User}},"Volumes":{{json .Config.Volumes}},"Labels":{{json .Config.Labels}}},"HostConfig":{' + ','.join('"'+key+'":{{json .HostConfig.'+key+'}}' for key in ['NetworkMode','ReadonlyRootfs','Binds','PortBindings','Tmpfs','Privileged','AutoRemove','RestartPolicy','CapAdd','CapDrop','SecurityOpt','PidsLimit','Memory','MemorySwap','NanoCpus','PublishAllPorts','Links','Devices','DeviceRequests','VolumesFrom','PidMode','IpcMode']) + '},"Mounts":{{json .Mounts}},"State":{"Status":{{json .State.Status}}}}'


class Stop(RuntimeError):
    pass


def need(condition, code):
    if not condition:
        raise Stop(code)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def encoded(value):
    return (json.dumps(value, separators=(',', ':'), ensure_ascii=True) + '\n').encode()


def strict(data):
    def pairs(items):
        result = {}
        for key, value in items:
            need(key not in result, 'DUPLICATE_JSON_KEY')
            result[key] = value
        return result
    try:
        return json.loads(data, object_pairs_hook=pairs, parse_constant=lambda _: (_ for _ in ()).throw(Stop('JSON_CONSTANT')))
    except (ValueError, UnicodeError, TypeError):
        raise Stop('INVALID_JSON') from None


def exact(value, fields):
    need(isinstance(value, dict) and set(value) == set(fields), 'FIELDS')


def utc(value):
    need(isinstance(value, str) and re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z', value), 'TIMESTAMP')
    try:
        parsed = datetime.datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError:
        raise Stop('TIMESTAMP') from None
    need(parsed.isoformat(timespec='milliseconds').replace('+00:00', 'Z') == value, 'TIMESTAMP')
    return parsed.timestamp()


def now_iso():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def operation_mode(value):
    if value['schema'] == 'PHUB_TIMEWEB_BACKUP_OPERATION_V1':
        return 'web', value['releaseId']
    if value['schema'] == 'PHUB_TIMEWEB_BACKUP_OPERATION_API_WORKER_V2':
        return 'api-worker', value['candidateReleaseId']
    raise Stop('TARGET')


def validate_operation(value, now, file_sha):
    common = ['schema', 'target', 'toolCommit', 'toolFileSha256', 'controllerSha',
              'toolProofSha256', 'toolInstallationSha256', 'controllerTree',
              'controllerConfigSha256', 'expectedBoundarySha256', 'expectedApi',
              'expectedPostgres', 'expiresAt', 'confirmation']
    schema = value.get('schema') if isinstance(value, dict) else None
    if schema == 'PHUB_TIMEWEB_BACKUP_OPERATION_V1':
        exact(value, common + ['releaseId'])
        mode = 'web'
        release_id = value['releaseId']
    elif schema == 'PHUB_TIMEWEB_BACKUP_OPERATION_API_WORKER_V2':
        extra=['candidateReleaseId', 'expectedLedgerSha256','controllerSourceCiRunId','migrationPlanSha256','migrationSuccessSha256']
        exact(value, common + extra)
        mode = 'api-worker'
        release_id = value['candidateReleaseId']
        need(release_id == API_WORKER_CANDIDATE and value['expectedLedgerSha256'] == API_WORKER_LEDGER_SHA256,
             'API_WORKER_OPERATION')
        need(re.fullmatch(r'[1-9][0-9]*', value['controllerSourceCiRunId'] or '')
             and HASH.fullmatch(value['migrationPlanSha256'] or '')
             and HASH.fullmatch(value['migrationSuccessSha256'] or '')
             and value['toolCommit']==value['controllerSha'], 'API_WORKER_PROOF')
    else:
        raise Stop('TARGET')
    need(value['target'] == TARGET, 'TARGET')
    need(SHA.fullmatch(value['toolCommit'] or '') and value['toolFileSha256'] == file_sha
         and SHA.fullmatch(value['controllerSha'] or '') and SHA.fullmatch(value['controllerTree'] or '')
         and HASH.fullmatch(value['controllerConfigSha256'] or '')
         and HASH.fullmatch(value['toolProofSha256'] or '') and HASH.fullmatch(value['toolInstallationSha256'] or '')
         and HASH.fullmatch(value['expectedBoundarySha256'] or ''), 'TOOL_SOURCE')
    match = RELEASE.fullmatch(release_id or '')
    need(match and (mode == 'api-worker' or match[1] == value['controllerSha']), 'RELEASE')
    fields = ['id', 'image', 'imageId', 'releaseId', 'revision', 'restarts', 'startedAt']
    for key in ['expectedApi', 'expectedPostgres']:
        exact(value[key], fields)
        row = value[key]
        need(HASH.fullmatch(row['id'] or '') and re.fullmatch(r'sha256:[a-f0-9]{64}', row['imageId'] or '')
             and type(row['restarts']) is int and row['restarts'] == 0 and isinstance(row['startedAt'], str), 'BASELINE')
    api, pg = value['expectedApi'], value['expectedPostgres']
    need(api == API_BASELINE, 'API_BASELINE')
    need(pg == PG_BASELINE, 'POSTGRES_BASELINE')
    need(1200 <= utc(value['expiresAt']) - now <= 3600, 'EXPIRY')
    confirmation = ('BACKUP_RESTORE_' + match[1][:12].upper() + '_KEEP_API_0D6078BE7A50'
                    if mode == 'web' else
                    'BACKUP_RESTORE_API_WORKER_11954FFD6D7B_KEEP_API_0D6078BE7A50')
    need(value['confirmation'] == confirmation, 'CONFIRMATION')
    return value


def v2_migration_proof(op, request_bytes, source, restore=None):
    """Bind a post-0097 backup to a reconciled immutable migration proof before any dump."""
    if op['schema'] != 'PHUB_TIMEWEB_BACKUP_OPERATION_API_WORKER_V2':
        return
    prefix=['/usr/bin/git','-C',str(source),'-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false']
    need(command(prefix+['rev-parse',MIGRATION_BASE_SHA+'^{tree}'], 'CONTROLLER_LINEAGE').decode().strip()==MIGRATION_BASE_TREE, 'CONTROLLER_LINEAGE')
    command(prefix+['merge-base','--is-ancestor',MIGRATION_BASE_SHA,op['controllerSha']], 'CONTROLLER_LINEAGE')
    raw=command(prefix+['diff','--no-renames','--raw','--abbrev=40','-z',MIGRATION_BASE_SHA,op['controllerSha']], 'CONTROLLER_LINEAGE').split(b'\0')
    rows=[v for v in raw if v]
    need(rows and len(rows)%2==0, 'CONTROLLER_LINEAGE')
    seen=set()
    for index in range(0,len(rows),2):
        match=re.fullmatch(rb':([0-7]{6}) ([0-7]{6}) [a-f0-9]{40} [a-f0-9]{40} ([AM])',rows[index])
        path=os.fsdecode(rows[index+1])
        need(match and path not in seen and path in API_WORKER_MIGRATION_CONTROLLER_FILES
             and match.group(2)==b'100644' and (match.group(3)==b'A' and match.group(1)==b'000000' or match.group(3)==b'M' and match.group(1)==b'100644'), 'CONTROLLER_LINEAGE')
        seen.add(path)
    expected={'controllerSha':op['controllerSha'],'controllerTree':op['controllerTree'],
              'controllerSourceCiRunId':op['controllerSourceCiRunId'],'candidateReleaseId':op['candidateReleaseId'],
              'migrationPlanSha256':op['migrationPlanSha256'],'migrationSuccessSha256':op['migrationSuccessSha256']}
    if restore is not None:
        exact(restore,['id','operationSha256'])
        need(HASH.fullmatch(restore['id'] or '') and HASH.fullmatch(restore['operationSha256'] or ''), 'MIGRATION_RESTORE')
    program="import {attestMigrationBackupProof} from '/opt/phub/timeweb-beta/standard/source/scripts/timeweb-api-worker-migration.js';import fs from 'node:fs';const value=JSON.parse(fs.readFileSync(0,'utf8'));process.stdout.write(JSON.stringify(await attestMigrationBackupProof(value.expected,value.restore))+'\\n');"
    node_env={key:ENV[key] for key in ['PATH','HOME','LANG','LC_ALL','GIT_CONFIG_NOSYSTEM','GIT_CONFIG_GLOBAL','GIT_OPTIONAL_LOCKS','GIT_NO_REPLACE_OBJECTS','GIT_NO_LAZY_FETCH','GIT_NO_PROMISOR_FETCH','GIT_ALTERNATE_OBJECT_DIRECTORIES']}
    result=strict(command(['/usr/bin/node','--input-type=module','-e',program], 'MIGRATION_ATTESTATION', input_data=encoded({'expected':expected,'restore':restore}), environment=node_env, timeout=30))
    exact(result,['schema','containerId','imageId','proofSha256'])
    need(result['schema']=='PHUB_TIMEWEB_MIGRATION_BACKUP_ATTESTATION_V1' and HASH.fullmatch(result['containerId'] or '') and re.fullmatch(r'sha256:[a-f0-9]{64}',result['imageId'] or '') and HASH.fullmatch(result['proofSha256'] or ''), 'MIGRATION_ATTESTATION')
    return result


def ledger_bytes(data):
    rows = strict(data)
    need(isinstance(rows, list) and 0 < len(rows) <= 10000, 'LEDGER_ROWS')
    seen = set()
    for row in rows:
        need(isinstance(row, list) and len(row) == 2 and isinstance(row[0], str)
             and re.fullmatch(r'[0-9]{4}_[a-zA-Z0-9_-]+\.sql', row[0])
             and isinstance(row[1], str) and HASH.fullmatch(row[1]) and row[0] not in seen, 'LEDGER_ENTRY')
        seen.add(row[0])
    return encoded(sorted(rows, key=lambda row: row[0]))


def capacity(database_bytes, available_memory, free_disk):
    need(type(database_bytes) is int and 0 < database_bytes <= MAX_DUMP, 'DATABASE_SIZE')
    tmpfs = max(512 * 1024 ** 2, database_bytes * 3 + 256 * 1024 ** 2)
    need(available_memory >= tmpfs + 2 * 1024 ** 3 and free_disk >= database_bytes * 2 + 5 * 1024 ** 3, 'CAPACITY')
    return tmpfs


def secure_info(info, kind, mode=None):
    need(info.st_uid == info.st_gid == 0 and not stat.S_ISLNK(info.st_mode)
         and not info.st_mode & 0o022, 'PATH_CUSTODY')
    need(stat.S_ISDIR(info.st_mode) if kind == 'dir' else stat.S_ISREG(info.st_mode) and info.st_nlink == 1, 'PATH_TYPE')
    if mode is not None:
        need(stat.S_IMODE(info.st_mode) == mode, 'PATH_MODE')


def secure(path, kind='file', mode=None):
    path = Path(path)
    info = path.lstat()
    secure_info(info, kind, mode)
    if path != Path('/'):
        secure(path.parent, 'dir')
    return info


def identity(info):
    return tuple(getattr(info, key) for key in ['st_dev', 'st_ino', 'st_uid', 'st_gid', 'st_mode', 'st_nlink', 'st_size', 'st_mtime_ns', 'st_ctime_ns'])


def git_oid(kind, raw):
    return hashlib.sha1(kind.encode()+b' '+str(len(raw)).encode()+b'\0'+raw).hexdigest()


def tree_entries(raw):
    need(0 < len(raw) <= 1024*1024, 'TREE_SIZE')
    entries = {}
    offset = 0
    while offset < len(raw):
        end = raw.find(b'\0', offset)
        need(end > offset and end+21 <= len(raw), 'TREE_ENTRY')
        header = raw[offset:end].split(b' ', 1)
        need(len(header)==2 and header[0] in (b'40000',b'100644',b'100755',b'120000',b'160000'), 'TREE_MODE')
        try:
            name = header[1].decode('utf-8', 'strict')
        except UnicodeError:
            raise Stop('TREE_NAME') from None
        need(name and name not in ('.','..') and '/' not in name and '\\' not in name
             and not any(ord(c)<32 or ord(c)==127 for c in name) and name not in entries, 'TREE_NAME')
        entries[name] = (header[0].decode(), raw[end+1:end+21].hex())
        offset = end+21
    return entries


def verify_source_proof(proof, op, script_bytes):
    exact(proof, ['schema','repository','path','commit','rootTree','scriptsTree','blob'])
    need(proof['schema']=='PHUB_TIMEWEB_BACKUP_SOURCE_PROOF_V1'
         and proof['repository']=={'name':'Z6v6e6r/lk2','id':1297548073}
         and proof['path']=='scripts/control-timeweb-database-backup.py'
         and digest(encoded(proof))==op['toolProofSha256'], 'SOURCE_PROOF')
    raw_objects = {}
    for key, kind in [('commit','commit'),('rootTree','tree'),('scriptsTree','tree')]:
        obj = proof[key]
        exact(obj, ['oid','sha256','base64'])
        need(isinstance(obj['base64'],str) and len(obj['base64'])<=2*1024*1024, 'SOURCE_OBJECT_SIZE')
        try:
            raw = base64.b64decode(obj['base64'], validate=True)
        except (ValueError, TypeError):
            raise Stop('SOURCE_OBJECT_ENCODING') from None
        need(git_oid(kind,raw)==obj['oid'] and digest(raw)==obj['sha256'], 'SOURCE_OBJECT_HASH')
        raw_objects[key]=raw
    need(proof['commit']['oid']==op['toolCommit'], 'SOURCE_COMMIT')
    headers = raw_objects['commit'].split(b'\n\n',1)[0].split(b'\n')
    expected = b'tree '+proof['rootTree']['oid'].encode()
    need(headers[0]==expected and sum(h.startswith(b'tree ') for h in headers)==1, 'COMMIT_TREE')
    need(tree_entries(raw_objects['rootTree']).get('scripts')==('40000',proof['scriptsTree']['oid']), 'ROOT_TREE')
    exact(proof['blob'], ['oid','sha256'])
    need(proof['blob']=={'oid':git_oid('blob',script_bytes),'sha256':digest(script_bytes)}
         and proof['blob']['sha256']==op['toolFileSha256']
         and tree_entries(raw_objects['scriptsTree']).get('control-timeweb-database-backup.py')==('100644',proof['blob']['oid']), 'SCRIPT_BLOB')


def tool_custody(op):
    path = ROOT/('operator/tools/'+op['toolCommit']+'/control-timeweb-database-backup.py')
    receipt_path = path.parent/'installation-receipt.json'
    script_bytes = read_secure(path,0o755)
    receipt_bytes = read_secure(receipt_path)
    need(digest(script_bytes)==op['toolFileSha256'] and digest(receipt_bytes)==op['toolInstallationSha256'], 'TOOL_CUSTODY')
    receipt = strict(receipt_bytes)
    exact(receipt, ['schema','sourceProof','installedPath','installedAt','installationPlanSha256','metadata'])
    need(receipt['schema']=='PHUB_TIMEWEB_BACKUP_INSTALLATION_V1' and receipt['installedPath']==str(path)
         and HASH.fullmatch(receipt['installationPlanSha256'] or ''), 'INSTALLATION')
    utc(receipt['installedAt'])
    info = secure(path,mode=0o755)
    expected = {key:getattr(info,'st_'+key) for key in ['dev','ino','uid','gid','mode','nlink','size']}
    need(receipt['metadata']==expected, 'TOOL_METADATA')
    verify_source_proof(receipt['sourceProof'],op,script_bytes)
    return receipt_bytes


def read_secure(path, mode=0o600):
    before = secure(path, mode=mode)
    need(0 < before.st_size <= 4 * 1024 ** 2, 'READ_SIZE')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        opened = os.fstat(fd)
        need(identity(before) == identity(opened), 'READ_RACE')
        with os.fdopen(os.dup(fd), 'rb') as stream:
            data = stream.read()
        need(identity(opened) == identity(os.fstat(fd)), 'READ_CHANGED')
        need(identity(opened) == identity(secure(path, mode=mode)), 'READ_REPLACED')
        return data
    finally:
        os.close(fd)


def sync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def exclusive(path, data):
    secure(Path(path).parent, 'dir')
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(os.dup(fd), 'wb') as stream:
            stream.write(data)
            stream.flush()
        os.fsync(fd)
    finally:
        os.close(fd)
    sync_directory(Path(path).parent)
    need(read_secure(path) == data, 'WRITE_READBACK')


def file_digest(path):
    before = secure(path, mode=0o600)
    need(0 < before.st_size <= MAX_DUMP, 'DUMP_SIZE')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        opened = os.fstat(fd)
        need(identity(before) == identity(opened), 'DUMP_RACE')
        h = hashlib.sha256()
        with os.fdopen(os.dup(fd), 'rb') as stream:
            for block in iter(lambda: stream.read(1024 ** 2), b''):
                h.update(block)
        need(identity(opened) == identity(os.fstat(fd)), 'DUMP_CHANGED')
        return h.hexdigest()
    finally:
        os.close(fd)


@contextmanager
def dump_stream(path, expected_sha):
    before=secure(path,mode=0o600)
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
    try:
        opened=os.fstat(fd)
        need(identity(before)==identity(opened),'DUMP_RACE')
        with os.fdopen(os.dup(fd),'rb') as stream:
            h=hashlib.sha256()
            for block in iter(lambda:stream.read(1024**2),b''):h.update(block)
            need(h.hexdigest()==expected_sha,'DUMP_CHANGED')
            stream.seek(0)
            yield stream
        need(identity(opened)==identity(os.fstat(fd)),'DUMP_CHANGED')
    finally:
        os.close(fd)


def command(args, code, stdin=None, input_data=None, stdout=subprocess.PIPE, timeout=120, file_limit=None, environment=ENV):
    need(not (stdin is not None and input_data is not None) and (input_data is None or isinstance(input_data,bytes)), 'COMMAND_INPUT')
    if file_limit is not None:
        need(type(file_limit) is int and 0 < file_limit <= MAX_DUMP, 'DUMP_LIMIT')
    def limit_output():
        resource.setrlimit(resource.RLIMIT_FSIZE,(file_limit,file_limit))
    try:
        result = subprocess.run(args, stdin=stdin, input=input_data, stdout=stdout, stderr=subprocess.DEVNULL,
                                env=environment, timeout=timeout, check=False, preexec_fn=limit_output if file_limit else None)
    except (OSError, subprocess.TimeoutExpired):
        raise Stop(code + '_UNCERTAIN') from None
    need(result.returncode == 0, code)
    return result.stdout


def docker(args, code='DOCKER_READ', **kwargs):
    return command(['/usr/bin/docker'] + args, code, **kwargs)


def service(project, name):
    ids = docker(['ps', '-q', '--no-trunc', '--filter', 'label=com.docker.compose.project=' + project,
                  '--filter', 'label=com.docker.compose.service=' + name]).decode().split()
    need(len(ids) == 1 and HASH.fullmatch(ids[0]), 'SERVICE_COUNT')
    row = strict(docker(['inspect', '--format', INSPECT_FORMAT, ids[0]]))
    labels, state = row['Config']['Labels'], row['State']
    need(row['Id'] == ids[0] and labels.get('com.docker.compose.project') == project
         and labels.get('com.docker.compose.service') == name, 'SERVICE_IDENTITY')
    need(state['Status'] == 'running' and state.get('Health', {}).get('Status') == 'healthy', 'SERVICE_HEALTH')
    return {'id': row['Id'], 'image': row['Config']['Image'], 'imageId': row['Image'],
            'releaseId': labels.get('phub.release-id'), 'revision': labels.get('org.opencontainers.image.revision'),
            'restarts': row['RestartCount'], 'startedAt': state['StartedAt']}


def source_query(shell):
    need(shell in (SOURCE_LEDGER, SOURCE_SIZE), 'SOURCE_QUERY')
    return docker(['exec', PG_ID, '/bin/sh', '-eu', '-c', shell], 'SOURCE_QUERY')


def restore_tmpfs(tmpfs_bytes):
    return {'/var/lib/postgresql/data': 'rw,nosuid,nodev,noexec,mode=1777,size='+str(tmpfs_bytes),
            '/var/run/postgresql': 'rw,nosuid,nodev,noexec,mode=1777,size=16777216',
            '/tmp': 'rw,nosuid,nodev,noexec,mode=1777,size=16777216'}


def inspect_restore(container, operation_sha, tmpfs_bytes, expected_state):
    need(isinstance(container, str) and HASH.fullmatch(container), 'RESTORE_ID')
    row = strict(docker(['inspect', '--format', RESTORE_FORMAT, container]))
    config, host = row['Config'], row['HostConfig']
    mounts = row['Mounts']
    need(row['Id'] == container and config['Image'] == PG_IMAGE and config['User'] == 'postgres'
         and row['Config']['Labels'].get('phub.backup-operation') == operation_sha
         and row['State']['Status'] == expected_state
         and host['NetworkMode'] == 'none' and host['ReadonlyRootfs'] is True
         and host['Tmpfs'] == restore_tmpfs(tmpfs_bytes)
         and host['Privileged'] is False and host['AutoRemove'] is False
         and host['RestartPolicy'] == {'Name':'no','MaximumRetryCount':0}
         and host['CapDrop'] == ['ALL'] and not host['CapAdd']
         and host['SecurityOpt'] in (['no-new-privileges'], ['no-new-privileges:true'])
         and host['PidsLimit'] == 128 and host['Memory'] == tmpfs_bytes+512*1024**2
         and host['MemorySwap'] == host['Memory'] and host['NanoCpus'] == 1000000000
         and host['PublishAllPorts'] is False and host['PidMode'] == '' and host['IpcMode'] == 'private'
         and all(not host[key] for key in ['Binds','PortBindings','Links','Devices','DeviceRequests','VolumesFrom'])
         and isinstance(config['Volumes'], (dict,type(None)))
         and set(config['Volumes'] or {}) <= {'/var/lib/postgresql/data'}
         and isinstance(mounts,list)
         and (not mounts and expected_state=='created' or len(mounts)==3 and {m.get('Destination') for m in mounts}==set(host['Tmpfs']))
         and len({m.get('Destination') for m in mounts}) == len(mounts)
         and all(m.get('Type')=='tmpfs' and m.get('RW') is True and m.get('Destination') in host['Tmpfs'] for m in mounts), 'RESTORE_CUSTODY')


def restore_create_args(name, operation_sha, tmpfs_bytes):
    need(re.fullmatch(r'phub-timeweb-restore-[a-f0-9]{12}-[1-9][0-9]{0,19}-1', name)
         and HASH.fullmatch(operation_sha) and type(tmpfs_bytes) is int and tmpfs_bytes >= 512*1024**2, 'RESTORE_PLAN')
    args = ['create', '--pull', 'never', '--name', name, '--label', 'phub.backup-operation=' + operation_sha,
            '--network', 'none', '--read-only', '--restart', 'no', '--user', 'postgres', '--cap-drop', 'ALL',
            '--security-opt', 'no-new-privileges', '--pids-limit', '128', '--memory', str(tmpfs_bytes + 512*1024**2),
            '--memory-swap', str(tmpfs_bytes + 512*1024**2), '--cpus', '1', '--ipc', 'private',
            '--tmpfs', '/var/lib/postgresql/data:rw,nosuid,nodev,noexec,mode=1777,size=' + str(tmpfs_bytes),
            '--tmpfs', '/var/run/postgresql:rw,nosuid,nodev,noexec,mode=1777,size=16777216',
            '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,mode=1777,size=16777216',
            '--env', 'PGDATA=/var/lib/postgresql/data/phub-restore', '--env', 'POSTGRES_USER=phub_restore',
            '--env', 'POSTGRES_DB=phub_restore', '--env', 'POSTGRES_HOST_AUTH_METHOD=trust', PG_IMAGE]
    return args


def execute(op, request_bytes, file_sha):
    mode, release_id = operation_mode(op)
    transaction = ROOT / ('backups/' + release_id + '-' + mode)
    incoming = transaction / 'database.pgcustom.incoming'
    final = transaction / 'database.pgcustom'
    receipt_path = transaction / 'database-backup-receipt.json'
    need(not os.path.lexists(LOCK) and not os.path.lexists(transaction), 'EXISTING_STATE')
    for path in [ROOT, ROOT/'standard', ROOT/'operator', ROOT/'backups']:
        secure(path, 'dir')
    config_path = Path('/etc/phub/timeweb-beta-standard-delivery.json')
    config_bytes = read_secure(config_path)
    config = strict(config_bytes)
    need(config['controllerSha'] == op['controllerSha'] and config['enabled'] is True
         and digest(config_bytes)==op['controllerConfigSha256'], 'CONTROLLER')
    installation_bytes=tool_custody(op)
    source = ROOT/'standard/source'
    secure(source, 'dir')
    controller_head = command(['/usr/bin/git', '-C', str(source), '-c', 'core.hooksPath=/dev/null',
                               '-c', 'core.fsmonitor=false', 'rev-parse', 'HEAD'], 'CONTROLLER').decode().strip()
    need(controller_head == op['controllerSha'], 'CONTROLLER')
    def controller_guard():
        secure(source, 'dir')
        secure(source/'.git', 'dir')
        prefix=['/usr/bin/git','-C',str(source),'-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false']
        need(command(prefix+['rev-parse','HEAD'],'CONTROLLER').decode().strip()==controller_head
             and command(prefix+['rev-parse','HEAD^{tree}'],'CONTROLLER').decode().strip()==op['controllerTree']
             and command(prefix+['status','--porcelain','--untracked-files=all'],'CONTROLLER').strip()==b'', 'CONTROLLER_DRIFT')
        for raw in command(prefix+['ls-files','-z'],'CONTROLLER').split(b'\0'):
            if not raw: continue
            relative=Path(os.fsdecode(raw))
            need(not relative.is_absolute() and '..' not in relative.parts,'CONTROLLER_PATH')
            secure(source/relative)
    controller_guard()
    migration_attestation=v2_migration_proof(op, request_bytes, source)
    restore_id=None
    def container_boundary():
        ids=docker(['ps','-aq','--no-trunc']).decode().split()
        need(len(ids)==len(set(ids)), 'CONTAINER_ID')
        result=[]
        for container_id in sorted(ids):
            need(HASH.fullmatch(container_id),'CONTAINER_ID')
            if container_id==restore_id:continue
            row=strict(docker(['inspect','--format',INSPECT_FORMAT,container_id]))
            need(row['Id']==container_id, 'CONTAINER_ID')
            result.append(row)
        return result
    boundary=container_boundary()
    if migration_attestation is not None:
        need(any(row['Id']==migration_attestation['containerId'] for row in boundary), 'MIGRATION_CONTAINER_BOUNDARY')
    need(digest(encoded(boundary))==op['expectedBoundarySha256'], 'BASELINE_BOUNDARY')
    def guard():
        need(time.time()<utc(op['expiresAt']),'EXPIRED_OPERATION')
        need(service('phub-timeweb-beta', 'api') == op['expectedApi']
             and service('phub-timeweb-beta-dependencies', 'postgres') == op['expectedPostgres'], 'RUNTIME_DRIFT')
        need(not docker(['ps','-q','--no-trunc','--filter','label=com.docker.compose.service=migrator']).strip(), 'ACTIVE_MIGRATOR')
        need(read_secure(config_path) == config_bytes and read_secure(REQUEST) == request_bytes, 'INPUT_DRIFT')
        need(container_boundary()==boundary,'CONTAINER_BOUNDARY_DRIFT')
        controller_guard()
        need(tool_custody(op)==installation_bytes,'TOOL_DRIFT')
        if migration_attestation is not None:
            current=v2_migration_proof(op, request_bytes, source, {'id':restore_id,'operationSha256':operation_sha} if restore_id else None)
            need(current==migration_attestation,'MIGRATION_ATTESTATION_DRIFT')
    guard()
    image = strict(docker(['image','inspect','--format','{"Os":{{json .Os}},"Architecture":{{json .Architecture}},"RepoDigests":{{json .RepoDigests}}}', PG_IMAGE]))
    need(image['Os']=='linux' and image['Architecture']=='amd64' and PG_IMAGE in image.get('RepoDigests', []), 'RESTORE_IMAGE')
    operation_sha = digest(request_bytes)
    marker = encoded({'schema':'PHUB_TIMEWEB_BACKUP_LOCK_V1','operationSha256':operation_sha,
                      'toolFileSha256':file_sha,'transaction':str(transaction),'createdAt':now_iso()})
    LOCK.mkdir(mode=0o700)
    sync_directory(LOCK.parent)
    lock_info = secure(LOCK, 'dir', 0o700)
    exclusive(LOCK/'backup-restore.json', marker)
    marker_info=secure(LOCK/'backup-restore.json',mode=0o600)
    transaction.mkdir(mode=0o700)
    sync_directory(transaction.parent)
    exclusive(transaction/'backup-operation.json', request_bytes)
    def phase(name, **fields):
        exclusive(transaction/(name+'.json'), encoded({'phase':name,'operationSha256':operation_sha,'observedAt':now_iso(),**fields}))
    def owned_lock():
        current=secure(LOCK,'dir',0o700)
        need((current.st_dev,current.st_ino)==(lock_info.st_dev,lock_info.st_ino)
             and sorted(p.name for p in LOCK.iterdir())==['backup-restore.json']
             and identity(secure(LOCK/'backup-restore.json',mode=0o600))==identity(marker_info)
             and read_secure(LOCK/'backup-restore.json')==marker,'LOCK_DRIFT')
    guard(); owned_lock(); phase('LOCKED')
    before = ledger_bytes(source_query(SOURCE_LEDGER))
    if mode == 'api-worker':
        need(digest(before) == API_WORKER_LEDGER_SHA256, 'API_WORKER_LEDGER')
    size_data = source_query(SOURCE_SIZE).decode().strip()
    need(re.fullmatch(r'[1-9][0-9]*',size_data),'DATABASE_SIZE')
    memory = Path('/proc/meminfo').read_text()
    found = re.search(r'^MemAvailable:\s+([0-9]+) kB$', memory, re.M)
    need(found is not None, 'MEMORY_READ')
    filesystem=os.statvfs(ROOT)
    tmpfs=capacity(int(size_data),int(found[1])*1024,filesystem.f_bavail*filesystem.f_frsize)
    phase('DUMP_INTENT',databaseBytes=int(size_data),restoreTmpfsBytes=tmpfs)
    fd=os.open(incoming,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    try:
        with os.fdopen(os.dup(fd),'wb') as stream:
            docker(['exec',PG_ID,'/bin/sh','-eu','-c',SOURCE_DUMP],'DUMP',stdout=stream,timeout=600,file_limit=min(MAX_DUMP,int(size_data)*2+256*1024**2))
            stream.flush()
        os.fsync(fd)
    finally:
        os.close(fd)
    sync_directory(transaction)
    dump_sha=file_digest(incoming)
    guard(); owned_lock()
    need(ledger_bytes(source_query(SOURCE_LEDGER))==before,'SOURCE_LEDGER_DRIFT')
    phase('DUMP_VERIFIED',dumpSha256=dump_sha,sourceLedgerSha256=digest(before))
    match=RELEASE.fullmatch(release_id)
    name='phub-timeweb-restore-'+match[1][:12]+'-'+match[2]+'-1'
    phase('RESTORE_CREATE_INTENT',containerName=name,restoreImage=PG_IMAGE)
    container=docker(restore_create_args(name,operation_sha,tmpfs),'RESTORE_CREATE').decode().strip()
    need(HASH.fullmatch(container),'RESTORE_ID')
    restore_id=container
    inspect_restore(container,operation_sha,tmpfs,'created')
    phase('RESTORE_CREATED',containerId=container)
    docker(['start',container],'RESTORE_START')
    ready=False
    for _ in range(45):
        inspect_restore(container,operation_sha,tmpfs,'running')
        try:
            docker(['exec',container,'pg_isready','--username=phub_restore','--dbname=phub_restore'],'RESTORE_READY')
            ready=True;break
        except Stop:
            time.sleep(2)
    need(ready,'RESTORE_NOT_READY')
    guard(); owned_lock()
    with dump_stream(incoming,dump_sha) as stream:
        docker(['exec','-i',container,'pg_restore','--list'],'DUMP_TOC',stdin=stream,stdout=subprocess.DEVNULL,timeout=120)
    with dump_stream(incoming,dump_sha) as stream:
        docker(['exec','-i',container,'pg_restore','--username=phub_restore','--dbname=phub_restore',
                '--no-owner','--no-acl','--exit-on-error'],'RESTORE',stdin=stream,stdout=subprocess.DEVNULL,timeout=600)
    restored=ledger_bytes(docker(['exec',container,'psql','-X','--username=phub_restore','--dbname=phub_restore',
                                 '--no-psqlrc','--tuples-only','--no-align','--set=ON_ERROR_STOP=1','--command='+LEDGER_SQL],'RESTORED_LEDGER'))
    need(restored==before and ledger_bytes(source_query(SOURCE_LEDGER))==before,'LEDGER_MISMATCH')
    need(file_digest(incoming)==dump_sha,'DUMP_CHANGED')
    guard(); owned_lock(); inspect_restore(container,operation_sha,tmpfs,'running')
    phase('RESTORE_VERIFIED',containerId=container,sourceLedgerSha256=digest(before),restoredLedgerSha256=digest(restored))
    need(not os.path.lexists(final) and not os.path.lexists(receipt_path),'OUTPUT_EXISTS')
    os.rename(incoming,final);sync_directory(transaction)
    need(file_digest(final)==dump_sha,'FINAL_DUMP_CHANGED')
    receipt={'schema':'PHUB_TIMEWEB_DATABASE_BACKUP_RESTORE_V1','baselineReleaseId':BASELINE,
             'completedAt':now_iso(),'backupFile':str(final),'backupSha256':dump_sha,'restoreVerified':True,
             'restoreImage':PG_IMAGE,'restoredLedgerSha256':digest(restored),'sourceLedgerSha256':digest(before)}
    exclusive(receipt_path,encoded(receipt))
    guard(); owned_lock(); inspect_restore(container,operation_sha,tmpfs,'running')
    phase('SUCCESS_RECEIPT',receiptSha256=digest(read_secure(receipt_path)),containerId=container)
    docker(['stop','--time','30',container],'RESTORE_STOP')
    inspect_restore(container,operation_sha,tmpfs,'exited')
    docker(['rm',container],'RESTORE_REMOVE')
    need(not docker(['ps','-aq','--no-trunc','--filter','name=^/'+name+'$']).strip(),'RESTORE_REMOVE_UNPROVEN')
    guard(); owned_lock()
    need(ledger_bytes(source_query(SOURCE_LEDGER))==before,'FINAL_LEDGER_DRIFT')
    need(file_digest(final)==dump_sha and strict(read_secure(receipt_path))==receipt,'FINAL_RECEIPT_DRIFT')
    phase('SUCCESS_CLEANUP_VERIFIED',receiptSha256=digest(read_secure(receipt_path)))
    guard(); owned_lock()
    (LOCK/'backup-restore.json').unlink();sync_directory(LOCK);LOCK.rmdir();sync_directory(LOCK.parent)
    return {'status':'BACKUP_RESTORE_VERIFIED','receiptSha256':digest(read_secure(receipt_path)),
            'releaseId':release_id,'authorizesDeploy':False,'dumpBytesPrinted':False}


def main():
    need(sys.flags.optimize==0 and sys.flags.isolated==1, 'ISOLATED_NONOPTIMIZED_PYTHON_REQUIRED')
    need(os.getuid()==0 and len(sys.argv)==3 and sys.argv[1]=='--execute' and sys.argv[2]==str(REQUEST), 'ENTRY')
    os.umask(0o077)
    file=Path(__file__)
    file_sha=digest(read_secure(file,0o755))
    request_bytes=read_secure(REQUEST)
    op=validate_operation(strict(request_bytes),time.time(),file_sha)
    need(file==ROOT/('operator/tools/'+op['toolCommit']+'/control-timeweb-database-backup.py'),'TOOL_PATH')
    need(os.uname().nodename=='msk-1-vm-z8ks' and os.uname().machine=='x86_64','HOST')
    ips=command(['/usr/bin/hostname','-I'],'HOST').decode().split()
    need('100.77.212.57' in ips and '103.88.243.171' in ips,'HOST')
    for sig in (signal.SIGTERM,signal.SIGINT):
        signal.signal(sig,lambda *_: (_ for _ in ()).throw(Stop('INTERRUPTED_UNCERTAIN')))
    print(json.dumps(execute(op,request_bytes,file_sha),separators=(',',':')))


if __name__=='__main__':
    try:
        main()
    except Exception as error:
        code=str(error) if isinstance(error,Stop) else 'UNEXPECTED_FAILURE'
        print(json.dumps({'status':'STOP','code':code,'replayAllowed':False,'cleanup':'REQUIRES_EXACT_OWNER_RECONCILIATION'},separators=(',',':')))
        sys.exit(1)
