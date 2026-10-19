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
import shlex
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
# Independent one-use exact CI pair; never add these paths to the ordinary allowlist.
API_WORKER_CI_DOWNLOAD_PATCH = {
    '.github/workflows/pull-request.yaml': {'path': '.github/workflows/pull-request.yaml', 'status': 'M', 'oldMode': '100644', 'newMode': '100644', 'oldOid': '632bed8b410a3ac3e42a7ba7e607e80f8004f30d', 'newOid': 'bd9cba78c1d9dbcb37fd2abf93f4e8a4ae3e4f87'},
    'scripts/pull-request-ci-workflow.test.ts': {'path': 'scripts/pull-request-ci-workflow.test.ts', 'status': 'M', 'oldMode': '100644', 'newMode': '100644', 'oldOid': 'caf2f124bbc58e4225feca1ad38100ed07991787', 'newOid': 'e2abfd6adac5d742b38ea16e8cb3d1dbb90c0982'},
}
API_WORKER_CI_READER_PATCH = {
    'scripts/timeweb-api-worker-upgrade.js': {'path': 'scripts/timeweb-api-worker-upgrade.js', 'status': 'M', 'oldMode': '100644', 'newMode': '100644', 'oldOid': '6420f1d4b5d5c905563d23921c61ce68be2ca28b', 'newOid': '5a2e148c5f82f291e329545989ef1136974d17a1'},
    'scripts/timeweb-api-worker-upgrade.d.ts': {'path': 'scripts/timeweb-api-worker-upgrade.d.ts', 'status': 'M', 'oldMode': '100644', 'newMode': '100644', 'oldOid': '151a183b17349c57a4d23cd58b03dd33be0e1172', 'newOid': 'cb7711e1dd145acb9b1beefc74e3d643ecbb5d60'},
    'scripts/timeweb-api-worker-upgrade.test.ts': {'path': 'scripts/timeweb-api-worker-upgrade.test.ts', 'status': 'M', 'oldMode': '100644', 'newMode': '100644', 'oldOid': 'e446cc167a63ee54e9352dc38589e414f1aa7247', 'newOid': '1e9e3e958b39ad80a6f68c0f51efef45308cfa86'},
    'scripts/timeweb-api-worker-adapter.test.ts': {'path': 'scripts/timeweb-api-worker-adapter.test.ts', 'status': 'M', 'oldMode': '100644', 'newMode': '100644', 'oldOid': 'dba09b8571260d1cb817971ce6a15a42a70f1032', 'newOid': 'e858abd81817cef9d6d62eca98b965f7bbce0c6e'},
    'scripts/timeweb-api-web-upgrade.js': {'path': 'scripts/timeweb-api-web-upgrade.js', 'status': 'M', 'oldMode': '100644', 'newMode': '100644', 'oldOid': 'c3da47a8fa4c95d06081d1a189c28b2ec8afa55e', 'newOid': 'c97b7c4c9afc3f2c0b2a09543954dc8215c579a7'},
}
API_WORKER_CONTROLLER_PROMOTION_PATCH = {
    'scripts/verify-source-ci.js': {'path': 'scripts/verify-source-ci.js', 'status': 'M', 'oldMode': '100644', 'newMode': '100644', 'oldOid': 'ed4ad7fa0c27caba918a9a4a6f5d151d3a996ac4', 'newOid': '31b891b4856dd95ecf849af0b13e609a281cbac1'},
    'scripts/verify-source-ci.test.ts': {'path': 'scripts/verify-source-ci.test.ts', 'status': 'M', 'oldMode': '100644', 'newMode': '100644', 'oldOid': 'deddc6be4d875375e813abe13a345311029d71bb', 'newOid': '63f207f3c05aa12fdf852fa0f898f14f4fb53282'},
}
API_WORKER_ANDROID_CHAT_TEST_PATCH = {
    'apps/mobile/src/MobileApp.test.tsx': {'path': 'apps/mobile/src/MobileApp.test.tsx', 'status': 'M', 'oldMode': '100644', 'newMode': '100644', 'oldOid': '35f557d6da06916e3a411129786e51a76cdd2ae0', 'newOid': '541fe96a4f895044faa123e157d4b1aa6ef38ad2'},
}
# One inert fixture correction; the exact regular pair is never a generic path allowance.
API_WORKER_REHEARSAL_READINESS_PATCH = {
    'scripts/rehearse-timeweb-standard-compose.js': {'path': 'scripts/rehearse-timeweb-standard-compose.js', 'status': 'M', 'oldMode': '100644', 'newMode': '100644', 'oldOid': '98c63003b8736bc1da48abfa9be5ee1e7bd6b005', 'newOid': 'df0f4dd006a229a55b517043042e7715127678eb'},
    'scripts/timeweb-standard-compose.test.ts': {'path': 'scripts/timeweb-standard-compose.test.ts', 'status': 'M', 'oldMode': '100644', 'newMode': '100644', 'oldOid': 'ba60973d95649afa3b81ac035e55b043cddc6285', 'newOid': '0e7ac3a12722d6250dd989e6d4dd9aed5b82bfac'},
}
# Independent duplicate of the frozen atomic native source tuple.
API_WORKER_NATIVE_BOOKINGS_PATCH = {
    'apps/mobile/android/app/build.gradle': {'path': 'apps/mobile/android/app/build.gradle', 'status': 'M', 'oldMode': '100644', 'newMode': '100644', 'oldOid': 'b5451e4334bc50c083e6b0d45cecf156d7e632e3', 'newOid': '70eb7c9f09bea9bc0aa8c26a67ae31c7595e7f15'},
    'apps/mobile/android/app/src/androidTest/java/ru/padlhub/app/AndroidHttpSenderTest.java': {'path': 'apps/mobile/android/app/src/androidTest/java/ru/padlhub/app/AndroidHttpSenderTest.java', 'status': 'M', 'oldMode': '100644', 'newMode': '100644', 'oldOid': '03b6967ef337078b1359ea9109440fd4d41b910b', 'newOid': 'ea5763e2fce0556717f01be1e1db03200f110755'},
    'apps/mobile/android/app/src/androidTest/java/ru/padlhub/app/AndroidSessionTest.java': {'path': 'apps/mobile/android/app/src/androidTest/java/ru/padlhub/app/AndroidSessionTest.java', 'status': 'M', 'oldMode': '100644', 'newMode': '100644', 'oldOid': '35a8e40c86060544e6454949ee72db293e8b5991', 'newOid': 'd60f3d8166b3129b89c1e415be5eac656c7fbea2'},
    'apps/mobile/android/app/src/androidTest/java/ru/padlhub/app/AndroidUpcomingBookingsRefreshTest.java': {'path': 'apps/mobile/android/app/src/androidTest/java/ru/padlhub/app/AndroidUpcomingBookingsRefreshTest.java', 'status': 'A', 'oldMode': '000000', 'newMode': '100644', 'oldOid': '0000000000000000000000000000000000000000', 'newOid': '6772d0dd08f779352a962128d4a062af3e012e4a'},
    'apps/mobile/android/app/src/main/java/ru/padlhub/app/AndroidHttpSender.java': {'path': 'apps/mobile/android/app/src/main/java/ru/padlhub/app/AndroidHttpSender.java', 'status': 'M', 'oldMode': '100644', 'newMode': '100644', 'oldOid': 'c468bcaeb1c5826de2e6e8983495eed59f9a69a6', 'newOid': 'e3610c361644fd57a48eb5e5602ba912ed1ab512'},
    'apps/mobile/android/app/src/main/java/ru/padlhub/app/AndroidSessionEngine.java': {'path': 'apps/mobile/android/app/src/main/java/ru/padlhub/app/AndroidSessionEngine.java', 'status': 'M', 'oldMode': '100644', 'newMode': '100644', 'oldOid': '1f939e114deb2ad04fd0be4ec7231b93a4431897', 'newOid': '58101384544473def5819106996529406dd29f13'},
    'apps/mobile/android/app/src/main/java/ru/padlhub/app/AndroidUpcomingBookingsRefresh.java': {'path': 'apps/mobile/android/app/src/main/java/ru/padlhub/app/AndroidUpcomingBookingsRefresh.java', 'status': 'A', 'oldMode': '000000', 'newMode': '100644', 'oldOid': '0000000000000000000000000000000000000000', 'newOid': 'e55ef5f508ce9e99e16068adee251f1d08231ad0'},
    'apps/mobile/android/app/src/main/java/ru/padlhub/app/PadlHubAndroidSessionPlugin.java': {'path': 'apps/mobile/android/app/src/main/java/ru/padlhub/app/PadlHubAndroidSessionPlugin.java', 'status': 'M', 'oldMode': '100644', 'newMode': '100644', 'oldOid': 'd82ccb21a299ddd96c53452f2c41c33c65250430', 'newOid': 'e0f4f8cdbc016dfaeb3aca9deaaa43323ae046db'},
    'apps/mobile/src/MobileApp.tsx': {'path': 'apps/mobile/src/MobileApp.tsx', 'status': 'M', 'oldMode': '100644', 'newMode': '100644', 'oldOid': 'fa598c298bfa8d95bfc8981f2e49c08862946299', 'newOid': '7e1188cc9493c6347f0ca84ca5c6cd38ad245144'},
    'apps/mobile/src/MobileSession.test.tsx': {'path': 'apps/mobile/src/MobileSession.test.tsx', 'status': 'M', 'oldMode': '100644', 'newMode': '100644', 'oldOid': 'ca26a53526fd7488e57c6200f924ec754947e7b2', 'newOid': 'fa26d6ad05715ece43ccdc904e9cc87c0f7f5817'},
    'apps/mobile/src/native-api-fetch.test.ts': {'path': 'apps/mobile/src/native-api-fetch.test.ts', 'status': 'M', 'oldMode': '100644', 'newMode': '100644', 'oldOid': 'fd7a348bd29a52f9f8beb79c1694c7e4f0b5b6ef', 'newOid': 'a93a254f179a52294ef0ce5e5594a9bb082ae8d7'},
    'apps/mobile/src/native-api-fetch.ts': {'path': 'apps/mobile/src/native-api-fetch.ts', 'status': 'M', 'oldMode': '100644', 'newMode': '100644', 'oldOid': '518a35a52876e49f873b1f3c0905f7672f9d5ff3', 'newOid': '98ea1bf70dee6c3a29d35ed0d6afc091f2bbe32f'},
    'apps/mobile/src/native-bookings-refresh.test.ts': {'path': 'apps/mobile/src/native-bookings-refresh.test.ts', 'status': 'A', 'oldMode': '000000', 'newMode': '100644', 'oldOid': '0000000000000000000000000000000000000000', 'newOid': 'f0bc5b853fc95a220f3795b091e7a26d6dfd8e44'},
    'apps/mobile/src/native-gateway.test.ts': {'path': 'apps/mobile/src/native-gateway.test.ts', 'status': 'M', 'oldMode': '100644', 'newMode': '100644', 'oldOid': '7ef122ec4302588ca5c2fd75c0881376a343a182', 'newOid': '8de932302903de5bd919721b281cb20e8200ac33'},
    'apps/mobile/src/session-failure.test.ts': {'path': 'apps/mobile/src/session-failure.test.ts', 'status': 'M', 'oldMode': '100644', 'newMode': '100644', 'oldOid': 'd7d19d39357faea456c02516901a6f03fa9896f3', 'newOid': '4f43d53c2319e1b304b16948d3af44e7857740f1'},
    'apps/mobile/src/session-failure.ts': {'path': 'apps/mobile/src/session-failure.ts', 'status': 'M', 'oldMode': '100644', 'newMode': '100644', 'oldOid': 'ced9a4274220ddbfffca756d46b863c86681f210', 'newOid': '00cb9921dd089da76ed4f7520694bb1433045a07'},
    'docs/adr/0005-viva-user-delegation-and-direct-transport.md': {'path': 'docs/adr/0005-viva-user-delegation-and-direct-transport.md', 'status': 'M', 'oldMode': '100644', 'newMode': '100644', 'oldOid': '34869e776f45d54cf2a33cbb481013693820b91d', 'newOid': 'bb1f2c6f137392fb3533bd5f1969217bf3d2c487'},
    'docs/adr/0020-client-assisted-booking-screen-snapshots.md': {'path': 'docs/adr/0020-client-assisted-booking-screen-snapshots.md', 'status': 'M', 'oldMode': '100644', 'newMode': '100644', 'oldOid': '9adc609998839ae23e00e5b6f27362d07de7b73c', 'newOid': '3cc2a9089ebb201268ba138d64b191524426f14d'},
    'docs/adr/0023-browser-only-viva-end-user-transport.md': {'path': 'docs/adr/0023-browser-only-viva-end-user-transport.md', 'status': 'M', 'oldMode': '100644', 'newMode': '100644', 'oldOid': '8f875c98a5524a25497bbf26e7c983bae5804530', 'newOid': 'b7bde1f395ae00ec5b7f195065d752c4a00c3af2'},
    'docs/runbooks/android-development.md': {'path': 'docs/runbooks/android-development.md', 'status': 'M', 'oldMode': '100644', 'newMode': '100644', 'oldOid': '6ee27c15223fda5d3239db8d1693ea727b69e355', 'newOid': 'c98d269710dabda6924e1524c7d9a45a16d407f4'},
}
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
SOURCE_LEDGER = READ_ONLY + 'exec psql -X --no-password --username="$POSTGRES_USER" --dbname="${POSTGRES_DB:-$POSTGRES_USER}" --no-psqlrc --tuples-only --no-align --set=ON_ERROR_STOP=1 --command=' + shlex.quote(LEDGER_SQL)
SOURCE_SIZE = READ_ONLY + 'exec psql -X --no-password --username="$POSTGRES_USER" --dbname="${POSTGRES_DB:-$POSTGRES_USER}" --no-psqlrc --tuples-only --no-align --set=ON_ERROR_STOP=1 --command=\'select pg_database_size(current_database())\''
SOURCE_DUMP = READ_ONLY + 'exec pg_dump --no-password --username="$POSTGRES_USER" --dbname="${POSTGRES_DB:-$POSTGRES_USER}" --format=custom --serializable-deferrable --no-owner --no-acl'
INSPECT_FORMAT = '{"Id":{{json .Id}},"Image":{{json .Image}},"Config":{"Image":{{json .Config.Image}},"Labels":{{json .Config.Labels}}},"RestartCount":{{json .RestartCount}},"State":{"Status":{{json .State.Status}},"StartedAt":{{json .State.StartedAt}},"Health":{"Status":{{with index .State "Health"}}{{json .Status}}{{else}}null{{end}}}}}'
RESTORE_FORMAT = '{"Id":{{json .Id}},"Config":{"Image":{{json .Config.Image}},"User":{{json .Config.User}},"Volumes":{{json .Config.Volumes}},"Labels":{{json .Config.Labels}}},"HostConfig":{' + ','.join('"'+key+'":{{json .HostConfig.'+key+'}}' for key in ['NetworkMode','ReadonlyRootfs','Binds','PortBindings','Tmpfs','Privileged','AutoRemove','RestartPolicy','CapAdd','CapDrop','SecurityOpt','PidsLimit','Memory','MemorySwap','NanoCpus','PublishAllPorts','Links','Devices','DeviceRequests','VolumesFrom','PidMode','IpcMode']) + '},"Mounts":{{json .Mounts}},"State":{"Status":{{json .State.Status}}}}'


# Two manual-only schemas. Ordinary Web V1 and API/Worker V2 remain tmpfs-only.
DISK_PRE_SCHEMA = 'PHUB_TIMEWEB_BACKUP_OPERATION_MIGRATION_PRE99_DISK_V1'
DISK_POST_SCHEMA = 'PHUB_TIMEWEB_BACKUP_OPERATION_API_WORKER_DISK_V1'
NS_PRE_SCHEMA = 'PHUB_TIMEWEB_BACKUP_OPERATION_MIGRATION_PRE99_DISK_NAMESPACE_V2'
NS_POST_SCHEMA = 'PHUB_TIMEWEB_BACKUP_OPERATION_API_WORKER_DISK_NAMESPACE_V2'
NS_DAEMON_MEMORY = 2 * 1024 ** 3
DISK_MEMORY = 2 * 1024 ** 3
DISK_HEADROOM = 5 * 1024 ** 3
DISK_COMMON_TMPFS = {'/var/run/postgresql': 'rw,nosuid,nodev,noexec,mode=1777,size=16777216',
                     '/tmp': 'rw,nosuid,nodev,noexec,mode=1777,size=16777216'}
DISK_MOUNT_OPTIONS = 'rw,nosuid,nodev,noexec,noatime'
DISK_TOOLS = {'loop': '/usr/sbin/losetup', 'crypt': '/usr/sbin/cryptsetup',
              'mkfs': '/usr/sbin/mke2fs', 'mount': '/usr/bin/mount',
              'umount': '/usr/bin/umount', 'findmnt': '/usr/bin/findmnt',
              'blkid': '/usr/sbin/blkid', 'blockdev': '/usr/sbin/blockdev',
              'dmsetup': '/usr/sbin/dmsetup'}


def is_disk_operation(op):
    return op.get('schema') in (DISK_PRE_SCHEMA, DISK_POST_SCHEMA, NS_PRE_SCHEMA, NS_POST_SCHEMA)


def disk_ledger_sha(op):
    return API_WORKER_PRE_LEDGER_SHA256 if op['schema'] in (DISK_PRE_SCHEMA, NS_PRE_SCHEMA) else API_WORKER_LEDGER_SHA256


def disk_sizing(database_bytes, available_memory, free_disk, after_dump=False):
    need(type(database_bytes) is int and 0 < database_bytes <= MAX_DUMP, 'DATABASE_SIZE')
    need(type(available_memory) is int and available_memory >= DISK_MEMORY + 2 * 1024 ** 3, 'DISK_MEMORY_CAPACITY')
    data = max(512 * 1024 ** 2, database_bytes * 3 + 256 * 1024 ** 2)
    overhead = max(512 * 1024 ** 2, (data + 19) // 20)
    image = ((data + overhead + 4 * 1024 ** 2 - 1) // (4 * 1024 ** 2)) * (4 * 1024 ** 2)
    dump_limit = min(MAX_DUMP, database_bytes * 2 + 256 * 1024 ** 2)
    need(type(free_disk) is int and free_disk >= (image if after_dump else dump_limit) + DISK_HEADROOM,
         'DISK_CAPACITY')
    return {'databaseBytes': database_bytes, 'restoreDataBytes': data, 'imageBytes': image,
            'memoryBytes': DISK_MEMORY, 'dumpLimitBytes': dump_limit, 'diskReserveBytes': DISK_HEADROOM}


def disk_plan(op, request_bytes, sizing):
    import uuid
    sha = digest(request_bytes)
    mode, release = operation_mode(op)
    work = ROOT / 'backups' / ('.disk-restore-' + sha)
    mapper = 'phub-restore-' + sha[:24]
    match = RELEASE.fullmatch(release)
    return {'schema': 'PHUB_TIMEWEB_DISK_RESTORE_PLAN_V1', 'operationSha256': sha,
            'work': str(work), 'canonical': str(ROOT / 'backups' / (release + '-' + mode)),
            'pendingLock': str(ROOT / 'standard' / ('.disk-lock-' + sha)),
            'image': str(work / 'restore.luks'), 'mount': str(work / 'pgdata-mounted'),
            'publication': str(work / 'publication'), 'mapperName': mapper,
            'mapperPath': '/dev/mapper/' + mapper,
            'luksUuid': str(uuid.uuid5(uuid.NAMESPACE_URL, 'phub-luks-' + sha)),
            'filesystemUuid': str(uuid.uuid5(uuid.NAMESPACE_URL, 'phub-ext4-' + sha)),
            'mountOptions': DISK_MOUNT_OPTIONS,
            'containerName': 'phub-timeweb-restore-' + match[1][:12] + '-' + match[2] + '-1',
            'restoreImage': PG_IMAGE, 'expectedLedgerSha256': disk_ledger_sha(op), **sizing}


def storage_identity(info):
    return {key: getattr(info, 'st_' + key) for key in ['dev', 'ino', 'uid', 'gid', 'mode'] + ([] if stat.S_ISDIR(info.st_mode) else ['nlink'])}


def same_storage(info, expected):
    return storage_identity(info) == expected


def disk_tool(name, args, code, **kwargs):
    return command([DISK_TOOLS[name], *args], code, **kwargs)


def disk_prerequisites(cleanup=False):
    need(sys.platform == 'linux' and os.uname().machine == 'x86_64', 'DISK_PLATFORM')
    if not cleanup:
        need(hasattr(os, 'posix_fallocate'), 'DISK_FALLOCATE_UNAVAILABLE')
    # No installation, kernel-module load or fallback belongs to this producer.
    names = ['loop', 'crypt', 'umount', 'findmnt', 'blkid', 'dmsetup'] if cleanup else list(DISK_TOOLS)
    for path in (DISK_TOOLS[name] for name in names):
        info = secure(path)
        need(stat.S_IMODE(info.st_mode) & 0o111 and not stat.S_IMODE(info.st_mode) & 0o022, 'DISK_TOOL_CUSTODY')
    need(Path('/sys/module/loop').is_dir() and Path('/dev/loop-control').exists()
         and Path('/dev/mapper/control').exists(), 'DISK_KERNEL_CAPABILITY')
    need('ext4' in Path('/proc/filesystems').read_text().split(), 'DISK_FILESYSTEM_CAPABILITY')
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    import ctypes
    libc = ctypes.CDLL(None, use_errno=True)
    need(hasattr(libc, 'renameat2'), 'DISK_NOREPLACE_UNAVAILABLE')
    if cleanup:
        return
    need(re.search(r'^crypt\s', disk_tool('dmsetup', ['targets'], 'DISK_CRYPT_TARGET').decode(), re.M), 'DISK_CRYPT_TARGET')
    need(re.search(r'^name\s*:\s*xts\(aes\)\s*$', Path('/proc/crypto').read_text(), re.M), 'DISK_CRYPTO_CAPABILITY')
    # mlockall does not survive cryptsetup exec. Require no active swap, never disable it here.
    swaps = Path('/proc/swaps').read_text().strip().splitlines()
    need(len(swaps) == 1 and swaps[0].startswith('Filename'), 'DISK_SWAP_ACTIVE')
    # Prevent the process-held ephemeral key from entering swap or a core dump.
    # This changes only this operator process; missing capability stops before locking/dump.
    try:
        resource.setrlimit(resource.RLIMIT_MEMLOCK, (128 * 1024 ** 2, 128 * 1024 ** 2))
        need(libc.mlockall(3) == 0, 'DISK_KEY_MEMORY_CUSTODY')
    except (OSError, ValueError):
        raise Stop('DISK_KEY_MEMORY_CUSTODY') from None


def rename_noreplace(source, destination):
    import ctypes
    libc = ctypes.CDLL(None, use_errno=True)
    fn = libc.renameat2
    fn.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    fn.restype = ctypes.c_int
    need(fn(-100, os.fsencode(source), -100, os.fsencode(destination), 1) == 0, 'DISK_PUBLISH_UNCERTAIN')
    sync_directory(Path(source).parent)
    sync_directory(Path(destination).parent)


def disk_memory_available():
    match = re.search(r'^MemAvailable:\s+([0-9]+) kB$', Path('/proc/meminfo').read_text(), re.M)
    need(match is not None, 'MEMORY_READ')
    return int(match[1]) * 1024


def disk_free():
    value = os.statvfs(ROOT)
    return value.f_bavail * value.f_frsize


def disk_container_args(plan):
    args = restore_create_args(plan['containerName'], plan['operationSha256'], 512 * 1024 ** 2)
    args[args.index('--memory') + 1] = str(plan['memoryBytes'])
    args[args.index('--memory-swap') + 1] = str(plan['memoryBytes'])
    index = args.index('--tmpfs')
    del args[index:index + 2]
    args[1:1] = ['--log-driver', 'none', '--entrypoint', 'docker-entrypoint.sh']
    args.append('postgres')
    index = args.index('--tmpfs')
    args[index:index] = ['--mount', 'type=bind,src=' + plan['mount'] + ',dst=/var/lib/postgresql/data,bind-propagation=rprivate']
    return args


def disk_container_projection(row):
    return {'Id': row['Id'], 'Config': {key: row['Config'].get(key) for key in ['Image', 'User', 'Volumes', 'Labels', 'Env', 'Cmd', 'Entrypoint']},
            'HostConfig': {key: row['HostConfig'].get(key) for key in ['NetworkMode', 'ReadonlyRootfs', 'Binds', 'PortBindings',
              'Tmpfs', 'Privileged', 'AutoRemove', 'RestartPolicy', 'CapAdd', 'CapDrop', 'SecurityOpt', 'PidsLimit',
              'Memory', 'MemorySwap', 'NanoCpus', 'PublishAllPorts', 'Links', 'Devices', 'DeviceRequests', 'VolumesFrom', 'PidMode', 'IpcMode', 'LogConfig']},
            'Mounts': row['Mounts'], 'State': {key: row['State'][key] for key in ['Status', 'Pid', 'StartedAt']}}


def disk_expected_environment():
    image = strict(docker(['image', 'inspect', '--format', '{"Env":{{json .Config.Env}}}', PG_IMAGE]))
    exact(image, ['Env'])
    need(isinstance(image['Env'], list) and all(isinstance(v, str) and '=' in v for v in image['Env']), 'DISK_IMAGE_ENV')
    values = {}
    for value in image['Env']:
        key, val = value.split('=', 1)
        need(key not in values, 'DISK_IMAGE_ENV')
        values[key] = val
    values.update(PGDATA='/var/lib/postgresql/data/phub-restore', POSTGRES_USER='phub_restore',
                  POSTGRES_DB='phub_restore', POSTGRES_HOST_AUTH_METHOD='trust')
    return [key + '=' + value for key, value in values.items()]


def validate_disk_container(row, plan):
    h, c, mounts = row['HostConfig'], row['Config'], row['Mounts']
    need(HASH.fullmatch(row['Id'] or '') and c['Image'] == PG_IMAGE and c['User'] == 'postgres'
         and c['Labels'] == {'phub.backup-operation': plan['operationSha256']}
         and isinstance(c['Env'], list) and sorted(c['Env']) == sorted(disk_expected_environment())
         and c['Cmd'] == ['postgres'] and c['Entrypoint'] == ['docker-entrypoint.sh']
         and row['State']['Status'] in ['created', 'running', 'exited']
         and h['LogConfig'] == {'Type': 'none', 'Config': {}}
         and h['NetworkMode'] == 'none' and h['ReadonlyRootfs'] is True
         and h['Tmpfs'] == DISK_COMMON_TMPFS and h['Privileged'] is False and h['AutoRemove'] is False
         and h['RestartPolicy'] == {'Name': 'no', 'MaximumRetryCount': 0}
         and h['CapDrop'] == ['ALL'] and not h['CapAdd']
         and h['SecurityOpt'] in (['no-new-privileges'], ['no-new-privileges:true'])
         and h['PidsLimit'] == 128 and h['Memory'] == DISK_MEMORY and h['MemorySwap'] == DISK_MEMORY
         and h['NanoCpus'] == 1000000000 and h['PublishAllPorts'] is False
         and h['PidMode'] == '' and h['IpcMode'] == 'private'
         and all(not h[key] for key in ['Binds', 'PortBindings', 'Links', 'Devices', 'DeviceRequests', 'VolumesFrom'])
         and isinstance(c['Volumes'], (dict, type(None))) and set(c['Volumes'] or {}) <= {'/var/lib/postgresql/data'}
         and isinstance(mounts, list), 'DISK_RESTORE_CUSTODY')
    binds = [v for v in mounts if v.get('Type') == 'bind']
    temps = [v for v in mounts if v.get('Type') == 'tmpfs']
    need(len(binds) == 1 and binds[0].get('Source') == plan['mount']
         and binds[0].get('Destination') == '/var/lib/postgresql/data'
         and binds[0].get('RW') is True and binds[0].get('Propagation') == 'rprivate'
         and len(mounts) == len({v.get('Destination') for v in mounts})
         and len(mounts) == len(binds) + len(temps)
         # Docker 29 reports tmpfs only through HostConfig.Tmpfs (verified on the host), while
         # older clients also listed them in Mounts; accept both, the HostConfig set is exact.
         and (len(temps) == 0
              or len(temps) == 2 and {v.get('Destination') for v in temps} == set(DISK_COMMON_TMPFS))
         and all(v.get('RW') is True for v in temps), 'DISK_RESTORE_MOUNTS')


class DiskJournal:
    """Immutable, chained metadata only; keys and database bytes never enter this journal."""
    def __init__(self, work, operation_sha):
        self.work, self.sha = Path(work), operation_sha
        self.events = []
        prefix = 'disk-event-'
        files = sorted(p for p in self.work.iterdir() if p.name.startswith(prefix))
        previous = '0' * 64
        for index, path in enumerate(files):
            need(path.name == prefix + f'{index:04d}.json', 'DISK_JOURNAL_SEQUENCE')
            raw = read_secure(path)
            event = strict(raw)
            exact(event, ['schema', 'operationSha256', 'index', 'previousSha256', 'phase', 'metadata', 'observedAt'])
            need(event['schema'] == 'PHUB_TIMEWEB_DISK_RESTORE_EVENT_V1'
                 and event['operationSha256'] == self.sha and event['index'] == index
                 and event['previousSha256'] == previous
                 and re.fullmatch(r'[A-Z][A-Z0-9_]{0,63}', event['phase'])
                 and isinstance(event['metadata'], dict), 'DISK_JOURNAL')
            utc(event['observedAt'])
            self.events.append(event)
            previous = digest(raw)
        self.previous = previous

    def add(self, phase, **metadata):
        # All callers supply fixed metadata fields; no external command output/key bytes are saved.
        event = {'schema': 'PHUB_TIMEWEB_DISK_RESTORE_EVENT_V1', 'operationSha256': self.sha,
                 'index': len(self.events), 'previousSha256': self.previous,
                 'phase': phase, 'metadata': metadata, 'observedAt': now_iso()}
        raw = encoded(event)
        atomic_exclusive(self.work / f'disk-event-{len(self.events):04d}.json', raw)
        self.events.append(event)
        self.previous = digest(raw)
        return metadata

    def find(self, phase):
        values = [v['metadata'] for v in self.events if v['phase'] == phase]
        need(len(values) <= 1, 'DISK_DUPLICATE_PHASE')
        return values[0] if values else None

    def once(self, phase, **metadata):
        old = self.find(phase)
        if old is None:
            return self.add(phase, **metadata)
        need(old == metadata, 'DISK_PHASE_DRIFT')
        return old


def disk_loop_rows():
    value = strict(disk_tool('loop', ['--json', '--list', '--output', 'NAME,BACK-FILE,BACK-INO,BACK-MAJ:MIN,OFFSET,SIZELIMIT,RO,AUTOCLEAR'], 'DISK_LOOP_READ'))
    exact(value, ['loopdevices'])
    need(isinstance(value['loopdevices'], list), 'DISK_LOOP_READ')
    return value['loopdevices']


def disk_loop(plan, image_identity, optional=False):
    rows = disk_loop_rows()
    candidates = [v for v in rows if v.get('back-file') == plan['image'] or v.get('back-ino') == image_identity['ino']
                  and v.get('back-maj:min') == f"{os.major(image_identity['dev'])}:{os.minor(image_identity['dev'])}"]
    need(len(candidates) <= 1 and (optional or len(candidates) == 1), 'DISK_LOOP_COUNT')
    if not candidates:
        return None
    row = candidates[0]
    need(re.fullmatch(r'/dev/loop[0-9]+', row.get('name', ''))
         and row.get('back-file') == plan['image'] and row.get('back-ino') == image_identity['ino']
         and row.get('back-maj:min') == f"{os.major(image_identity['dev'])}:{os.minor(image_identity['dev'])}"
         and row.get('offset') == 0 and row.get('sizelimit') == plan['imageBytes']
         and row.get('ro') in (False, 0) and row.get('autoclear') in (False, 0), 'DISK_LOOP_CUSTODY')
    return row['name']


def disk_mapper(plan, loop, optional=False):
    if not os.path.lexists(plan['mapperPath']):
        need(optional, 'DISK_MAPPER_MISSING')
        return None
    block = os.stat(plan['mapperPath'])
    need(stat.S_ISBLK(block.st_mode), 'DISK_MAPPER_TYPE')
    status = disk_tool('crypt', ['status', plan['mapperName']], 'DISK_MAPPER_READ').decode()
    parsed = dict(re.findall(r'^\s*([a-zA-Z]+):\s*(.*?)\s*$', status, re.M))
    need(parsed.get('type') == 'LUKS2' and parsed.get('device') == loop
         and parsed.get('cipher') == 'aes-xts-plain64'
         and parsed.get('keysize') in ('512 bits', '512 [bits]')
         and parsed.get('mode') == 'read/write', 'DISK_MAPPER_CUSTODY')
    uuid = disk_tool('crypt', ['luksUUID', loop], 'DISK_LUKS_UUID').decode().strip()
    info = disk_tool('dmsetup', ['info', '--columns', '--noheadings', '--separator', ':',
                              '--options', 'name,major,minor,uuid', plan['mapperName']], 'DISK_MAPPER_ID').decode().strip().split(':')
    need(uuid == plan['luksUuid'] and len(info) == 4 and info[0] == plan['mapperName']
         and info[1:3] == [str(os.major(block.st_rdev)), str(os.minor(block.st_rdev))]
         and info[3] == 'CRYPT-LUKS2-' + plan['luksUuid'].replace('-', '') + '-' + plan['mapperName'], 'DISK_MAPPER_ID')
    return {'device': os.major(block.st_rdev), 'minor': os.minor(block.st_rdev), 'uuid': info[3]}


def disk_mount(plan, mapper, optional=False, complete=True):
    # --target may return the parent filesystem; accept only the exact mountpoint, no submounts.
    value = strict(disk_tool('findmnt', ['--json', '--submounts', '--target', plan['mount'],
                       '--output', 'TARGET,SOURCE,FSTYPE,OPTIONS,MAJ:MIN,FSROOT'], 'DISK_MOUNT_READ'))
    exact(value, ['filesystems'])
    rows = value['filesystems']
    need(isinstance(rows, list) and len(rows) == 1, 'DISK_MOUNT_COUNT')
    row = rows[0]
    if row.get('target') != plan['mount']:
        need(optional, 'DISK_MOUNT_MISSING')
        return None
    need(mapper is not None and row.get('source') == plan['mapperPath'] and row.get('fstype') == 'ext4'
         and row.get('fsroot') == '/' and row.get('maj:min') == f"{mapper['device']}:{mapper['minor']}"
         and not row.get('children')
         and set(row.get('options', '').split(',')) == {'rw', 'nosuid', 'nodev', 'noexec', 'noatime'}, 'DISK_MOUNT_CUSTODY')
    info = Path(plan['mount']).lstat()
    need(info.st_dev == os.makedev(mapper['device'], mapper['minor']) and info.st_uid == info.st_gid == 0
         and stat.S_ISDIR(info.st_mode) and (stat.S_IMODE(info.st_mode) == (0o700 if plan['schema'] == 'PHUB_TIMEWEB_DISK_RESTORE_PLAN_V2' else 0o1777) if complete else stat.S_IMODE(info.st_mode) in (0o700, 0o755, 0o1777)), 'DISK_MOUNT_METADATA')
    uuid = disk_tool('blkid', ['--probe', '--match-tag', 'UUID', '--output', 'value', plan['mapperPath']], 'DISK_FILESYSTEM_UUID').decode().strip()
    need(uuid == plan['filesystemUuid'], 'DISK_FILESYSTEM_UUID')
    # PGDATA creation changes root link count; device/inode/owner/mode identify the mount.
    return {key: value for key, value in storage_identity(info).items() if key != 'nlink'}


def disk_image(plan, journal, optional=False, complete=True):
    expected = journal.find('IMAGE_CREATED')
    if not os.path.lexists(plan['image']):
        need(optional, 'DISK_IMAGE_MISSING')
        return None
    need(expected is not None, 'DISK_IMAGE_UNPROVEN')
    info = secure(plan['image'], mode=0o600)
    need(same_storage(info, expected['identity']) and 0 <= info.st_size <= plan['imageBytes'], 'DISK_IMAGE_DRIFT')
    if complete:
        need(info.st_size == plan['imageBytes'] and info.st_blocks * 512 >= plan['imageBytes'], 'DISK_IMAGE_SPARSE')
    return expected['identity']


def disk_storage_attest(plan, journal, mounted=True):
    image = disk_image(plan, journal)
    loop = disk_loop(plan, image)
    expected = journal.find('LOOP_ATTACHED')
    need(expected is not None and expected['loop'] == loop, 'DISK_LOOP_DRIFT')
    mapper = disk_mapper(plan, loop)
    need(journal.find('MAPPER_OPENED') == {'identity': mapper}, 'DISK_MAPPER_DRIFT')
    mount = disk_mount(plan, mapper)
    need(journal.find('MOUNTED') == {'identity': mount}, 'DISK_MOUNT_DRIFT')
    size = os.statvfs(plan['mount'])
    need(size.f_frsize * size.f_blocks >= plan['restoreDataBytes'], 'DISK_FILESYSTEM_SIZE')
    return {'image': image, 'loop': loop, 'mapper': mapper, 'mount': mount}


def mountinfo_records(raw):
    result = []
    def unescape(value):
        # Kernel mountinfo uses octal escapes, not URL or shell escaping.
        need(not re.search(r'\\(?![0-7]{3})', value), 'DISK_MOUNTINFO_ESCAPE')
        return re.sub(r'\\([0-7]{3})', lambda m: chr(int(m[1], 8)), value)
    for line in raw.splitlines():
        fields = line.split(' - ')
        need(len(fields) == 2, 'DISK_MOUNTINFO')
        left, right = fields[0].split(), fields[1].split()
        need(len(left) >= 6 and len(right) == 3 and re.fullmatch(r'[0-9]+:[0-9]+', left[2]), 'DISK_MOUNTINFO')
        result.append({'id': left[0], 'parent': left[1], 'device': left[2], 'root': unescape(left[3]),
                       'target': unescape(left[4]), 'options': left[5].split(','), 'optional': left[6:],
                       'fstype': right[0], 'source': unescape(right[1]), 'superOptions': right[2].split(',')})
    return result


def mountinfo_match(records, target, mapper, source=None):
    rows = [v for v in records if v['target'] == target]
    need(len(rows) == 1, 'DISK_KERNEL_MOUNT_COUNT')
    row = rows[0]
    need(row['device'] == f"{mapper['device']}:{mapper['minor']}" and row['root'] == '/'
         and row['fstype'] == 'ext4' and (source is None or row['source'] == source)
         and {'rw', 'nosuid', 'nodev', 'noexec'} <= set(row['options'])
         and 'ro' not in row['options'] and not row['optional']
         and not any(v['target'].startswith(target.rstrip('/') + '/') for v in records), 'DISK_KERNEL_MOUNT_CUSTODY')
    return row


def disk_kernel_mount_proof(plan, mapper, row):
    state = row['State']
    need(state['Status'] == 'running' and type(state['Pid']) is int and 1 <= state['Pid'] <= 2 ** 31 - 1,
         'DISK_RESTORE_RUNNING')
    pid = state['Pid']
    host_ns = os.stat('/proc/self/ns/mnt').st_ino
    container_ns = os.stat(f'/proc/{pid}/ns/mnt').st_ino
    host = mountinfo_match(mountinfo_records(Path('/proc/self/mountinfo').read_text()), plan['mount'], mapper, plan['mapperPath'])
    container = mountinfo_match(mountinfo_records(Path(f'/proc/{pid}/mountinfo').read_text()),
                               '/var/lib/postgresql/data', mapper)
    need(os.stat('/proc/self/ns/mnt').st_ino == host_ns and os.stat(f'/proc/{pid}/ns/mnt').st_ino == container_ns,
         'DISK_MOUNT_NAMESPACE_DRIFT')
    return {'hostNamespace': host_ns, 'containerNamespace': container_ns, 'pid': pid,
            'startedAt': state['StartedAt'], 'hostMount': host, 'containerMount': container}


def disk_daemon_namespace():
    # Private mounts must be visible to dockerd BEFORE it starts any PostgreSQL writer.
    secure('/usr/bin/systemctl')
    secure('/usr/bin/dockerd')
    def pid_read():
        raw = command(['/usr/bin/systemctl', 'show', 'docker.service', '--property=MainPID', '--value'], 'DISK_DAEMON_PID').decode().strip()
        need(re.fullmatch(r'[1-9][0-9]{0,9}', raw) and int(raw) <= 2 ** 31 - 1, 'DISK_DAEMON_PID')
        return int(raw)
    pid = pid_read()
    before = Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()[19]
    need(os.readlink(f'/proc/{pid}/exe') == '/usr/bin/dockerd', 'DISK_DAEMON_EXECUTABLE')
    namespace = os.stat('/proc/self/ns/mnt').st_ino
    need(os.stat(f'/proc/{pid}/ns/mnt').st_ino == namespace, 'DISK_DAEMON_NAMESPACE')
    need(pid_read() == pid and Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()[19] == before
         and os.stat('/proc/self/ns/mnt').st_ino == namespace
         and os.stat(f'/proc/{pid}/ns/mnt').st_ino == namespace, 'DISK_DAEMON_DRIFT')
    return {'pid': pid, 'startTicks': before, 'namespace': namespace}


def disk_daemon_guard(journal):
    need(journal.find('DAEMON_NAMESPACE') == disk_daemon_namespace(), 'DISK_DAEMON_DRIFT')


@contextmanager
def disk_mutation_lock():
    # One host-local invocation, including reconcilers; attestation is deliberately read-only.
    import fcntl
    path = ROOT / 'standard/database-backup-disk-process.lock'
    secure(path.parent, 'dir')
    fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        opened = os.fstat(fd)
        secure_info(opened, 'file', 0o600)
        need(identity(opened) == identity(secure(path, mode=0o600)), 'DISK_PROCESS_LOCK_DRIFT')
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise Stop('DISK_PROCESS_BUSY') from None
        need(identity(opened) == identity(secure(path, mode=0o600)), 'DISK_PROCESS_LOCK_DRIFT')
        yield
    finally:
        os.close(fd)


def disk_private_parent(plan):
    # A new mount must not propagate into any peer namespace. Never change global propagation.
    rows = mountinfo_records(Path('/proc/self/mountinfo').read_text())
    parents = [v for v in rows if plan['work'] == v['target'] or plan['work'].startswith(v['target'].rstrip('/') + '/')]
    need(parents, 'DISK_PARENT_MOUNT')
    parent = max(parents, key=lambda v: len(v['target']))
    need(not parent['optional'], 'DISK_PARENT_NOT_PRIVATE')


def disk_container_lookup(plan):
    values = docker(['ps', '-aq', '--no-trunc', '--filter', 'name=^/' + plan['containerName'] + '$']).decode().split()
    need(len(values) <= 1 and all(HASH.fullmatch(v) for v in values), 'DISK_RESTORE_COUNT')
    if not values:
        return None
    row = strict(docker(['inspect', '--format', DISK_RESTORE_FORMAT, values[0]]))
    validate_disk_container(row, plan)
    return row


def disk_running_attestation(plan, journal):
    storage = disk_storage_attest(plan, journal)
    row = disk_container_lookup(plan)
    need(row is not None, 'DISK_RESTORE_MISSING')
    created = journal.find('RESTORE_CREATED')
    need(created is not None and created['containerId'] == row['Id'], 'DISK_RESTORE_ID_DRIFT')
    kernel = disk_kernel_mount_proof(plan, storage['mapper'], row)
    again = disk_container_lookup(plan)
    need(again == row, 'DISK_RESTORE_PID_DRIFT')
    return {'storage': storage, 'kernel': kernel, 'container': disk_container_projection(row)}


def disk_verify_reference(op, request_bytes, file_sha):
    """Read-only, independent entry for the Node proof reader. Derives all paths/IDs locally."""
    need(op['schema'] == DISK_POST_SCHEMA, 'DISK_POST_ATTESTATION_ONLY')
    tool_custody(op)
    sha = digest(request_bytes)
    work = ROOT / 'backups' / ('.disk-restore-' + sha)
    need(read_secure(work / 'backup-operation.json') == request_bytes, 'DISK_REQUEST_DRIFT')
    plan_bytes = read_secure(work / 'disk-plan.json')
    plan = strict(plan_bytes)
    sizing = {key: plan[key] for key in ['databaseBytes', 'restoreDataBytes', 'imageBytes', 'memoryBytes', 'dumpLimitBytes', 'diskReserveBytes']}
    need(plan == disk_plan(op, request_bytes, sizing), 'DISK_PLAN_DRIFT')
    journal = DiskJournal(work, sha)
    proof_bytes = read_secure(work / 'restore-storage-proof.json')
    proof = strict(proof_bytes)
    exact(proof, ['schema', 'operationSha256', 'planSha256', 'readback'])
    need(proof['schema'] == 'PHUB_TIMEWEB_DISK_RESTORE_STORAGE_PROOF_V1'
         and proof['operationSha256'] == sha and proof['planSha256'] == digest(plan_bytes), 'DISK_STORAGE_PROOF')
    lock = journal.find('LOCK_PREPARED')
    need(lock is not None and same_storage(secure(LOCK, 'dir', 0o700), lock['identity'])
         and sorted(p.name for p in LOCK.iterdir()) == ['backup-restore.json']
         and read_secure(LOCK / 'backup-restore.json') == encoded(lock['marker']), 'DISK_LOCK_DRIFT')
    readback = disk_running_attestation(plan, journal)
    need(readback == proof['readback'] and read_secure(work / 'restore-storage-proof.json') == proof_bytes
         and read_secure(REQUEST) == request_bytes, 'DISK_STORAGE_PROOF_DRIFT')
    return {'schema': 'PHUB_TIMEWEB_DISK_RESTORE_READBACK_V1', 'operationSha256': sha,
            'storageProofSha256': digest(proof_bytes), 'plan': plan, 'readback': readback,
            'migration': {**{key: op[key] for key in ['controllerSha', 'controllerTree', 'controllerSourceCiRunId',
                                                'candidateReleaseId', 'migrationPlanSha256', 'migrationSuccessSha256']}, **promotion_expected(op)}}

DISK_RESTORE_FORMAT = RESTORE_FORMAT.replace('"State":{"Status":{{json .State.Status}}}', '"State":{"Status":{{json .State.Status}},"Pid":{{json .State.Pid}},"StartedAt":{{json .State.StartedAt}}}').replace('"Labels":{{json .Config.Labels}}}', '"Labels":{{json .Config.Labels}},"Env":{{json .Config.Env}},"Cmd":{{json .Config.Cmd}},"Entrypoint":{{json .Config.Entrypoint}}}').replace('"IpcMode":{{json .HostConfig.IpcMode}}}', '"IpcMode":{{json .HostConfig.IpcMode}},"LogConfig":{{json .HostConfig.LogConfig}}}')

# Namespace V2 is deliberately separate from the existing tmpfs/DISK V1 contracts.
def is_namespace_operation(op):
    return op.get('schema') in (NS_PRE_SCHEMA, NS_POST_SCHEMA)


NS_IMAGE_FORMAT = '{"Id":{{json .Id}},"Os":{{json .Os}},"Architecture":{{json .Architecture}},"RepoDigests":{{json .RepoDigests}},"Size":{{json .Size}},"RootFS":{{json .RootFS}},"Env":{{json .Config.Env}}}'
NS_RESTORE_FORMAT = DISK_RESTORE_FORMAT.replace('{"Id":', '{"Image":{{json .Image}},"Id":', 1).replace('"LogConfig":{{json .HostConfig.LogConfig}}}', '"LogConfig":{{json .HostConfig.LogConfig}},"CgroupParent":{{json .HostConfig.CgroupParent}},"CgroupnsMode":{{json .HostConfig.CgroupnsMode}}}')
NS_RESTORE_FORMAT = NS_RESTORE_FORMAT.removesuffix('}') + ',"NetworkSettings":{"SandboxKey":{{json .NetworkSettings.SandboxKey}}}' + '}'
NS_ALIAS = Path('/media')


def namespace_image(value, source=None):
    exact(value, ['Id', 'Os', 'Architecture', 'RepoDigests', 'Size', 'RootFS', 'Env'])
    exact(value['RootFS'], ['Type', 'Layers'])
    need(re.fullmatch(r'sha256:[a-f0-9]{64}', value['Id'] or '')
         and value['Os'] == 'linux' and value['Architecture'] == 'amd64'
         and type(value['Size']) is int and 0 < value['Size'] <= 2 * 1024**3
         and value['RootFS']['Type'] == 'layers' and isinstance(value['RootFS']['Layers'], list)
         and 0 < len(value['RootFS']['Layers']) <= 128
         and all(re.fullmatch(r'sha256:[a-f0-9]{64}', v or '') for v in value['RootFS']['Layers']), 'NS_IMAGE')
    need(isinstance(value['Env'], list) and len(value['Env']) <= 256 and all(isinstance(v, str) and '=' in v for v in value['Env'])
         and len({v.split('=',1)[0] for v in value['Env']}) == len(value['Env']), 'NS_IMAGE_ENV')
    if source is None:
        need(restore_image_admitted(value), 'NS_IMAGE_SOURCE')
    else:
        # docker save/load need not retain RepoDigests. A containerd-image-store host reports
        # the manifest digest while a classic isolated daemon assigns the config digest, so the
        # platform/ordered layer chain/environment bind the import; the exact imported ID is then
        # recorded by the IMAGE_LOADED journal event and reused for container custody. Reported
        # Size is store-dependent (containerd store = compressed manifest, classic = unpacked).
        need(all(value[k] == source[k] for k in ['Os', 'Architecture', 'RootFS', 'Env']), 'NS_IMAGE_IMPORT')
    return value


def namespace_sizing(database_bytes, memory, free, image, after_dump=False):
    namespace_image(image)
    need(memory >= DISK_MEMORY + NS_DAEMON_MEMORY + 2 * 1024**3, 'NS_MEMORY_CAPACITY')
    base = disk_sizing(database_bytes, memory, free, after_dump=False)
    runtime = max(2 * 1024**3, image['Size'] * 3 + 256 * 1024**2)
    total = base['restoreDataBytes'] + runtime
    base['imageBytes'] = ((total + max(512 * 1024**2, (total + 19)//20) + 4*1024**2-1)//(4*1024**2))*(4*1024**2)
    need(free >= (base['imageBytes'] if after_dump else base['dumpLimitBytes']) + DISK_HEADROOM, 'NS_DISK_CAPACITY')
    return base


def namespace_plan(op, raw, sizing, image):
    need(is_namespace_operation(op), 'NS_OPERATION')
    namespace_image(image)
    p = disk_plan(op, raw, sizing)
    p['schema'] = 'PHUB_TIMEWEB_DISK_RESTORE_PLAN_V2'
    root, control = str(NS_ALIAS / '.runtime'), p['work'] + '/runtime-control'
    p['isolation'] = {'strategy': 'SYSTEMD_SUPERVISOR_PRIVATE_ALIAS_V1',
        'unit': 'phub-disk-runtime-' + p['operationSha256'][:24] + '.service',
        'slice': 'phubdiskrestore' + p['operationSha256'][:24] + '.slice',
        'controlRoot': control, 'pgdata': p['mount'] + '/pgdata',
        'dataRoot': root + '/docker-data', 'execRoot': root + '/docker-exec',
        'socket': root + '/docker.sock', 'pidFile': root + '/dockerd.pid',
        'configFile': control + '/daemon.json', 'image': image,
        'imageTransferLimitBytes': image['Size'] * 2 + 512*1024**2,
        'daemonMemoryBytes': NS_DAEMON_MEMORY, 'daemonPids': 256, 'daemonNanoCpus': 1000000000}
    return p


def namespace_config(p):
    r = p['isolation']; suffix = p['operationSha256'][:24]
    return {'hosts': ['unix:///media/.runtime/docker.sock'], 'pidfile': r['pidFile'],
        'data-root': r['dataRoot'], 'exec-root': r['execRoot'], 'storage-driver': 'vfs',
        'bridge': 'none', 'iptables': False, 'ip6tables': False, 'ip-forward': False,
        'ip-masq': False, 'userland-proxy': False, 'live-restore': False,
        'shutdown-timeout': 30, 'group': 'root', 'log-driver': 'none',
        'exec-opts': ['native.cgroupdriver=systemd'], 'cgroup-parent': r['slice'],
        'default-cgroupns-mode': 'private', 'default-runtime': 'runc', 'no-new-privileges': True,
        'containerd-namespace': 'phub-' + suffix,
        'features': {'containerd-snapshotter': False}}


def namespace_unit_args(p, tool):
    r = p['isolation']
    props = {'Restart': 'no', 'Delegate': 'yes', 'KillMode': 'control-group',
        'SendSIGKILL': 'yes', 'TimeoutStopSec': '30s', 'MemoryAccounting': 'yes', 'MemoryMax': str(NS_DAEMON_MEMORY),
        'MemorySwapMax': '0', 'TasksAccounting': 'yes', 'TasksMax': '256',
        'CPUAccounting': 'yes', 'CPUQuota': '100%', 'LimitCORE': '0', 'UMask': '0077', 'PrivateNetwork': 'yes',
        # systemd 259 gives a PrivateNetwork=yes unit its own mount namespace. The supervisor must
        # start in the host mount namespace because it proves that identity before unsharing and
        # making / private; PrivateMounts=no keeps the network namespace without that mount split.
        'PrivateMounts': 'no',
        'StandardInput': 'null', 'StandardOutput': 'null', 'StandardError': 'null'}
    return ['/usr/bin/systemd-run', '--unit=' + r['unit'], '--service-type=exec', '--collect',
        '--quiet', '--slice=' + r['slice'], '--uid=root', '--gid=root', '--working-directory=' + p['work'],
        *['--property=' + k + '=' + v for k, v in props.items()],
        '--setenv=PATH=/usr/bin:/bin', '--setenv=HOME=/root', '--setenv=LANG=C', '--setenv=LC_ALL=C',
        '/usr/bin/python3', '-I', '-S', '-B', str(tool), '--disk-runtime-supervisor', str(REQUEST), p['operationSha256']]


def namespace_process(pid, root=True):
    need(type(pid) is int and 0 < pid < 2**31, 'NS_PID')
    base = Path('/proc') / str(pid)
    start = (base/'stat').read_text().rsplit(')', 1)[1].split()[19]
    status = (base/'status').read_text()
    uids = re.search(r'^Uid:\s+([0-9]+)\s+([0-9]+)\s+([0-9]+)\s+([0-9]+)$', status, re.M)
    gids = re.search(r'^Gid:\s+([0-9]+)\s+([0-9]+)\s+([0-9]+)\s+([0-9]+)$', status, re.M)
    need(uids is not None and gids is not None, 'NS_PROCESS_OWNER')
    uid, gid = [int(v) for v in uids.groups()], [int(v) for v in gids.groups()]
    need((uid == gid == [0]*4) if root else all(v != 0 for v in uid + gid), 'NS_PROCESS_OWNER')
    argv = (base/'cmdline').read_bytes()
    need(0 < len(argv) <= 65536 and argv.endswith(b'\0'), 'NS_PROCESS_ARGV')
    value = {'pid': pid, 'startTicks': start, 'executable': os.readlink(base/'exe'),
        'cmdline': argv[:-1].decode().split('\0'), 'mountNamespace': os.stat(base/'ns/mnt').st_ino,
        'uid': uid, 'gid': gid, 'cgroup': (base/'cgroup').read_text().strip()}
    need((base/'stat').read_text().rsplit(')', 1)[1].split()[19] == start
         and os.stat(base/'ns/mnt').st_ino == value['mountNamespace'], 'NS_PROCESS_DRIFT')
    return value


def namespace_source_daemon():
    secure('/usr/bin/systemctl'); secure('/usr/bin/dockerd')
    raw = command(['/usr/bin/systemctl', 'show', 'docker.service', '--property=MainPID', '--value'], 'NS_SOURCE_DAEMON').decode().strip()
    need(re.fullmatch(r'[1-9][0-9]*', raw), 'NS_SOURCE_DAEMON')
    v = namespace_process(int(raw)); need(v['executable'] == '/usr/bin/dockerd', 'NS_SOURCE_DAEMON')
    return v


def namespace_network(pid):
    need(type(pid) is int and 0 < pid < 2**31, 'NS_NETWORK_PID')
    try:
        return os.stat('/proc/' + str(pid) + '/ns/net').st_ino
    except OSError:
        raise Stop('NS_NETWORK_READ') from None


NS_UNIT_KEYS = ['LoadState', 'ActiveState', 'SubState', 'MainPID', 'InvocationID', 'ControlGroup',
    'MemoryMax', 'MemorySwapMax', 'TasksMax', 'Delegate', 'CPUQuotaPerSecUSec', 'KillMode',
    'SendSIGKILL', 'Restart', 'TimeoutStopUSec', 'LimitCORE', 'UMask', 'User', 'Group',
    'WorkingDirectory', 'StandardInput', 'StandardOutput', 'StandardError', 'Slice',
    'Transient', 'NRestarts', 'Result', 'ExecMainCode', 'ExecMainStatus', 'PrivateNetwork', 'PrivateMounts']
NS_SLICE_KEYS = ['LoadState', 'ActiveState', 'ControlGroup', 'Transient', 'MemoryMax', 'MemorySwapMax', 'TasksMax', 'CPUQuotaPerSecUSec']


def namespace_show(name, keys):
    raw = command(['/usr/bin/systemctl', 'show', name, *['--property=' + v for v in keys]], 'NS_UNIT_READ').decode()
    rows = [line.split('=', 1) for line in raw.splitlines()]
    need(len(rows) == len(keys) and len({v[0] for v in rows}) == len(keys), 'NS_UNIT_FIELDS')
    value = dict(rows); need(set(value) == set(keys), 'NS_UNIT_FIELDS'); return value


def namespace_unit(p):
    return namespace_show(p['isolation']['unit'], NS_UNIT_KEYS)


def namespace_bounds(group, memory, pids, cpus):
    need(re.fullmatch(r'/phubdiskrestore[a-f0-9]{24}\.slice(?:/phub-disk-runtime-[a-f0-9]{24}\.service)?', group), 'NS_CGROUP_PATH')
    path = Path('/sys/fs/cgroup') / group.lstrip('/')
    result = {'identity': storage_identity(secure(path, 'dir')), 'path': str(path)}
    for filename, expected in [('memory.max', str(memory)), ('memory.swap.max', '0'), ('pids.max', str(pids))]:
        v = (path/filename).read_text().strip(); need(v == expected, 'NS_CGROUP_BOUND'); result[filename] = v
    quota = (path/'cpu.max').read_text().strip().split()
    need(len(quota) == 2 and all(v.isdigit() and int(v)>0 for v in quota) and int(quota[0]) == cpus*int(quota[1]), 'NS_CGROUP_CPU')
    result['cpu.max'] = ' '.join(quota); return result


def namespace_slice(p):
    r = p['isolation']; u = namespace_show(r['slice'], NS_SLICE_KEYS)
    need(u == {'LoadState':'loaded', 'ActiveState':'active', 'ControlGroup':'/'+r['slice'], 'Transient':'yes',
        'MemoryMax':str(2*NS_DAEMON_MEMORY), 'MemorySwapMax':'0', 'TasksMax':'384', 'CPUQuotaPerSecUSec':'2s'}, 'NS_SLICE_CUSTODY')
    return {'unit':u, 'bounds':namespace_bounds(u['ControlGroup'], 2*NS_DAEMON_MEMORY, 384, 2)}


def namespace_slice_args(p):
    # A transient unit via typed D-Bus properties: no persistent runtime drop-in.
    return ['/usr/bin/busctl', 'call', 'org.freedesktop.systemd1', '/org/freedesktop/systemd1',
        'org.freedesktop.systemd1.Manager', 'StartTransientUnit', 'ssa(sv)a(sa(sv))', p['isolation']['slice'], 'fail', '9',
        'Description','s','PadlHub owned disk restore '+p['operationSha256'],
        'MemoryAccounting','b','true','MemoryMax','t',str(2*NS_DAEMON_MEMORY),'MemorySwapMax','t','0',
        'TasksAccounting','b','true','TasksMax','t','384','CPUAccounting','b','true','CPUQuotaPerSecUSec','t','2000000',
        'CollectMode','s','inactive-or-failed','0']


def namespace_live_pids(ids):
    # Zombies hold no mount/cgroup custody and can appear transiently while a daemon child is
    # being reaped; a PID reaped between cgroup enumeration and this read is equally gone.
    live = []
    for value in ids:
        try:
            rest = (Path('/proc') / str(value) / 'stat').read_text().rsplit(')', 1)[1].split()
        except OSError:
            continue
        if rest and rest[0] != 'Z':live.append(value)
    return live


def namespace_members(group):
    path = Path('/sys/fs/cgroup') / group.lstrip('/')
    if not path.exists():return []
    ids = []
    for file in path.rglob('cgroup.procs'):
        ids += file.read_text().split()
    need(len(ids)==len(set(ids)) and all(re.fullmatch(r'[1-9][0-9]*', v) for v in ids), 'NS_CGROUP_MEMBERS')
    return sorted(namespace_live_pids([int(v) for v in ids]))


def namespace_frozen_source(p):
    event = DiskJournal(p['work'], p['operationSha256']).find('SOURCE_DAEMON')
    need(event is not None and event['identity'] == namespace_source_daemon(), 'NS_SOURCE_DAEMON_DRIFT')
    return event['identity']


def namespace_control(p, name):
    need(name in ('namespace-receipt.json', 'daemon.json', 'daemon-start.json', 'daemon-receipt.json',
                  'daemon-stop.json', 'daemon-exit.json', 'daemon-startup-error.json', 'supervisor-terminal.json'), 'NS_CONTROL_PATH')
    return Path(p['isolation']['controlRoot']) / name


def namespace_supervisor_identity(p, op):
    value = namespace_unit(p)
    need(value['LoadState'] == 'loaded' and value['ActiveState'] == 'active'
         and value['SubState'] == 'running' and value['Delegate'] == 'yes'
         and value['KillMode'] == 'control-group' and value['MemoryMax'] == str(NS_DAEMON_MEMORY)
         and value['MemorySwapMax'] == '0' and value['TasksMax'] == '256'
         and value['CPUQuotaPerSecUSec'] == '1s'
         and re.fullmatch(r'[a-f0-9]{32}', value['InvocationID'] or '')
         and value['ControlGroup'] == '/' + p['isolation']['slice'] + '/' + p['isolation']['unit']
         and all(value[k] == v for k,v in {'SendSIGKILL':'yes','Restart':'no','TimeoutStopUSec':'30s','LimitCORE':'0',
             'UMask':'0077','PrivateNetwork':'yes','PrivateMounts':'no','User':'root','Group':'root','WorkingDirectory':p['work'], 'StandardInput':'null',
             'StandardOutput':'null','StandardError':'null','Slice':p['isolation']['slice'],'Transient':'yes',
             'NRestarts':'0','Result':'success','ExecMainCode':'0','ExecMainStatus':'0'}.items()), 'NS_UNIT_CUSTODY')
    process = namespace_process(int(value['MainPID']))
    tool = str(ROOT/'operator/tools'/op['toolCommit']/'control-timeweb-database-backup.py')
    need(process['executable'] == os.readlink('/proc/self/exe')
         and process['cmdline'] == ['/usr/bin/python3', '-I', '-S', '-B', tool,
             '--disk-runtime-supervisor', str(REQUEST), p['operationSha256']]
         and process['cgroup'] == '0::' + value['ControlGroup'], 'NS_SUPERVISOR_CUSTODY')
    return {'unit':value, 'process':process, 'bounds':namespace_bounds(value['ControlGroup'], NS_DAEMON_MEMORY,256,1),
            'slice':namespace_slice(p)}


def namespace_admission(p, op):
    receipt = strict(read_secure(namespace_control(p, 'namespace-receipt.json')))
    exact(receipt, ['schema', 'operationSha256', 'toolFileSha256', 'sourceDaemon', 'supervisor', 'network'])
    source_network = DiskJournal(p['work'], p['operationSha256']).find('SOURCE_NETWORK')
    need(receipt['schema'] == 'PHUB_TIMEWEB_PRIVATE_NAMESPACE_RECEIPT_V1'
         and receipt['operationSha256'] == p['operationSha256']
         and receipt['toolFileSha256'] == op['toolFileSha256']
         and receipt['supervisor'] == namespace_supervisor_identity(p, op)
         and receipt['sourceDaemon'] == namespace_frozen_source(p)
         and receipt['sourceDaemon']['mountNamespace'] != receipt['supervisor']['process']['mountNamespace']
         and type(receipt['network']) is dict and set(receipt['network']) == {'sourceNamespace','supervisorNamespace'}
         and source_network is not None and receipt['network']['sourceNamespace'] == source_network['namespace']
         and receipt['network']['sourceNamespace'] == namespace_network(receipt['sourceDaemon']['pid'])
         and receipt['network']['supervisorNamespace'] == namespace_network(receipt['supervisor']['process']['pid'])
         and receipt['network']['sourceNamespace'] != receipt['network']['supervisorNamespace'], 'NS_RECEIPT_DRIFT')
    return receipt


def namespace_syscall(name, fd=None):
    import ctypes
    libc = ctypes.CDLL(None, use_errno=True)
    fn = getattr(libc, name); fn.argtypes = [ctypes.c_int] if name == 'unshare' else [ctypes.c_int, ctypes.c_int]; fn.restype = ctypes.c_int
    need(fn(0x00020000) == 0 if name == 'unshare' else fn(fd, 0x00020000) == 0, 'NS_' + name.upper())


@contextmanager
def namespace_enter(p, op):
    admission = namespace_admission(p, op); expected = admission['supervisor']['process']
    host = os.open('/proc/self/ns/mnt', os.O_RDONLY | os.O_CLOEXEC); target = None; entered = False
    try:
        need(os.fstat(host).st_ino == admission['sourceDaemon']['mountNamespace'], 'NS_ATTACH_CALLER')
        target = os.open('/proc/' + str(expected['pid']) + '/ns/mnt', os.O_RDONLY | os.O_CLOEXEC)
        need(os.fstat(target).st_ino == expected['mountNamespace'] and namespace_admission(p, op) == admission, 'NS_ATTACH_DRIFT')
        namespace_syscall('setns', target); entered = True; os.chdir('/')
        need(os.stat('/proc/self/ns/mnt').st_ino == expected['mountNamespace'], 'NS_ATTACH_READBACK')
        disk_private_parent(p); yield admission
    finally:
        try:
            if entered:
                namespace_syscall('setns', host); os.chdir('/')
                need(os.stat('/proc/self/ns/mnt').st_ino == admission['sourceDaemon']['mountNamespace'], 'NS_RETURN_READBACK')
        finally:
            if target is not None:os.close(target)
            os.close(host)


def namespace_socket(p):
    path = Path(p['isolation']['socket']); info = path.lstat()
    need(stat.S_ISSOCK(info.st_mode) and info.st_uid == info.st_gid == 0
         and stat.S_IMODE(info.st_mode) == 0o660 and info.st_nlink == 1, 'NS_SOCKET_CUSTODY')
    for parent in path.parents:
        secure(parent, 'dir')
    return storage_identity(info)


def namespace_alias_rows(pid=None):
    path = '/proc/self/mountinfo' if pid is None else '/proc/' + str(pid) + '/mountinfo'
    return mountinfo_records(Path(path).read_text())


def namespace_alias_identity(info):
    return {key:getattr(info, 'st_' + key) for key in ['dev','ino','uid','gid','mode','nlink']}


def namespace_mask_identity(info):
    return {key:getattr(info, 'st_' + key) for key in ['dev','ino','uid','gid','mode']}


def namespace_mask_baseline(source):
    path = Path('/run/containerd'); info = secure(path, 'dir')
    need(stat.S_IMODE(info.st_mode) in (0o711,0o755), 'NS_MASK_BASELINE')
    baseline = namespace_mask_identity(info)
    for rows in [namespace_alias_rows(), namespace_alias_rows(source['pid'])]:
        need(not any(v['target'] == str(path) or v['target'].startswith(str(path) + '/') for v in rows), 'NS_MASK_MOUNTED')
    source_path = Path('/proc') / str(source['pid']) / 'root' / 'run' / 'containerd'
    need(namespace_mask_identity(source_path.lstat()) == baseline, 'NS_MASK_SOURCE_DRIFT')
    return baseline


def namespace_mask_source_baseline(source, baseline):
    path = Path('/proc') / str(source['pid']) / 'root' / 'run' / 'containerd'
    rows = namespace_alias_rows(source['pid'])
    need(namespace_mask_identity(path.lstat()) == baseline
         and not any(v['target'] == '/run/containerd' or v['target'].startswith('/run/containerd/') for v in rows),
         'NS_MASK_SOURCE_DRIFT')


def namespace_runtime_root(p, journal):
    need(journal.find('ALIAS_MOUNTED') is not None, 'NS_RUNTIME_ROOT_PROOF')
    namespace_alias_attest(p, journal)
    root = NS_ALIAS / '.runtime'; event = journal.find('RUNTIME_ROOT_CREATED')
    if event is None:
        root.mkdir(mode=0o700)
        identity = storage_identity(secure(root, 'dir', 0o700))
        journal.add('RUNTIME_ROOT_CREATED', identity=identity)
    else:
        identity = storage_identity(secure(root, 'dir', 0o700))
        need(identity == event['identity'], 'NS_RUNTIME_ROOT_DRIFT')
    return root


def namespace_alias_baseline(source):
    info = secure(NS_ALIAS, 'dir', 0o755)
    baseline = namespace_alias_identity(info)
    need(not any(NS_ALIAS.iterdir()), 'NS_ALIAS_DIRTY')
    for rows in [namespace_alias_rows(), namespace_alias_rows(source['pid'])]:
        need(not any(v['target'] == str(NS_ALIAS) or v['target'].startswith(str(NS_ALIAS) + '/') for v in rows), 'NS_ALIAS_MOUNTED')
    source_alias = Path('/proc') / str(source['pid']) / 'root' / 'media'
    source_info = source_alias.lstat()
    need(namespace_alias_identity(source_info) == baseline and not any(source_alias.iterdir()), 'NS_ALIAS_SOURCE_DRIFT')
    return baseline


def namespace_alias_local_baseline(baseline):
    info = secure(NS_ALIAS, 'dir', 0o755)
    need(namespace_alias_identity(info) == baseline and not any(NS_ALIAS.iterdir())
         and not any(v['target'] == str(NS_ALIAS) or v['target'].startswith(str(NS_ALIAS) + '/') for v in namespace_alias_rows()),
         'NS_ALIAS_UNMOUNT')


def namespace_alias_restored(journal):
    baseline = journal.find('ALIAS_BASELINE')['identity']; namespace_alias_local_baseline(baseline)
    ready = journal.find('NAMESPACE_READY')
    need(ready is not None and namespace_alias_baseline(ready['receipt']['sourceDaemon']) == baseline, 'NS_ALIAS_SOURCE_DRIFT')


def namespace_mask_local_baseline(baseline):
    path = Path('/run/containerd'); info = secure(path, 'dir')
    need(namespace_mask_identity(info) == baseline
         and not any(v['target'] == str(path) or v['target'].startswith(str(path) + '/') for v in namespace_alias_rows()),
         'NS_MASK_UNMOUNT')


def namespace_mask_restored(journal):
    baseline = journal.find('CONTAINERD_MASK_BASELINE')['identity']; namespace_mask_local_baseline(baseline)
    ready = journal.find('NAMESPACE_READY')
    need(ready is not None and namespace_mask_baseline(ready['receipt']['sourceDaemon']) == baseline, 'NS_MASK_SOURCE_DRIFT')


def namespace_alias_mount(p, journal):
    baseline = journal.find('ALIAS_BASELINE')
    mounted = journal.find('MOUNTED')
    ready = journal.find('NAMESPACE_READY')
    need(baseline is not None and mounted is not None and ready is not None, 'NS_ALIAS_PROOF')
    source = ready['receipt']['sourceDaemon']
    need(os.stat('/proc/self/ns/mnt').st_ino == ready['receipt']['supervisor']['process']['mountNamespace'], 'NS_ALIAS_NAMESPACE')
    need(namespace_alias_baseline(source) == baseline['identity'], 'NS_ALIAS_SOURCE_DRIFT')
    journal.add('ALIAS_MOUNT_INTENT', baseline=baseline['identity'])
    disk_tool('mount', ['--no-mtab', '--bind', p['mount'], str(NS_ALIAS)], 'NS_ALIAS_MOUNT')
    value = namespace_alias_attest(p, journal)
    journal.add('ALIAS_MOUNTED', alias=value)
    return value


def namespace_alias_attest(p, journal):
    baseline = journal.find('ALIAS_BASELINE')
    mounted = journal.find('MOUNTED')
    ready = journal.find('NAMESPACE_READY')
    need(baseline is not None and mounted is not None and ready is not None, 'NS_ALIAS_PROOF')
    receipt = ready['receipt']; source = receipt['sourceDaemon']
    need(os.stat('/proc/self/ns/mnt').st_ino == receipt['supervisor']['process']['mountNamespace'], 'NS_ALIAS_NAMESPACE')
    source_alias = Path('/proc') / str(source['pid']) / 'root' / 'media'
    need(namespace_alias_identity(source_alias.lstat()) == baseline['identity'] and not any(source_alias.iterdir()), 'NS_ALIAS_SOURCE_DRIFT')
    source_rows = namespace_alias_rows(source['pid'])
    need(not any(v['target'] == str(NS_ALIAS) or v['target'].startswith(str(NS_ALIAS) + '/') for v in source_rows), 'NS_ALIAS_LEAK')
    rows = namespace_alias_rows(); matches = [v for v in rows if v['target'] == str(NS_ALIAS)]
    need(len(matches) == 1, 'NS_ALIAS_MOUNT')
    row = matches[0]; mapper = p['mapperPath']; identity = mounted['identity']
    need(row['source'] == mapper and row['root'] == '/' and row['fstype'] == 'ext4' and not row['optional']
         and set(row['options']) == {'rw','nosuid','nodev','noexec','noatime'}, 'NS_ALIAS_MOUNT')
    info = secure(NS_ALIAS, 'dir', 0o700)
    current = {key:getattr(info, 'st_' + key) for key in ['dev','ino','uid','gid','mode']}
    need(current == identity, 'NS_ALIAS_IDENTITY')
    namespace_runtime_mounts(p, journal, rows)
    return {'baseline': baseline['identity'], 'mount': identity, 'brokerMount': row}


def namespace_alias_unmount(p, journal):
    attempted = journal.find('ALIAS_MOUNT_INTENT') is not None
    if not attempted:
        namespace_alias_restored(journal)
        return
    if journal.find('ALIAS_UNMOUNTED') is not None:
        namespace_alias_restored(journal)
        return
    if journal.find('ALIAS_MOUNTED') is None:
        matches=[v for v in namespace_alias_rows() if v['target'] == str(NS_ALIAS)]
        if matches:
            journal.once('ALIAS_MOUNTED', alias=namespace_alias_attest(p, journal))
        else:
            namespace_alias_restored(journal)
            journal.once('ALIAS_UNMOUNTED', neverMounted=True)
            return
    if journal.find('ALIAS_UNMOUNT_INTENT') is None:
        namespace_alias_attest(p, journal)
        journal.add('ALIAS_UNMOUNT_INTENT')
    rows = namespace_alias_rows(); matches = [v for v in rows if v['target'] == str(NS_ALIAS)]
    if matches:
        namespace_alias_attest(p, journal)
        disk_tool('umount', ['--no-mtab', str(NS_ALIAS)], 'NS_ALIAS_UNMOUNT')
    namespace_alias_restored(journal)
    journal.once('ALIAS_UNMOUNTED')


def namespace_mask_mount(p, journal):
    ready = journal.find('NAMESPACE_READY'); baseline = journal.find('CONTAINERD_MASK_BASELINE')
    need(ready is not None and baseline is not None, 'NS_MASK_PROOF')
    source = ready['receipt']['sourceDaemon']; private = namespace_runtime_root(p, journal) / 'run-containerd'
    need(os.stat('/proc/self/ns/mnt').st_ino == ready['receipt']['supervisor']['process']['mountNamespace'], 'NS_MASK_NAMESPACE')
    namespace_mask_source_baseline(source, baseline['identity'])
    private.mkdir(mode=0o700); info = secure(private, 'dir', 0o700); source_identity = namespace_mask_identity(info)
    need(not any(private.iterdir()), 'NS_MASK_SOURCE_DIRTY')
    journal.add('CONTAINERD_MASK_INTENT', baseline=baseline['identity'], source=source_identity,
                namespace=ready['receipt']['supervisor']['process']['mountNamespace'])
    disk_tool('mount', ['--no-mtab', '--bind', str(private), '/run/containerd'], 'NS_MASK_MOUNT')
    value = namespace_mask_attest(p, journal)
    need(not Path('/run/containerd/containerd.sock').exists(), 'NS_MASK_SOCKET')
    journal.add('CONTAINERD_MASKED', mask=value)
    return value


def namespace_mask_attest(p, journal):
    baseline = journal.find('CONTAINERD_MASK_BASELINE'); intent = journal.find('CONTAINERD_MASK_INTENT'); ready = journal.find('NAMESPACE_READY')
    need(baseline is not None and intent is not None and ready is not None, 'NS_MASK_PROOF')
    source = ready['receipt']['sourceDaemon']; private = namespace_runtime_root(p, journal) / 'run-containerd'
    need(os.stat('/proc/self/ns/mnt').st_ino == intent['namespace'] == ready['receipt']['supervisor']['process']['mountNamespace'], 'NS_MASK_NAMESPACE')
    namespace_mask_source_baseline(source, baseline['identity'])
    rows = namespace_alias_rows(); matches = [v for v in rows if v['target'] == '/run/containerd']
    need(len(matches) == 1 and not any(v['target'].startswith('/run/containerd/') for v in rows), 'NS_MASK_MOUNT')
    row = matches[0]; source_identity = namespace_mask_identity(secure(private, 'dir', 0o700))
    need(row['source'] == p['mapperPath'] and row['root'] == '/.runtime/run-containerd' and row['fstype'] == 'ext4'
         and not row['optional'] and set(row['options']) == {'rw','nosuid','nodev','noexec','noatime'}
         and source_identity == intent['source'] and namespace_mask_identity(secure('/run/containerd', 'dir', 0o700)) == source_identity, 'NS_MASK_MOUNT')
    return {'baseline':baseline['identity'], 'source':source_identity, 'brokerMount':row}


def namespace_mask_unmount(p, journal):
    attempted = journal.find('CONTAINERD_MASK_INTENT') is not None
    baseline = journal.find('CONTAINERD_MASK_BASELINE')['identity']
    if not attempted:
        namespace_mask_restored(journal); return
    if journal.find('CONTAINERD_MASK_UNMOUNTED') is not None:
        namespace_mask_restored(journal); return
    if journal.find('CONTAINERD_MASKED') is None:
        matches=[v for v in namespace_alias_rows() if v['target'] == '/run/containerd']
        if matches:
            journal.once('CONTAINERD_MASKED', mask=namespace_mask_attest(p, journal))
        else:
            namespace_mask_restored(journal)
            journal.once('CONTAINERD_MASK_UNMOUNTED', neverMasked=True)
            return
    if journal.find('CONTAINERD_MASK_UNMOUNT_INTENT') is None:
        namespace_mask_attest(p, journal); journal.add('CONTAINERD_MASK_UNMOUNT_INTENT')
    rows = namespace_alias_rows(); matches = [v for v in rows if v['target'] == '/run/containerd']
    if matches:
        namespace_mask_attest(p, journal)
        disk_tool('umount', ['--no-mtab', '/run/containerd'], 'NS_MASK_UNMOUNT')
    else:need(journal.find('CONTAINERD_MASK_UNMOUNT_INTENT') is not None, 'NS_MASK_DISAPPEARED')
    namespace_mask_restored(journal)
    journal.once('CONTAINERD_MASK_UNMOUNTED')


def namespace_client_cwd(p):
    journal = DiskJournal(p['work'], p['operationSha256'])
    namespace_alias_attest(p, journal)
    namespace_mask_attest(p, journal)
    return NS_ALIAS


def namespace_docker(p, args, code='NS_DOCKER_READ', **kwargs):
    # No overload, ambient socket or host fallback. Source reads remain docker().
    namespace_socket(p)
    need('cwd' not in kwargs, 'NS_DOCKER_CWD_OVERRIDE')
    return command(['/usr/bin/docker', '--host', 'unix:///media/.runtime/docker.sock', *args], code,
                   environment={**ENV, 'DOCKER_HOST': 'unix:///media/.runtime/docker.sock'},
                   cwd=namespace_client_cwd(p), **kwargs)


def namespace_daemon_cwd(p, pid):
    expected = namespace_client_cwd(p)
    path = Path('/proc') / str(pid) / 'cwd'
    need(os.readlink(path) == str(expected), 'NS_DAEMON_CWD')
    actual = path.stat()
    expected_info = expected.lstat()
    need(storage_identity(actual) == storage_identity(expected_info), 'NS_DAEMON_CWD')
    return storage_identity(expected_info)


def namespace_daemon_identity(p, op):
    admission = namespace_admission(p, op)
    need(os.stat('/proc/self/ns/mnt').st_ino == admission['supervisor']['process']['mountNamespace'], 'NS_CALLER_NAMESPACE')
    path = Path(p['isolation']['pidFile']); raw = read_secure(path, 0o644).decode().strip()
    need(re.fullmatch(r'[1-9][0-9]*', raw), 'NS_DAEMON_PID')
    process = namespace_process(int(raw))
    need(process['executable'] == '/usr/bin/dockerd'
         and process['cmdline'] == ['/usr/bin/dockerd', '--config-file', p['isolation']['configFile']]
         and process['mountNamespace'] == admission['supervisor']['process']['mountNamespace']
         and process['cgroup'] == '0::' + admission['supervisor']['unit']['ControlGroup'], 'NS_DAEMON_CUSTODY')
    namespace_daemon_cwd(p, process['pid'])
    need(namespace_network(process['pid']) == admission['network']['supervisorNamespace'], 'NS_DAEMON_NETWORK')
    need(strict(read_secure(namespace_control(p, 'daemon.json'))) == namespace_config(p), 'NS_DAEMON_CONFIG')
    info = strict(namespace_docker(p, ['info', '--format', '{"DockerRootDir":{{json .DockerRootDir}},"Driver":{{json .Driver}},"CgroupDriver":{{json .CgroupDriver}},"LiveRestoreEnabled":{{json .LiveRestoreEnabled}}}']))
    need(info == {'DockerRootDir': p['isolation']['dataRoot'], 'Driver': 'vfs', 'CgroupDriver': 'systemd', 'LiveRestoreEnabled': False}, 'NS_DAEMON_INFO')
    # Dockerd/containerd can briefly spawn a helper (runc/shim setup) while the daemon is starting;
    # it leaves the cgroup before any container exists. Retry transient managed-custody races.
    for attempt in range(30):
        try:
            managed = namespace_managed(p, admission, process)
            break
        except Stop as error:
            if error.args[0] not in ('NS_SHIM_CUSTODY', 'NS_MANAGED_CUSTODY', 'NS_CONTAINERD_COUNT') or attempt == 29:
                raise
            time.sleep(0.5)
    return {'admission':admission, 'process':process, 'socket':namespace_socket(p), 'info':info,
            'managed':managed}


def namespace_managed(p, admission, daemon):
    import tomllib
    r = p['isolation']; broker = admission['supervisor']['process']; group = admission['supervisor']['unit']['ControlGroup']
    members = [namespace_process(pid) for pid in namespace_members(group)]
    need([v for v in members if v['pid']==broker['pid']]==[broker] and [v for v in members if v['pid']==daemon['pid']]==[daemon], 'NS_RUNTIME_MEMBERS')
    children = [v for v in members if v['pid'] not in (broker['pid'], daemon['pid'])]
    containerds = [v for v in children if v['executable']=='/usr/bin/containerd']
    need(len(containerds)==1, 'NS_CONTAINERD_COUNT'); child = containerds[0]
    path = r['execRoot']+'/containerd/containerd.toml'
    need(child['cmdline'] in (['containerd','--config',path], ['containerd','--config',path,'--log-level','info']), 'NS_CONTAINERD_ARGV')
    raw = read_secure(path, 0o600); cfg = tomllib.loads(raw.decode())
    projection = {'version':cfg.get('version'), 'root':cfg.get('root'), 'state':cfg.get('state'),
                  'address':cfg.get('grpc',{}).get('address'), 'disabledPlugins':cfg.get('disabled_plugins')}
    need(projection['version']==2 and projection['root']==r['dataRoot']+'/containerd/daemon'
         and projection['state']==r['execRoot']+'/containerd/daemon'
         and projection['address']==r['execRoot']+'/containerd/containerd.sock'
         and projection['disabledPlugins']==['io.containerd.grpc.v1.cri'], 'NS_CONTAINERD_CONFIG')
    # Reject external runtime configuration, remote sockets, imports and custom plugins.
    need(not cfg.get('imports') and not cfg.get('proxy_plugins'), 'NS_CONTAINERD_EXTERNAL')
    shims = [v for v in children if v is not child]
    for v in children:
        need(v['mountNamespace']==broker['mountNamespace'] and v['cgroup']=='0::'+group
             and namespace_network(v['pid']) == admission['network']['supervisorNamespace'], 'NS_MANAGED_CUSTODY')
    for v in shims:
        argv=v['cmdline']
        need(v['executable']=='/usr/bin/containerd-shim-runc-v2' and len(argv)==7
             and argv[:3]==['/usr/bin/containerd-shim-runc-v2','-namespace','phub-'+p['operationSha256'][:24]]
             and argv[3]=='-id' and HASH.fullmatch(argv[4]) and argv[5:]==['-address',projection['address']], 'NS_SHIM_CUSTODY')
    need(len(shims)<=1 and namespace_members(group)==sorted(v['pid'] for v in members)
         and all(namespace_process(v['pid'])==v for v in members), 'NS_MANAGED_DRIFT')
    return {'containerd':child, 'config':projection, 'configSha256':digest(raw), 'shims':shims}


def namespace_control_value(p, name, schema, fields):
    value = strict(read_secure(namespace_control(p,name))); exact(value, ['schema','operationSha256','planSha256',*fields])
    need(value['schema']==schema and value['operationSha256']==p['operationSha256']
         and value['planSha256']==digest(read_secure(Path(p['work'])/'disk-plan.json')), 'NS_CONTROL_DRIFT')
    return value


def namespace_wait(path, predicate, seconds=45):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if path.exists():
            value = strict(read_secure(path)); need(predicate(value), 'NS_ACK_DRIFT'); return value
        time.sleep(0.2)
    raise Stop('NS_ACK_UNKNOWN')


def namespace_require_absent(name):
    # show/LoadUnit synthesizes implicit .slice units. These listing queries do not
    # load the name; StartTransientUnit(mode=fail) remains the atomic admission.
    need(isinstance(name, str) and re.fullmatch(
        r'(?:phubdiskrestore[a-f0-9]{24}\.slice|phub-disk-runtime-[a-f0-9]{24}\.service)', name),
        'NS_ADMISSION_UNIT_NAME')
    code = 'NS_SLICE_EXISTS' if name.endswith('.slice') else 'NS_UNIT_EXISTS'
    rows = command(['/usr/bin/systemctl', 'list-units', '--all', '--plain', '--full',
                    '--no-legend', '--no-pager', '--', name], 'NS_UNIT_ADMISSION', timeout=15)
    need(not rows.strip(), code)
    namespace_require_no_unit_file(name)


def namespace_require_no_unit_file(name):
    need(isinstance(name, str) and re.fullmatch(
        r'(?:phubdiskrestore[a-f0-9]{24}\.slice|phub-disk-runtime-[a-f0-9]{24}\.service)', name),
        'NS_ADMISSION_UNIT_NAME')
    code = 'NS_SLICE_EXISTS' if name.endswith('.slice') else 'NS_UNIT_EXISTS'
    # On systemd 259 a filtered unit-file query returns 1 for no matches. Read the
    # complete non-loading inventory instead; command errors are never absence.
    rows = command(['/usr/bin/systemctl', 'list-unit-files', '--all', '--full',
                    '--no-legend', '--no-pager'], 'NS_UNIT_ADMISSION', timeout=15)
    need(0 < len(rows) <= 1024 ** 2, 'NS_UNIT_ADMISSION_OUTPUT')
    try:
        lines = rows.decode('utf-8').splitlines()
    except UnicodeError:
        raise Stop('NS_UNIT_ADMISSION_OUTPUT') from None
    need(0 < len(lines) <= 16384, 'NS_UNIT_ADMISSION_OUTPUT')
    states = {'enabled', 'enabled-runtime', 'linked', 'linked-runtime', 'alias', 'masked',
              'masked-runtime', 'static', 'disabled', 'indirect', 'generated', 'transient', 'bad'}
    seen = set()
    for line in lines:
        fields = line.split()
        need(len(fields) in (2, 3) and re.fullmatch(
            r'[^\s]+\.(?:automount|busname|device|mount|path|scope|service|slice|socket|swap|target|timer)',
            fields[0]) and fields[1] in states and
            (len(fields) == 2 or fields[2] in {'enabled', 'disabled', '-'}), 'NS_UNIT_ADMISSION_OUTPUT')
        need(fields[0] not in seen, 'NS_UNIT_ADMISSION_OUTPUT')
        seen.add(fields[0])
        need(fields[0] != name, code)



def namespace_start(p, op, journal):
    for tool in ['/usr/bin/busctl', '/usr/bin/containerd-shim-runc-v2', '/usr/bin/runc', '/usr/bin/systemd-run', '/usr/bin/systemctl', '/usr/bin/docker', '/usr/bin/dockerd', '/usr/bin/containerd']:
        need(stat.S_IMODE(secure(tool).st_mode) & 0o111, 'NS_TOOL_CUSTODY')
    namespace_require_absent(p['isolation']['unit'])
    namespace_require_absent(p['isolation']['slice'])
    Path(p['isolation']['controlRoot']).mkdir(mode=0o700); sync_directory(p['work'])
    namespace_frozen_source(p)
    journal.add('NAMESPACE_SLICE_START_INTENT')
    command(namespace_slice_args(p), 'NS_SLICE_START', timeout=30)
    journal.add('NAMESPACE_SLICE_READY', identity=namespace_slice(p))
    journal.add('NAMESPACE_UNIT_START_INTENT')
    tool = ROOT/'operator/tools'/op['toolCommit']/'control-timeweb-database-backup.py'
    command(namespace_unit_args(p, tool), 'NS_UNIT_START', timeout=30)
    namespace_wait(namespace_control(p, 'namespace-receipt.json'), lambda v: v['operationSha256'] == p['operationSha256'])
    value = namespace_admission(p, op); journal.add('NAMESPACE_READY', receipt=value)


def namespace_daemon_start(p, op, journal):
    need(namespace_admission(p, op) == journal.find('NAMESPACE_READY')['receipt'], 'NS_START_DRIFT')
    Path(p['isolation']['pgdata']).mkdir(mode=0o1777); os.chmod(p['isolation']['pgdata'], 0o1777)
    root = namespace_runtime_root(p, journal)
    for path in [p['isolation']['dataRoot'], p['isolation']['execRoot']]:Path(path).mkdir(mode=0o700)
    sync_directory(p['mount']); sync_directory(root)
    config = encoded(namespace_config(p)); atomic_exclusive(namespace_control(p, 'daemon.json'), config)
    command(['/usr/bin/dockerd', '--validate', '--config-file', str(namespace_control(p, 'daemon.json'))], 'NS_DAEMON_CONFIG_VALIDATE', timeout=15)
    journal.add('DAEMON_START_INTENT', configSha256=digest(config))
    request = {'schema': 'PHUB_PRIVATE_DAEMON_START_V1', 'operationSha256': p['operationSha256'],
               'planSha256': digest(read_secure(Path(p['work'])/'disk-plan.json')), 'configSha256': digest(config)}
    atomic_exclusive(namespace_control(p, 'daemon-start.json'), encoded(request))
    namespace_wait(namespace_control(p, 'daemon-receipt.json'), lambda v: v['operationSha256'] == p['operationSha256'])
    identity = namespace_daemon_identity(p, op)
    receipt = namespace_control_value(p,'daemon-receipt.json','PHUB_PRIVATE_DAEMON_RECEIPT_V1',['identity'])
    need(receipt['identity']==identity, 'NS_DAEMON_RECEIPT_DRIFT')
    journal.add('DAEMON_READY', identity=identity)


def namespace_client_death(parent):
    import ctypes
    libc=ctypes.CDLL(None, use_errno=True)
    if libc.prctl(1, signal.SIGKILL, 0, 0, 0)!=0 or os.getppid()!=parent:os._exit(125)


def namespace_image_transfer(p, op, journal):
    namespace_daemon_identity(p, op)
    frozen = namespace_frozen_source(p)
    source = namespace_image(strict(docker(['image', 'inspect', '--format', NS_IMAGE_FORMAT, PG_IMAGE])))
    need(source == p['isolation']['image'], 'NS_SOURCE_IMAGE_DRIFT')
    journal.add('IMAGE_TRANSFER_INTENT')
    # Streaming relay: no temporary tar, unbounded capture, shell or secret-bearing args.
    owned_cwd=namespace_client_cwd(p)
    client_parent=os.getpid()
    save = subprocess.Popen(['/usr/bin/docker', '--host', 'unix:///var/run/docker.sock', 'image', 'save', PG_IMAGE],
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL, env=ENV, close_fds=True, preexec_fn=lambda:namespace_client_death(client_parent))
    load = subprocess.Popen(['/usr/bin/docker', '--host', 'unix:///media/.runtime/docker.sock', 'image', 'load'],
                            stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env={**ENV, 'DOCKER_HOST':'unix:///media/.runtime/docker.sock'}, cwd=owned_cwd, close_fds=True, preexec_fn=lambda:namespace_client_death(client_parent))
    import selectors
    selector = selectors.DefaultSelector(); selector.register(save.stdout, selectors.EVENT_READ); selector.register(load.stdin, selectors.EVENT_WRITE)
    total, pending, eof, deadline = 0, b'', False, time.monotonic() + 120
    try:
        os.set_blocking(save.stdout.fileno(), False); os.set_blocking(load.stdin.fileno(), False)
        while not eof or pending:
            need(time.monotonic() < deadline and load.poll() is None, 'NS_IMAGE_TRANSFER_TIMEOUT')
            for key, _ in selector.select(0.2):
                if key.fileobj is save.stdout and not pending and not eof:
                    chunk = os.read(save.stdout.fileno(), 65536)
                    if not chunk:eof = True; selector.unregister(save.stdout)
                    else:
                        total += len(chunk); need(total <= p['isolation']['imageTransferLimitBytes'], 'NS_IMAGE_TRANSFER_LIMIT'); pending = chunk
                elif key.fileobj is load.stdin and pending:
                    pending = pending[os.write(load.stdin.fileno(), pending):]
        load.stdin.close(); need(save.wait(timeout=15) == 0 and load.wait(timeout=30) == 0, 'NS_IMAGE_TRANSFER')
    finally:
        selector.close()
        for proc in [save, load]:
            if proc.poll() is None:proc.kill()
            proc.wait(timeout=15)
        save.stdout.close()
        if not load.stdin.closed:load.stdin.close()
    need(namespace_frozen_source(p)==frozen and namespace_image(strict(docker(['image','inspect','--format',NS_IMAGE_FORMAT,PG_IMAGE])))==source, 'NS_TRANSFER_SOURCE_DRIFT')
    need(os.statvfs(p['mount']).f_bavail * os.statvfs(p['mount']).f_frsize >= p['restoreDataBytes'], 'NS_RESTORE_CAPACITY')
    # The isolated classic store assigns its own config-digest ID on load; discover it instead of
    # looking up the host-visible manifest digest.
    ids = namespace_docker(p, ['image', 'ls', '-aq', '--no-trunc']).decode().split()
    need(len(ids) == 1, 'NS_IMAGE_DISCOVERY')
    image_id = namespace_image_id(ids[0])
    imported = namespace_image(strict(namespace_docker(p, ['image', 'inspect', '--format', NS_IMAGE_FORMAT, image_id])), source)
    need(imported['Id'] == image_id, 'NS_IMAGE_DISCOVERY')
    journal.add('IMAGE_LOADED', source=source, imported=imported)


def namespace_image_id(value):
    # `docker image ls -aq --no-trunc` prints the sha256: prefixed digest; container IDs are bare.
    need(re.fullmatch(r'sha256:[a-f0-9]{64}', value or ''), 'NS_IMAGE_ID')
    return value


def namespace_current_image_id(p, journal):
    event = journal.find('IMAGE_LOADED')
    return event['imported']['Id'] if event is not None else None


def namespace_imported_image(p, journal):
    event = journal.find('IMAGE_LOADED')
    need(event is not None, 'NS_IMAGE_IMPORT_MISSING')
    imported = event['imported']
    need(namespace_image(imported, p['isolation']['image']) == imported, 'NS_IMAGE_IMPORT')
    return imported


def namespace_container_args(p, image_id=None):
    value = {**p, 'mount': p['isolation']['pgdata']}; args = disk_container_args(value)
    args[args.index(PG_IMAGE)] = image_id or p['isolation']['image']['Id']
    args[1:1] = ['--pull', 'never', '--cgroup-parent', p['isolation']['slice'], '--cgroupns', 'private']
    return args


def namespace_container_lookup(p, image_id=None):
    ids = namespace_docker(p, ['ps', '-aq', '--no-trunc']).decode().split()
    need(len(ids) <= 1 and all(HASH.fullmatch(v) for v in ids), 'NS_CONTAINER_COUNT')
    if not ids:return None
    row = strict(namespace_docker(p, ['inspect', '--format', NS_RESTORE_FORMAT, ids[0]]))
    need(row['Id'] == ids[0] and row['Image'] == row['Config']['Image'] == (image_id or p['isolation']['image']['Id'])
         and row['HostConfig']['CgroupParent'] == p['isolation']['slice'] and row['HostConfig']['CgroupnsMode'] == 'private', 'NS_CONTAINER_IMAGE_CGROUP')
    legacy = {**row, 'Config': {**row['Config'], 'Image': PG_IMAGE}}
    try:
        validate_disk_container(legacy, {**p, 'mount': p['isolation']['pgdata']})
    except Stop as error:
        try:
            Path('/opt/phub/timeweb-beta/backups/ns-container-debug.json').write_text(json.dumps(
                {'code': error.args[0], 'expectedMount': p['isolation']['pgdata'], 'mounts': row.get('Mounts'),
                 'hostConfigMounts': {k: row.get('HostConfig', {}).get(k) for k in ['Binds', 'Tmpfs', 'ReadonlyRootfs']},
                 'state': row.get('State')}, separators=(',', ':')))
        except OSError:
            pass
        raise
    return row


def namespace_runtime_mounts(p, journal, rows):
    alias = [v for v in rows if v['target'] == str(NS_ALIAS)]
    need(len(alias) == 1, 'NS_RUNTIME_ALIAS_MOUNT')
    data = [v for v in rows if v['target'] == p['isolation']['dataRoot']]
    net = [v for v in rows if re.fullmatch(re.escape(p['isolation']['execRoot']) + r'/netns/[a-f0-9]{12}', v['target'])]
    allowed = {str(NS_ALIAS), p['isolation']['dataRoot'], *[v['target'] for v in net]}
    descendants = [v for v in rows if v['target'].startswith(str(NS_ALIAS) + '/')]
    need(all(v['target'] in allowed for v in descendants), 'NS_RUNTIME_DESCENDANT')
    daemon_start = journal.find('DAEMON_START_INTENT') is not None
    daemon_ready = journal.find('DAEMON_READY') is not None
    daemon_stopped = journal.find('DAEMON_STOPPED') is not None
    created = journal.find('RESTORE_CREATE_INTENT') is not None
    start_intent = journal.find('RESTORE_START_INTENT') is not None
    started = journal.find('RESTORE_STARTED') is not None
    remove_intent = journal.find('CONTAINER_REMOVE_INTENT') is not None
    stop_intent = journal.find('CONTAINER_STOP_INTENT') is not None
    removed = journal.find('CONTAINER_REMOVED') is not None
    if not daemon_start:
        need(not data and not net, 'NS_RUNTIME_EARLY')
        return {'dataRoot':None, 'network':None}
    if daemon_stopped:
        need(not data and not net, 'NS_RUNTIME_STOPPED')
        return {'dataRoot':None, 'network':None}
    need((len(data) == 1 if daemon_ready else len(data) in (0,1)), 'NS_RUNTIME_DATA_MOUNT')
    if not data:
        need(not net, 'NS_RUNTIME_NET_EARLY')
        return {'dataRoot':None, 'network':None}
    need(data[0]['parent'] == alias[0]['id'] and data[0]['device'] == alias[0]['device']
         and data[0]['source'] == p['mapperPath'] and data[0]['root'] == '/.runtime/docker-data'
         and data[0]['fstype'] == 'ext4' and set(data[0]['options']) == {'rw','nosuid','nodev','noexec','noatime'}
         and len(data[0]['optional']) == 1 and re.fullmatch(r'shared:[1-9][0-9]*', data[0]['optional'][0]), 'NS_RUNTIME_DATA_MOUNT')
    token=data[0]['optional'][0]
    need(sum(token in v['optional'] for v in rows) == 1, 'NS_RUNTIME_DATA_PEER')
    ready=journal.find('NAMESPACE_READY')
    if ready is not None:
        source_rows=namespace_alias_rows(ready['receipt']['sourceDaemon']['pid'])
        need(not any(token in v['optional'] for v in source_rows), 'NS_RUNTIME_DATA_PEER')
    if not created or removed:
        need(not net, 'NS_RUNTIME_NET_EARLY')
        return {'dataRoot':data[0], 'network':None}
    if not start_intent:
        need(not net, 'NS_RUNTIME_NET_EARLY')
        return {'dataRoot':data[0], 'network':None}
    need((len(net) == 1 if started and not remove_intent and not stop_intent else len(net) in (0,1)), 'NS_RUNTIME_NET_MOUNT')
    if not net:return {'dataRoot':data[0], 'network':None}
    need(net[0]['parent'] == alias[0]['id'] and net[0]['fstype'] == 'nsfs'
         and net[0]['source'] == 'nsfs' and re.fullmatch(r'net:\[[1-9][0-9]*\]', net[0]['root'])
         and net[0]['options'] == ['rw'] and net[0]['superOptions'] == ['rw'] and not net[0]['optional'], 'NS_RUNTIME_NET_MOUNT')
    inode = int(net[0]['root'][5:-1]); info = Path(net[0]['target']).stat()
    need(info.st_ino == inode and net[0]['device'] == str(os.major(info.st_dev)) + ':' + str(os.minor(info.st_dev)), 'NS_RUNTIME_NET_IDENTITY')
    return {'dataRoot':data[0], 'network':net[0]}


def namespace_runtime_mounts_empty():
    rows = namespace_alias_rows()
    need(not any(v['target'].startswith(str(NS_ALIAS) + '/') for v in rows), 'NS_RUNTIME_CHILDREN_REMAIN')


def namespace_running_attestation(p, op, journal):
    isolation = namespace_daemon_identity(p, op); storage = disk_storage_attest(p, journal)
    row = namespace_container_lookup(p, namespace_current_image_id(p, journal)); need(row is not None and row['State']['Status'] == 'running', 'NS_CONTAINER_STATE')
    container = namespace_process(row['State']['Pid'], root=False)
    need(container['cgroup'] == '0::/' + p['isolation']['slice'] + '/docker-' + row['Id'] + '.scope', 'NS_CONTAINER_CGROUP')
    cg = Path('/sys/fs/cgroup')/p['isolation']['slice']/('docker-' + row['Id'] + '.scope')
    container_bounds={k:(cg/k).read_text().strip() for k in ['memory.max','memory.swap.max','pids.max','cpu.max']}
    for filename, expected in [('memory.max', str(DISK_MEMORY)), ('memory.swap.max', '0'), ('pids.max', '128')]:
        need(container_bounds[filename]==expected, 'NS_CONTAINER_BOUND')
    cpu = (cg/'cpu.max').read_text().strip().split(); need(len(cpu) == 2 and cpu[0].isdigit() and cpu[1].isdigit() and int(cpu[0]) == int(cpu[1]), 'NS_CONTAINER_CPU')
    mapper = storage['mapper']; device = str(mapper['device']) + ':' + str(mapper['minor'])
    def mount(pid, target, root, no_children=True):
        rows = mountinfo_records(Path('/proc/'+str(pid)+'/mountinfo').read_text())
        match = [v for v in rows if v['target'] == target]
        need(len(match) == 1 and match[0]['device'] == device and match[0]['source'] == p['mapperPath']
             and match[0]['root'] == root and match[0]['fstype'] == 'ext4' and not match[0]['optional']
             and {'rw','nosuid','nodev','noexec'} <= set(match[0]['options'])
             and (not no_children or not any(v['target'].startswith(target+'/') for v in rows)), 'NS_KERNEL_MOUNT')
        return match[0]
    broker = isolation['admission']['supervisor']['process']; daemon = isolation['process']; source = isolation['admission']['sourceDaemon']
    need(os.stat('/proc/self/ns/mnt').st_ino == broker['mountNamespace'] == daemon['mountNamespace']
         and container['mountNamespace'] not in (broker['mountNamespace'], source['mountNamespace']), 'NS_KERNEL_NAMESPACE')
    source_mounts = mountinfo_records(Path('/proc/'+str(source['pid'])+'/mountinfo').read_text())
    need(not any(v['target'] == p['mount'] or v['target'].startswith(p['mount']+'/')
                 or v['source'] == p['mapperPath'] or v['device'] == device for v in source_mounts), 'NS_HOST_MOUNT_LEAK')
    managed = isolation['managed']
    need(len(managed['shims'])==1 and managed['shims'][0]['cmdline'][4]==row['Id'], 'NS_RESTORE_SHIM')
    container_members=[namespace_process(pid,root=False) for pid in namespace_members('/'+p['isolation']['slice']+'/docker-'+row['Id']+'.scope')]
    need(container in container_members and all(v['mountNamespace']==container['mountNamespace'] and v['cgroup']==container['cgroup'] for v in container_members), 'NS_CONTAINER_MEMBERS')
    alias = namespace_alias_attest(p, journal)
    alias['brokerMount'] = mount(broker['pid'], str(NS_ALIAS), '/', no_children=False)
    alias['daemonMount'] = mount(daemon['pid'], str(NS_ALIAS), '/', no_children=False)
    mask = namespace_mask_attest(p, journal)
    mask['brokerMount'] = mount(broker['pid'], '/run/containerd', '/.runtime/run-containerd')
    mask['daemonMount'] = mount(daemon['pid'], '/run/containerd', '/.runtime/run-containerd')
    runtime_mounts = namespace_runtime_mounts(p, journal, mountinfo_records(Path('/proc/'+str(daemon['pid'])+'/mountinfo').read_text()))
    net = runtime_mounts['network']
    need(net is not None and row['NetworkSettings']['SandboxKey'] == net['target'], 'NS_CONTAINER_NETWORK_BINDING')
    network_inode = int(net['root'][5:-1])
    need(namespace_network(container['pid']) == network_inode
         and network_inode not in (isolation['admission']['network']['sourceNamespace'], isolation['admission']['network']['supervisorNamespace']),
         'NS_CONTAINER_NETWORK_NAMESPACE')
    kernel = {'containerProcess': container, 'containerBounds':container_bounds, 'containerMembers':container_members, 'containerNetworkNamespace':network_inode, 'networkSandboxKey':row['NetworkSettings']['SandboxKey'], 'brokerMount': mount(broker['pid'], p['mount'], '/'),
              'daemonMount': mount(daemon['pid'], p['mount'], '/'),
              'containerMount': mount(container['pid'], '/var/lib/postgresql/data', '/pgdata')}
    projection = disk_container_projection(row); projection['Image'] = row['Image']
    projection['HostConfig'].update(CgroupParent=p['isolation']['slice'], CgroupnsMode='private')
    need(namespace_daemon_identity(p, op) == isolation and namespace_container_lookup(p, namespace_current_image_id(p, journal)) == row
         and namespace_process(container['pid'],root=False)==container
         and [namespace_process(v['pid'],root=False) for v in container_members]==container_members
         and namespace_network(container['pid']) == network_inode
         and namespace_runtime_mounts(p, journal, mountinfo_records(Path('/proc/'+str(daemon['pid'])+'/mountinfo').read_text())) == runtime_mounts,
         'NS_ATTESTATION_DRIFT')
    return {'storage': storage, 'alias': alias, 'mask': mask, 'runtimeMounts':runtime_mounts, 'isolation': isolation, 'kernel': kernel, 'container': projection,
            'image': {k:journal.find('IMAGE_LOADED')[k] for k in ['source','imported']}}


def namespace_daemon_absent(p, op, identity=None):
    need(not os.path.lexists(p['isolation']['socket']) and not os.path.lexists(p['isolation']['pidFile']), 'NS_DAEMON_STOP_UNPROVEN')
    unit=namespace_supervisor_identity(p,op)
    need(namespace_members(unit['unit']['ControlGroup'])==[unit['process']['pid']]
         and namespace_members('/'+p['isolation']['slice'])==[unit['process']['pid']], 'NS_DAEMON_CHILDREN_REMAIN')
    if identity is not None:
        for process in [identity['process'],identity['managed']['containerd'],*identity['managed']['shims']]:
            need(not Path('/proc/'+str(process['pid'])).exists(), 'NS_DAEMON_PID_REMAINS')


def namespace_daemon_quiescence(p, op, seconds=10):
    deadline=time.monotonic()+seconds
    while True:
        # The supervisor is a child subreaper. Reap only its exited adopted children;
        # never signal a guessed process, host daemon or another operation.
        while True:
            try:
                pid,_=os.waitpid(-1,os.WNOHANG)
                if pid==0:break
            except ChildProcessError:break
        try:
            namespace_daemon_absent(p,op)
            # Close the exit-between-reap-and-cgroup-read race. Only ECHILD is
            # terminal: a reaped PID or a still-live child requires another round.
            try:os.waitpid(-1,os.WNOHANG)
            except ChildProcessError:return
        except Stop as error:
            need(str(error) in ('NS_DAEMON_STOP_UNPROVEN','NS_DAEMON_CHILDREN_REMAIN'), 'NS_QUIESCENCE_DRIFT')
        need(time.monotonic()<deadline,'NS_DAEMON_QUIESCENCE_UNKNOWN')
        time.sleep(.2)


def namespace_daemon_exit(p, op, request, code):
    need(code==0,'NS_DAEMON_EXIT')
    namespace_daemon_quiescence(p,op)
    atomic_exclusive(namespace_control(p,'daemon-exit.json'),encoded({'schema':'PHUB_PRIVATE_DAEMON_EXIT_V1',
        'operationSha256':p['operationSha256'],'planSha256':digest(read_secure(Path(p['work'])/'disk-plan.json')),
        'process':request['process'],'exitCode':code}))


def namespace_daemon_stop(p, op, journal):
    if journal.find('DAEMON_START_INTENT') is None:
        namespace_daemon_absent(p,op); return
    if not namespace_control(p,'daemon-start.json').exists():
        # The held mutator flock means no parent may publish this request later.
        namespace_daemon_absent(p,op); journal.once('DAEMON_STOPPED', neverStarted=True); return
    if journal.find('DAEMON_STOPPED') is not None:
        namespace_daemon_absent(p,op); return
    previous=journal.find('DAEMON_STOP_INTENT')
    if previous is None:
        need(namespace_control(p,'daemon-receipt.json').exists(), 'NS_DAEMON_START_MANUAL_STOP')
        need(namespace_container_lookup(p, namespace_current_image_id(p, journal)) is None, 'NS_STOP_CONTAINER_PRESENT')
        identity=namespace_daemon_identity(p,op)
        need(not identity['managed']['shims'], 'NS_STOP_SHIM_PRESENT')
        journal.add('DAEMON_STOP_INTENT',identity=identity)
    else:identity=previous['identity']
    request={'schema':'PHUB_PRIVATE_DAEMON_STOP_V1','operationSha256':p['operationSha256'],
             'planSha256':digest(read_secure(Path(p['work'])/'disk-plan.json')),'process':identity['process']}
    path=namespace_control(p,'daemon-stop.json'); exitpath=namespace_control(p,'daemon-exit.json')
    if not path.exists():
        need(namespace_daemon_identity(p,op)==identity, 'NS_STOP_IDENTITY_DRIFT')
        atomic_exclusive(path,encoded(request))
    need(strict(read_secure(path))==request, 'NS_STOP_REQUEST_DRIFT')
    namespace_wait(exitpath,lambda v: v.get('operationSha256')==p['operationSha256'],55)
    result=namespace_control_value(p,'daemon-exit.json','PHUB_PRIVATE_DAEMON_EXIT_V1',['process','exitCode'])
    need(result['process']==identity['process'] and result['exitCode']==0, 'NS_DAEMON_EXIT')
    namespace_daemon_absent(p,op,identity); journal.once('DAEMON_STOPPED',identity=identity)


def namespace_release(p, op, journal):
    if journal.find('NAMESPACE_SLICE_START_INTENT') is None:return
    need(journal.find('NAMESPACE_STORAGE_CLEANED') is not None and
         (journal.find('DAEMON_START_INTENT') is None or journal.find('DAEMON_STOPPED') is not None), 'NS_RELEASE_PREREQUISITES')
    need(not os.path.lexists(p['image']) and not os.path.lexists(p['mount']) and not os.path.lexists(p['mapperPath']), 'NS_RELEASE_STORAGE')
    source=namespace_frozen_source(p)
    need(os.stat('/proc/self/ns/mnt').st_ino==source['mountNamespace'], 'NS_RELEASE_CALLER')
    if journal.find('NAMESPACE_UNIT_START_INTENT') is not None and journal.find('NAMESPACE_RELEASED') is None:
        previous=journal.find('NAMESPACE_RELEASE_INTENT')
        if previous is None:
            admission=namespace_admission(p,op)
            need(namespace_members('/'+p['isolation']['slice'])==[admission['supervisor']['process']['pid']], 'NS_RELEASE_MEMBERS')
            journal.add('NAMESPACE_RELEASE_INTENT',receipt=admission)
        else:admission=previous['receipt']
        value=namespace_unit(p)
        if value['ActiveState']=='active':
            need(namespace_admission(p,op)==admission, 'NS_RELEASE_DRIFT')
            command(['/usr/bin/systemctl','stop',p['isolation']['unit']], 'NS_UNIT_STOP',timeout=45)
            value=namespace_unit(p)
        need(value['ActiveState'] in ('inactive','failed') and value['LoadState']=='not-found'
             and value['MainPID']=='0' and not Path('/proc/'+str(admission['supervisor']['process']['pid'])).exists()
             and not Path(admission['supervisor']['bounds']['path']).exists(), 'NS_RELEASE_UNPROVEN')
        journal.once('NAMESPACE_RELEASED')
    need(not namespace_members('/'+p['isolation']['slice']), 'NS_SLICE_NOT_EMPTY')
    if journal.find('NAMESPACE_SLICE_RELEASED') is None:
        current=namespace_show(p['isolation']['slice'],NS_SLICE_KEYS)
        if journal.find('NAMESPACE_SLICE_RELEASE_INTENT') is None:
            need(namespace_slice(p)==journal.find('NAMESPACE_SLICE_READY')['identity'], 'NS_SLICE_RELEASE_DRIFT')
            journal.add('NAMESPACE_SLICE_RELEASE_INTENT')
        if current['ActiveState']=='active':
            need(namespace_slice(p)==journal.find('NAMESPACE_SLICE_READY')['identity'], 'NS_SLICE_RELEASE_DRIFT')
            command(['/usr/bin/systemctl','stop',p['isolation']['slice']], 'NS_SLICE_STOP',timeout=30)
        namespace_slice_terminal(p, journal)
        journal.once('NAMESPACE_SLICE_RELEASED')


NS_TERMINAL_SLICE_KEYS = NS_SLICE_KEYS + ['SubState', 'FragmentPath', 'SourcePath',
    'DropInPaths', 'UnitFileState', 'Job', 'InvocationID']


def namespace_slice_terminal_properties(value):
    # show/LoadUnit may synthesize an implicit default .slice after transient removal.
    need(isinstance(value, dict) and set(value) == set(NS_TERMINAL_SLICE_KEYS), 'NS_SLICE_TERMINAL_FIELDS')
    expected = {'LoadState': value['LoadState'], 'ActiveState': 'inactive', 'SubState': 'dead',
        'ControlGroup': '', 'Transient': 'no', 'MemoryMax': 'infinity', 'MemorySwapMax': 'infinity',
        'TasksMax': 'infinity', 'CPUQuotaPerSecUSec': 'infinity', 'FragmentPath': '',
        'SourcePath': '', 'DropInPaths': '', 'UnitFileState': '', 'Job': '', 'InvocationID': ''}
    need(value['LoadState'] in ('not-found', 'loaded') and value == expected, 'NS_SLICE_RELEASE_UNPROVEN')
    return value


def namespace_slice_terminal(p, journal):
    need(journal.find('NAMESPACE_SLICE_READY') is not None
         and journal.find('NAMESPACE_SLICE_RELEASE_INTENT') is not None
         and journal.find('NAMESPACE_STORAGE_CLEANED') is not None
         and (journal.find('NAMESPACE_UNIT_START_INTENT') is None
              or journal.find('NAMESPACE_RELEASED') is not None), 'NS_SLICE_TERMINAL_PREREQUISITES')
    name = p['isolation']['slice']
    namespace_require_no_unit_file(name)
    value = namespace_slice_terminal_properties(namespace_show(name, NS_TERMINAL_SLICE_KEYS))
    need(not os.path.lexists('/sys/fs/cgroup/' + name) and not namespace_members('/' + name),
         'NS_SLICE_RELEASE_UNPROVEN')
    return value


def namespace_startup_drain(stream, captured=None):
    for _ in range(16):
        try:chunk = os.read(stream.fileno(), 8192)
        except BlockingIOError:return
        if not chunk:return
        if captured is not None and len(captured) < 65536:captured.extend(chunk[:65536-len(captured)])


def namespace_startup_error(p, code, exit_code, captured):
    need(code in ('NS_DAEMON_START_EXIT','NS_DAEMON_START_UNKNOWN') and (exit_code is None or type(exit_code) is int), 'NS_STARTUP_ERROR')
    value={'schema':'PHUB_PRIVATE_DAEMON_STARTUP_ERROR_V1','operationSha256':p['operationSha256'],
           'code':code,'exitCode':exit_code,'stderrByteCount':len(captured),'truncated':len(captured)==65536,
           'stderrSha256':digest(bytes(captured))}
    atomic_exclusive(namespace_control(p,'daemon-startup-error.json'),encoded(value))


def namespace_supervisor_loop(op, raw, p):
    """PID1-owned actor. Only fixed daemon start/stop, never source DB or DiskJournal."""
    import ctypes
    libc=ctypes.CDLL(None,use_errno=True); subreaper=ctypes.c_int()
    need(libc.prctl(36,1,0,0,0)==0 and libc.prctl(37,ctypes.byref(subreaper),0,0,0)==0 and subreaper.value==1, 'NS_SUBREAPER')
    source = namespace_frozen_source(p)
    namespace_supervisor_identity(p, op)
    need(os.stat('/proc/self/ns/mnt').st_ino == source['mountNamespace'], 'NS_SUPERVISOR_INITIAL_NAMESPACE')
    namespace_syscall('unshare'); disk_tool('mount', ['--make-rprivate', '/'], 'NS_PRIVATE_ROOT')
    disk_private_parent(p)
    identity = namespace_supervisor_identity(p, op)
    need(identity['process']['pid'] == os.getpid() and identity['process']['mountNamespace'] != source['mountNamespace'], 'NS_SUPERVISOR_IDENTITY')
    network = {'sourceNamespace': namespace_network(source['pid']), 'supervisorNamespace': namespace_network(os.getpid())}
    need(network['sourceNamespace'] != network['supervisorNamespace'], 'NS_SUPERVISOR_NETWORK')
    receipt = {'schema': 'PHUB_TIMEWEB_PRIVATE_NAMESPACE_RECEIPT_V1', 'operationSha256': p['operationSha256'],
               'toolFileSha256': op['toolFileSha256'], 'sourceDaemon': source, 'supervisor': identity, 'network': network}
    atomic_exclusive(namespace_control(p, 'namespace-receipt.json'), encoded(receipt))
    daemon = None; stopped = False; daemon_stderr = None
    # No inherited stdio/flock, restart, parent-death signal or automatic recovery.
    while True:
        need(read_secure(REQUEST)==raw and namespace_supervisor_identity(p,op)==identity, 'NS_SUPERVISOR_DRIFT')
        tool_custody(op); namespace_validate_plan(op,raw,strict(read_secure(Path(p['work'])/'disk-plan.json')))
        namespace_frozen_source(p)
        start = namespace_control(p, 'daemon-start.json')
        if start.exists() and daemon is None:
            need(strict(read_secure(start)) == {'schema': 'PHUB_PRIVATE_DAEMON_START_V1', 'operationSha256': p['operationSha256'],
                'planSha256': digest(read_secure(Path(p['work'])/'disk-plan.json')),
                'configSha256': digest(read_secure(namespace_control(p, 'daemon.json')))}, 'NS_START_REQUEST')
            need(strict(read_secure(namespace_control(p, 'daemon.json'))) == namespace_config(p), 'NS_DAEMON_CONFIG')
            for path in [p['isolation']['dataRoot'], p['isolation']['execRoot']]:secure(path, 'dir', 0o700)
            disk_storage_attest(p, DiskJournal(p['work'], p['operationSha256']))
            daemon = subprocess.Popen(['/usr/bin/dockerd', '--config-file', p['isolation']['configFile']],
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, env=ENV,
                cwd=namespace_client_cwd(p), close_fds=True)
            daemon_stderr = daemon.stderr; os.set_blocking(daemon_stderr.fileno(), False); startup_stderr = bytearray()
            deadline = time.monotonic() + 45
            while True:
                namespace_startup_drain(daemon_stderr, startup_stderr)
                if daemon.poll() is not None or time.monotonic() >= deadline:
                    namespace_startup_drain(daemon_stderr, startup_stderr)
                    code = 'NS_DAEMON_START_EXIT' if daemon.poll() is not None else 'NS_DAEMON_START_UNKNOWN'
                    namespace_startup_error(p, code, daemon.poll(), startup_stderr)
                    raise Stop(code)
                try:
                    ready=namespace_daemon_identity(p,op); break
                except (Stop,FileNotFoundError):time.sleep(.2)
            process = namespace_process(daemon.pid)
            need(process['cmdline'] == ['/usr/bin/dockerd', '--config-file', p['isolation']['configFile']], 'NS_DAEMON_CHILD')
            atomic_exclusive(namespace_control(p, 'daemon-receipt.json'), encoded({'schema':'PHUB_PRIVATE_DAEMON_RECEIPT_V1','operationSha256':p['operationSha256'],
                    'planSha256':digest(read_secure(Path(p['work'])/'disk-plan.json')), 'identity':ready}))
        stop = namespace_control(p, 'daemon-stop.json')
        if daemon is not None and not stopped:
            namespace_startup_drain(daemon_stderr)
            need(daemon.poll() is None, 'NS_DAEMON_DISAPPEARED')
            if stop.exists():
                request=namespace_control_value(p,'daemon-stop.json','PHUB_PRIVATE_DAEMON_STOP_V1',['process'])
                need(request['operationSha256'] == p['operationSha256'] and request['process'] == namespace_process(daemon.pid), 'NS_STOP_CHILD_DRIFT')
                disk_storage_attest(p,DiskJournal(p['work'],p['operationSha256']))
                need(read_secure(REQUEST)==raw and namespace_supervisor_identity(p,op)==identity, 'NS_STOP_CUSTODY')
                daemon.terminate(); code=daemon.wait(timeout=35)
                namespace_daemon_exit(p,op,request,code);stopped=True
        time.sleep(.2)

def namespace_supervisor(op, raw, p):
    try:
        namespace_supervisor_loop(op,raw,p)
    except Exception as error:
        code=str(error) if isinstance(error,Stop) and re.fullmatch(r'[A-Z0-9_]+',str(error)) else 'NS_SUPERVISOR_UNKNOWN'
        receipt={'schema':'PHUB_PRIVATE_SUPERVISOR_TERMINAL_V1','operationSha256':p['operationSha256'],
                 'planSha256':digest(read_secure(Path(p['work'])/'disk-plan.json')),'phase':'MANUAL_STOP','code':code}
        atomic_exclusive(namespace_control(p,'supervisor-terminal.json'),encoded(receipt))
        raise


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
    if value['schema'] in ('PHUB_TIMEWEB_BACKUP_OPERATION_V1', DISK_PRE_SCHEMA, NS_PRE_SCHEMA):
        return 'web', value['releaseId']
    if value['schema'] in ('PHUB_TIMEWEB_BACKUP_OPERATION_API_WORKER_V2', DISK_POST_SCHEMA, NS_POST_SCHEMA):
        return 'api-worker', value['candidateReleaseId']
    raise Stop('TARGET')



def validate_controller_promotion(value, op):
    fields = ['schema', 'controllerSha', 'controllerTree', 'prNumber', 'headBranch',
              'baseSha', 'prCiRunId', 'mergeSha', 'mergeTree', 'mainCiRunId',
              'executableManifestSha256', 'resolutionManifestSha256', 'sha256']
    exact(value, fields)
    need(type(value['schema']) is int and value['schema'] == 1
         and type(value['prNumber']) is int and 1 <= value['prNumber'] <= 9007199254740991
         and isinstance(value['headBranch'], str)
         and re.fullmatch(r'codex/[a-z0-9][a-z0-9/_-]{0,199}', value['headBranch'])
         and '..' not in value['headBranch'] and not value['headBranch'].endswith('/'),
         'CONTROLLER_PROMOTION_IDENTITY')
    need(all(isinstance(value[k], str) and SHA.fullmatch(value[k])
             for k in ['controllerSha', 'controllerTree', 'baseSha', 'mergeSha', 'mergeTree'])
         and all(isinstance(value[k], str) and re.fullmatch(r'[1-9][0-9]*', value[k])
                 for k in ['prCiRunId', 'mainCiRunId'])
         and value['prCiRunId'] != value['mainCiRunId']
         and all(isinstance(value[k], str) and HASH.fullmatch(value[k])
                 for k in ['executableManifestSha256', 'resolutionManifestSha256', 'sha256']),
         'CONTROLLER_PROMOTION_IDENTITY')
    canonical = {k: value[k] for k in sorted(value) if k != 'sha256'}
    need(value['sha256'] == digest(encoded(canonical)), 'CONTROLLER_PROMOTION_DIGEST')
    need(value['controllerSha'] == op['controllerSha'] and value['controllerTree'] == op['controllerTree']
         and value['prCiRunId'] == op['controllerSourceCiRunId'], 'CONTROLLER_PROMOTION_BINDING')
    return value


def promotion_expected(op):
    return {'controllerPromotionSha256': op['controllerPromotion']['sha256']} if 'controllerPromotion' in op else {}


def validate_operation(value, now, file_sha, allow_expired=False):
    common = ['schema', 'target', 'toolCommit', 'toolFileSha256', 'controllerSha',
              'toolProofSha256', 'toolInstallationSha256', 'controllerTree',
              'controllerConfigSha256', 'expectedBoundarySha256', 'expectedApi',
              'expectedPostgres', 'expiresAt', 'confirmation']
    schema = value.get('schema') if isinstance(value, dict) else None
    if isinstance(value, dict) and 'controllerPromotion' in value:
        need(schema != 'PHUB_TIMEWEB_BACKUP_OPERATION_V1', 'CONTROLLER_PROMOTION_SCHEMA')
        common += ['controllerPromotion']
    if schema == 'PHUB_TIMEWEB_BACKUP_OPERATION_V1':
        exact(value, common + ['releaseId'])
        mode = 'web'
        release_id = value['releaseId']
    elif schema in (DISK_PRE_SCHEMA, NS_PRE_SCHEMA):
        exact(value, common + ['releaseId', 'controllerSourceCiRunId', 'expectedLedgerSha256'])
        mode = 'web'
        release_id = value['releaseId']
        need(re.fullmatch(r'[1-9][0-9]*', value['controllerSourceCiRunId'] or '')
             and release_id == value['controllerSha'] + '-' + value['controllerSourceCiRunId'] + '-1'
             and value['expectedLedgerSha256'] == API_WORKER_PRE_LEDGER_SHA256
             and value['toolCommit'] == value['controllerSha'], 'DISK_PRE99_OPERATION')
    elif schema in ('PHUB_TIMEWEB_BACKUP_OPERATION_API_WORKER_V2', DISK_POST_SCHEMA, NS_POST_SCHEMA):
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
    if 'controllerPromotion' in value:
        validate_controller_promotion(value['controllerPromotion'], value)
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
    expires = utc(value['expiresAt'])
    need(allow_expired or 1200 <= expires - now <= 3600, 'EXPIRY')
    confirmation = ('BACKUP_RESTORE_' + match[1][:12].upper() + '_KEEP_API_0D6078BE7A50'
                    if mode == 'web' else
                    'BACKUP_RESTORE_API_WORKER_11954FFD6D7B_KEEP_API_0D6078BE7A50')
    if schema == DISK_PRE_SCHEMA:
        confirmation = 'BACKUP_RESTORE_PRE99_DISK_LUKS2_KEEP_API_0D6078BE7A50'
    elif schema == DISK_POST_SCHEMA:
        confirmation = 'BACKUP_RESTORE_API_WORKER_DISK_LUKS2_11954FFD6D7B_KEEP_API_0D6078BE7A50'
    if schema == NS_PRE_SCHEMA:
        confirmation = 'BACKUP_RESTORE_PRE99_PRIVATE_NAMESPACE_ISOLATED_DOCKERD_KEEP_API_0D6078BE7A50'
    elif schema == NS_POST_SCHEMA:
        confirmation = 'BACKUP_RESTORE_API_WORKER_PRIVATE_NAMESPACE_ISOLATED_DOCKERD_11954FFD6D7B_KEEP_API_0D6078BE7A50'
    need(value['confirmation'] == confirmation, 'CONFIRMATION')
    return value


def validate_migration_controller_delta(data):
    rows=[v for v in data.split(b'\0') if v]
    need(rows and len(rows)%2==0, 'CONTROLLER_LINEAGE')
    parsed=[];seen=set()
    for index in range(0,len(rows),2):
        match=re.fullmatch(rb':([0-7]{6}) ([0-7]{6}) ([a-f0-9]{40}) ([a-f0-9]{40}) ([AM])',rows[index])
        path=os.fsdecode(rows[index+1]);need(match and path not in seen,'CONTROLLER_LINEAGE');seen.add(path)
        parsed.append(dict(path=path,oldMode=match.group(1).decode(),newMode=match.group(2).decode(),oldOid=match.group(3).decode(),newOid=match.group(4).decode(),status=match.group(5).decode()))
    for pins,code in [(API_WORKER_CONTROLLER_PROMOTION_PATCH,'CONTROLLER_PROMOTION_PATCH'),
                      (API_WORKER_ANDROID_CHAT_TEST_PATCH,'ANDROID_CHAT_TEST_PATCH'),
                      (API_WORKER_REHEARSAL_READINESS_PATCH,'REHEARSAL_READINESS_PATCH'),
                      (API_WORKER_NATIVE_BOOKINGS_PATCH,'NATIVE_BOOKINGS_PATCH')]:
        group=[v for v in parsed if v['path'] in pins]
        if group:
            need(len(group)==len(pins) and all(v==pins[v['path']] for v in group),code)
        parsed=[v for v in parsed if v['path'] not in pins]
    pins={**API_WORKER_CI_DOWNLOAD_PATCH,**API_WORKER_CI_READER_PATCH}
    ci=[v for v in parsed if v['path'] in pins]
    if ci:
        need(len(ci)==len(pins) and {v['path']for v in ci}==set(pins),'CI_DOWNLOAD_PATCH')
        need(all(v==pins[v['path']] for v in ci),'CI_DOWNLOAD_PATCH')
    for v in parsed:
        if v['path'] in pins:continue
        need(v['path'] in API_WORKER_MIGRATION_CONTROLLER_FILES and v['newMode']=='100644'
             and v['oldMode']==('000000'if v['status']=='A'else '100644') and v['newOid']!='0'*40
             and (v['status']!='A' or v['oldOid']=='0'*40),'CONTROLLER_LINEAGE')


def v2_migration_proof(op, request_bytes, source, restore=None):
    """Bind a post-0097 backup to a reconciled immutable migration proof before any dump."""
    if op['schema'] not in ('PHUB_TIMEWEB_BACKUP_OPERATION_API_WORKER_V2', DISK_POST_SCHEMA, NS_POST_SCHEMA):
        return
    prefix=['/usr/bin/git','-C',str(source),'-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false']
    need(command(prefix+['rev-parse',MIGRATION_BASE_SHA+'^{tree}'], 'CONTROLLER_LINEAGE').decode().strip()==MIGRATION_BASE_TREE, 'CONTROLLER_LINEAGE')
    command(prefix+['merge-base','--is-ancestor',MIGRATION_BASE_SHA,op['controllerSha']], 'CONTROLLER_LINEAGE')
    raw=command(prefix+['diff','--no-renames','--raw','--abbrev=40','-z',MIGRATION_BASE_SHA,op['controllerSha']], 'CONTROLLER_LINEAGE')
    validate_migration_controller_delta(raw)
    expected={'controllerSha':op['controllerSha'],'controllerTree':op['controllerTree'],
              'controllerSourceCiRunId':op['controllerSourceCiRunId'],'candidateReleaseId':op['candidateReleaseId'],
              'migrationPlanSha256':op['migrationPlanSha256'],'migrationSuccessSha256':op['migrationSuccessSha256'],
              **promotion_expected(op)}
    if restore is not None:
        if op['schema'] in (DISK_POST_SCHEMA, NS_POST_SCHEMA):
            exact(restore, ['schema', 'storageProofSha256'])
            need(restore['schema'] == ('PHUB_TIMEWEB_DISK_RESTORE_EXCLUSION_V2' if is_namespace_operation(op) else 'PHUB_TIMEWEB_DISK_RESTORE_EXCLUSION_V1')
                 and HASH.fullmatch(restore['storageProofSha256'] or ''), 'MIGRATION_DISK_RESTORE')
        else:
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


def atomic_exclusive(path, data):
    # A partial temporary inode is private incident evidence, never a committed journal event.
    # Do not automatically delete unknown/uncommitted files during reconciliation.
    import uuid
    path = Path(path)
    temporary = path.parent / ('.disk-write-' + uuid.uuid4().hex + '.tmp')
    exclusive(temporary, data)
    rename_noreplace(temporary, path)
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


def command(args, code, stdin=None, input_data=None, stdout=subprocess.PIPE, timeout=120, file_limit=None, environment=ENV, cwd=None):
    need(not (stdin is not None and input_data is not None) and (input_data is None or isinstance(input_data,bytes)), 'COMMAND_INPUT')
    if file_limit is not None:
        need(type(file_limit) is int and 0 < file_limit <= MAX_DUMP, 'DUMP_LIMIT')
    def limit_output():
        resource.setrlimit(resource.RLIMIT_FSIZE,(file_limit,file_limit))
    try:
        result = subprocess.run(args, stdin=stdin, input=input_data, stdout=stdout, stderr=subprocess.DEVNULL,
                                env=environment, cwd=cwd, timeout=timeout, check=False, preexec_fn=limit_output if file_limit else None)
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


def restore_image_admitted(image):
    # Docker Engine shortens official docker.io/library names in RepoDigests.
    # Accept only these two names for the same frozen digest, never tags or another registry.
    digests = image.get('RepoDigests')
    return (image.get('Os') == 'linux' and image.get('Architecture') == 'amd64'
            and isinstance(digests, list)
            and any(value in (PG_IMAGE, PG_IMAGE.removeprefix('docker.io/library/')) for value in digests))


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


def execute_tmpfs(op, request_bytes, file_sha):
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
    need(restore_image_admitted(image), 'RESTORE_IMAGE')
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


def disk_context(op, request_bytes, plan, journal, allow_expired=False):
    """Reattest the frozen source/runtime and owned lock. Never mutates the source database."""
    sha, work = plan['operationSha256'], Path(plan['work'])
    need(read_secure(work / 'backup-operation.json') == request_bytes
         and strict(read_secure(work / 'disk-plan.json')) == plan, 'DISK_CAPSULE_DRIFT')
    source = ROOT / 'standard/source'
    config_path = Path('/etc/phub/timeweb-beta-standard-delivery.json')
    installation = tool_custody(op)
    config = read_secure(config_path)
    need(digest(config) == op['controllerConfigSha256']
         and strict(config).get('controllerSha') == op['controllerSha']
         and strict(config).get('enabled') is True, 'CONTROLLER')
    prefix = ['/usr/bin/git', '-C', str(source), '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false']
    def source_guard():
        secure(source, 'dir'); secure(source / '.git', 'dir')
        need(command(prefix + ['rev-parse', 'HEAD'], 'CONTROLLER').decode().strip() == op['controllerSha']
             and command(prefix + ['rev-parse', 'HEAD^{tree}'], 'CONTROLLER').decode().strip() == op['controllerTree']
             and not command(prefix + ['status', '--porcelain', '--untracked-files=all'], 'CONTROLLER').strip(), 'CONTROLLER_DRIFT')
        for path in command(prefix + ['ls-files', '-z'], 'CONTROLLER').split(b'\0'):
            if path:
                relative = Path(os.fsdecode(path))
                need(not relative.is_absolute() and '..' not in relative.parts, 'CONTROLLER_PATH')
                secure(source / relative)
    source_guard()
    boundary = strict(read_secure(work / 'boundary.json'))
    need(boundary == {'sha256': op['expectedBoundarySha256']}, 'BASELINE_BOUNDARY')
    marker = journal.find('LOCK_PREPARED')
    def owned_lock(optional=False):
        need(marker is not None, 'DISK_LOCK_UNPROVEN')
        if not os.path.lexists(LOCK):
            need(optional and journal.find('UNLOCK_INTENT') is not None, 'DISK_LOCK_MISSING')
            return False
        need(same_storage(secure(LOCK, 'dir', 0o700), marker['identity']), 'DISK_LOCK_DRIFT')
        entries = sorted(p.name for p in LOCK.iterdir())
        if entries == []:
            need(journal.find('UNLOCK_INTENT') is not None
                 and journal.find('STORAGE_CLEANUP_VERIFIED') is not None
                 and (journal.find('PUBLISHED') is not None or journal.find('ABORTED') is not None), 'DISK_LOCK_DRIFT')
        else:
            need(entries == ['backup-restore.json']
                 and read_secure(LOCK / 'backup-restore.json') == encoded(marker['marker']), 'DISK_LOCK_DRIFT')
        return True
    def guard(restore=None, cleanup=False, optional_lock=False):
        if is_namespace_operation(op):namespace_frozen_source(plan)
        if not allow_expired:
            need(time.time() < utc(op['expiresAt']), 'EXPIRED_OPERATION')
        source_guard(); owned_lock(optional_lock)
        need(read_secure(REQUEST) == request_bytes and read_secure(config_path) == config
             and tool_custody(op) == installation, 'INPUT_DRIFT')
        need(service('phub-timeweb-beta', 'api') == op['expectedApi']
             and service('phub-timeweb-beta-dependencies', 'postgres') == op['expectedPostgres'], 'RUNTIME_DRIFT')
        need(not docker(['ps', '-q', '--no-trunc', '--filter', 'label=com.docker.compose.service=migrator']).strip(), 'ACTIVE_MIGRATOR')
        # Exclusion follows exact containment/custody verification, never a caller-selected ID.
        ignored = None
        if restore is not None:
            row = namespace_container_lookup(plan, namespace_current_image_id(plan, journal)) if is_namespace_operation(op) else disk_container_lookup(plan)
            need(row is not None and row['Id'] == restore, 'DISK_RESTORE_ID_DRIFT')
            if not cleanup:
                proof = namespace_running_attestation(plan, op, journal) if is_namespace_operation(op) else disk_running_attestation(plan, journal)
                need(proof == strict(read_secure(work / 'restore-storage-proof.json'))['readback'], 'DISK_STORAGE_PROOF_DRIFT')
            ignored = None if is_namespace_operation(op) else row['Id']
        rows = []
        ids = docker(['ps', '-aq', '--no-trunc']).decode().split()
        need(len(ids) == len(set(ids)) and all(HASH.fullmatch(v) for v in ids), 'CONTAINER_ID')
        for container in sorted(ids):
            if container != ignored:
                row = strict(docker(['inspect', '--format', INSPECT_FORMAT, container]))
                need(row['Id'] == container, 'CONTAINER_ID')
                rows.append(row)
        need(digest(encoded(rows)) == boundary['sha256'], 'CONTAINER_BOUNDARY_DRIFT')
        if not cleanup or ignored is None:
            ref = None
            if ignored is not None or (is_namespace_operation(op) and restore is not None and not cleanup):
                ref = {'schema': 'PHUB_TIMEWEB_DISK_RESTORE_EXCLUSION_V2' if is_namespace_operation(op) else 'PHUB_TIMEWEB_DISK_RESTORE_EXCLUSION_V1',
                       'storageProofSha256': digest(read_secure(work / 'restore-storage-proof.json'))}
            attestation = v2_migration_proof(op, request_bytes, source, ref)
            initial = journal.find('MIGRATION_ATTESTATION')
            if initial is not None:
                need(initial['proof'] == attestation, 'MIGRATION_ATTESTATION_DRIFT')
        need(digest(ledger_bytes(source_query(SOURCE_LEDGER))) == plan['expectedLedgerSha256'], 'SOURCE_LEDGER_DRIFT')
    return guard, owned_lock


def disk_initialize(op, request_bytes, file_sha):
    disk_prerequisites()
    mode, release = operation_mode(op)
    canonical = ROOT / 'backups' / (release + '-' + mode)
    work = ROOT / 'backups' / ('.disk-restore-' + digest(request_bytes))
    need(not os.path.lexists(LOCK) and not os.path.lexists(work) and not os.path.lexists(canonical), 'EXISTING_STATE')
    for path in [ROOT, ROOT / 'standard', ROOT / 'operator', ROOT / 'backups']:
        secure(path, 'dir')
    tool_custody(op)
    need(service('phub-timeweb-beta', 'api') == op['expectedApi']
         and service('phub-timeweb-beta-dependencies', 'postgres') == op['expectedPostgres'], 'RUNTIME_DRIFT')
    need(not docker(['ps', '-q', '--no-trunc', '--filter', 'label=com.docker.compose.service=migrator']).strip(), 'ACTIVE_MIGRATOR')
    boundary = []
    ids = docker(['ps', '-aq', '--no-trunc']).decode().split()
    need(len(ids) == len(set(ids)) and all(HASH.fullmatch(v) for v in ids), 'CONTAINER_ID')
    for container in sorted(ids):
        row = strict(docker(['inspect', '--format', INSPECT_FORMAT, container]))
        need(row['Id'] == container, 'CONTAINER_ID')
        boundary.append(row)
    need(digest(encoded(boundary)) == op['expectedBoundarySha256'], 'BASELINE_BOUNDARY')
    ledger = ledger_bytes(source_query(SOURCE_LEDGER))
    need(digest(ledger) == disk_ledger_sha(op), 'DISK_LEDGER')
    raw_size = source_query(SOURCE_SIZE).decode().strip()
    need(re.fullmatch(r'[1-9][0-9]*', raw_size), 'DATABASE_SIZE')
    sizing = disk_sizing(int(raw_size), disk_memory_available(), disk_free())
    plan = disk_plan(op, request_bytes, sizing)
    disk_private_parent(plan)
    daemon = disk_daemon_namespace()
    need(not os.path.lexists(plan['pendingLock']), 'DISK_PENDING_LOCK_EXISTS')
    image = strict(docker(['image', 'inspect', '--format', '{"Os":{{json .Os}},"Architecture":{{json .Architecture}},"RepoDigests":{{json .RepoDigests}}}', PG_IMAGE]))
    need(restore_image_admitted(image), 'RESTORE_IMAGE')
    work.mkdir(mode=0o700); sync_directory(work.parent)
    atomic_exclusive(work / 'backup-operation.json', request_bytes)
    atomic_exclusive(work / 'disk-plan.json', encoded(plan))
    atomic_exclusive(work / 'boundary.json', encoded({'sha256': op['expectedBoundarySha256']}))
    journal = DiskJournal(work, plan['operationSha256'])
    journal.add('PREPARED')
    journal.add('DAEMON_NAMESPACE', **daemon)
    attestation = v2_migration_proof(op, request_bytes, ROOT / 'standard/source')
    journal.add('MIGRATION_ATTESTATION', proof=attestation)
    pending = Path(plan['pendingLock'])
    pending.mkdir(mode=0o700); sync_directory(pending.parent)
    marker = {'schema': 'PHUB_TIMEWEB_BACKUP_LOCK_V1', 'operationSha256': plan['operationSha256'],
              'toolFileSha256': file_sha, 'transaction': str(work), 'createdAt': now_iso()}
    atomic_exclusive(pending / 'backup-restore.json', encoded(marker))
    journal.add('LOCK_PREPARED', identity=storage_identity(secure(pending, 'dir', 0o700)), marker=marker)
    journal.add('LOCK_PUBLISH_INTENT')
    rename_noreplace(pending, LOCK)
    journal.add('LOCKED')
    guard, _ = disk_context(op, request_bytes, plan, journal)
    guard()
    return plan, journal, guard


def disk_create_storage(plan, journal, guard):
    work = Path(plan['work'])
    if plan['schema'] == 'PHUB_TIMEWEB_DISK_RESTORE_PLAN_V2':
        namespace_sizing(plan['databaseBytes'], disk_memory_available(), disk_free(), plan['isolation']['image'], after_dump=True)
    else:
        disk_sizing(plan['databaseBytes'], disk_memory_available(), disk_free(), after_dump=True)
    guard(); disk_private_parent(plan)
    journal.add('IMAGE_CREATE_INTENT')
    fd = os.open(plan['image'], os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        os.fsync(fd); sync_directory(work)
        journal.add('IMAGE_CREATED', identity=storage_identity(os.fstat(fd)))
        journal.add('IMAGE_ALLOCATE_INTENT')
        os.posix_fallocate(fd, 0, plan['imageBytes'])
        os.fsync(fd)
    finally:
        os.close(fd)
    disk_image(plan, journal)
    journal.add('IMAGE_ALLOCATED')
    guard(); need(disk_free() >= DISK_HEADROOM, 'DISK_RESERVE')
    journal.add('LOOP_ATTACH_INTENT')
    loop = disk_tool('loop', ['--find', '--show', '--nooverlap', '--offset', '0', '--sizelimit', str(plan['imageBytes']), plan['image']], 'DISK_LOOP_ATTACH').decode().strip()
    need(disk_loop(plan, disk_image(plan, journal)) == loop, 'DISK_LOOP_CUSTODY')
    journal.add('LOOP_ATTACHED', loop=loop)
    key = os.urandom(64)
    try:
        journal.add('LUKS_FORMAT_INTENT')
        disk_tool('crypt', ['luksFormat', '--type', 'luks2', '--batch-mode', '--uuid', plan['luksUuid'],
                          '--cipher', 'aes-xts-plain64', '--key-size', '512', '--pbkdf', 'pbkdf2',
                          '--pbkdf-force-iterations', '1000', '--key-file', '-', loop], 'DISK_LUKS_FORMAT', input_data=key)
        need(disk_tool('crypt', ['luksUUID', loop], 'DISK_LUKS_UUID').decode().strip() == plan['luksUuid'], 'DISK_LUKS_UUID')
        journal.add('LUKS_FORMATTED')
        journal.add('MAPPER_OPEN_INTENT')
        disk_tool('crypt', ['open', '--type', 'luks2', '--key-file', '-', loop, plan['mapperName']], 'DISK_MAPPER_OPEN', input_data=key)
    finally:
        # No claim of Python memory zeroization; process memory/stdin are the only key custody.
        del key
    mapper = disk_mapper(plan, loop)
    journal.add('MAPPER_OPENED', identity=mapper)
    journal.add('FS_FORMAT_INTENT')
    env = {**ENV, 'MKE2FS_CONFIG': '/dev/null'}
    disk_tool('mkfs', ['-t', 'ext4', '-F', '-q', '-b', '4096', '-m', '0', '-U', plan['filesystemUuid'],
                       '-E', 'lazy_itable_init=0,lazy_journal_init=0', plan['mapperPath']], 'DISK_FS_FORMAT', environment=env)
    need(disk_tool('blkid', ['--probe', '--match-tag', 'UUID', '--output', 'value', plan['mapperPath']], 'DISK_FILESYSTEM_UUID').decode().strip() == plan['filesystemUuid'], 'DISK_FILESYSTEM_UUID')
    journal.add('FS_FORMATTED')
    journal.add('MOUNTPOINT_CREATE_INTENT')
    Path(plan['mount']).mkdir(mode=0o700); sync_directory(work)
    journal.add('MOUNTPOINT_CREATED', identity=storage_identity(secure(plan['mount'], 'dir', 0o700)))
    guard(); disk_private_parent(plan)
    journal.add('MOUNT_INTENT')
    disk_tool('mount', ['--no-mtab', '--types', 'ext4', '--options', plan['mountOptions'], plan['mapperPath'], plan['mount']], 'DISK_MOUNT')
    os.chmod(plan['mount'], 0o700 if plan['schema'] == 'PHUB_TIMEWEB_DISK_RESTORE_PLAN_V2' else 0o1777)
    mount = disk_mount(plan, mapper)
    journal.add('MOUNTED', identity=mount)
    available = os.statvfs(plan['mount'])
    need(available.f_bavail * available.f_frsize >= plan['restoreDataBytes'], 'DISK_FILESYSTEM_CAPACITY')
    disk_storage_attest(plan, journal)
    guard()


def disk_cleanup(plan, journal, guard):
    """Explicit exact-owner cleanup. Never dumps, restores, formats or starts a container."""
    image = disk_image(plan, journal, optional=True, complete=False)
    row = disk_container_lookup(plan)
    created = journal.find('RESTORE_CREATED')
    if row is not None:
        need(journal.find('RESTORE_CREATE_INTENT') is not None and image is not None, 'DISK_RESTORE_UNPROVEN')
        if created is None:
            journal.add('RESTORE_CREATED', containerId=row['Id'])
        else:
            need(created['containerId'] == row['Id'], 'DISK_RESTORE_ID_DRIFT')
        # An unchanged exact source/mapping is required before stopping or removing.
        loop = disk_loop(plan, image)
        mapper = disk_mapper(plan, loop)
        disk_mount(plan, mapper)
        guard(row['Id'], cleanup=True)
        if row['State']['Status'] == 'running':
            journal.once('CONTAINER_STOP_INTENT', containerId=row['Id'])
            disk_kernel_mount_proof(plan, mapper, row)
            docker(['stop', '--time', '30', row['Id']], 'DISK_RESTORE_STOP')
            row = disk_container_lookup(plan)
            need(row is not None and row['State']['Status'] == 'exited', 'DISK_RESTORE_STOP_UNPROVEN')
        else:
            need(row['State']['Status'] in ('created', 'exited'), 'DISK_RESTORE_STATE')
        journal.once('CONTAINER_STOPPED', containerId=row['Id'])
        journal.once('CONTAINER_REMOVE_INTENT', containerId=row['Id'])
        docker(['rm', row['Id']], 'DISK_RESTORE_REMOVE')
        need(disk_container_lookup(plan) is None, 'DISK_RESTORE_REMOVE_UNPROVEN')
        journal.once('CONTAINER_REMOVED', containerId=row['Id'])
    elif created is not None:
        need(journal.find('CONTAINER_REMOVE_INTENT') is not None, 'DISK_RESTORE_DISAPPEARED')
        journal.once('CONTAINER_REMOVED', containerId=created['containerId'])
    disk_cleanup_storage(plan, journal, guard)


def disk_cleanup_storage(plan, journal, guard, finalize=True):
    image = disk_image(plan, journal, optional=True, complete=False)
    guard(cleanup=True)
    expected_image = (journal.find('IMAGE_CREATED') or {}).get('identity')
    loop = disk_loop(plan, expected_image, optional=True) if expected_image is not None else None
    need(image is not None or loop is None, 'DISK_LOOP_ORPHAN')
    mapper = disk_mapper(plan, loop, optional=True) if loop is not None else None
    # Never infer absence from a missing image/loop while a foreign mapper still occupies its name.
    if loop is None:
        need(not os.path.lexists(plan['mapperPath']), 'DISK_MAPPER_ORPHAN')
    if os.path.lexists(plan['mount']):
        mount = disk_mount(plan, mapper, optional=True, complete=False)
        if mount is not None:
            need(journal.find('MOUNT_INTENT') is not None, 'DISK_MOUNT_UNPROVEN')
            journal.once('UNMOUNT_INTENT')
            disk_tool('umount', ['--no-mtab', plan['mount']], 'DISK_UNMOUNT')
            need(disk_mount(plan, mapper, optional=True) is None, 'DISK_UNMOUNT_UNPROVEN')
        elif journal.find('MOUNTED') is not None:
            need(journal.find('UNMOUNT_INTENT') is not None, 'DISK_MOUNT_DISAPPEARED')
        journal.once('UNMOUNTED')
        point = journal.find('MOUNTPOINT_CREATED')
        need(point is not None and same_storage(secure(plan['mount'], 'dir', 0o700), point['identity'])
             and not any(Path(plan['mount']).iterdir()), 'DISK_MOUNTPOINT_DRIFT')
        journal.once('MOUNTPOINT_REMOVE_INTENT')
        Path(plan['mount']).rmdir(); sync_directory(plan['work'])
        journal.once('MOUNTPOINT_REMOVED')
    elif journal.find('MOUNTPOINT_CREATED') is not None:
        need(journal.find('MOUNTPOINT_REMOVE_INTENT') is not None, 'DISK_MOUNTPOINT_DISAPPEARED')
        journal.once('MOUNTPOINT_REMOVED')
    if mapper is not None:
        need(journal.find('MAPPER_OPEN_INTENT') is not None, 'DISK_MAPPER_UNPROVEN')
        if journal.find('MAPPER_OPENED') is not None:
            need(journal.find('MAPPER_OPENED') == {'identity': mapper}, 'DISK_MAPPER_DRIFT')
        journal.once('MAPPER_CLOSE_INTENT')
        disk_tool('crypt', ['close', plan['mapperName']], 'DISK_MAPPER_CLOSE')
        need(not os.path.lexists(plan['mapperPath']), 'DISK_MAPPER_CLOSE_UNPROVEN')
    elif journal.find('MAPPER_OPENED') is not None:
        need(journal.find('MAPPER_CLOSE_INTENT') is not None, 'DISK_MAPPER_DISAPPEARED')
    journal.once('MAPPER_CLOSED')
    if loop is not None:
        need(journal.find('LOOP_ATTACH_INTENT') is not None, 'DISK_LOOP_UNPROVEN')
        prior = journal.find('LOOP_ATTACHED')
        need(prior is None or prior['loop'] == loop, 'DISK_LOOP_DRIFT')
        journal.once('LOOP_DETACH_INTENT', loop=loop)
        disk_tool('loop', ['--detach', loop], 'DISK_LOOP_DETACH')
        need(disk_loop(plan, image, optional=True) is None, 'DISK_LOOP_DETACH_UNPROVEN')
    elif journal.find('LOOP_ATTACHED') is not None:
        prior = journal.find('LOOP_DETACH_INTENT')
        need(prior is not None, 'DISK_LOOP_DISAPPEARED')
    journal.once('LOOP_DETACHED')
    if image is not None:
        need(disk_image(plan, journal, complete=False) == image, 'DISK_IMAGE_DRIFT')
        journal.once('IMAGE_UNLINK_INTENT', identity=image)
        Path(plan['image']).unlink(); sync_directory(plan['work'])
    elif journal.find('IMAGE_CREATED') is not None:
        need(journal.find('IMAGE_UNLINK_INTENT') is not None, 'DISK_IMAGE_DISAPPEARED')
    journal.once('IMAGE_UNLINKED')
    need(not os.path.lexists(plan['image']) and not os.path.lexists(plan['mount'])
         and not os.path.lexists(plan['mapperPath']), 'DISK_CLEANUP_UNPROVEN')
    guard(cleanup=True)
    if finalize:
        journal.once('STORAGE_CLEANUP_VERIFIED')


def disk_publication(plan, journal):
    ready = journal.find('PUBLISH_READY')
    need(ready is not None and journal.find('STORAGE_CLEANUP_VERIFIED') is not None, 'DISK_PUBLICATION_UNPROVEN')
    publication, canonical = Path(plan['publication']), Path(plan['canonical'])
    if os.path.lexists(canonical):
        need(journal.find('PUBLISH_INTENT') is not None and not os.path.lexists(publication), 'DISK_CANONICAL_EXISTS')
        directory = canonical
    else:
        directory = publication
    secure(directory, 'dir', 0o700)
    need(sorted(p.name for p in directory.iterdir()) == ['database-backup-receipt.json', 'database.pgcustom'], 'DISK_PUBLICATION_INVENTORY')
    receipt = read_secure(directory / 'database-backup-receipt.json')
    need(digest(receipt) == ready['receiptSha256'] and file_digest(directory / 'database.pgcustom') == ready['dumpSha256'], 'DISK_PUBLICATION_DRIFT')
    value = strict(receipt)
    need(value['backupFile'] == str(canonical / 'database.pgcustom')
         and value['sourceLedgerSha256'] == value['restoredLedgerSha256'] == plan['expectedLedgerSha256'], 'DISK_PUBLICATION_LEDGER')
    journal.once('PUBLISH_INTENT')
    if directory == publication:
        rename_noreplace(publication, canonical)
    journal.once('PUBLISHED', receiptSha256=ready['receiptSha256'])
    return ready['receiptSha256']


def disk_release(plan, journal, owned_lock):
    need(journal.find('STORAGE_CLEANUP_VERIFIED') is not None
         and (journal.find('PUBLISHED') is not None or journal.find('ABORTED') is not None), 'DISK_RELEASE_UNPROVEN')
    if journal.find('UNLOCK_INTENT') is None:
        owned_lock(optional=False)
        journal.add('UNLOCK_INTENT')
    if owned_lock(optional=True):
        if os.path.lexists(LOCK / 'backup-restore.json'):
            (LOCK / 'backup-restore.json').unlink(); sync_directory(LOCK)
        LOCK.rmdir(); sync_directory(LOCK.parent)
    journal.once('RECONCILED')


def execute_disk(op, request_bytes, file_sha):
    plan, journal, guard = disk_initialize(op, request_bytes, file_sha)
    work = Path(plan['work'])
    incoming = work / 'database.pgcustom.incoming'
    journal.add('DUMP_INTENT')
    fd = os.open(incoming, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(os.dup(fd), 'wb') as stream:
            docker(['exec', PG_ID, '/bin/sh', '-eu', '-c', SOURCE_DUMP], 'DUMP', stdout=stream, timeout=600,
                   file_limit=plan['dumpLimitBytes'])
            stream.flush()
        os.fsync(fd)
    finally:
        os.close(fd)
    sync_directory(work)
    dump_sha = file_digest(incoming)
    guard(); journal.add('DUMP_VERIFIED', dumpSha256=dump_sha)
    disk_create_storage(plan, journal, guard)
    disk_daemon_guard(journal)
    disk_storage_attest(plan, journal)
    journal.add('RESTORE_CREATE_INTENT')
    container = docker(disk_container_args(plan), 'DISK_RESTORE_CREATE').decode().strip()
    row = disk_container_lookup(plan)
    need(row is not None and row['Id'] == container and row['State']['Status'] == 'created', 'DISK_RESTORE_CREATE_UNPROVEN')
    journal.add('RESTORE_CREATED', containerId=container)
    disk_daemon_guard(journal)
    disk_storage_attest(plan, journal)
    journal.add('RESTORE_START_INTENT', containerId=container)
    docker(['start', container], 'DISK_RESTORE_START')
    ready = False
    for _ in range(45):
        row = disk_container_lookup(plan)
        need(row is not None and row['Id'] == container and row['State']['Status'] == 'running', 'DISK_RESTORE_START_UNPROVEN')
        try:
            docker(['exec', container, 'pg_isready', '--username=phub_restore', '--dbname=phub_restore'], 'DISK_RESTORE_READY')
            ready = True; break
        except Stop:
            time.sleep(2)
    need(ready, 'RESTORE_NOT_READY')
    journal.add('RESTORE_STARTED', containerId=container)
    readback = disk_running_attestation(plan, journal)
    proof = {'schema': 'PHUB_TIMEWEB_DISK_RESTORE_STORAGE_PROOF_V1', 'operationSha256': plan['operationSha256'],
             'planSha256': digest(read_secure(work / 'disk-plan.json')), 'readback': readback}
    atomic_exclusive(work / 'restore-storage-proof.json', encoded(proof))
    guard(container)
    with dump_stream(incoming, dump_sha) as stream:
        docker(['exec', '-i', container, 'pg_restore', '--list'], 'DUMP_TOC', stdin=stream, stdout=subprocess.DEVNULL, timeout=120)
    journal.add('RESTORE_INTENT', containerId=container)
    with dump_stream(incoming, dump_sha) as stream:
        docker(['exec', '-i', container, 'pg_restore', '--username=phub_restore', '--dbname=phub_restore',
                '--no-owner', '--no-acl', '--exit-on-error'], 'RESTORE', stdin=stream, stdout=subprocess.DEVNULL, timeout=600)
    restored = ledger_bytes(docker(['exec', container, 'psql', '-X', '--username=phub_restore', '--dbname=phub_restore',
                                  '--no-psqlrc', '--tuples-only', '--no-align', '--set=ON_ERROR_STOP=1', '--command=' + LEDGER_SQL], 'RESTORED_LEDGER'))
    need(digest(restored) == plan['expectedLedgerSha256'] and file_digest(incoming) == dump_sha, 'LEDGER_MISMATCH')
    guard(container)
    journal.add('RESTORE_VERIFIED', containerId=container, ledgerSha256=digest(restored), dumpSha256=dump_sha)
    Path(plan['publication']).mkdir(mode=0o700); sync_directory(work)
    rename_noreplace(incoming, Path(plan['publication']) / 'database.pgcustom')
    receipt = {'schema': 'PHUB_TIMEWEB_DATABASE_BACKUP_RESTORE_V1', 'baselineReleaseId': BASELINE,
               'completedAt': now_iso(), 'backupFile': str(Path(plan['canonical']) / 'database.pgcustom'),
               'backupSha256': dump_sha, 'restoreVerified': True, 'restoreImage': PG_IMAGE,
               'restoredLedgerSha256': digest(restored), 'sourceLedgerSha256': digest(restored)}
    atomic_exclusive(Path(plan['publication']) / 'database-backup-receipt.json', encoded(receipt))
    journal.add('PUBLISH_READY', dumpSha256=dump_sha, receiptSha256=digest(encoded(receipt)))
    disk_cleanup(plan, journal, guard)
    receipt_sha = disk_publication(plan, journal)
    guard(cleanup=True)
    _, owner = disk_context(op, request_bytes, plan, journal)
    disk_release(plan, journal, owner)
    return {'status': 'BACKUP_RESTORE_VERIFIED', 'receiptSha256': receipt_sha, 'releaseId': operation_mode(op)[1],
            'authorizesDeploy': False, 'dumpBytesPrinted': False}


def reconcile_disk(op, request_bytes, file_sha):
    disk_prerequisites(cleanup=True)
    work = ROOT / 'backups' / ('.disk-restore-' + digest(request_bytes))
    need(read_secure(work / 'backup-operation.json') == request_bytes, 'DISK_CAPSULE_DRIFT')
    plan = strict(read_secure(work / 'disk-plan.json'))
    sizing = {key: plan[key] for key in ['databaseBytes', 'restoreDataBytes', 'imageBytes', 'memoryBytes', 'dumpLimitBytes', 'diskReserveBytes']}
    need(plan == disk_plan(op, request_bytes, sizing), 'DISK_PLAN_DRIFT')
    journal = DiskJournal(work, plan['operationSha256'])
    need(journal.find('LOCK_PREPARED') is not None, 'DISK_LOCK_UNPROVEN')
    guard, owner = disk_context(op, request_bytes, plan, journal, allow_expired=True)
    if journal.find('RECONCILED') is not None:
        need(not os.path.lexists(LOCK) and not os.path.lexists(plan['pendingLock'])
             and not os.path.lexists(plan['image']) and not os.path.lexists(plan['mount'])
             and not os.path.lexists(plan['mapperPath']) and disk_container_lookup(plan) is None, 'DISK_TERMINAL_DRIFT')
        image = (journal.find('IMAGE_CREATED') or {}).get('identity')
        need(image is None or disk_loop(plan, image, optional=True) is None, 'DISK_TERMINAL_LOOP_DRIFT')
        if journal.find('PUBLISHED') is not None:
            disk_publication(plan, journal)
        else:
            need(journal.find('ABORTED') is not None and not os.path.lexists(plan['canonical']), 'DISK_TERMINAL_DRIFT')
        guard(cleanup=True, optional_lock=True)
        return {'status': 'DISK_RECONCILED', 'authorizesDeploy': False, 'replayAllowed': False}
    if not os.path.lexists(LOCK):
        if os.path.lexists(plan['pendingLock']):
            marker = journal.find('LOCK_PREPARED')
            need(same_storage(secure(plan['pendingLock'], 'dir', 0o700), marker['identity'])
                 and sorted(p.name for p in Path(plan['pendingLock']).iterdir()) == ['backup-restore.json']
                 and read_secure(Path(plan['pendingLock']) / 'backup-restore.json') == encoded(marker['marker']), 'DISK_LOCK_DRIFT')
            # No storage can be created until the shared-lock publication is proven.
            need(journal.find('DUMP_INTENT') is None, 'DISK_ORPHAN_MUTATION')
            rename_noreplace(plan['pendingLock'], LOCK)
        else:
            need(journal.find('UNLOCK_INTENT') is not None, 'DISK_LOCK_MISSING')
            journal.once('RECONCILED')
            return {'status': 'DISK_RECONCILED', 'authorizesDeploy': False, 'replayAllowed': False}
    disk_cleanup(plan, journal, guard)
    if journal.find('PUBLISH_READY') is not None:
        disk_publication(plan, journal)
    else:
        need(not os.path.lexists(plan['canonical']), 'DISK_ABORT_CANONICAL_EXISTS')
        # Retain the partial/complete dump privately as incident evidence, never publish it.
        journal.once('ABORTED')
    guard(cleanup=True)
    disk_release(plan, journal, owner)
    return {'status': 'DISK_RECONCILED', 'authorizesDeploy': False, 'replayAllowed': False}


def namespace_initialize(op, request_bytes, file_sha):
    disk_prerequisites()
    mode, release = operation_mode(op)
    canonical = ROOT / 'backups' / (release + '-' + mode)
    work = ROOT / 'backups' / ('.disk-restore-' + digest(request_bytes))
    need(not os.path.lexists(LOCK) and not os.path.lexists(work) and not os.path.lexists(canonical), 'EXISTING_STATE')
    for path in [ROOT, ROOT / 'standard', ROOT / 'operator', ROOT / 'backups']:
        secure(path, 'dir')
    tool_custody(op)
    need(service('phub-timeweb-beta', 'api') == op['expectedApi']
         and service('phub-timeweb-beta-dependencies', 'postgres') == op['expectedPostgres'], 'RUNTIME_DRIFT')
    need(not docker(['ps', '-q', '--no-trunc', '--filter', 'label=com.docker.compose.service=migrator']).strip(), 'ACTIVE_MIGRATOR')
    boundary = []
    ids = docker(['ps', '-aq', '--no-trunc']).decode().split()
    need(len(ids) == len(set(ids)) and all(HASH.fullmatch(v) for v in ids), 'CONTAINER_ID')
    for container in sorted(ids):
        row = strict(docker(['inspect', '--format', INSPECT_FORMAT, container]))
        need(row['Id'] == container, 'CONTAINER_ID')
        boundary.append(row)
    need(digest(encoded(boundary)) == op['expectedBoundarySha256'], 'BASELINE_BOUNDARY')
    ledger = ledger_bytes(source_query(SOURCE_LEDGER))
    need(digest(ledger) == disk_ledger_sha(op), 'DISK_LEDGER')
    raw_size = source_query(SOURCE_SIZE).decode().strip()
    need(re.fullmatch(r'[1-9][0-9]*', raw_size), 'DATABASE_SIZE')
    image = namespace_image(strict(docker(['image', 'inspect', '--format', NS_IMAGE_FORMAT, PG_IMAGE])))
    sizing = namespace_sizing(int(raw_size), disk_memory_available(), disk_free(), image)
    plan = namespace_plan(op, request_bytes, sizing, image)
    daemon = namespace_source_daemon()
    need(os.stat('/proc/self/ns/mnt').st_ino == daemon['mountNamespace'], 'NS_INITIAL_HOST_NAMESPACE')
    need(not os.path.lexists(plan['pendingLock']), 'DISK_PENDING_LOCK_EXISTS')
    image = strict(docker(['image', 'inspect', '--format', '{"Os":{{json .Os}},"Architecture":{{json .Architecture}},"RepoDigests":{{json .RepoDigests}}}', PG_IMAGE]))
    need(restore_image_admitted(image), 'RESTORE_IMAGE')
    work.mkdir(mode=0o700); sync_directory(work.parent)
    atomic_exclusive(work / 'backup-operation.json', request_bytes)
    atomic_exclusive(work / 'disk-plan.json', encoded(plan))
    atomic_exclusive(work / 'boundary.json', encoded({'sha256': op['expectedBoundarySha256']}))
    journal = DiskJournal(work, plan['operationSha256'])
    journal.add('PREPARED')
    journal.add('SOURCE_DAEMON', identity=daemon)
    journal.add('SOURCE_NETWORK', namespace=namespace_network(daemon['pid']))
    journal.add('ALIAS_BASELINE', identity=namespace_alias_baseline(daemon))
    journal.add('CONTAINERD_MASK_BASELINE', identity=namespace_mask_baseline(daemon))
    attestation = v2_migration_proof(op, request_bytes, ROOT / 'standard/source')
    journal.add('MIGRATION_ATTESTATION', proof=attestation)
    pending = Path(plan['pendingLock'])
    pending.mkdir(mode=0o700); sync_directory(pending.parent)
    marker = {'schema': 'PHUB_TIMEWEB_BACKUP_LOCK_V1', 'operationSha256': plan['operationSha256'],
              'toolFileSha256': file_sha, 'transaction': str(work), 'createdAt': now_iso()}
    atomic_exclusive(pending / 'backup-restore.json', encoded(marker))
    journal.add('LOCK_PREPARED', identity=storage_identity(secure(pending, 'dir', 0o700)), marker=marker)
    journal.add('LOCK_PUBLISH_INTENT')
    rename_noreplace(pending, LOCK)
    journal.add('LOCKED')
    guard, _ = disk_context(op, request_bytes, plan, journal)
    guard()
    return plan, journal, guard


def execute_namespace(op, request_bytes, file_sha):
    plan, journal, guard = namespace_initialize(op, request_bytes, file_sha)
    work = Path(plan['work'])
    guard(); namespace_start(plan, op, journal)
    with namespace_enter(plan, op):
        incoming = work / 'database.pgcustom.incoming'
        journal.add('DUMP_INTENT')
        fd = os.open(incoming, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        try:
            with os.fdopen(os.dup(fd), 'wb') as stream:
                namespace_frozen_source(plan)
                docker(['exec', PG_ID, '/bin/sh', '-eu', '-c', SOURCE_DUMP], 'DUMP', stdout=stream, timeout=600,
                       file_limit=plan['dumpLimitBytes'])
                stream.flush()
            os.fsync(fd)
        finally:
            os.close(fd)
        sync_directory(work)
        dump_sha = file_digest(incoming)
        namespace_frozen_source(plan)
        guard(); journal.add('DUMP_VERIFIED', dumpSha256=dump_sha)
        disk_create_storage(plan, journal, guard)
        disk_storage_attest(plan, journal)
        namespace_alias_mount(plan, journal)
        namespace_mask_mount(plan, journal)
        namespace_daemon_start(plan, op, journal)
        namespace_image_transfer(plan, op, journal)
        journal.add('RESTORE_CREATE_INTENT')
        image_id = namespace_imported_image(plan, journal)['Id']
        container = namespace_docker(plan, namespace_container_args(plan, image_id), 'DISK_RESTORE_CREATE').decode().strip()
        row = namespace_container_lookup(plan, image_id)
        need(row is not None and row['Id'] == container and row['State']['Status'] == 'created', 'DISK_RESTORE_CREATE_UNPROVEN')
        journal.add('RESTORE_CREATED', containerId=container)
        disk_storage_attest(plan, journal)
        journal.add('RESTORE_START_INTENT', containerId=container)
        namespace_docker(plan, ['start', container], 'DISK_RESTORE_START')
        ready = False
        for _ in range(45):
            row = namespace_container_lookup(plan, image_id)
            need(row is not None and row['Id'] == container and row['State']['Status'] == 'running', 'DISK_RESTORE_START_UNPROVEN')
            try:
                namespace_docker(plan, ['exec', container, 'pg_isready', '--username=phub_restore', '--dbname=phub_restore'], 'DISK_RESTORE_READY')
                ready = True; break
            except Stop:
                time.sleep(2)
        need(ready, 'RESTORE_NOT_READY')
        journal.add('RESTORE_STARTED', containerId=container)
        readback = namespace_running_attestation(plan, op, journal)
        proof = {'schema': 'PHUB_TIMEWEB_DISK_RESTORE_STORAGE_PROOF_V2', 'operationSha256': plan['operationSha256'],
                 'planSha256': digest(read_secure(work / 'disk-plan.json')), 'readback': readback}
        atomic_exclusive(work / 'restore-storage-proof.json', encoded(proof))
        guard(container)
        with dump_stream(incoming, dump_sha) as stream:
            namespace_docker(plan, ['exec', '-i', container, 'pg_restore', '--list'], 'DUMP_TOC', stdin=stream, stdout=subprocess.DEVNULL, timeout=120)
        journal.add('RESTORE_INTENT', containerId=container)
        with dump_stream(incoming, dump_sha) as stream:
            namespace_docker(plan, ['exec', '-i', container, 'pg_restore', '--username=phub_restore', '--dbname=phub_restore',
                    '--no-owner', '--no-acl', '--exit-on-error'], 'RESTORE', stdin=stream, stdout=subprocess.DEVNULL, timeout=600)
        restored = ledger_bytes(namespace_docker(plan, ['exec', container, 'psql', '-X', '--username=phub_restore', '--dbname=phub_restore',
                                      '--no-psqlrc', '--tuples-only', '--no-align', '--set=ON_ERROR_STOP=1', '--command=' + LEDGER_SQL], 'RESTORED_LEDGER'))
        need(digest(restored) == plan['expectedLedgerSha256'] and file_digest(incoming) == dump_sha, 'LEDGER_MISMATCH')
        guard(container)
        journal.add('RESTORE_VERIFIED', containerId=container, ledgerSha256=digest(restored), dumpSha256=dump_sha)
        Path(plan['publication']).mkdir(mode=0o700); sync_directory(work)
        rename_noreplace(incoming, Path(plan['publication']) / 'database.pgcustom')
        receipt = {'schema': 'PHUB_TIMEWEB_DATABASE_BACKUP_RESTORE_V1', 'baselineReleaseId': BASELINE,
                   'completedAt': now_iso(), 'backupFile': str(Path(plan['canonical']) / 'database.pgcustom'),
                   'backupSha256': dump_sha, 'restoreVerified': True, 'restoreImage': PG_IMAGE,
                   'restoredLedgerSha256': digest(restored), 'sourceLedgerSha256': digest(restored)}
        atomic_exclusive(Path(plan['publication']) / 'database-backup-receipt.json', encoded(receipt))
        journal.add('PUBLISH_READY', dumpSha256=dump_sha, receiptSha256=digest(encoded(receipt)))
        namespace_cleanup(plan, op, journal, guard)
    namespace_release(plan, op, journal)
    guard(cleanup=True); journal.once('STORAGE_CLEANUP_VERIFIED')
    receipt_sha = disk_publication(plan, journal)
    guard(cleanup=True)
    _, owner = disk_context(op, request_bytes, plan, journal)
    disk_release(plan, journal, owner)
    return {'status': 'BACKUP_RESTORE_VERIFIED', 'receiptSha256': receipt_sha, 'releaseId': operation_mode(op)[1],
            'authorizesDeploy': False, 'dumpBytesPrinted': False}


def namespace_validate_plan(op, raw, plan):
    image = plan['isolation']['image']
    expected = namespace_sizing(plan['databaseBytes'], 2**50, 2**50, image)
    need(plan == namespace_plan(op, raw, expected, image), 'NS_PLAN_DRIFT')
    return plan


def namespace_cleanup(plan, op, journal, guard):
    image = disk_image(plan, journal, optional=True, complete=False)
    started = journal.find('DAEMON_START_INTENT') is not None
    stopped = journal.find('DAEMON_STOPPED') is not None
    if started and not stopped and namespace_control(plan,'daemon-start.json').exists():
        need(namespace_control(plan,'daemon-receipt.json').exists(), 'NS_DAEMON_START_MANUAL_STOP')
        if journal.find('DAEMON_STOP_INTENT') is None:row=namespace_container_lookup(plan, namespace_current_image_id(plan, journal))
        else:row=None
    else:row=None
    created = journal.find('RESTORE_CREATED')
    if row is not None:
        need(journal.find('RESTORE_CREATE_INTENT') is not None and image is not None
             and journal.find('IMAGE_LOADED') is not None, 'NS_RESTORE_UNPROVEN')
        if created is None:journal.add('RESTORE_CREATED', containerId=row['Id'])
        else:need(created['containerId'] == row['Id'], 'NS_RESTORE_ID_DRIFT')
        runtime = namespace_runtime_mounts(plan, journal, namespace_alias_rows())
        if runtime['network'] is not None:
            need(row['NetworkSettings']['SandboxKey'] == runtime['network']['target'], 'NS_CONTAINER_NETWORK_BINDING')
            if row['State']['Pid']:
                need(namespace_network(row['State']['Pid']) == int(runtime['network']['root'][5:-1]), 'NS_CONTAINER_NETWORK_NAMESPACE')
        guard(row['Id'], cleanup=True)
        if row['State']['Status'] == 'running':
            namespace_running_attestation(plan, op, journal)
            journal.once('CONTAINER_STOP_INTENT', containerId=row['Id'])
            namespace_docker(plan, ['stop', '--time', '30', row['Id']], 'NS_CONTAINER_STOP')
            row = namespace_container_lookup(plan, namespace_current_image_id(plan, journal))
            need(row is not None and row['State']['Status'] == 'exited', 'NS_CONTAINER_STOP_UNKNOWN')
        else:need(row['State']['Status'] in ('created', 'exited'), 'NS_RESTORE_STATE')
        need(namespace_runtime_mounts(plan, journal, namespace_alias_rows())['network'] is None, 'NS_RUNTIME_UNBOUND')
        journal.once('CONTAINER_STOPPED', containerId=row['Id'])
        journal.once('CONTAINER_REMOVE_INTENT', containerId=row['Id'])
        namespace_docker(plan, ['rm', row['Id']], 'NS_CONTAINER_REMOVE')
        need(namespace_container_lookup(plan, namespace_current_image_id(plan, journal)) is None, 'NS_CONTAINER_REMOVE_UNKNOWN')
        need(namespace_runtime_mounts(plan, journal, namespace_alias_rows())['network'] is None, 'NS_RUNTIME_UNBOUND')
        journal.once('CONTAINER_REMOVED', containerId=row['Id'])
    elif created is not None:
        need(journal.find('CONTAINER_REMOVE_INTENT') is not None, 'NS_CONTAINER_DISAPPEARED')
        need(namespace_runtime_mounts(plan, journal, namespace_alias_rows())['network'] is None, 'NS_RUNTIME_UNBOUND')
        journal.once('CONTAINER_REMOVED', containerId=created['containerId'])
    if journal.find('RESTORE_CREATE_INTENT') is not None and journal.find('RESTORE_CREATED') is None:
        runtime = namespace_runtime_mounts(plan, journal, namespace_alias_rows())
        need(runtime['network'] is None, 'NS_RUNTIME_UNBOUND')
    guard(cleanup=True)
    namespace_daemon_stop(plan, op, journal)
    namespace_runtime_mounts_empty()
    namespace_mask_unmount(plan, journal)
    namespace_alias_unmount(plan, journal)
    disk_cleanup_storage(plan, journal, guard, finalize=False)
    journal.once('NAMESPACE_STORAGE_CLEANED')


def namespace_terminal(plan, journal):
    need(journal.find('CONTAINERD_MASK_INTENT') is None or journal.find('CONTAINERD_MASK_UNMOUNTED') is not None, 'NS_TERMINAL_MASK')
    need(journal.find('ALIAS_MOUNT_INTENT') is None or journal.find('ALIAS_UNMOUNTED') is not None, 'NS_TERMINAL_ALIAS')
    need(journal.find('NAMESPACE_UNIT_START_INTENT') is None or journal.find('NAMESPACE_RELEASED') is not None, 'NS_TERMINAL_UNIT')
    need(journal.find('NAMESPACE_SLICE_START_INTENT') is None or journal.find('NAMESPACE_SLICE_RELEASED') is not None, 'NS_TERMINAL_SLICE')
    need(not os.path.lexists(plan['image']) and not os.path.lexists(plan['mount'])
         and not os.path.lexists(plan['mapperPath']), 'NS_TERMINAL_STORAGE')
    image = (journal.find('IMAGE_CREATED') or {}).get('identity')
    need(image is None or disk_loop(plan, image, optional=True) is None, 'NS_TERMINAL_LOOP')


def reconcile_namespace(op, raw, file_sha):
    disk_prerequisites(cleanup=True)
    work = ROOT/'backups'/('.disk-restore-' + digest(raw))
    need(read_secure(work/'backup-operation.json') == raw, 'NS_CAPSULE_DRIFT')
    plan = namespace_validate_plan(op, raw, strict(read_secure(work/'disk-plan.json')))
    journal = DiskJournal(work, plan['operationSha256'])
    guard, owner = disk_context(op, raw, plan, journal, allow_expired=True)
    need(journal.find('LOCK_PREPARED') is not None, 'NS_LOCK_UNPROVEN')
    if journal.find('RECONCILED') is not None:
        namespace_terminal(plan, journal); guard(cleanup=True, optional_lock=True)
        if journal.find('PUBLISHED') is not None:disk_publication(plan, journal)
        else:need(journal.find('ABORTED') is not None and not os.path.lexists(plan['canonical']), 'NS_TERMINAL_PUBLICATION')
        return {'status': 'DISK_RECONCILED', 'authorizesDeploy': False, 'replayAllowed': False}
    if not os.path.lexists(LOCK):
        if os.path.lexists(plan['pendingLock']):
            expected = journal.find('LOCK_PREPARED'); pending = Path(plan['pendingLock'])
            need(same_storage(secure(pending, 'dir', 0o700), expected['identity'])
                 and sorted(p.name for p in pending.iterdir()) == ['backup-restore.json']
                 and read_secure(pending/'backup-restore.json') == encoded(expected['marker'])
                 and journal.find('NAMESPACE_UNIT_START_INTENT') is None, 'NS_PENDING_LOCK_DRIFT')
            rename_noreplace(pending, LOCK)
        else:
            need(journal.find('UNLOCK_INTENT') is not None, 'NS_LOCK_MISSING')
            namespace_terminal(plan, journal); guard(cleanup=True, optional_lock=True)
            journal.once('RECONCILED'); return {'status': 'DISK_RECONCILED', 'authorizesDeploy': False, 'replayAllowed': False}
    if journal.find('NAMESPACE_RELEASE_INTENT') is not None:
        namespace_release(plan, op, journal)
    elif journal.find('NAMESPACE_UNIT_START_INTENT') is not None:
        # No guessed process adoption before the supervisor's owned durable receipt.
        admission = namespace_admission(plan, op)
        journal.once('NAMESPACE_READY', receipt=admission)
        with namespace_enter(plan, op):namespace_cleanup(plan, op, journal, guard)
        namespace_release(plan, op, journal)
    else:
        need(journal.find('DUMP_INTENT') is None, 'NS_ORPHAN_MUTATION')
        disk_cleanup_storage(plan,journal,guard,finalize=False)
        journal.once('NAMESPACE_STORAGE_CLEANED')
        if journal.find('NAMESPACE_SLICE_START_INTENT') is not None:
            need(journal.find('NAMESPACE_SLICE_READY') is not None, 'NS_SLICE_START_MANUAL_STOP')
            namespace_release(plan,op,journal)
    namespace_terminal(plan, journal); guard(cleanup=True)
    journal.once('STORAGE_CLEANUP_VERIFIED')
    if journal.find('PUBLISH_READY') is not None:disk_publication(plan, journal)
    else:
        need(not os.path.lexists(plan['canonical']), 'NS_ABORT_CANONICAL_EXISTS'); journal.once('ABORTED')
    disk_release(plan, journal, owner)
    return {'status': 'DISK_RECONCILED', 'authorizesDeploy': False, 'replayAllowed': False}


def namespace_verify_reference(op, raw, file_sha):
    need(op['schema'] == NS_POST_SCHEMA, 'NS_POST_ATTESTATION_ONLY'); tool_custody(op)
    work = ROOT/'backups'/('.disk-restore-' + digest(raw))
    need(read_secure(work/'backup-operation.json') == raw, 'NS_REQUEST_DRIFT')
    plan_bytes = read_secure(work/'disk-plan.json'); plan = namespace_validate_plan(op, raw, strict(plan_bytes))
    journal = DiskJournal(work, plan['operationSha256']); lock = journal.find('LOCK_PREPARED')
    need(lock is not None and same_storage(secure(LOCK, 'dir', 0o700), lock['identity'])
         and sorted(p.name for p in LOCK.iterdir()) == ['backup-restore.json']
         and read_secure(LOCK/'backup-restore.json') == encoded(lock['marker']), 'NS_ATTEST_LOCK')
    proof_bytes = read_secure(work/'restore-storage-proof.json'); proof = strict(proof_bytes)
    exact(proof, ['schema', 'operationSha256', 'planSha256', 'readback'])
    need(proof['schema'] == 'PHUB_TIMEWEB_DISK_RESTORE_STORAGE_PROOF_V2'
         and proof['operationSha256'] == plan['operationSha256'] and proof['planSha256'] == digest(plan_bytes), 'NS_STORAGE_PROOF')
    # Read-only callers must already be in the independently proven runtime namespace.
    value = namespace_running_attestation(plan, op, journal)
    need(value == proof['readback'] and read_secure(work/'restore-storage-proof.json') == proof_bytes
         and read_secure(REQUEST) == raw, 'NS_PROOF_DRIFT')
    return {'schema': 'PHUB_TIMEWEB_DISK_RESTORE_READBACK_V2', 'operationSha256': digest(raw),
            'storageProofSha256': digest(proof_bytes), 'plan': plan, 'readback': value,
            'migration': {**{k: op[k] for k in ['controllerSha', 'controllerTree', 'controllerSourceCiRunId',
               'candidateReleaseId', 'migrationPlanSha256', 'migrationSuccessSha256']}, **promotion_expected(op)}}

def execute(op, request_bytes, file_sha):
    if is_namespace_operation(op):return execute_namespace(op, request_bytes, file_sha)
    return execute_disk(op, request_bytes, file_sha) if is_disk_operation(op) else execute_tmpfs(op, request_bytes, file_sha)


def main():
    need(sys.flags.optimize==0 and sys.flags.isolated==1, 'ISOLATED_NONOPTIMIZED_PYTHON_REQUIRED')
    supervisor = len(sys.argv) == 4 and sys.argv[1] == '--disk-runtime-supervisor' and sys.argv[2] == str(REQUEST)
    need(os.getuid()==0 and (supervisor or len(sys.argv)==3 and sys.argv[1] in ('--execute', '--reconcile-disk', '--attest-disk') and sys.argv[2]==str(REQUEST)), 'ENTRY')
    os.umask(0o077)
    file=Path(__file__)
    file_sha=digest(read_secure(file,0o755))
    request_bytes=read_secure(REQUEST)
    op=validate_operation(strict(request_bytes),time.time(),file_sha,allow_expired=sys.argv[1]!='--execute')
    need(file==ROOT/('operator/tools/'+op['toolCommit']+'/control-timeweb-database-backup.py'),'TOOL_PATH')
    need(os.uname().nodename=='msk-1-vm-z8ks' and os.uname().machine=='x86_64','HOST')
    if not supervisor:
        # The supervisor runs in systemd's private network namespace. Its host
        # binding is the frozen source daemon and admitted unit/namespace proof.
        ips=command(['/usr/bin/hostname','-I'],'HOST').decode().split()
        need('100.77.212.57' in ips and '103.88.243.171' in ips,'HOST')
    if supervisor:
        need(is_namespace_operation(op) and sys.argv[3]==digest(request_bytes) and time.time()<utc(op['expiresAt']), 'NS_SUPERVISOR_ENTRY')
        tool_custody(op)
        work = ROOT/'backups'/('.disk-restore-' + digest(request_bytes))
        need(read_secure(work/'backup-operation.json') == request_bytes, 'NS_SUPERVISOR_CAPSULE')
        plan = namespace_validate_plan(op, request_bytes, strict(read_secure(work/'disk-plan.json')))
        journal = DiskJournal(work, plan['operationSha256'])
        need(journal.find('NAMESPACE_UNIT_START_INTENT') is not None, 'NS_SUPERVISOR_INTENT')
        namespace_supervisor(op, request_bytes, plan); return
    for sig in (signal.SIGTERM,signal.SIGINT):
        signal.signal(sig,lambda *_: (_ for _ in ()).throw(Stop('INTERRUPTED_UNCERTAIN')))
    if sys.argv[1] == '--attest-disk':
        result = namespace_verify_reference(op, request_bytes, file_sha) if is_namespace_operation(op) else disk_verify_reference(op, request_bytes, file_sha)
    elif sys.argv[1] == '--reconcile-disk':
        need(is_disk_operation(op), 'DISK_RECONCILIATION_ONLY')
        with disk_mutation_lock():
            result = reconcile_namespace(op, request_bytes, file_sha) if is_namespace_operation(op) else reconcile_disk(op, request_bytes, file_sha)
    elif is_disk_operation(op):
        with disk_mutation_lock():
            result = execute(op, request_bytes, file_sha)
    else:
        result = execute_tmpfs(op, request_bytes, file_sha)
    print(json.dumps(result,separators=(',',':')))


if __name__=='__main__':
    try:
        main()
    except Exception as error:
        code=str(error) if isinstance(error,Stop) else 'UNEXPECTED_FAILURE'
        print(json.dumps({'status':'STOP','code':code,'replayAllowed':False,'cleanup':'REQUIRES_EXACT_OWNER_RECONCILIATION'},separators=(',',':')))
        sys.exit(1)
