"""Mock-only regression scenarios; no Docker, provider or database is contacted."""
import base64
from contextlib import ExitStack
import copy
import importlib.util
import io
import re
import shutil
import json
import os
import socket
import time
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('backup',Path(__file__).with_name('control-timeweb-database-backup.py'))
m=importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
API=copy.deepcopy(m.API_BASELINE)
PG={'id':m.PG_ID,'image':m.PG_IMAGE,'imageId':m.PG_IMAGE.split('@')[1],'releaseId':None,'revision':None,'restarts':0,'startedAt':'2026-08-28T16:49:17.916395698Z'}
LEDGER=[['0001_initial.sql','c'*64],['0002_next.sql','d'*64]]
OP={'schema':'PHUB_TIMEWEB_BACKUP_OPERATION_V1','target':m.TARGET,'toolCommit':'1'*40,'toolFileSha256':'2'*64,'releaseId':'3'*40+'-38060874880-1','controllerSha':'3'*40,'controllerTree':'4'*40,'controllerConfigSha256':'5'*64,'expectedBoundarySha256':'6'*64,'toolProofSha256':'7'*64,'toolInstallationSha256':'8'*64,'expectedApi':API,'expectedPostgres':PG,'expiresAt':'2026-10-10T16:00:00.000Z','confirmation':'BACKUP_RESTORE_'+'3'*12+'_KEEP_API_0D6078BE7A50'}
NOW=m.utc('2026-10-10T15:20:00.000Z')
# The old release's synthetic ledger must not grow when main gains a new migration.
FROZEN_API_WORKER=json.loads(Path(__file__).with_name('fixtures').joinpath('timeweb-api-worker-ledger-8158ac44.json').read_text())
assert FROZEN_API_WORKER['sourceSha']==m.API_WORKER_CANDIDATE.split('-',1)[0]
API_WORKER_LEDGER=[[row['filename'],row['checksum']] for row in FROZEN_API_WORKER['ledger']]
assert len(API_WORKER_LEDGER)==102
assert m.digest(m.encoded(API_WORKER_LEDGER))==m.API_WORKER_LEDGER_SHA256
OP_API={**OP,'schema':'PHUB_TIMEWEB_BACKUP_OPERATION_API_WORKER_V2','candidateReleaseId':m.API_WORKER_CANDIDATE,
        'expectedLedgerSha256':m.API_WORKER_LEDGER_SHA256,
        'controllerSourceCiRunId':'38170498441','migrationPlanSha256':'a'*64,'migrationSuccessSha256':'b'*64,
        'confirmation':'BACKUP_RESTORE_API_WORKER_8158AC445C9F_KEEP_API_0D6078BE7A50'}
del OP_API['releaseId']


def v2_operation(plan_sha='a'*64, success_sha='b'*64):
    return {**OP_API,'toolCommit':OP_API['controllerSha'],'migrationPlanSha256':plan_sha,'migrationSuccessSha256':success_sha}


def restore_row(container, operation_sha, tmpfs_bytes, state):
    return {'Id':container,'Config':{'Image':m.PG_IMAGE,'User':'postgres','Volumes':{'/var/lib/postgresql/data':{}},'Labels':{'phub.backup-operation':operation_sha}},
            'HostConfig':{'NetworkMode':'none','ReadonlyRootfs':True,'Binds':None,'PortBindings':{},'Tmpfs':m.restore_tmpfs(tmpfs_bytes),
                          'Privileged':False,'AutoRemove':False,'RestartPolicy':{'Name':'no','MaximumRetryCount':0},'CapAdd':None,'CapDrop':['ALL'],
                          'SecurityOpt':['no-new-privileges'],'PidsLimit':128,'Memory':tmpfs_bytes+512*1024**2,'MemorySwap':tmpfs_bytes+512*1024**2,
                          'NanoCpus':1000000000,'PublishAllPorts':False,'Links':None,'Devices':[],'DeviceRequests':None,'VolumesFrom':None,'PidMode':'','IpcMode':'private'},
            'Mounts':[{'Type':'tmpfs','Destination':key,'RW':True}for key in m.restore_tmpfs(tmpfs_bytes)],'State':{'Status':state}}


def source_proof(script=b'synthetic reviewed helper'):
    import base64
    blob=m.git_oid('blob',script)
    scripts=b'100644 control-timeweb-database-backup.py\0'+bytes.fromhex(blob)
    root=b'40000 scripts\0'+bytes.fromhex(m.git_oid('tree',scripts))
    commit=b'tree '+m.git_oid('tree',root).encode()+b'\nauthor Test <synthetic@example.invalid> 1 +0000\ncommitter Test <synthetic@example.invalid> 1 +0000\n\nfixture\n'
    def obj(kind,raw):return {'oid':m.git_oid(kind,raw),'sha256':m.digest(raw),'base64':base64.b64encode(raw).decode()}
    return {'schema':'PHUB_TIMEWEB_BACKUP_SOURCE_PROOF_V1','repository':{'name':'Z6v6e6r/lk2','id':1297548073},'path':'scripts/control-timeweb-database-backup.py',
            'commit':obj('commit',commit),'rootTree':obj('tree',root),'scriptsTree':obj('tree',scripts),'blob':{'oid':blob,'sha256':m.digest(script)}}


class PureTests(unittest.TestCase):
    def test_ledger_query_survives_real_shell_quoting(self):
        with tempfile.TemporaryDirectory(prefix='phub-ledger-shell-') as directory:
            psql=Path(directory)/'psql'
            psql.write_text('#!/bin/sh\nprintf \'%s\\n\' "$@"\n')
            psql.chmod(0o700)
            result=subprocess.run(['/bin/sh','-eu','-c',m.SOURCE_LEDGER],
                                  env={'PATH':directory,'POSTGRES_USER':'synthetic_role','POSTGRES_DB':'synthetic_db'},
                                  capture_output=True,text=True,timeout=5)
            self.assertEqual(result.returncode,0,result.stderr)
            arguments=result.stdout.splitlines()
            self.assertIn('--username=synthetic_role',arguments)
            self.assertIn('--dbname=synthetic_db',arguments)
            self.assertIn('--command='+m.LEDGER_SQL,arguments)
            self.assertIn("'[]'::json",arguments[-1])

    def test_command_real_node_stdin_uses_clean_environment(self):
        env={key:m.ENV[key] for key in ['PATH','HOME','LANG','LC_ALL','GIT_CONFIG_NOSYSTEM','GIT_CONFIG_GLOBAL','GIT_OPTIONAL_LOCKS','GIT_NO_REPLACE_OBJECTS','GIT_NO_LAZY_FETCH','GIT_NO_PROMISOR_FETCH','GIT_ALTERNATE_OBJECT_DIRECTORIES']}
        program="import fs from 'node:fs';process.stdout.write(JSON.stringify({stdin:fs.readFileSync(0,'utf8'),docker:process.env.DOCKER_HOST??null,compose:process.env.COMPOSE_FILE??null,node:process.env.NODE_OPTIONS??null}));"
        node=shutil.which('node')
        self.assertIsNotNone(node)
        result=json.loads(m.command([node,'--input-type=module','-e',program],'NODE_TEST',input_data=b'fixture',environment=env))
        self.assertEqual(result,{'stdin':'fixture','docker':None,'compose':None,'node':None})

    def test_v2_controller_allowlist_matches_the_js_contract_exactly(self):
        contract=Path(__file__).with_name('timeweb-api-worker-contract.js').read_text()
        section=contract.split('export const API_WORKER_MIGRATION_CONTROLLER_FILES = new Set([',1)[1].split(']);',1)[0]
        self.assertEqual(set(re.findall(r"'([^']+)'",section)),m.API_WORKER_MIGRATION_CONTROLLER_FILES)

    def test_restore_image_accepts_only_frozen_official_digest_aliases(self):
        canonical = {'Os': 'linux', 'Architecture': 'amd64', 'RepoDigests': [m.PG_IMAGE]}
        short = m.PG_IMAGE.removeprefix('docker.io/library/')
        self.assertTrue(m.restore_image_admitted(canonical))
        self.assertTrue(m.restore_image_admitted({**canonical, 'RepoDigests': [short]}))
        invalid = [
            {'Os': 'windows'}, {'Architecture': 'arm64'}, {'RepoDigests': []},
            {'RepoDigests': None}, {'RepoDigests': short},
            {'RepoDigests': ['postgres:latest']}, {'RepoDigests': ['postgres@sha256:' + '0' * 64]},
            {'RepoDigests': ['untrusted.example/library/' + short]},
            {'RepoDigests': ['library/' + short]}, {'RepoDigests': [m.PG_IMAGE.upper()]},
        ]
        for changes in invalid:
            with self.subTest(changes=changes):
                self.assertFalse(m.restore_image_admitted({**canonical, **changes}))

    def test_notification_pre102_profile_is_closed_and_keeps_legacy_profiles_frozen(self):
        op={**copy.deepcopy(OP),'schema':m.NOTIFICATION_PRE105_SCHEMA,'profile':'production',
            'toolCommit':OP['controllerSha'],'releaseId':OP['controllerSha']+'-100-1','controllerSourceCiRunId':'100',
            'expectedLedgerSha256':m.API_WORKER_LEDGER_SHA256,'packageDescriptorSha256':'a'*64,'catalogsSha256':'b'*64,
            'expectedApi':{**API,'image':m.WEB8158_IMAGE,'imageId':m.WEB8158_IMAGE.split('@')[1],
                           'revision':m.MIGRATION_BASE_SHA,'releaseId':m.API_WORKER_CANDIDATE},
            'confirmation':'BACKUP_RESTORE_NOTIFICATION_PRE102_PRIVATE_NAMESPACE_KEEP_API_8158AC445C9F'}
        self.assertEqual(m.validate_operation(op,NOW,'2'*64),op)
        self.assertEqual(m.operation_mode(op),('notification-pre105',op['releaseId']))
        self.assertTrue(m.is_namespace_operation(op));self.assertTrue(m.is_disk_operation(op))
        self.assertEqual(m.disk_ledger_sha(op),m.API_WORKER_LEDGER_SHA256)
        for change in ({'expectedLedgerSha256':m.API_WORKER_PRE_LEDGER_SHA256},{'expectedLedgerSha256':'0'*64},
                       {'controllerPromotion':{}},{'profile':'beta'},{'catalogsSha256':'missing'},
                       {'confirmation':'BACKUP'},{'unexpected':True},
                       {'expectedPostgres':{**PG,'id':'a'*64}}):
            with self.subTest(change=change):
                with self.assertRaises(m.Stop):m.validate_operation({**op,**change},NOW,'2'*64)

    def test_notification_restore_role_closure_is_private_restricted_and_quotes_ddl(self):
        acl=[{'grantor':'phub_beta','grantee':'phub_beta','privilege':'CONNECT','grantable':False}]
        security={'schema':'PHUB_NOTIFICATION_BACKUP_SECURITY_V1','roles':['phub_beta'],
          'unsupported':{'largeObjects':0,'securityLabels':0},
          'objects':[{'key':'database','kind':'database','owner':'phub_beta','props':{},'acl':acl}]}
        self.assertEqual(m.validate_notification_security(security),security)
        sql=m.notification_restore_prerequisites(security)
        self.assertIn('nologin nosuperuser nobypassrls nocreatedb nocreaterole noreplication noinherit',sql)
        self.assertIn('alter database phub_restore owner to "phub_beta"',sql)
        self.assertNotIn('password',sql.lower());self.assertNotIn('membership',sql.lower())
        missing_database_create={**security,'roles':['phub_beta','phub_runtime'],'objects':security['objects']+[{'key':'extension:pg_trgm','kind':'extension','owner':'phub_runtime','acl':[],'props':{'name':'pg_trgm','schema':'public','version':'1.6'}}]}
        with self.assertRaisesRegex(m.Stop,'NOTIFICATION_SECURITY_EXTENSION_DATABASE_CREATE'):
            m.notification_restore_prerequisites(missing_database_create)
        for patch in ({'roles':['phub_restore']},{'roles':['unreviewed_role']},
                      {'unsupported':{'largeObjects':1,'securityLabels':0}},
                      {'unsupported':{'largeObjects':0,'securityLabels':1}}):
            with self.assertRaises(m.Stop):m.notification_restore_prerequisites({**security,**patch})

    def test_exact_request(self):
        self.assertEqual(m.validate_operation(copy.deepcopy(OP),NOW,'2'*64),OP)

    def test_request_negative_boundaries(self):
        changes=[('schema','OTHER'),('target',{'hostname':'other'}),('toolFileSha256','f'*64),('toolCommit','main'),('releaseId','3'*40+'-123-2'),('controllerSha','4'*40),('confirmation','BACKUP'),('expiresAt','2026-10-10T15:30:00.000Z'),('expiresAt','2026-10-10T16:30:00.000Z')]
        for key,value in changes:
            with self.subTest(key=key,value=value):
                op=copy.deepcopy(OP);op[key]=value
                with self.assertRaises(m.Stop):m.validate_operation(op,NOW,'2'*64)
        op=copy.deepcopy(OP);op['unknown']='value'
        with self.assertRaises(m.Stop):m.validate_operation(op,NOW,'2'*64)

    def test_api_worker_request_is_closed_to_the_candidate_and_json_ledger(self):
        actual=m.validate_operation(v2_operation(),NOW,'2'*64)
        self.assertEqual(m.operation_mode(actual),('api-worker',m.API_WORKER_CANDIDATE))
        for key,value in [('candidateReleaseId','4'*40+'-39366813227-1'),('expectedLedgerSha256','f'*64),
                          ('confirmation','BACKUP_RESTORE_API_WORKER_KEEP_API')]:
            with self.subTest(key=key):
                op=copy.deepcopy(OP_API);op[key]=value
                with self.assertRaises(m.Stop):m.validate_operation(op,NOW,'2'*64)

    def test_v2_requires_bound_migration_proof_hashes(self):
        self.assertEqual(m.validate_operation(v2_operation(),NOW,'2'*64)['schema'],'PHUB_TIMEWEB_BACKUP_OPERATION_API_WORKER_V2')
        for key,value in [('migrationPlanSha256','x'),('migrationSuccessSha256','f'*63),('controllerSourceCiRunId','0')]:
            op=v2_operation();op[key]=value
            with self.assertRaises(m.Stop):m.validate_operation(op,NOW,'2'*64)

    def test_v2_migration_proof_requires_lineage_capsule_success_and_reconciliation(self):
        with tempfile.TemporaryDirectory(prefix='phub-v2-proof-') as directory:
            root=Path(directory);tx=root/'backups'/(m.API_WORKER_CANDIDATE+'-migration');tx.mkdir(parents=True)
            operation_bytes=b'{"migration":"operation"}\n'
            plan={'schema':'PHUB_TIMEWEB_API_WORKER_MIGRATION_PLAN_V1','controllerSha':OP['controllerSha'],'controllerTree':OP['controllerTree'],'controllerSourceCiRunId':'38170498441','candidate':m.API_WORKER_CANDIDATE,'migratorImage':'sha256:fixed','imageId':'sha256:fixed','preLedgerSha256':m.API_WORKER_PRE_LEDGER_SHA256,'postLedgerSha256':m.API_WORKER_LEDGER_SHA256,'operationSha256':m.digest(operation_bytes),'secretSet':{},'runtime':{},'backup':{},'roleProbeSourceSha256':'e'*64}
            plan_bytes=m.encoded(plan);capsule=m.encoded({'schema':'PHUB_TIMEWEB_API_WORKER_MIGRATION_CAPSULE_V1','operation':base64.b64encode(operation_bytes).decode(),'plan':base64.b64encode(plan_bytes).decode()})
            role=m.encoded({'schema':'PHUB_TIMEWEB_MIGRATION_ROLE_PROOF_V1','planSha256':m.digest(plan_bytes),'operationSha256':m.digest(operation_bytes),'observedAt':'2026-10-10T15:00:00.000Z','target':{},'runtime':{},'migrator':{}})
            success=m.encoded({'schema':'PHUB_TIMEWEB_API_WORKER_MIGRATION_SUCCESS_V1','status':'SUCCESS','planSha256':m.digest(plan_bytes),'operationSha256':m.digest(operation_bytes),'containerId':'c'*64,'roleProofSha256':m.digest(role),'observedAt':'2026-10-10T15:00:00.000Z'})
            receipt=m.encoded({'schema':'PHUB_TIMEWEB_API_WORKER_MIGRATION_RECEIPT_V1','status':'RECONCILED','planSha256':m.digest(plan_bytes),'operationSha256':m.digest(operation_bytes),'observedAt':'2026-10-10T15:00:00.000Z','containerId':'c'*64,'successSha256':m.digest(success),'reconciledStatus':'SUCCESS'})
            files={tx/'preparation.json':capsule,tx/'plan.json':plan_bytes,tx/'role-proof.json':role,tx/'migration-success.json':success,tx/'migration-receipt.json':receipt}
            op=v2_operation(m.digest(plan_bytes),m.digest(success));op['controllerSha']=OP['controllerSha'];op['controllerTree']=OP['controllerTree']
            for path,data in files.items():path.write_bytes(data)
            raw=b':000000 100644 '+b'0'*40+b' '+b'b'*40+b' A\0scripts/control-timeweb-database-backup.py\0'
            def command(args,code,**kwargs):
                if args[0]=='/usr/bin/node':
                    valid=files[tx/'migration-success.json']==success and files[tx/'migration-receipt.json']==receipt
                    return m.encoded({'schema':'PHUB_TIMEWEB_MIGRATION_BACKUP_ATTESTATION_V1' if valid else 'invalid','containerId':'c'*64,'imageId':'sha256:'+'e'*64,'proofSha256':'f'*64})
                if 'rev-parse' in args:return (m.MIGRATION_BASE_TREE+'\n').encode()
                if 'merge-base' in args:return b''
                if 'diff' in args:return raw
                raise AssertionError(args)
            def read(path,*args):return files[Path(path)]
            with patch.object(m,'ROOT',root),patch.object(m,'LOCK',root/'standard/active'),patch.object(m,'command',side_effect=command),patch.object(m,'read_secure',side_effect=read),patch.object(m,'secure',return_value=SimpleNamespace()):
                m.v2_migration_proof(op,b'backup request',root/'source')
                for path,data in [(tx/'migration-success.json',m.encoded({**m.strict(success),'status':'FAILED'})),(tx/'migration-receipt.json',m.encoded({**m.strict(receipt),'successSha256':'e'*64}))]:
                    files[path]=data
                    with self.assertRaises(m.Stop):m.v2_migration_proof(op,b'backup request',root/'source')
                    files[path]=success if path.name=='migration-success.json' else receipt

    def test_frozen_ci_download_pair_requires_exact_oids_modes_atomic_paths(self):
        pair=list(m.API_WORKER_CI_DOWNLOAD_PATCH.values())+list(m.API_WORKER_CI_READER_PATCH.values())
        def raw(rows):return b''.join((':'+v['oldMode']+' '+v['newMode']+' '+v['oldOid']+' '+v['newOid']+' '+v['status']+'\0'+v['path']+'\0').encode()for v in rows)
        m.validate_migration_controller_delta(raw(pair))
        invalid=[pair[:1],pair[:2],pair[2:],pair[:-1],[dict(v,newOid=v['oldOid'])if i==2 else v for i,v in enumerate(pair)],pair+[pair[0]],pair+[dict(pair[0],path='.github/workflows/other.yaml')]]
        for field,value in [('oldOid','a'*40),('newOid','b'*40),('newMode','100755'),('newMode','120000'),('oldMode','000000'),('status','A'),('status','D'),('status','R100')]:
            invalid.append([dict(pair[0],**{field:value})]+pair[1:])
        for rows in invalid:
            with self.assertRaises(m.Stop):m.validate_migration_controller_delta(raw(rows))
        contract=(Path(__file__).parent/'timeweb-api-worker-contract.js').read_text()
        section=contract.split('export const API_WORKER_CI_DOWNLOAD_PATCH = Object.freeze([',1)[1].split(']);',1)[0]
        js={}
        for item in re.findall(r'Object.freeze\(\{(.*?)\}\)',section,re.S):
            value=dict(re.findall(r"(path|status|oldMode|newMode|oldOid|newOid):\s*'([^']+)'",item));js[value['path']]=value
        self.assertEqual(js,m.API_WORKER_CI_DOWNLOAD_PATCH)
        section=contract.split('export const API_WORKER_CI_READER_PATCH = Object.freeze([',1)[1].split(']);',1)[0]
        js={}
        for item in re.findall(r'Object.freeze\(\{(.*?)\}\)',section,re.S):
            value=dict(re.findall(r"(path|status|oldMode|newMode|oldOid|newOid):\s*'([^']+)'",item));js[value['path']]=value
        self.assertEqual(js,m.API_WORKER_CI_READER_PATCH)

    def test_promotion_and_android_test_groups_are_exact_atomic_and_match_both_languages(self):
        import hashlib
        contract=(Path(__file__).parent/'timeweb-api-worker-contract.js').read_text()
        for name in ['API_WORKER_CONTROLLER_PROMOTION_PATCH','API_WORKER_ANDROID_CHAT_TEST_PATCH']:
            pins=getattr(m,name);rows=list(pins.values())
            def raw(items):return b''.join((':'+v['oldMode']+' '+v['newMode']+' '+v['oldOid']+' '+v['newOid']+' '+v['status']+'\0'+v['path']+'\0').encode()for v in items)
            ordinary=dict(rows[0],path='scripts/timeweb-api-worker-contract.js')
            for case in [rows,rows+[ordinary],[ordinary]]:m.validate_migration_controller_delta(raw(case))
            invalid=[rows+[rows[0]],rows+[dict(rows[0],path='scripts/unreviewed-promotion.js')]]
            if len(rows)>1:invalid.append(rows[1:])
            for index in range(len(rows)):
                for field,value in [('oldOid','a'*40),('newOid','b'*40),('oldMode','000000'),('newMode','100755'),('newMode','120000'),('status','A'),('status','D')]:
                    invalid.append([dict(row,**{field:value})if i==index else row for i,row in enumerate(rows)])
            for case in invalid:
                with self.subTest(group=name,case=case),self.assertRaises(m.Stop):m.validate_migration_controller_delta(raw(case))
            section=contract.split('export const '+name+' = Object.freeze([',1)[1].split(']);',1)[0]
            js={}
            for item in re.findall(r'Object.freeze\(\{(.*?)\}\)',section,re.S):
                value=dict(re.findall(r"(path|status|oldMode|newMode|oldOid|newOid):\s*'([^']+)'",item));js[value['path']]=value
            self.assertEqual(js,pins)
            for row in rows:
                self.assertNotIn(row['path'],m.API_WORKER_MIGRATION_CONTROLLER_FILES)
                data=(Path(__file__).parents[1]/row['path']).read_bytes()
                self.assertEqual(hashlib.sha1(b'blob '+str(len(data)).encode()+b'\0'+data).hexdigest(),row['newOid'])

    def test_inert_rehearsal_pair_is_exact_atomic_and_matches_source_and_javascript(self):
        import hashlib
        rows=list(m.API_WORKER_REHEARSAL_READINESS_PATCH.values())
        def raw(items):return b''.join((':'+v['oldMode']+' '+v['newMode']+' '+v['oldOid']+' '+v['newOid']+' '+v['status']+'\0'+v['path']+'\0').encode()for v in items)
        ordinary=dict(rows[0],path='scripts/timeweb-api-worker-contract.js')
        for case in [rows,rows+[ordinary],[ordinary]]:m.validate_migration_controller_delta(raw(case))
        invalid=[rows[:1],rows[1:],rows+[rows[0]],rows+[dict(rows[0],path='scripts/unreviewed-compose.js')]]
        for index in range(2):
            for field,value in [('oldOid','a'*40),('newOid','b'*40),('oldMode','000000'),('oldMode','100755'),('oldMode','120000'),('newMode','100755'),('newMode','120000'),('newMode','160000'),('status','A'),('status','D'),('status','R100'),('path','scripts/unreviewed-compose.js')]:
                invalid.append([dict(row,**{field:value})if i==index else row for i,row in enumerate(rows)])
        for case in invalid:
            with self.subTest(case=case),self.assertRaises(m.Stop):m.validate_migration_controller_delta(raw(case))
        for row in rows:
            self.assertNotIn(row['path'],m.API_WORKER_MIGRATION_CONTROLLER_FILES)
            data=(Path(__file__).parents[1]/row['path']).read_bytes()
            self.assertEqual(hashlib.sha1(b'blob '+str(len(data)).encode()+b'\0'+data).hexdigest(),row['newOid'])
        import subprocess
        js="import {API_WORKER_REHEARSAL_READINESS_PATCH as p} from './scripts/timeweb-api-worker-contract.js';process.stdout.write(JSON.stringify(p));"
        result=subprocess.run([shutil.which('node'),'--input-type=module','-e',js],cwd=Path(__file__).parents[1],env={'PATH':os.environ.get('PATH','')},capture_output=True,check=True)
        self.assertEqual(json.loads(result.stdout),rows)

    def test_runtime_negative_boundaries(self):
        for service,key,value in [('expectedApi','restarts',1),('expectedApi','releaseId','other'),('expectedApi','revision','4'*40),('expectedPostgres','id','5'*64),('expectedPostgres','image','postgres:latest'),('expectedPostgres','imageId','sha256:'+'6'*64)]:
            with self.subTest(service=service,key=key):
                op=copy.deepcopy(OP);op[service][key]=value
                with self.assertRaises(m.Stop):m.validate_operation(op,NOW,'2'*64)

    def test_duplicate_and_nonfinite_json(self):
        for value in ['{"a":1,"a":2}','{"nested":{"a":1,"a":2}}','{"a":NaN}','{"a":Infinity}','invalid']:
            with self.subTest(value=value):
                with self.assertRaises(m.Stop):m.strict(value)

    def test_canonical_ledger(self):
        self.assertEqual(m.ledger_bytes(json.dumps(list(reversed(LEDGER)))),m.encoded(LEDGER))

    def test_ledger_refuses_malformed_empty_ambiguous(self):
        invalid=[[],{},[LEDGER[0],LEDGER[0]],[['0001_foo.sql','bad']],[['../0001_foo.sql','c'*64]],[['0001_foo\n.sql','c'*64]],[['0001_foo.sql','c'*64,'extra']],[[1,'c'*64]]]
        for rows in invalid:
            with self.subTest(rows=rows):
                with self.assertRaises(m.Stop):m.ledger_bytes(json.dumps(rows))

    def test_capacity_with_reserve(self):
        value=m.capacity(1024**3,8*1024**3,20*1024**3)
        self.assertEqual(value,3*1024**3+256*1024**2)
        for args in [(0,10**12,10**12),(True,10**12,10**12),(m.MAX_DUMP+1,10**12,10**12),(1024**3,1024**3,20*1024**3),(1024**3,8*1024**3,1024**3)]:
            with self.subTest(args=args):
                with self.assertRaises(m.Stop):m.capacity(*args)

    def test_path_custody_refuses_owner_mode_links_type(self):
        base={'st_uid':0,'st_gid':0,'st_mode':stat.S_IFREG|0o600,'st_nlink':1}
        m.secure_info(SimpleNamespace(**base),'file',0o600)
        for key,value in [('st_uid',1),('st_gid',1),('st_mode',stat.S_IFLNK|0o600),('st_mode',stat.S_IFREG|0o620),('st_nlink',2),('st_mode',stat.S_IFDIR|0o700)]:
            with self.subTest(key=key,value=value):
                info=SimpleNamespace(**{**base,key:value})
                with self.assertRaises(m.Stop):m.secure_info(info,'file',0o600)

    def test_restore_plan_is_networkless_unmounted_and_never_pulls(self):
        args=m.restore_create_args('phub-timeweb-restore-'+('3'*12)+'-38060874880-1','2'*64,1024**3)
        self.assertEqual(args[args.index('--network')+1],'none')
        self.assertEqual(args[args.index('--pull')+1],'never')
        self.assertIn('--read-only',args)
        self.assertEqual(args[-1],m.PG_IMAGE)
        for forbidden in ['--rm','--privileged','--volume','--mount','--publish','--net=host']:
            self.assertNotIn(forbidden,args)
        self.assertEqual(sum(1 for arg in args if arg=='--tmpfs'),3)
        with self.assertRaises(m.Stop):m.restore_create_args('foreign','2'*64,1024**3)

    def test_command_redacts_error_and_uses_fixed_environment(self):
        with patch.object(m.subprocess,'run',return_value=SimpleNamespace(returncode=1,stdout=b'SECRET_CANARY')) as run:
            with self.assertRaisesRegex(m.Stop,'DUMP') as error:m.command(['/fixed'],'DUMP')
            self.assertNotIn('SECRET_CANARY',str(error.exception))
            self.assertEqual(run.call_args.kwargs['stderr'],m.subprocess.DEVNULL)
            self.assertEqual(run.call_args.kwargs['env'],m.ENV)


    def test_source_proof_and_negative_object_chain(self):
        script=b'synthetic reviewed helper';proof=source_proof(script);op=copy.deepcopy(OP)
        op.update(toolCommit=proof['commit']['oid'],toolProofSha256=m.digest(m.encoded(proof)),toolFileSha256=m.digest(script))
        m.verify_source_proof(proof,op,script)
        for key in ['commit','rootTree','scriptsTree','blob']:
            with self.subTest(key=key):
                bad=copy.deepcopy(proof);bad[key]['oid']='f'*40
                changed=copy.deepcopy(op);changed['toolProofSha256']=m.digest(m.encoded(bad))
                with self.assertRaises(m.Stop):m.verify_source_proof(bad,changed,script)
        for key,value in [('repository',{'name':'other/repo','id':1297548073}),('path','scripts/other.py')]:
            bad=copy.deepcopy(proof);bad[key]=value
            changed=copy.deepcopy(op);changed['toolProofSha256']=m.digest(m.encoded(bad))
            with self.assertRaises(m.Stop):m.verify_source_proof(bad,changed,script)
        with self.assertRaises(m.Stop):m.verify_source_proof(proof,op,script+b'changed')

    def test_binary_tree_rejects_duplicate_truncation_modes_and_paths(self):
        entry=b'100644 helper.py\0'+bytes.fromhex('f'*40)
        self.assertEqual(m.tree_entries(entry),{'helper.py':('100644','f'*40)})
        for raw in [entry+entry,entry[:-1],b'100600 file\0'+b'x'*20,b'100644 ../file\0'+b'x'*20,b'100644 \xff\0'+b'x'*20,entry+b'junk']:
            with self.subTest(raw=raw):
                with self.assertRaises(m.Stop):m.tree_entries(raw)

    def test_restore_inspection_rejects_each_containment_drift(self):
        row=restore_row('e'*64,'2'*64,1024**3,'running')
        def check(value):
            with patch.object(m,'docker',return_value=m.encoded(value)):m.inspect_restore('e'*64,'2'*64,1024**3,'running')
        check(row)
        fields={'NetworkMode':'host','ReadonlyRootfs':False,'Binds':['/live:/live'],'PortBindings':{'5432/tcp':[]},'Tmpfs':{},'Privileged':True,'AutoRemove':True,
                'RestartPolicy':{'Name':'always','MaximumRetryCount':0},'CapAdd':['SYS_ADMIN'],'CapDrop':[],'SecurityOpt':[],'PidsLimit':0,'Memory':0,'MemorySwap':-1,
                'NanoCpus':0,'PublishAllPorts':True,'Links':['other'],'Devices':[{}],'DeviceRequests':[{}],'VolumesFrom':['other'],'PidMode':'host','IpcMode':'host'}
        for key,value in fields.items():
            with self.subTest(field=key):
                bad=copy.deepcopy(row);bad['HostConfig'][key]=value
                with self.assertRaises(m.Stop):check(bad)
        for group,key,value in [('Config','User','root'),('Config','Volumes',{'/foreign':{}}),('State','Status','exited')]:
            bad=copy.deepcopy(row);bad[group][key]=value
            with self.assertRaises(m.Stop):check(bad)
        invalid_mounts=[[],row['Mounts'][:1],row['Mounts'][:2],[row['Mounts'][0]]*3,[{'Type':'tmpfs','Destination':'/foreign','RW':True}]*3,[{'Type':'volume','Destination':'/var/lib/postgresql/data','RW':True}]]
        for mounts in invalid_mounts:
            with self.subTest(mounts=mounts):
                bad=copy.deepcopy(row);bad['Mounts']=mounts
                with self.assertRaises(m.Stop):check(bad)
        bad=copy.deepcopy(row);bad['Mounts'][0]['RW']=False
        with self.assertRaises(m.Stop):check(bad)


    def test_installation_receipt_pins_file_inode_and_source_proof(self):
        script=b'synthetic reviewed helper';proof=source_proof(script);op=copy.deepcopy(OP)
        op.update(toolCommit=proof['commit']['oid'],toolProofSha256=m.digest(m.encoded(proof)),toolFileSha256=m.digest(script))
        path=m.ROOT/('operator/tools/'+op['toolCommit']+'/control-timeweb-database-backup.py')
        metadata={'dev':1,'ino':2,'uid':0,'gid':0,'mode':stat.S_IFREG|0o755,'nlink':1,'size':len(script)}
        receipt={'schema':'PHUB_TIMEWEB_BACKUP_INSTALLATION_V1','sourceProof':proof,'installedPath':str(path),'installedAt':'2026-10-10T15:00:00.000Z','installationPlanSha256':'a'*64,'metadata':metadata}
        encoded=m.encoded(receipt);op['toolInstallationSha256']=m.digest(encoded)
        info=SimpleNamespace(**{'st_'+k:v for k,v in metadata.items()})
        with patch.object(m,'read_secure',side_effect=lambda p,*args:script if p==path else encoded),patch.object(m,'secure',return_value=info):
            self.assertEqual(m.tool_custody(op),encoded)
            info.st_ino=3
            with self.assertRaisesRegex(m.Stop,'TOOL_METADATA'):m.tool_custody(op)
        with patch.object(m,'read_secure',side_effect=lambda p,*args:script+b'changed' if p==path else encoded):
            with self.assertRaisesRegex(m.Stop,'TOOL_CUSTODY'):m.tool_custody(op)

    def test_fixed_source_commands_are_read_only_and_noninteractive(self):
        for shell in [m.SOURCE_LEDGER,m.SOURCE_SIZE,m.SOURCE_DUMP]:
            self.assertIn('default_transaction_read_only=on',shell)
            self.assertIn('--no-password',shell)
        with self.assertRaises(m.Stop):m.source_query('arbitrary')

    def test_service_refuses_short_id_and_wrong_labels(self):
        with patch.object(m,'docker',return_value=b'a'*12):
            with self.assertRaisesRegex(m.Stop,'SERVICE_COUNT'):m.service('project','api')
        row={'Config':{'Labels':{},'Image':API['image']},'State':{'Status':'running','Health':{'Status':'healthy'}},'Id':API['id']}
        with patch.object(m,'docker',side_effect=[API['id'].encode(),m.encoded(row)]):
            with self.assertRaisesRegex(m.Stop,'SERVICE_IDENTITY'):m.service('project','api')


class Scenario:
    def __init__(self, directory, fault=None, operation=OP, ledger=LEDGER):
        self.runtime_api=copy.deepcopy(operation['expectedApi']);self.root=Path(directory);self.fault=fault;self.calls=[];self.container='e'*64
        self.ledger=ledger
        self.created=False;self.running=False;self.query_count=0;self.api_reads=0
        for path in ['operator','standard','backups','standard/source','standard/source/.git']:(self.root/path).mkdir(parents=True,exist_ok=True)
        self.request=self.root/'operator/database-backup-restore.json'
        self.request.write_bytes(m.encoded(operation))
        self.config=m.encoded({'controllerSha':operation['controllerSha'],'enabled':True})
        self.op=copy.deepcopy(operation);self.op['controllerConfigSha256']=m.digest(self.config)
        self.op['expectedBoundarySha256']=m.digest(m.encoded(sorted([self.service_row(True),self.service_row(False)],key=lambda r:r['Id'])))
        self.request.write_bytes(m.encoded(self.op))
        self.tmpfs=m.capacity(1024,10**12,10**12)

    def read(self,path,mode=0o600):
        if str(path)=='/etc/phub/timeweb-beta-standard-delivery.json':return self.config
        return Path(path).read_bytes()

    def command(self,args,code,**kwargs):
        self.calls.append(args)
        if args[0]=='/usr/bin/git':
            if args[-1]=='HEAD':return (self.op['controllerSha']+'\n').encode()
            if args[-1]=='HEAD^{tree}':return (self.op['controllerTree']+'\n').encode()
            return b''
        raise AssertionError('unmocked command: '+repr(args))

    def service_row(self,api):
        v=self.runtime_api if api else PG
        return {'Id':v['id'],'Image':v['imageId'],'Config':{'Image':v['image'],'Labels':{'phub.release-id':v['releaseId'],'org.opencontainers.image.revision':v['revision'],'com.docker.compose.project':'phub-timeweb-beta' if api else 'phub-timeweb-beta-dependencies','com.docker.compose.service':'api' if api else 'postgres'}},'RestartCount':v['restarts'],'State':{'Status':'running','StartedAt':v['startedAt'],'Health':{'Status':'healthy'}}}

    def docker(self,args,code='DOCKER_READ',**kwargs):
        self.calls.append(['/usr/bin/docker']+args)
        if self.fault==code and code not in ['DOCKER_READ','SOURCE_QUERY']:raise m.Stop(code)
        if args[0]=='ps':
            assert '--no-trunc' in args
            if '--filter' in args and '-aq' in args:return self.container.encode() if self.created else b''
            if '--filter' in args:
                filters=' '.join(args)
                if 'migrator' in filters:return b'a'*64 if self.fault=='migrator' else b''
                return self.runtime_api['id'].encode() if 'service=api' in filters else m.PG_ID.encode()
            return ('\n'.join([self.runtime_api['id'],m.PG_ID]+([self.container]if self.created else []))).encode()
        if args[0]=='inspect':
            target=args[-1]
            self.assert_no_environment(args)
            if target==self.container:
                row=restore_row(self.container,m.digest(m.encoded(self.op)),self.tmpfs,'running' if self.running else 'created')
                if not self.running and any(a[1]=='stop' for a in self.calls if len(a)>1):row['State']['Status']='exited'
            else:
                row=self.service_row(target==self.runtime_api['id'])
                if target==self.runtime_api['id']:
                    self.api_reads+=1
                    if self.fault=='runtime-drift' and self.api_reads>=4:row['RestartCount']=1
            return m.encoded(row)
        if args[:2]==['image','inspect']:return m.encoded({'Os':'linux','Architecture':'amd64','RepoDigests':[m.PG_IMAGE]})
        if args[0]=='create':self.created=True;return (self.container+'\n').encode()
        if args[0]=='start':self.running=True;return b''
        if args[0]=='stop':self.running=False;return b''
        if args[0]=='rm':self.created=False;return b''
        if args[0]=='exec':
            if m.SOURCE_DUMP in args:
                assert kwargs['file_limit']==2048+256*1024**2
                kwargs['stdout'].write(b'PGDMP synthetic fixture only')
                return b''
            if m.SOURCE_SIZE in args:return b'1024\n'
            if m.SOURCE_LEDGER in args:
                self.query_count+=1
                return m.encoded([['0001_changed.sql','f'*64]]) if self.fault=='source-ledger-drift' and self.query_count>1 else m.encoded(self.ledger)
            if 'pg_restore' in args:
                assert args[2]==self.container
                kwargs['stdin'].read()
                return b''
            if 'pg_isready' in args:return b''
            if '--command='+m.LEDGER_SQL in args:
                return m.encoded([['0001_changed.sql','f'*64]]) if self.fault=='restore-ledger-mismatch' else m.encoded(self.ledger)
        raise AssertionError('unmocked docker command: '+repr(args))

    def assert_no_environment(self,args):
        assert '.Config.Env' not in args[args.index('--format')+1]

    def invoke(self):
        real_read_text=Path.read_text
        def read_text(path,*args,**kwargs):
            return 'MemAvailable: 10000000 kB\n' if str(path)=='/proc/meminfo' else real_read_text(path,*args,**kwargs)
        with patch.object(m,'ROOT',self.root),patch.object(m,'REQUEST',self.request),patch.object(m,'LOCK',self.root/'standard/active'),patch.object(m,'secure',side_effect=lambda path,*args,**kwargs:Path(path).lstat()),patch.object(m,'read_secure',side_effect=self.read),patch.object(m,'docker',side_effect=self.docker),patch.object(m,'command',side_effect=self.command),patch.object(m,'tool_custody',return_value=b'validated-installation'),patch.object(m,'v2_migration_proof',return_value=None),patch.object(m.time,'time',return_value=NOW),patch.object(m.os,'statvfs',return_value=SimpleNamespace(f_bavail=50*1024**3,f_frsize=1)),patch.object(Path,'read_text',new=read_text):
            return m.execute(copy.deepcopy(self.op),m.encoded(self.op),'2'*64)


class PipelineTests(unittest.TestCase):
    def scenario(self,fault=None,operation=OP,ledger=LEDGER):
        tmp=tempfile.TemporaryDirectory(prefix='phub-backup-mock-')
        self.addCleanup(tmp.cleanup)
        return Scenario(tmp.name,fault,operation,ledger)

    def test_complete_mock_pipeline_emits_exact_receipt_then_removes_only_owned_restore(self):
        scenario=self.scenario()
        result=scenario.invoke()
        transaction=scenario.root/'backups'/('3'*40+'-38060874880-1-web')
        receipt=json.loads((transaction/'database-backup-receipt.json').read_bytes())
        self.assertEqual(set(receipt),{'schema','baselineReleaseId','completedAt','backupFile','backupSha256','restoreVerified','restoreImage','restoredLedgerSha256','sourceLedgerSha256'})
        self.assertEqual(receipt['schema'],'PHUB_TIMEWEB_DATABASE_BACKUP_RESTORE_V1')
        self.assertEqual(receipt['sourceLedgerSha256'],receipt['restoredLedgerSha256'])
        self.assertFalse(result['authorizesDeploy'])
        self.assertFalse((scenario.root/'standard/active').exists())
        mutations=[a for a in scenario.calls if a[0]=='/usr/bin/docker' and a[1] in ['create','start','stop','rm']]
        self.assertEqual([a[1]for a in mutations],['create','start','stop','rm'])
        self.assertTrue(all(a[-1]==scenario.container for a in mutations[1:]))

    def test_failures_preserve_lock_and_never_false_success(self):
        for fault in ['DUMP','RESTORE_CREATE','RESTORE_START','DUMP_TOC','RESTORE','RESTORE_STOP','RESTORE_REMOVE','runtime-drift','source-ledger-drift','restore-ledger-mismatch']:
            with self.subTest(fault=fault):
                scenario=self.scenario(fault)
                expected={'runtime-drift':'RUNTIME_DRIFT','source-ledger-drift':'SOURCE_LEDGER_DRIFT','restore-ledger-mismatch':'LEDGER_MISMATCH'}.get(fault,fault)
                with self.assertRaisesRegex(m.Stop,'^'+expected+'$'):scenario.invoke()
                transaction=scenario.root/'backups'/('3'*40+'-38060874880-1-web')
                self.assertTrue((scenario.root/'standard/active').is_dir())
                self.assertFalse((transaction/'SUCCESS_CLEANUP_VERIFIED.json').exists())
                if fault not in ['RESTORE_STOP','RESTORE_REMOVE']:self.assertFalse((transaction/'database-backup-receipt.json').exists())

    def test_foreign_lock_is_preserved_before_commands(self):
        scenario=self.scenario();lock=scenario.root/'standard/active';lock.write_text('foreign')
        with self.assertRaisesRegex(m.Stop,'EXISTING_STATE'):scenario.invoke()
        self.assertEqual(lock.read_text(),'foreign');self.assertEqual(scenario.calls,[])

    def test_existing_transaction_refuses_replay(self):
        scenario=self.scenario();transaction=scenario.root/'backups'/('3'*40+'-38060874880-1-web');transaction.mkdir()
        with self.assertRaisesRegex(m.Stop,'EXISTING_STATE'):scenario.invoke()
        self.assertEqual(scenario.calls,[])

    def test_active_migrator_stops_before_lock_and_dump(self):
        scenario=self.scenario('migrator')
        with self.assertRaisesRegex(m.Stop,'ACTIVE_MIGRATOR'):scenario.invoke()
        self.assertFalse((scenario.root/'standard/active').exists())
        self.assertFalse(any(m.SOURCE_DUMP in a for a in scenario.calls))

    def test_api_worker_backup_uses_the_candidate_path_and_exact_101_row_ledger(self):
        scenario=self.scenario(operation=OP_API,ledger=API_WORKER_LEDGER)
        result=scenario.invoke()
        transaction=scenario.root/'backups'/(m.API_WORKER_CANDIDATE+'-api-worker')
        receipt=json.loads((transaction/'database-backup-receipt.json').read_bytes())
        self.assertEqual(result['releaseId'],m.API_WORKER_CANDIDATE)
        self.assertEqual(receipt['sourceLedgerSha256'],m.API_WORKER_LEDGER_SHA256)
        self.assertEqual(receipt['restoredLedgerSha256'],m.API_WORKER_LEDGER_SHA256)

    def test_api_worker_rejects_99_row_ledger_before_dump_or_restore_creation(self):
        scenario=self.scenario(operation=OP_API,ledger=API_WORKER_LEDGER[:-2])
        with self.assertRaisesRegex(m.Stop,'^API_WORKER_LEDGER$'):scenario.invoke()
        self.assertFalse(any(m.SOURCE_DUMP in args for args in scenario.calls))
        self.assertFalse(any(args[0]=='/usr/bin/docker' and args[1] in ['create','start','stop','rm'] for args in scenario.calls))


class SourceWitnessTests(unittest.TestCase):
    def test_local_git_proof_roundtrip_refuses_dirty_and_overridden_sources(self):
        import subprocess
        source_spec=importlib.util.spec_from_file_location('prepare',Path(__file__).with_name('prepare-timeweb-database-backup-source.py'))
        source=importlib.util.module_from_spec(source_spec);source_spec.loader.exec_module(source)
        with tempfile.TemporaryDirectory(prefix='phub-backup-source-') as directory:
            repo=Path(directory);(repo/'scripts').mkdir()
            helper=repo/'scripts/control-timeweb-database-backup.py';helper.write_bytes(Path(m.__file__).read_bytes())
            environment={**m.ENV,'GIT_AUTHOR_NAME':'Synthetic Test','GIT_AUTHOR_EMAIL':'synthetic@example.invalid','GIT_COMMITTER_NAME':'Synthetic Test','GIT_COMMITTER_EMAIL':'synthetic@example.invalid'}
            def git(args):
                result=subprocess.run(['/usr/bin/git','-C',str(repo),'-c','core.hooksPath=/dev/null',*args],env=environment,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,check=False)
                self.assertEqual(result.returncode,0)
                return result.stdout
            git(['init','--initial-branch=main']);git(['remote','add','origin','https://github.com/Z6v6e6r/lk2.git']);git(['add','scripts/control-timeweb-database-backup.py']);git(['commit','-m','synthetic fixture'])
            commit=git(['rev-parse','HEAD']).decode().strip()
            proof=source.prepare(repo,commit)
            self.assertEqual(proof['commit']['oid'],commit)
            self.assertEqual(proof['blob']['sha256'],m.digest(helper.read_bytes()))
            op={'toolCommit':commit,'toolProofSha256':m.digest(m.encoded(proof)),'toolFileSha256':proof['blob']['sha256']}
            m.verify_source_proof(proof,op,helper.read_bytes())
            with self.assertRaisesRegex(source.backup.Stop,'SOURCE_NOT_CLEAN'):source.prepare(repo,'f'*40)
            helper.write_bytes(helper.read_bytes()+b'changed')
            with self.assertRaisesRegex(source.backup.Stop,'SOURCE_NOT_CLEAN'):source.prepare(repo,commit)
            git(['restore','scripts/control-timeweb-database-backup.py'])
            (repo/'.git/info/grafts').write_text('synthetic ambiguity')
            with self.assertRaisesRegex(source.backup.Stop,'SOURCE_OBJECT_OVERRIDE'):source.prepare(repo,commit)

def disk_operation(post=False):
    if post:
        return {**v2_operation(), 'schema': m.DISK_POST_SCHEMA,
                'confirmation': 'BACKUP_RESTORE_API_WORKER_DISK_LUKS2_8158AC445C9F_KEEP_API_0D6078BE7A50'}
    op = {**OP, 'schema': m.DISK_PRE_SCHEMA, 'toolCommit': OP['controllerSha'],
          'controllerSourceCiRunId': '38060874880', 'expectedLedgerSha256': m.API_WORKER_PRE_LEDGER_SHA256,
          'confirmation': 'BACKUP_RESTORE_PRE99_DISK_LUKS2_KEEP_API_0D6078BE7A50'}
    return op


def disk_restore_row(plan, container='e'*64, state='running'):
    row = restore_row(container, plan['operationSha256'], 512*1024**2, state)
    row['Config'].update(Env=['PGDATA=/var/lib/postgresql/data/phub-restore','POSTGRES_USER=phub_restore','POSTGRES_DB=phub_restore','POSTGRES_HOST_AUTH_METHOD=trust'], Cmd=['postgres'], Entrypoint=['docker-entrypoint.sh'])
    row['HostConfig']['LogConfig'] = {'Type':'none','Config':{}}
    row['HostConfig']['Tmpfs'] = m.DISK_COMMON_TMPFS.copy()
    row['HostConfig']['Memory'] = row['HostConfig']['MemorySwap'] = m.DISK_MEMORY
    row['Mounts'] = [{'Type': 'bind', 'Source': plan['mount'], 'Destination': '/var/lib/postgresql/data', 'RW': True, 'Propagation': 'rprivate'}]
    if state != 'created':
        row['Mounts'] += [{'Type': 'tmpfs', 'Destination': key, 'RW': True} for key in m.DISK_COMMON_TMPFS]
    row['State'].update(Pid=221 if state == 'running' else 0, StartedAt='2026-10-10T15:25:00.000Z')
    return row


class DiskPureTests(unittest.TestCase):
    def plan(self):
        op = disk_operation()
        return m.disk_plan(op, m.encoded(op), m.disk_sizing(1024**3, 8*1024**3, 30*1024**3))

    def mapper_readback(self, keysize='512 [bits]', status_changes=None, uuid=None, dm_uuid=None):
        plan=self.plan();loop='/dev/loop7';major,minor=253,2
        fields={'type':'LUKS2','cipher':'aes-xts-plain64','keysize':keysize,'device':loop,'mode':'read/write'}
        fields.update(status_changes or {})
        status=''.join('  '+key+': '+value+'\n' for key,value in fields.items()).encode()
        expected_uuid='CRYPT-LUKS2-'+plan['luksUuid'].replace('-','')+'-'+plan['mapperName']
        def tool(name,args,code,**kwargs):
            if name=='crypt' and args==['status',plan['mapperName']]:return status
            if name=='crypt' and args==['luksUUID',loop]:return ((uuid or plan['luksUuid'])+'\n').encode()
            if name=='dmsetup' and args==['info','--columns','--noheadings','--separator',':','--options','name,major,minor,uuid',plan['mapperName']]:
                return (plan['mapperName']+':'+str(major)+':'+str(minor)+':'+(dm_uuid or expected_uuid)+'\n').encode()
            raise AssertionError('unexpected mapper read command')
        block=SimpleNamespace(st_mode=stat.S_IFBLK|0o600,st_rdev=os.makedev(major,minor))
        with patch.object(m.os.path,'lexists',return_value=True),patch.object(m.os,'stat',return_value=block),patch.object(m,'disk_tool',side_effect=tool):
            return m.disk_mapper(plan,loop)

    def test_mapper_accepts_legacy_and_bracketed_cryptsetup_bit_units(self):
        for keysize in ['512 bits','512 [bits]']:
            with self.subTest(keysize=keysize):
                result=self.mapper_readback(keysize)
                self.assertEqual(result['device'],253)
                self.assertEqual(result['minor'],2)
                self.assertEqual(result['uuid'],'CRYPT-LUKS2-'+self.plan()['luksUuid'].replace('-','')+'-'+self.plan()['mapperName'])

    def test_mapper_rejects_wrong_sizes_units_and_extra_status_content(self):
        for keysize in ['256 bits','1024 [bits]','512 bytes','512 [bytes]','512bits','512 [bits] trailing','']:
            with self.subTest(keysize=keysize),self.assertRaisesRegex(m.Stop,'DISK_MAPPER_CUSTODY'):
                self.mapper_readback(keysize)

    def test_mapper_unit_compatibility_preserves_device_cipher_mode_and_uuid_checks(self):
        for change in [{'type':'LUKS1'},{'cipher':'aes-cbc-essiv:sha256'},{'device':'/dev/loop8'},{'mode':'readonly'}]:
            with self.subTest(change=change),self.assertRaisesRegex(m.Stop,'DISK_MAPPER_CUSTODY'):
                self.mapper_readback(status_changes=change)
        for changes in [{'uuid':'00000000-0000-0000-0000-000000000000'},{'dm_uuid':'CRYPT-LUKS2-foreign-device'}]:
            with self.subTest(changes=changes),self.assertRaisesRegex(m.Stop,'DISK_MAPPER_ID'):
                self.mapper_readback(**changes)

    def test_closed_pre_and_post_disk_schemas_bind_actual_ledger_and_distinct_authority(self):
        for post in (False, True):
            op = disk_operation(post)
            m.validate_operation(op, NOW, '2'*64)
            for key, value in [('expectedLedgerSha256', 'f'*64), ('confirmation', OP['confirmation']),
                               ('controllerSourceCiRunId', '0'), ('toolCommit', 'f'*40)]:
                bad = copy.deepcopy(op); bad[key] = value
                with self.subTest(post=post,key=key), self.assertRaises(m.Stop):
                    m.validate_operation(bad, NOW, '2'*64)
            bad = copy.deepcopy(op); bad['mountPath'] = '/live/pgdata'
            with self.assertRaises(m.Stop):m.validate_operation(bad, NOW, '2'*64)
        bad = disk_operation();bad['releaseId'] = OP['controllerSha']+'-1-1'
        with self.assertRaises(m.Stop):m.validate_operation(bad,NOW,'2'*64)

    def test_disk_fields_cannot_widen_existing_tmpfs_modes(self):
        for op in (OP, v2_operation()):
            bad = copy.deepcopy(op);bad['restoreStorage'] = 'disk'
            with self.assertRaises(m.Stop):m.validate_operation(bad,NOW,'2'*64)
            self.assertFalse(m.is_disk_operation(op))

    def test_disk_capacity_two_stage_allows_current_ram_but_preserves_full_data_and_reserve(self):
        db = 7021263895
        first = m.disk_sizing(db, 9348202496, 34485190656)
        self.assertEqual(first['restoreDataBytes'],21332227141)
        self.assertGreater(first['imageBytes'],first['restoreDataBytes'])
        self.assertEqual(first['imageBytes']%(4*1024**2),0)
        with self.assertRaises(m.Stop):m.capacity(db,9348202496,34485190656)
        self.assertEqual(m.disk_sizing(db,9348202496,34485190656,True),first)
        for args in [(db,m.DISK_MEMORY+2*1024**3-1,10**12),(db,10**12,first['dumpLimitBytes']+m.DISK_HEADROOM-1),
                     (0,10**12,10**12),(True,10**12,10**12)]:
            with self.subTest(args=args),self.assertRaises(m.Stop):m.disk_sizing(*args)
        with self.assertRaises(m.Stop):m.disk_sizing(db,10**12,first['imageBytes']+m.DISK_HEADROOM-1,True)

    def test_names_paths_uuid_and_sizes_derive_from_operation_bytes_not_operator_paths(self):
        p=self.plan();other=m.disk_plan(disk_operation(),m.encoded({**disk_operation(),'expiresAt':'2026-10-10T16:01:00.000Z'}),
                                       m.disk_sizing(1024**3,8*1024**3,30*1024**3))
        self.assertEqual(p['canonical'],str(m.ROOT/'backups'/(OP['releaseId']+'-web')))
        self.assertNotEqual(p['work'],other['work']);self.assertNotEqual(p['luksUuid'],other['luksUuid'])
        self.assertNotEqual(p['filesystemUuid'],p['luksUuid'])
        self.assertTrue(p['work'].endswith(p['operationSha256']))

    def test_disk_container_has_only_operation_storage_fixed_memory_and_two_tmpfs(self):
        p=self.plan();args=m.disk_container_args(p)
        self.assertEqual(args.count('--mount'),1);self.assertEqual(args.count('--tmpfs'),2)
        self.assertEqual(args[args.index('--memory')+1],str(m.DISK_MEMORY))
        self.assertEqual(args[args.index('--memory-swap')+1],str(m.DISK_MEMORY))
        self.assertIn('type=bind,src='+p['mount']+',dst=/var/lib/postgresql/data,bind-propagation=rprivate',args)
        for forbidden in ['--privileged','--volume','--device','--env-file','--publish','--rm']:self.assertNotIn(forbidden,args)
        with patch.object(m,'disk_expected_environment',return_value=disk_restore_row(p)['Config']['Env']):
            for state in ['created','running','exited']:m.validate_disk_container(disk_restore_row(p,state=state),p)

    def test_disk_container_rejects_all_containment_drift_and_extra_mounts(self):
        p=self.plan();row=disk_restore_row(p)
        changes={'NetworkMode':'host','ReadonlyRootfs':False,'Privileged':True,'AutoRemove':True,
                 'CapAdd':['SYS_ADMIN'],'CapDrop':[],'SecurityOpt':[],'PidsLimit':0,'Memory':0,'MemorySwap':-1,
                 'NanoCpus':0,'PublishAllPorts':True,'Links':['other'],'Devices':[{}],'DeviceRequests':[{}],
                 'VolumesFrom':['other'],'PidMode':'host','IpcMode':'host','Binds':['/live:/var/lib/postgresql/data'],
                 'Tmpfs':{},'PortBindings':{'5432/tcp':[]},'LogConfig':{'Type':'json-file','Config':{}}}
        for key,val in changes.items():
            bad=copy.deepcopy(row);bad['HostConfig'][key]=val
            with self.subTest(key=key),patch.object(m,'disk_expected_environment',return_value=row['Config']['Env']),self.assertRaises(m.Stop):m.validate_disk_container(bad,p)
        for key,val in [('Source','/live/pgdata'),('Propagation','rshared'),('RW',False),('Type','volume')]:
            bad=copy.deepcopy(row);bad['Mounts'][0][key]=val
            with self.subTest(key=key),patch.object(m,'disk_expected_environment',return_value=row['Config']['Env']),self.assertRaises(m.Stop):m.validate_disk_container(bad,p)
        for extra in [copy.deepcopy(row['Mounts'][0]),{'Type':'bind','Source':'/etc','Destination':'/etc','RW':False}]:
            bad=copy.deepcopy(row);bad['Mounts'].append(extra)
            with patch.object(m,'disk_expected_environment',return_value=row['Config']['Env']),self.assertRaises(m.Stop):m.validate_disk_container(bad,p)

    def test_mountinfo_parser_and_match_reject_shared_nested_wrong_device_root_and_options(self):
        raw='42 1 253:7 / /private/pgdata rw,nosuid,nodev,noexec,noatime - ext4 /dev/mapper/owned rw\n'
        rows=m.mountinfo_records(raw);mapper={'device':253,'minor':7}
        self.assertEqual(m.mountinfo_match(rows,'/private/pgdata',mapper,'/dev/mapper/owned')['id'],'42')
        escaped=m.mountinfo_records(raw.replace('/private/pgdata','/private/has\\040space'))
        self.assertEqual(escaped[0]['target'],'/private/has space')
        for bad in [raw.replace('253:7','253:8'),raw.replace(' / /private',' /other /private'),
                    raw.replace('noexec,',''),raw.replace(' - ext4',' shared:4 - ext4'),
                    raw+'43 42 253:7 / /private/pgdata/nested rw - ext4 /dev/mapper/owned rw\n']:
            with self.subTest(raw=bad),self.assertRaises(m.Stop):m.mountinfo_match(m.mountinfo_records(bad),'/private/pgdata',mapper,'/dev/mapper/owned')
        with self.assertRaises(m.Stop):m.mountinfo_records(raw.replace('/private/pgdata','/private/\\q'))

    def test_journal_is_append_only_and_detects_missing_reordered_or_mutated_events(self):
        with tempfile.TemporaryDirectory(prefix='phub-disk-journal-') as directory:
            with patch.object(m,'secure',side_effect=lambda p,*a:Path(p).lstat()),patch.object(m,'read_secure',side_effect=lambda p,*a:Path(p).read_bytes()),patch.object(m,'rename_noreplace',side_effect=lambda a,b:os.rename(a,b)):
                j=m.DiskJournal(directory,'a'*64);j.add('PREPARED');j.add('LOCKED',identity={'ino':1})
                self.assertEqual(m.DiskJournal(directory,'a'*64).find('LOCKED'),{'identity':{'ino':1}})
                p=Path(directory)/'disk-event-0001.json';raw=p.read_bytes();value=json.loads(raw);value['previousSha256']='f'*64;p.write_bytes(m.encoded(value))
                with self.assertRaises(m.Stop):m.DiskJournal(directory,'a'*64)
                p.write_bytes(raw);(Path(directory)/'disk-event-0000.json').unlink()
                with self.assertRaises(m.Stop):m.DiskJournal(directory,'a'*64)

    def test_image_requires_preexisting_inode_proof_exact_allocation_and_no_replacement(self):
        p=self.plan();info=SimpleNamespace(st_dev=1,st_ino=2,st_uid=0,st_gid=0,st_mode=stat.S_IFREG|0o600,st_nlink=1,
                                         st_size=p['imageBytes'],st_blocks=p['imageBytes']//512)
        journal=SimpleNamespace(find=lambda phase:{'identity':m.storage_identity(info)})
        with patch.object(m.os.path,'lexists',return_value=True),patch.object(m,'secure',return_value=info):
            m.disk_image(p,journal)
            info.st_blocks=0
            with self.assertRaisesRegex(m.Stop,'SPARSE'):m.disk_image(p,journal)
            info.st_blocks=p['imageBytes']//512;expected=m.storage_identity(info);info.st_ino=3
            with self.assertRaises(m.Stop):m.disk_image(p,SimpleNamespace(find=lambda phase:{'identity':expected}))
        with patch.object(m.os.path,'lexists',return_value=True):
            with self.assertRaises(m.Stop):m.disk_image(p,SimpleNamespace(find=lambda phase:None))

    def test_ephemeral_key_prerequisites_are_not_required_for_abort_cleanup(self):
        fake=SimpleNamespace(st_mode=stat.S_IFREG|0o755)
        with patch.object(m.sys,'platform','linux'), patch.object(m.os,'uname',return_value=SimpleNamespace(machine='x86_64')), \
             patch.object(m,'secure',return_value=fake) as custody, patch.object(m.Path,'is_dir',return_value=True), \
             patch.object(m.Path,'exists',return_value=True), patch.object(m.Path,'read_text',return_value='nodev ext4'), \
             patch.object(m.resource,'setrlimit'), patch('ctypes.CDLL',return_value=SimpleNamespace(renameat2=lambda:None)), \
             patch.object(m,'disk_tool',side_effect=AssertionError('create-only command')):
            m.disk_prerequisites(cleanup=True)
        self.assertNotIn(m.DISK_TOOLS['mkfs'],[v.args[0]for v in custody.call_args_list])
        self.assertNotIn(m.DISK_TOOLS['mount'],[v.args[0]for v in custody.call_args_list])

    def test_cleanup_requires_atomic_publication_primitive_but_not_key_custody(self):
        fake=SimpleNamespace(st_mode=stat.S_IFREG|0o755)
        with patch.object(m.sys,'platform','linux'), patch.object(m.os,'uname',return_value=SimpleNamespace(machine='x86_64')), \
             patch.object(m,'secure',return_value=fake), patch.object(m.Path,'is_dir',return_value=True), \
             patch.object(m.Path,'exists',return_value=True), patch.object(m.Path,'read_text',return_value='nodev ext4'), \
             patch.object(m.resource,'setrlimit'), patch('ctypes.CDLL',return_value=SimpleNamespace()):
            with self.assertRaisesRegex(m.Stop,'DISK_NOREPLACE_UNAVAILABLE'):m.disk_prerequisites(cleanup=True)

    def test_docker_namespace_is_proven_before_any_database_writer(self):
        fake_stat='44 (dockerd) '+ ' '.join(['S']+['0']*18+['123'])
        with patch.object(m,'secure'),patch.object(m,'command',return_value=b'44\n'), \
             patch.object(m.Path,'read_text',return_value=fake_stat),patch.object(m.os,'readlink',return_value='/usr/bin/dockerd'), \
             patch.object(m.os,'stat',return_value=SimpleNamespace(st_ino=11)):
            self.assertEqual(m.disk_daemon_namespace(),{'pid':44,'startTicks':'123','namespace':11})
        with patch.object(m,'secure'),patch.object(m,'command',return_value=b'44\n'), \
             patch.object(m.Path,'read_text',return_value=fake_stat),patch.object(m.os,'readlink',return_value='/usr/bin/dockerd'), \
             patch.object(m.os,'stat',side_effect=lambda p:SimpleNamespace(st_ino=12 if p=='/proc/44/ns/mnt' else 11)):
            with self.assertRaisesRegex(m.Stop,'DISK_DAEMON_NAMESPACE'):m.disk_daemon_namespace()

    def test_atomic_journal_partial_temporary_write_is_never_a_committed_event(self):
        with tempfile.TemporaryDirectory(prefix='phub-disk-atomic-journal-') as directory:
            work=Path(directory)
            def partial(path,data):
                Path(path).write_bytes(data[:17])
                raise m.Stop('SYNTHETIC_PARTIAL_WRITE')
            with patch.object(m,'secure',side_effect=lambda p,*a,**k:Path(p).lstat()),patch.object(m,'read_secure',side_effect=lambda p,*a:Path(p).read_bytes()), \
                 patch.object(m,'rename_noreplace',side_effect=lambda a,b:os.rename(a,b)):
                j=m.DiskJournal(work,'a'*64)
                with patch.object(m,'exclusive',side_effect=partial):
                    with self.assertRaises(m.Stop):j.add('PREPARED')
                self.assertFalse((work/'disk-event-0000.json').exists())
                self.assertEqual(m.DiskJournal(work,'a'*64).events,[])
                self.assertEqual(len(list(work.glob('.disk-write-*.tmp'))),1)
                m.DiskJournal(work,'a'*64).add('PREPARED')
                self.assertEqual(len(m.DiskJournal(work,'a'*64).events),1)

    def test_same_operation_mutators_are_serialized_and_lock_is_never_deleted(self):
        with tempfile.TemporaryDirectory(prefix='phub-disk-process-lock-') as directory:
            root=Path(directory);(root/'standard').mkdir()
            with patch.object(m,'ROOT',root),patch.object(m,'secure',side_effect=lambda p,*a,**k:Path(p).lstat()),patch.object(m,'secure_info'):
                with m.disk_mutation_lock():
                    with self.assertRaisesRegex(m.Stop,'DISK_PROCESS_BUSY'):
                        with m.disk_mutation_lock():self.fail('parallel mutator entered')
                with m.disk_mutation_lock():pass
                self.assertTrue((root/'standard/database-backup-disk-process.lock').exists())

    def test_fixed_environment_and_command_cannot_be_replaced_in_a_lost_ack_container(self):
        p=self.plan();row=disk_restore_row(p)
        with patch.object(m,'disk_expected_environment',return_value=row['Config']['Env']):
            for key,val in [('Cmd',['sh','-c','foreign']),('Entrypoint',['sh']),('Env',row['Config']['Env']+['LD_PRELOAD=/foreign']),
                            ('Labels',{**row['Config']['Labels'],'foreign':'label'})]:
                bad=copy.deepcopy(row);bad['Config'][key]=val
                with self.subTest(key=key),self.assertRaises(m.Stop):m.validate_disk_container(bad,p)



class DiskScenario(Scenario):
    """Only Linux/Docker primitives are simulated; capsule/journal/publish/lock I/O is real."""
    def __init__(self,directory,post=False,fault=None):
        super().__init__(directory,None,disk_operation(post),API_WORKER_LEDGER if post else API_WORKER_LEDGER[:-3])
        self.fault=fault;self.loop=None;self.mapper=None;self.mounted=False;self.stopped=False
        with patch.object(m,'ROOT',self.root):
            self.plan=m.disk_plan(self.op,m.encoded(self.op),m.disk_sizing(1024,10**12,50*1024**3))
        self.secret=b'SYNTHETIC_EPHEMERAL_KEY_CANARY_'*2+b'!!!!!!'
        self.secret=self.secret[:64].ljust(64,b'!')

    def trip(self,code,after=False):
        if self.fault==('after:'if after else 'before:')+code:raise m.Stop(code+'_UNCERTAIN')

    def docker(self,args,code='DOCKER_READ',**kwargs):
        self.trip(code)
        if args[0]=='inspect' and args[-1]==self.container:
            self.calls.append(['/usr/bin/docker']+args)
            state='running'if self.running else 'exited'if self.stopped else 'created'
            result=m.encoded(disk_restore_row(self.plan,self.container,state))
        else:
            saved=self.fault;self.fault=None
            try:result=super().docker(args,code,**kwargs)
            finally:self.fault=saved
            if args[0]=='stop':self.stopped=True
        self.trip(code,True)
        return result

    def tool(self,name,args,code,**kwargs):
        self.calls.append([m.DISK_TOOLS[name],*args]);self.trip(code)
        result=b''
        if name=='loop':
            if '--json' in args:
                rows=[]
                if self.loop:
                    info=Path(self.plan['image']).lstat()
                    rows=[{'name':self.loop,'back-file':self.plan['image'],'back-ino':info.st_ino,
                           'back-maj:min':f'{os.major(info.st_dev)}:{os.minor(info.st_dev)}','offset':0,
                           'sizelimit':self.plan['imageBytes'],'ro':False,'autoclear':False}]
                result=m.encoded({'loopdevices':rows})
            elif '--detach' in args:self.loop=None
            else:self.loop='/dev/loop7';result=(self.loop+'\n').encode()
        elif name=='crypt':
            if args[0]=='luksUUID':result=(self.plan['luksUuid']+'\n').encode()
            elif args[0]=='open':self.mapper={'device':253,'minor':7,'uuid':'synthetic-owned-mapper'}
            elif args[0]=='close':self.mapper=None
            if args[0] in ('open','luksFormat'):
                assert kwargs['input_data']==self.secret
                assert all(self.secret not in v.encode() for v in args)
                assert self.secret not in m.encoded(kwargs.get('environment',m.ENV))
        elif name=='blkid':result=(self.plan['filesystemUuid']+'\n').encode()
        elif name=='mount':self.mounted=True
        elif name=='umount':self.mounted=False;Path(self.plan['mount']).chmod(0o700)
        elif name=='mkfs':
            assert kwargs['environment']['MKE2FS_CONFIG']=='/dev/null'
        else:raise AssertionError((name,args,code))
        self.trip(code,True);return result

    def mapper_read(self,plan,loop,optional=False):
        if not self.mapper:m.need(optional,'DISK_MAPPER_MISSING')
        if self.mapper:m.need(loop==self.loop,'DISK_MAPPER_CUSTODY')
        return self.mapper

    def mount_read(self,plan,mapper,optional=False,complete=True):
        if not self.mounted:m.need(optional,'DISK_MOUNT_MISSING');return None
        m.need(mapper==self.mapper and self.mapper is not None,'DISK_MOUNT_CUSTODY')
        info=Path(self.plan['mount']).lstat()
        return {k:v for k,v in m.storage_identity(info).items()if k!='nlink'}

    def kernel(self,plan,mapper,row):
        m.need(row['State']['Status']=='running','DISK_RESTORE_RUNNING')
        return {'hostNamespace':11,'containerNamespace':12,'pid':row['State']['Pid'],'startedAt':row['State']['StartedAt'],
                'hostMount':{'target':plan['mount']},'containerMount':{'target':'/var/lib/postgresql/data'}}

    def journal(self):
        with patch.object(m,'read_secure',side_effect=lambda p,*a:Path(p).read_bytes()):
            return m.DiskJournal(self.plan['work'],self.plan['operationSha256'])

    def invoke(self,reconcile=False):
        from contextlib import ExitStack
        original_statvfs=os.statvfs
        original_urandom=os.urandom
        original_add=m.DiskJournal.add
        def fs(path):
            if str(path)==self.plan['mount']:return SimpleNamespace(f_bavail=self.plan['restoreDataBytes'],f_frsize=1,f_blocks=self.plan['restoreDataBytes'])
            return SimpleNamespace(f_bavail=50*1024**3,f_frsize=1,f_blocks=50*1024**3)
        def secure(path,*args,**kwargs):
            value=Path(path).lstat()
            if str(path)==self.plan['image']:
                result=SimpleNamespace(**{k:getattr(value,k)for k in dir(value)if k.startswith('st_')})
                result.st_blocks=value.st_size//512
                return result
            return value
        def phase(journal,phase,**metadata):
            self.trip('PHASE_'+phase)
            result=original_add(journal,phase,**metadata)
            self.trip('PHASE_'+phase,True);return result
        with ExitStack()as stack:
            for name,val in [('ROOT',self.root),('REQUEST',self.request),('LOCK',self.root/'standard/active')]:stack.enter_context(patch.object(m,name,val))
            for name,fn in [('secure',secure),('read_secure',self.read),('docker',self.docker),('command',self.command),('tool_custody',lambda op:b'validated-installation'),
                            ('v2_migration_proof',lambda *a:None),('disk_prerequisites',lambda **kwargs:None),('disk_private_parent',lambda p:None),
                            ('disk_daemon_namespace',lambda:{'pid':44,'startTicks':'123','namespace':11}),
                            ('disk_expected_environment',lambda:disk_restore_row(self.plan)['Config']['Env']),
                            ('disk_memory_available',lambda:10**12),('disk_tool',self.tool),('disk_mapper',self.mapper_read),('disk_mount',self.mount_read),
                            ('disk_kernel_mount_proof',self.kernel)]:stack.enter_context(patch.object(m,name,side_effect=fn))
            stack.enter_context(patch.object(m.time,'time',return_value=NOW))
            stack.enter_context(patch.object(m.os,'statvfs',side_effect=fs))
            stack.enter_context(patch.object(m.os,'posix_fallocate',side_effect=lambda fd,offset,size:os.ftruncate(fd,size),create=True))
            stack.enter_context(patch.object(m.os,'urandom',side_effect=lambda size:self.secret if size==64 else original_urandom(size)))
            stack.enter_context(patch.object(m,'rename_noreplace',side_effect=lambda source,dest:os.rename(source,dest)))
            stack.enter_context(patch.object(m.DiskJournal,'add',new=phase))
            # Only the actual Linux mapper path is virtual in this mock.
            original_lexists=m.os.path.lexists
            stack.enter_context(patch.object(m.os.path,'lexists',side_effect=lambda p:bool(self.mapper)if str(p)==self.plan['mapperPath'] else original_lexists(p)))
            return m.reconcile_disk(copy.deepcopy(self.op),m.encoded(self.op),'2'*64)if reconcile else m.execute(copy.deepcopy(self.op),m.encoded(self.op),'2'*64)


class DiskPipelineTests(unittest.TestCase):
    def scenario(self,post=False,fault=None):
        tmp=tempfile.TemporaryDirectory(prefix='phub-disk-backup-mock-');self.addCleanup(tmp.cleanup)
        return DiskScenario(tmp.name,post,fault)

    def test_both_real_consumer_paths_are_published_only_after_exact_cleanup(self):
        for post in (False,True):
            with self.subTest(post=post):
                s=self.scenario(post);result=s.invoke();canonical=Path(s.plan['canonical'])
                receipt=json.loads((canonical/'database-backup-receipt.json').read_bytes())
                self.assertEqual(len(receipt),9);self.assertEqual(receipt['sourceLedgerSha256'],s.plan['expectedLedgerSha256'])
                self.assertEqual(receipt['backupFile'],str(canonical/'database.pgcustom'))
                self.assertFalse((s.root/'standard/active').exists());self.assertFalse(s.created)
                self.assertFalse(s.loop);self.assertFalse(s.mapper);self.assertFalse(s.mounted)
                self.assertFalse(Path(s.plan['image']).exists());self.assertFalse(Path(s.plan['mount']).exists())
                self.assertFalse(result['authorizesDeploy'])
                events=s.journal().events
                phases=[v['phase']for v in events]
                self.assertLess(phases.index('STORAGE_CLEANUP_VERIFIED'),phases.index('PUBLISHED'))
                self.assertLess(phases.index('PUBLISHED'),phases.index('UNLOCK_INTENT'))
                for p in Path(s.plan['work']).glob('*.json'):self.assertNotIn(s.secret,p.read_bytes())

    def test_every_mutating_command_lost_ack_retains_lock_and_reconcile_never_replays(self):
        codes=['DUMP','DISK_LOOP_ATTACH','DISK_LUKS_FORMAT','DISK_MAPPER_OPEN','DISK_FS_FORMAT','DISK_MOUNT',
               'DISK_RESTORE_CREATE','DISK_RESTORE_START','RESTORE','DISK_RESTORE_STOP','DISK_RESTORE_REMOVE',
               'DISK_UNMOUNT','DISK_MAPPER_CLOSE','DISK_LOOP_DETACH']
        for when in ('before:','after:'):
            for code in codes:
                with self.subTest(fault=when+code):
                    s=self.scenario(True,when+code)
                    with self.assertRaises(m.Stop):s.invoke()
                    self.assertTrue((s.root/'standard/active').exists())
                    self.assertFalse(Path(s.plan['canonical']).exists())
                    old=len(s.calls);s.fault=None;s.invoke(True)
                    forbidden={'create','start'}
                    for args in s.calls[old:]:
                        self.assertFalse(args[0]=='/usr/bin/docker'and(args[1]in forbidden or m.SOURCE_DUMP in args or 'pg_restore'in args))
                        self.assertFalse(args[0]==m.DISK_TOOLS['crypt']and args[1]in ['open','luksFormat'])
                        self.assertNotEqual(args[0],m.DISK_TOOLS['mkfs'])
                    s.invoke(True)
                    self.assertFalse((s.root/'standard/active').exists())
                    self.assertFalse(Path(s.plan['image']).exists())

    def test_after_each_durable_phase_reconciliation_preserves_canonical_admission(self):
        phases=['LOCK_PREPARED','LOCK_PUBLISH_INTENT','LOCKED','DUMP_INTENT','DUMP_VERIFIED','IMAGE_CREATE_INTENT','IMAGE_CREATED',
                'IMAGE_ALLOCATE_INTENT','IMAGE_ALLOCATED','LOOP_ATTACH_INTENT','LOOP_ATTACHED','LUKS_FORMAT_INTENT',
                'LUKS_FORMATTED','MAPPER_OPEN_INTENT','MAPPER_OPENED','FS_FORMAT_INTENT','FS_FORMATTED',
                'MOUNTPOINT_CREATE_INTENT','MOUNTPOINT_CREATED','MOUNT_INTENT','MOUNTED','RESTORE_CREATE_INTENT','RESTORE_CREATED','RESTORE_START_INTENT',
                'RESTORE_STARTED','RESTORE_INTENT','RESTORE_VERIFIED','PUBLISH_READY','CONTAINER_STOP_INTENT',
                'CONTAINER_STOPPED','CONTAINER_REMOVE_INTENT','CONTAINER_REMOVED','UNMOUNT_INTENT','UNMOUNTED',
                'MOUNTPOINT_REMOVE_INTENT','MOUNTPOINT_REMOVED','MAPPER_CLOSE_INTENT','MAPPER_CLOSED','LOOP_DETACH_INTENT',
                'LOOP_DETACHED','IMAGE_UNLINK_INTENT','IMAGE_UNLINKED','STORAGE_CLEANUP_VERIFIED','PUBLISH_INTENT','PUBLISHED','UNLOCK_INTENT']
        for phase in phases:
            with self.subTest(phase=phase):
                s=self.scenario(False,'after:PHASE_'+phase)
                with self.assertRaises(m.Stop):s.invoke()
                s.fault=None;s.invoke(True)
                events=s.journal()
                self.assertIsNotNone(events.find('RECONCILED'))
                self.assertEqual(Path(s.plan['canonical']).exists(),events.find('PUBLISH_READY')is not None)
                self.assertFalse((s.root/'standard/active').exists())

    def test_foreign_lock_canonical_path_and_replay_are_never_overwritten(self):
        s=self.scenario();lock=s.root/'standard/active';lock.write_text('foreign')
        with self.assertRaises(m.Stop):s.invoke()
        self.assertEqual(lock.read_text(),'foreign');self.assertEqual(s.calls,[])
        s=self.scenario();Path(s.plan['canonical']).mkdir()
        with self.assertRaises(m.Stop):s.invoke()
        s=self.scenario();s.invoke()
        with self.assertRaises(m.Stop):s.invoke()

    def test_partial_unlock_reconciliation_finishes_only_exact_owned_empty_lock(self):
        s=self.scenario(False,'after:PHASE_UNLOCK_INTENT')
        with self.assertRaises(m.Stop):s.invoke()
        marker=s.root/'standard/active/backup-restore.json';marker.unlink()
        s.fault=None;s.invoke(True)
        self.assertFalse((s.root/'standard/active').exists())
        s=self.scenario(False,'after:PHASE_UNLOCK_INTENT')
        with self.assertRaises(m.Stop):s.invoke()
        (s.root/'standard/active/foreign').write_text('foreign')
        s.fault=None
        with self.assertRaises(m.Stop):s.invoke(True)
        self.assertTrue((s.root/'standard/active/foreign').exists())

    def test_missing_owned_lock_or_marker_before_unlock_intent_is_not_authorized_by_new_intent(self):
        for entire in (False,True):
            s=self.scenario(False,'before:PHASE_UNLOCK_INTENT')
            with self.assertRaises(m.Stop):s.invoke()
            marker=s.root/'standard/active/backup-restore.json';marker.unlink()
            if entire:marker.parent.rmdir()
            s.fault=None
            with self.assertRaises(m.Stop):s.invoke(True)
            self.assertIsNone(s.journal().find('UNLOCK_INTENT'))

    def test_mountpoint_disappearance_before_removal_intent_requires_manual_resolution(self):
        s=self.scenario(False,'after:PHASE_MOUNTPOINT_CREATED')
        with self.assertRaises(m.Stop):s.invoke()
        Path(s.plan['mount']).rmdir();s.fault=None
        with self.assertRaisesRegex(m.Stop,'DISK_MOUNTPOINT_DISAPPEARED'):s.invoke(True)
        self.assertTrue((s.root/'standard/active').exists())
        self.assertTrue(Path(s.plan['image']).exists())

    def test_raw_filesystem_gaps_stop_without_claiming_unrecorded_resources(self):
        # These crash windows deliberately need exact-owner manual incident handling.
        for phase in ('LOCK_PREPARED','IMAGE_CREATED','MOUNTPOINT_CREATED'):
            s=self.scenario(False,'before:PHASE_'+phase)
            with self.assertRaises(m.Stop):s.invoke()
            s.fault=None;before=list(s.calls)
            with self.subTest(phase=phase),self.assertRaises(m.Stop):s.invoke(True)
            self.assertFalse(Path(s.plan['canonical']).exists())
            self.assertFalse(any(v[0]==m.DISK_TOOLS['mkfs'] for v in s.calls[len(before):]))

    def test_pending_lock_with_foreign_inventory_is_never_published(self):
        s=self.scenario(False,'after:PHASE_LOCK_PREPARED')
        with self.assertRaises(m.Stop):s.invoke()
        foreign=Path(s.plan['pendingLock'])/'foreign';foreign.write_text('foreign');s.fault=None
        with self.assertRaises(m.Stop):s.invoke(True)
        self.assertTrue(foreign.exists());self.assertFalse((s.root/'standard/active').exists())

    def test_boundary_labels_affect_digest_without_persisting_unrelated_private_metadata(self):
        s=self.scenario()
        original=s.service_row
        canary='SYNTHETIC_PRIVATE_LABEL_CANARY'
        def labelled(api):
            row=original(api);row['Config']['Labels']['private-note']=canary;return row
        s.service_row=labelled
        s.op['expectedBoundarySha256']=m.digest(m.encoded(sorted([labelled(True),labelled(False)],key=lambda r:r['Id'])))
        s.request.write_bytes(m.encoded(s.op))
        with patch.object(m,'ROOT',s.root):s.plan=m.disk_plan(s.op,m.encoded(s.op),m.disk_sizing(1024,10**12,50*1024**3))
        s.invoke()
        self.assertEqual(json.loads((Path(s.plan['work'])/'boundary.json').read_bytes()),{'sha256':s.op['expectedBoundarySha256']})
        for path in Path(s.plan['work']).glob('*.json'):self.assertNotIn(canary.encode(),path.read_bytes())




def namespace_operation(post=False):
    op=disk_operation(post); op['schema']=m.NS_POST_SCHEMA if post else m.NS_PRE_SCHEMA
    op['confirmation']='BACKUP_RESTORE_API_WORKER_PRIVATE_NAMESPACE_ISOLATED_DOCKERD_8158AC445C9F_KEEP_API_0D6078BE7A50' if post else 'BACKUP_RESTORE_PRE99_PRIVATE_NAMESPACE_ISOLATED_DOCKERD_KEEP_API_0D6078BE7A50'
    return op


NS_IMAGE={'Id':'sha256:'+'9'*64,'Os':'linux','Architecture':'amd64','RepoDigests':[m.PG_IMAGE],
          'Size':300*1024**2,'RootFS':{'Type':'layers','Layers':['sha256:'+'a'*64]},'Env':['PATH=/usr/bin:/bin']}


def namespace_fixture():
    op=namespace_operation(True);raw=m.encoded(op);sha=m.digest(raw)
    plan=m.namespace_plan(op,raw,m.namespace_sizing(3*1024**3,8*1024**3,40*1024**3,NS_IMAGE),NS_IMAGE);r=plan['isolation'];cg='/'+r['slice']+'/'+r['unit']
    def process(pid,exe,args,ns=12,group=cg,root=True):
        return {'pid':pid,'startTicks':str(100+pid),'executable':exe,'cmdline':args,'mountNamespace':ns,
                'uid':[0 if root else 999]*4,'gid':[0 if root else 999]*4,'cgroup':'0::'+group}
    tool=str(m.ROOT/'operator/tools'/op['toolCommit']/'control-timeweb-database-backup.py')
    broker=process(45,'/usr/bin/python3.13',['/usr/bin/python3','-I','-S','-B',tool,'--disk-runtime-supervisor',str(m.REQUEST),sha])
    source=process(44,'/usr/bin/dockerd',['/usr/bin/dockerd'],11,'/system.slice/docker.service')
    daemon=process(46,'/usr/bin/dockerd',['/usr/bin/dockerd','--config-file',r['configFile']])
    child=process(47,'/usr/bin/containerd',['containerd','--config',r['execRoot']+'/containerd/containerd.toml'])
    cid='e'*64;shim=process(48,'/usr/bin/containerd-shim-runc-v2',['/usr/bin/containerd-shim-runc-v2','-namespace','phub-'+sha[:24],'-id',cid,'-address',r['execRoot']+'/containerd/containerd.sock'])
    pg=process(4242,'/usr/lib/postgresql/16/bin/postgres',['postgres'],13,'/'+r['slice']+'/docker-'+cid+'.scope',False)
    unit={'LoadState':'loaded','ActiveState':'active','SubState':'running','MainPID':'45','InvocationID':'a'*32,'ControlGroup':cg,
        'MemoryMax':str(2*1024**3),'MemorySwapMax':'0','TasksMax':'256','Delegate':'yes','CPUQuotaPerSecUSec':'1s','KillMode':'control-group',
        'SendSIGKILL':'yes','Restart':'no','TimeoutStopUSec':'30s','LimitCORE':'0','UMask':'0077','User':'root','Group':'root',
        'WorkingDirectory':plan['work'],'StandardInput':'null','StandardOutput':'null','StandardError':'null','Slice':r['slice'],'Transient':'yes',
        'NRestarts':'0','Result':'success','ExecMainCode':'0','ExecMainStatus':'0','PrivateNetwork':'yes','PrivateMounts':'no'}
    sl={'LoadState':'loaded','ActiveState':'active','ControlGroup':'/'+r['slice'],'Transient':'yes','MemoryMax':str(4*1024**3),'MemorySwapMax':'0','TasksMax':'384','CPUQuotaPerSecUSec':'2s'}
    def bounds(group,mem,pids,cpu):return {'identity':{'dev':29,'ino':1000+pids,'uid':0,'gid':0,'mode':0o40755},'path':'/sys/fs/cgroup'+group,
        'memory.max':str(mem),'memory.swap.max':'0','pids.max':str(pids),'cpu.max':str(cpu*100000)+' 100000'}
    b=bounds(cg,2*1024**3,256,1);sb=bounds('/'+r['slice'],4*1024**3,384,2)
    admission={'schema':'PHUB_TIMEWEB_PRIVATE_NAMESPACE_RECEIPT_V1','operationSha256':sha,'toolFileSha256':op['toolFileSha256'],
               'sourceDaemon':source,'supervisor':{'unit':unit,'process':broker,'bounds':b,'slice':{'unit':sl,'bounds':sb}},
               'network':{'sourceNamespace':21,'supervisorNamespace':22}}
    managed={'containerd':child,'config':{'version':2,'root':r['dataRoot']+'/containerd/daemon','state':r['execRoot']+'/containerd/daemon',
              'address':r['execRoot']+'/containerd/containerd.sock','disabledPlugins':['io.containerd.grpc.v1.cri']},'configSha256':'d'*64,'shims':[shim]}
    socket={'dev':64775,'ino':7003,'uid':0,'gid':0,'mode':0o140660,'nlink':1}
    isolation={'admission':admission,'process':daemon,'socket':socket,'info':{'DockerRootDir':r['dataRoot'],'Driver':'vfs','CgroupDriver':'systemd','LiveRestoreEnabled':False},'managed':managed}
    def mounts(target,root='/'):
        return '1 0 8:1 / / rw - ext4 /dev/root rw\n41 1 253:7 '+root+' '+target+' rw,nosuid,nodev,noexec,noatime - ext4 '+plan['mapperPath']+' rw\n'
    broker_m=mounts(plan['mount']);container_m=mounts('/var/lib/postgresql/data','/pgdata')
    alias_m=mounts('/media');mask_m=mounts('/run/containerd','/.runtime/run-containerd')
    runtime_m=('42 41 253:7 /.runtime/docker-data '+r['dataRoot']+' rw,nosuid,nodev,noexec,noatime shared:123 - ext4 '+plan['mapperPath']+' rw\n'
               '43 41 0:4 net:[23] '+r['execRoot']+'/netns/'+'a'*12+' rw - nsfs nsfs rw\n')
    storage={'image':{'dev':64775,'ino':7001,'uid':0,'gid':0,'mode':0o100600,'nlink':1},'loop':'/dev/loop7',
        'mapper':{'device':253,'minor':7,'uuid':'CRYPT-LUKS2-'+plan['luksUuid'].replace('-','')+'-'+plan['mapperName']},
        'mount':{'dev':64775,'ino':7002,'uid':0,'gid':0,'mode':0o40700}}
    container_bounds={'memory.max':str(2*1024**3),'memory.swap.max':'0','pids.max':'128','cpu.max':'100000 100000'}
    alias={'baseline':{'dev':2049,'ino':1687,'uid':0,'gid':0,'mode':0o40755,'nlink':2},'mount':storage['mount'],
           'brokerMount':m.mountinfo_records(alias_m)[1],'daemonMount':m.mountinfo_records(alias_m)[1]}
    mask={'baseline':{'dev':28,'ino':3582,'uid':0,'gid':0,'mode':0o40711},'source':{'dev':64775,'ino':7003,'uid':0,'gid':0,'mode':0o40700},
          'brokerMount':m.mountinfo_records(mask_m)[1],'daemonMount':m.mountinfo_records(mask_m)[1]}
    kernel={'containerProcess':pg,'containerBounds':container_bounds,'containerMembers':[pg],'containerNetworkNamespace':23,'networkSandboxKey':r['execRoot']+'/netns/'+'a'*12,'brokerMount':m.mountinfo_records(broker_m)[1],'daemonMount':m.mountinfo_records(broker_m)[1],'containerMount':m.mountinfo_records(container_m)[1]}
    row=disk_restore_row({**plan,'mount':r['pgdata']},cid);row['Image']=row['Config']['Image']=NS_IMAGE['Id']
    row['NetworkSettings']={'SandboxKey':r['execRoot']+'/netns/'+'a'*12}
    row['State']['Pid']=pg['pid'];row['HostConfig'].update(CgroupParent=r['slice'],CgroupnsMode='private')
    row['Config']['Env']=NS_IMAGE['Env']+['PGDATA=/var/lib/postgresql/data/phub-restore','POSTGRES_USER=phub_restore','POSTGRES_DB=phub_restore','POSTGRES_HOST_AUTH_METHOD=trust']
    container=m.disk_container_projection(row);container['Image']=row['Image'];container['HostConfig'].update(CgroupParent=r['slice'],CgroupnsMode='private')
    expected={k:op[k]for k in ['controllerSha','controllerTree','controllerSourceCiRunId','candidateReleaseId','migrationPlanSha256','migrationSuccessSha256']}
    value={'schema':'PHUB_TIMEWEB_DISK_RESTORE_READBACK_V2','operationSha256':sha,'storageProofSha256':'b'*64,'plan':plan,
        'readback':{'storage':storage,'alias':alias,'mask':mask,'runtimeMounts':{'dataRoot':m.mountinfo_records(runtime_m)[0],'network':m.mountinfo_records(runtime_m)[1]},'isolation':isolation,'kernel':{**kernel,'containerNetworkNamespace':23},'container':container,'image':{'source':NS_IMAGE,'imported':NS_IMAGE}},'migration':expected}
    runtime={'unit':unit,'slice':sl,'bounds':b,'sliceBounds':sb,'configSha256':managed['configSha256'],'members':[45,46,47,48],'containerBounds':container_bounds,'containerMembers':[pg]}
    processes={'broker':broker,'daemon':daemon,'source':source,'container':pg,'containerd':child,'shim':shim}
    mountinfo={'broker':broker_m+alias_m+mask_m+runtime_m,'daemon':broker_m+alias_m+mask_m+runtime_m,'source':'1 0 8:1 / / rw shared:1 - ext4 /dev/root rw\n','container':container_m,'containerd':broker_m+alias_m+mask_m+runtime_m,'shim':broker_m+alias_m+mask_m+runtime_m}
    actual={'selfNamespace':12,'afterSelfNamespace':12,'processes':processes,'afterProcesses':processes,'socket':socket,'sourceImage':NS_IMAGE,
        'privateImage':NS_IMAGE,'container':container,'afterContainer':copy.deepcopy(container),'runtime':runtime,'afterRuntime':runtime,
        'alias':{'mount':storage['mount'],'alias':storage['mount'],'sourceAlias':alias['baseline'],'sourceAliasEmpty':True,'daemonCwd':'/media','daemonCwdIdentity':storage['mount'],'mask':mask['source'],'maskSource':mask['source'],'sourceMask':mask['baseline'],'networkMountIdentity':{'dev':4,'ino':23},'containerNetworkIdentity':{'dev':4,'ino':23}},
        'afterAlias':{'mount':storage['mount'],'alias':storage['mount'],'sourceAlias':alias['baseline'],'sourceAliasEmpty':True,'daemonCwd':'/media','daemonCwdIdentity':storage['mount'],'mask':mask['source'],'maskSource':mask['source'],'sourceMask':mask['baseline'],'networkMountIdentity':{'dev':4,'ino':23},'containerNetworkIdentity':{'dev':4,'ino':23}},
        'network':{'source':21,'broker':22,'daemon':22,'containerd':22,'shim':22,'container':23},'afterNetwork':{'source':21,'broker':22,'daemon':22,'containerd':22,'shim':22,'container':23},'networkSandboxKey':row['NetworkSettings']['SandboxKey'],'afterNetworkSandboxKey':kernel['networkSandboxKey'],
        'mountinfo':mountinfo,'afterMountinfo':copy.deepcopy(mountinfo)}
    return {'nativePatch':list(m.API_WORKER_NATIVE_BOOKINGS_PATCH.values()),'operationBase64':base64.b64encode(raw).decode(),'expected':expected,'reference':{'schema':'PHUB_TIMEWEB_DISK_RESTORE_EXCLUSION_V2','storageProofSha256':'b'*64},'value':value,'actual':actual}


class NamespacePureTests(unittest.TestCase):
    def plan(self,post=False):
        op=namespace_operation(post)
        return m.namespace_plan(op,m.encoded(op),m.namespace_sizing(1024**3,8*1024**3,40*1024**3,NS_IMAGE),NS_IMAGE)

    def test_unix_socket_relative_alias_survives_absolute_path_limit(self):
        with tempfile.TemporaryDirectory(prefix='phub-unix-socket-') as directory:
            deep=Path(directory)/('a'*60)/('b'*60);deep.mkdir(parents=True)
            absolute=deep/'.runtime'/'docker.sock';absolute.parent.mkdir()
            self.assertGreater(len(str(absolute).encode()),107)
            blocked=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
            try:
                with self.assertRaises(OSError):blocked.bind(str(absolute))
            finally:blocked.close()
            old=os.getcwd();os.chdir(deep)
            try:
                relative=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
                try:
                    try:relative.bind('./.runtime/docker.sock')
                    except PermissionError:self.skipTest('execution sandbox forbids AF_UNIX bind')
                finally:relative.close()
            finally:os.chdir(old)

    def test_admission_does_not_load_implicit_units(self):
        p=self.plan();loaded=set();calls=[]
        def listing(args,*unused,**options):
            calls.append(args)
            self.assertEqual(args[0],'/usr/bin/systemctl')
            self.assertIn('--no-legend',args);self.assertIn('--no-pager',args)
            if args[1]=='list-unit-files':
                self.assertEqual(args[-1],'--no-pager')
                return b'unrelated.service disabled enabled\nother.target static -\n'
            self.assertEqual(args[1],'list-units');self.assertEqual(args[-2],'--')
            return (args[-1]+' loaded inactive\n').encode() if args[-1] in loaded else b''
        def loading(name,*unused):
            loaded.add(name)
            return {'LoadState':'loaded','ActiveState':'inactive','Transient':'no'}
        with patch.object(m,'command',side_effect=listing),patch.object(m,'namespace_show',side_effect=loading) as show:
            m.namespace_require_absent(p['isolation']['unit'])
            m.namespace_require_absent(p['isolation']['slice'])
            show.assert_not_called()
        self.assertEqual(loaded,set());self.assertEqual(len(calls),4)

    def test_admission_rejects_existing_loaded_or_file_backed_units(self):
        p=self.plan()
        for kind in ('unit','slice'):
            name=p['isolation'][kind]
            for state in ('inactive','active','transient'):
                with self.subTest(kind=kind,state=state),patch.object(m,'command',return_value=(name+' loaded '+state+'\n').encode()):
                    with self.assertRaisesRegex(m.Stop,'NS_SLICE_EXISTS' if kind=='slice' else 'NS_UNIT_EXISTS'):
                        m.namespace_require_absent(name)
            for state in ('static','enabled-runtime','generated','transient','masked','linked-runtime'):
                def listing(args,*unused,**options):
                    return b'' if args[1]=='list-units' else (name+' '+state+'\n').encode()
                with self.subTest(kind=kind,file=state),patch.object(m,'command',side_effect=listing):
                    with self.assertRaisesRegex(m.Stop,'NS_SLICE_EXISTS' if kind=='slice' else 'NS_UNIT_EXISTS'):
                        m.namespace_require_absent(name)

    def test_admission_rejects_bad_names_responses_and_command_failure(self):
        name=self.plan()['isolation']['slice']
        for bad in ('docker.service','../foreign.slice','--all',None,5):
            with self.subTest(name=bad),patch.object(m,'command') as command:
                with self.assertRaisesRegex(m.Stop,'NS_ADMISSION_UNIT_NAME'):m.namespace_require_absent(bad)
                command.assert_not_called()
        with patch.object(m,'command',return_value=b'malformed response'):
            with self.assertRaisesRegex(m.Stop,'NS_SLICE_EXISTS'):m.namespace_require_absent(name)
        for verb in ('list-units','list-unit-files'):
            def failure(args,*unused,**options):
                if args[1]==verb:raise m.Stop('NS_UNIT_ADMISSION')
                return b''
            with self.subTest(verb=verb),patch.object(m,'command',side_effect=failure):
                with self.assertRaisesRegex(m.Stop,'NS_UNIT_ADMISSION'):m.namespace_require_absent(name)

    def test_unit_file_inventory_accepts_unrelated_names_and_known_states(self):
        name=self.plan()['isolation']['slice']
        states=('enabled','enabled-runtime','linked','linked-runtime','alias','masked','masked-runtime',
                'static','disabled','indirect','generated','transient','bad')
        rows=''.join('unrelated'+str(i)+'.service '+state+'\n' for i,state in enumerate(states))
        rows+='prefix'+name+' disabled enabled\n'+name+'.service static -\n'
        with patch.object(m,'command',side_effect=lambda args,*a,**kw: b'' if args[1]=='list-units' else rows.encode()):
            m.namespace_require_absent(name)

    def test_unit_file_inventory_rejects_malformed_empty_duplicate_or_unknown(self):
        name=self.plan()['isolation']['slice']
        bad_rows=(b'',b'\n',b'a'*(1024**2+1),b'a.service static\n'*16385,b'a.service static\na.service disabled\n',
                  b'invalid static\n',b'a.service\n',b'a.service static - extra\n',b'a.service unknown -\n',
                  b'a.service static unknown\n',b'a.service static -\n\n',b'\xff.service static\n')
        for rows in bad_rows:
            with self.subTest(bytes=len(rows)),patch.object(m,'command',side_effect=lambda args,*a,**kw: b'' if args[1]=='list-units' else rows):
                with self.assertRaisesRegex(m.Stop,'NS_UNIT_ADMISSION_OUTPUT'):m.namespace_require_absent(name)

    def test_admission_failure_precedes_control_directory_and_start_intent(self):
        for kind in ('unit','slice'):
            with self.subTest(kind=kind),tempfile.TemporaryDirectory() as directory:
                p=self.plan();p['work']=directory;p['isolation']['controlRoot']=directory+'/runtime-control'
                name=p['isolation'][kind];journal=unittest.mock.Mock()
                def listing(args,*unused,**options):
                    if args[1]=='list-unit-files':return b'unrelated.service static -\n'
                    return (name+' loaded inactive\n').encode() if args[-1]==name else b''
                with patch.object(m,'secure',return_value=SimpleNamespace(st_mode=0o100755)),patch.object(m,'command',side_effect=listing),patch.object(m,'namespace_frozen_source') as frozen:
                    with self.assertRaisesRegex(m.Stop,'NS_SLICE_EXISTS' if kind=='slice' else 'NS_UNIT_EXISTS'):
                        m.namespace_start(p,{},journal)
                self.assertFalse(Path(p['isolation']['controlRoot']).exists())
                journal.add.assert_not_called();frozen.assert_not_called()

    def test_slice_start_ack_loss_keeps_only_durable_intent(self):
        with tempfile.TemporaryDirectory() as directory:
            p=self.plan();p['work']=directory;p['isolation']['controlRoot']=directory+'/runtime-control'
            journal=unittest.mock.Mock();calls=[]
            def command(args,*unused,**options):
                calls.append(args)
                if args[0]=='/usr/bin/busctl':raise m.Stop('NS_SLICE_START')
                return b'unrelated.service static -\n' if args[1]=='list-unit-files' else b''
            with patch.object(m,'secure',return_value=SimpleNamespace(st_mode=0o100755)),patch.object(m,'command',side_effect=command),patch.object(m,'namespace_frozen_source'),patch.object(m,'namespace_slice') as slice_read:
                with self.assertRaisesRegex(m.Stop,'NS_SLICE_START'):m.namespace_start(p,{},journal)
            journal.add.assert_called_once_with('NAMESPACE_SLICE_START_INTENT')
            slice_read.assert_not_called()
            self.assertEqual(calls[-1][calls[-1].index(p['isolation']['slice'])+1],'fail')
            self.assertFalse(any(args[0]=='/usr/bin/systemd-run' for args in calls))

    def test_closed_namespace_authority_never_downgrades_to_v1(self):
        for post in (False,True):
            op=namespace_operation(post);m.validate_operation(op,NOW,'2'*64)
            for key,value in [('schema',disk_operation(post)['schema']),('confirmation',disk_operation(post)['confirmation']),
                              ('expectedLedgerSha256','f'*64),('containerdSocket','/run/containerd/containerd.sock')]:
                bad=copy.deepcopy(op);bad[key]=value
                with self.subTest(post=post,key=key),self.assertRaises(m.Stop):m.validate_operation(bad,NOW,'2'*64)

    def test_capacity_reserves_vfs_and_aggregate_memory_without_changing_v1(self):
        p=self.plan();self.assertGreater(p['imageBytes'],m.disk_sizing(1024**3,8*1024**3,40*1024**3)['imageBytes'])
        for memory,free,after in [(6*1024**3-1,40*1024**3,False),(8*1024**3,p['imageBytes']+m.DISK_HEADROOM-1,True)]:
            with self.assertRaises(m.Stop):m.namespace_sizing(1024**3,memory,free,NS_IMAGE,after)
        altered=copy.deepcopy(NS_IMAGE);altered['RepoDigests']=[]
        m.namespace_image(altered,NS_IMAGE)
        with self.assertRaises(m.Stop):m.namespace_image(altered)
        # A containerd-image-store host reports the manifest digest while a classic isolated daemon
        # assigns the config digest: the exact ID may differ, the import binding is the journal event.
        drift=copy.deepcopy(altered);drift['Id']='sha256:'+'b'*64;m.namespace_image(drift,NS_IMAGE)
        for key,value in [('RootFS',{'Type':'layers','Layers':['sha256:'+'b'*64]}),('Env',['PATH=/foreign'])]:
            bad=copy.deepcopy(altered);bad[key]=value
            with self.subTest(key=key),self.assertRaises(m.Stop):m.namespace_image(bad,NS_IMAGE)

    def test_image_discovery_accepts_docker_prefixed_digests_only(self):
        digest='sha256:'+'a'*64
        self.assertEqual(m.namespace_image_id(digest),digest)
        for value in ['a'*64,digest.upper(),'sha256:'+'a'*63,'']:
            with self.subTest(value=value),self.assertRaises(m.Stop):m.namespace_image_id(value)

    @unittest.skipUnless(Path('/proc/self/stat').exists(),'requires Linux procfs')
    def test_transient_zombie_children_are_not_runtime_members(self):
        proc=subprocess.Popen([sys.executable,'-c','pass']);self.addCleanup(lambda:proc.wait())
        deadline=time.monotonic()+5
        while time.monotonic()<deadline:
            state=(Path('/proc')/str(proc.pid)/'stat').read_text().rsplit(')',1)[1].split()[0]
            if state=='Z':break
            time.sleep(0.02)
        self.assertEqual(state,'Z')
        self.assertEqual(m.namespace_live_pids([proc.pid,os.getpid()]),[os.getpid()])
        self.assertEqual(m.namespace_live_pids([2**30]),[])

    def test_closed_unit_slice_and_daemon_paths_cannot_touch_host_runtime(self):
        p=self.plan();cfg=m.namespace_config(p);args=m.namespace_unit_args(p,'/reviewed/helper.py')
        self.assertRegex(p['isolation']['slice'],r'^phubdiskrestore[a-f0-9]{24}\.slice$')
        self.assertIn('--slice='+p['isolation']['slice'],args)
        self.assertIn('--property=SendSIGKILL=yes',args);self.assertIn('--property=Restart=no',args)
        # systemd 259 otherwise creates a private mount namespace for PrivateNetwork=yes; the
        # supervisor's initial-namespace proof requires the host mount namespace, while network
        # isolation must remain enabled.
        self.assertIn('--property=PrivateNetwork=yes',args);self.assertIn('--property=PrivateMounts=no',args)
        self.assertIn('--property=MemoryMax=2147483648',args);self.assertIn('--property=TasksMax=256',args)
        self.assertEqual(cfg['hosts'],['unix:///media/.runtime/docker.sock']);self.assertEqual(cfg['cgroup-parent'],p['isolation']['slice'])
        self.assertEqual(cfg['storage-driver'],'vfs');self.assertFalse(cfg['iptables']);self.assertFalse(cfg['live-restore'])
        for key in ['data-root','exec-root','pidfile']:self.assertTrue(cfg[key].startswith('/media/.runtime/'))
        self.assertNotIn('containerd-plugins-namespace',cfg);self.assertNotIn('containerd-plugin-namespace',cfg)
        for endpoint in [cfg['hosts'][0].removeprefix('unix://'),p['isolation']['socket'],
                         p['isolation']['execRoot']+'/containerd/containerd.sock',
                         p['isolation']['execRoot']+'/containerd/debug.sock',
                         p['isolation']['execRoot']+'/containerd/s/'+'f'*64]:
            self.assertLessEqual(len(endpoint.encode()),107)
        self.assertNotIn('containerd',cfg);self.assertNotIn('/run/containerd/containerd.sock',m.encoded(cfg).decode())
        create=m.namespace_container_args(p)
        self.assertEqual(create[create.index('--cgroup-parent')+1],p['isolation']['slice'])
        self.assertIn(NS_IMAGE['Id'],create);self.assertNotIn(m.PG_IMAGE,create)
        self.assertIn('--pull',create);self.assertEqual(create[create.index('--pull')+1],'never')
        bus=m.namespace_slice_args(p)
        self.assertIn('ssa(sv)a(sa(sv))',bus);self.assertEqual(bus[-1],'0')
        self.assertIn('4294967296',bus);self.assertIn('384',bus);self.assertIn('2000000',bus)

    def test_private_socket_uses_fixed_relative_uri_and_owned_mount_cwd(self):
        p=self.plan(); calls=[]
        with patch.object(m,'namespace_socket',return_value={'socket':'custody'}),patch.object(m,'namespace_client_cwd',return_value=Path('/media')) as cwd,patch.object(m,'command',side_effect=lambda args,code,**kwargs:calls.append((args,code,kwargs)) or b'{}'):
            self.assertEqual(m.namespace_docker(p,['info'],'NS_TEST'),b'{}')
        self.assertEqual(calls,[(['/usr/bin/docker','--host','unix:///media/.runtime/docker.sock','info'],'NS_TEST',
            {'environment':{**m.ENV,'DOCKER_HOST':'unix:///media/.runtime/docker.sock'},'cwd':Path('/media')})])
        cwd.assert_called_once_with(p)
        with patch.object(m,'namespace_socket'),patch.object(m,'namespace_client_cwd') as owned,patch.object(m,'command') as command:
            with self.assertRaisesRegex(m.Stop,'NS_DOCKER_CWD_OVERRIDE'):m.namespace_docker(p,['info'],cwd='/foreign')
        owned.assert_not_called();command.assert_not_called()

    def test_private_client_cwd_requires_mounted_receipt_namespace_and_identity(self):
        p=self.plan()
        with patch.object(m,'DiskJournal'),patch.object(m,'namespace_alias_attest',return_value={'mount':{}}) as attest,patch.object(m,'namespace_mask_attest',return_value={'source':{}}) as mask:
            self.assertEqual(m.namespace_client_cwd(p),Path('/media'))
        attest.assert_called_once()
        mask.assert_called_once()
        with patch.object(m,'DiskJournal'),patch.object(m,'namespace_alias_attest',side_effect=m.Stop('NS_ALIAS_IDENTITY')),patch.object(m,'namespace_mask_attest'):
            with self.assertRaisesRegex(m.Stop,'NS_ALIAS_IDENTITY'):m.namespace_client_cwd(p)

    def test_private_daemon_cwd_is_exact_owned_mount(self):
        p=self.plan(); expected=SimpleNamespace(st_dev=1,st_ino=2,st_uid=0,st_gid=0,st_mode=0o40700,st_nlink=2)
        actual=copy.copy(expected)
        with patch.object(m,'namespace_client_cwd',return_value=Path('/owned/mount')),patch.object(m.os,'readlink',return_value='/owned/mount'),patch.object(Path,'stat',return_value=actual),patch.object(Path,'lstat',return_value=expected):
            self.assertEqual(m.namespace_daemon_cwd(p,46),m.storage_identity(expected))
        for link,info in [('/foreign/mount',actual),('/owned/mount',SimpleNamespace(**{**actual.__dict__,'st_ino':3}))]:
            with self.subTest(link=link),patch.object(m,'namespace_client_cwd',return_value=Path('/owned/mount')),patch.object(m.os,'readlink',return_value=link),patch.object(Path,'stat',return_value=info),patch.object(Path,'lstat',return_value=expected):
                with self.assertRaisesRegex(m.Stop,'NS_DAEMON_CWD'):m.namespace_daemon_cwd(p,46)

    def test_network_inode_is_fail_closed_when_process_disappears(self):
        with patch.object(m.os,'stat',side_effect=FileNotFoundError):
            with self.assertRaisesRegex(m.Stop,'NS_NETWORK_READ'):m.namespace_network(46)

    def test_runtime_root_attests_alias_before_any_filesystem_access(self):
        journal=unittest.mock.Mock();journal.find.return_value={}
        with patch.object(m,'namespace_alias_attest',side_effect=m.Stop('NS_ALIAS_NAMESPACE')),patch.object(Path,'mkdir') as mkdir,patch.object(m,'secure') as secure:
            with self.assertRaisesRegex(m.Stop,'NS_ALIAS_NAMESPACE'):m.namespace_runtime_root(self.plan(),journal)
        mkdir.assert_not_called();secure.assert_not_called();journal.add.assert_not_called()

    def test_runtime_root_retains_directory_custody_after_owned_children_and_rejects_replacement(self):
        with tempfile.TemporaryDirectory(prefix='phub-runtime-root-owned-') as directory:
            alias=Path(directory);events={'ALIAS_MOUNTED':{}};journal=unittest.mock.Mock()
            journal.find.side_effect=events.get
            journal.add.side_effect=lambda phase,**value:events.__setitem__(phase,value)
            def local_secure(path,kind,mode):
                info=Path(path).lstat()
                self.assertTrue(stat.S_ISDIR(info.st_mode));self.assertEqual(stat.S_IMODE(info.st_mode),mode)
                return info
            with patch.object(m,'NS_ALIAS',alias),patch.object(m,'namespace_alias_attest') as attest,patch.object(m,'secure',side_effect=local_secure):
                root=m.namespace_runtime_root(self.plan(),journal)
                self.assertEqual(set(events['RUNTIME_ROOT_CREATED']['identity']),{'dev','ino','uid','gid','mode'})
                for name in ['run-containerd','docker-data','docker-exec']:(root/name).mkdir(mode=0o700)
                self.assertEqual(m.namespace_runtime_root(self.plan(),journal),root)
                root.rename(alias/'retained-runtime');root.mkdir(mode=0o700)
                with self.assertRaisesRegex(m.Stop,'NS_RUNTIME_ROOT_DRIFT'):m.namespace_runtime_root(self.plan(),journal)
                self.assertEqual(attest.call_count,3)

    def test_startup_stderr_drain_caps_receipt_payload(self):
        stream=SimpleNamespace(fileno=lambda: 9); captured=bytearray(); chunks=[b'x'*65536,b'y'*8192,b'']
        with patch.object(m.os,'read',side_effect=chunks):
            m.namespace_startup_drain(stream,captured)
        self.assertEqual(len(captured),65536)

    def test_startup_stderr_drain_returns_for_continuously_readable_pipe(self):
        stream=SimpleNamespace(fileno=lambda: 9); captured=bytearray()
        with patch.object(m.os,'read',return_value=b'x'*8192) as read:
            m.namespace_startup_drain(stream,captured)
        self.assertEqual(read.call_count,16);self.assertEqual(len(captured),65536)

    def test_startup_error_receipt_never_persists_stderr(self):
        p=self.plan();saved=[]
        with patch.object(m,'atomic_exclusive',side_effect=lambda _path,raw:saved.append(raw)):
            m.namespace_startup_error(p,'NS_DAEMON_START_EXIT',7,b'private-marker')
        self.assertNotIn(b'private-marker',saved[0]);value=json.loads(saved[0])
        self.assertEqual(set(value),{'schema','operationSha256','code','exitCode','stderrByteCount','truncated','stderrSha256'})

    def test_runtime_mount_classifier_rejects_unowned_descendants_and_netns_drift(self):
        p=self.plan();p['mapperPath']='/dev/mapper/synthetic';j=unittest.mock.Mock()
        j.find.side_effect=lambda phase:{} if phase in ('DAEMON_START_INTENT','RESTORE_CREATE_INTENT','RESTORE_START_INTENT') else None
        rows=[
            {'id':'41','parent':'1','device':'253:7','root':'/','target':'/media','options':['rw','nosuid','nodev','noexec','noatime'],'optional':[],'fstype':'ext4','source':p['mapperPath'],'superOptions':['rw']},
            {'id':'42','parent':'41','device':'253:7','root':'/.runtime/docker-data','target':p['isolation']['dataRoot'],'options':['rw','nosuid','nodev','noexec','noatime'],'optional':['shared:77'],'fstype':'ext4','source':p['mapperPath'],'superOptions':['rw']},
            {'id':'43','parent':'41','device':'0:4','root':'net:[23]','target':p['isolation']['execRoot']+'/netns/'+'a'*12,'options':['rw'],'optional':[],'fstype':'nsfs','source':'nsfs','superOptions':['rw']},
        ]
        inode=SimpleNamespace(st_ino=23,st_dev=4)
        with patch.object(Path,'stat',return_value=inode),patch.object(m.os,'major',return_value=0),patch.object(m.os,'minor',return_value=4):
            value=m.namespace_runtime_mounts(p,j,rows)
        self.assertEqual(value['network'],rows[2])
        with patch.object(Path,'stat',return_value=inode),patch.object(m.os,'major',return_value=0),patch.object(m.os,'minor',return_value=4):
            with self.assertRaisesRegex(m.Stop,'NS_RUNTIME_DESCENDANT'):m.namespace_runtime_mounts(p,j,[*rows,{**rows[1],'id':'44','target':'/media/foreign'}])
        with patch.object(Path,'stat',return_value=SimpleNamespace(st_ino=24,st_dev=4)),patch.object(m.os,'major',return_value=0),patch.object(m.os,'minor',return_value=4):
            with self.assertRaisesRegex(m.Stop,'NS_RUNTIME_NET_IDENTITY'):m.namespace_runtime_mounts(p,j,rows)
        early=unittest.mock.Mock();early.find.side_effect=lambda phase:{} if phase=='DAEMON_START_INTENT' else None
        with self.assertRaisesRegex(m.Stop,'NS_RUNTIME_NET_EARLY'):m.namespace_runtime_mounts(p,early,[rows[0],rows[2]])
        before_start=unittest.mock.Mock();before_start.find.side_effect=lambda phase:{} if phase in ('DAEMON_START_INTENT','RESTORE_CREATE_INTENT') else None
        with self.assertRaisesRegex(m.Stop,'NS_RUNTIME_NET_EARLY'):m.namespace_runtime_mounts(p,before_start,rows)

    def test_lost_remove_ack_with_lingering_netns_stops_before_cleanup(self):
        p=self.plan();events={'DAEMON_START_INTENT':{},'RESTORE_CREATED':{'containerId':'e'*64},
                               'CONTAINER_REMOVE_INTENT':{}}
        journal=unittest.mock.Mock();journal.find.side_effect=events.get;guard=unittest.mock.Mock()
        control=SimpleNamespace(exists=lambda:True)
        with patch.object(m,'disk_image',return_value={'synthetic':True}),patch.object(m,'namespace_control',return_value=control),patch.object(m,'namespace_container_lookup',return_value=None),patch.object(m,'namespace_alias_rows',return_value=[]),patch.object(m,'namespace_runtime_mounts',return_value={'dataRoot':None,'network':{'target':'/media/.runtime/docker-exec/netns/'+'a'*12}}),patch.object(m,'namespace_daemon_stop') as daemon,patch.object(m,'namespace_mask_unmount') as mask,patch.object(m,'namespace_alias_unmount') as alias,patch.object(m,'disk_cleanup_storage') as storage:
            with self.assertRaisesRegex(m.Stop,'NS_RUNTIME_UNBOUND'):m.namespace_cleanup(p,namespace_operation(),journal,guard)
        journal.once.assert_not_called();guard.assert_not_called();daemon.assert_not_called();mask.assert_not_called();alias.assert_not_called();storage.assert_not_called()

    def test_source_restart_is_not_adopted_and_is_detected_before_mutation(self):
        p=self.plan();frozen={'pid':44,'startTicks':'123','mountNamespace':11}
        with patch.object(m,'DiskJournal') as journal,patch.object(m,'namespace_source_daemon',return_value={**frozen,'startTicks':'124'}):
            journal.return_value.find.return_value={'identity':frozen}
            with self.assertRaisesRegex(m.Stop,'NS_SOURCE_DAEMON_DRIFT'):m.namespace_frozen_source(p)

    def test_enter_rejects_wrong_caller_and_closes_fd_even_when_target_open_fails(self):
        from contextlib import ExitStack
        p=self.plan();ad={'sourceDaemon':{'mountNamespace':11},'supervisor':{'process':{'pid':45,'mountNamespace':12}}}
        for inode,side in [(99,[7]),(11,[7,OSError('synthetic target disappearance')])]:
            with self.subTest(inode=inode),ExitStack() as stack:
                stack.enter_context(patch.object(m,'namespace_admission',return_value=ad))
                stack.enter_context(patch.object(m.os,'open',side_effect=side))
                stack.enter_context(patch.object(m.os,'fstat',return_value=SimpleNamespace(st_ino=inode)))
                closed=stack.enter_context(patch.object(m.os,'close'));switch=stack.enter_context(patch.object(m,'namespace_syscall'))
                with self.assertRaises((m.Stop,OSError)):
                    with m.namespace_enter(p,namespace_operation()):self.fail('must not enter')
                closed.assert_called_once_with(7);switch.assert_not_called()

    def test_release_requires_cleanup_and_never_stops_an_unproven_unit(self):
        p=self.plan()
        with patch.object(m,'command') as cmd:
            journal=unittest.mock.Mock();journal.find.side_effect=lambda phase: {} if phase=='NAMESPACE_SLICE_START_INTENT' else None
            with self.assertRaisesRegex(m.Stop,'NS_RELEASE_PREREQUISITES'):m.namespace_release(p,namespace_operation(),journal)
            cmd.assert_not_called()

    def test_every_unit_property_drift_stops_before_cgroup_or_daemon_use(self):
        f=namespace_fixture();p=f['value']['plan'];u=f['value']['readback']['isolation']['admission']['supervisor']['unit']
        for key in m.NS_UNIT_KEYS:
            bad={**u,key:'foreign'}
            with self.subTest(key=key),patch.object(m,'namespace_unit',return_value=bad),patch.object(m,'namespace_process') as proc:
                with self.assertRaises((m.Stop,ValueError)):m.namespace_supervisor_identity(p,namespace_operation(True))
                proc.assert_not_called()

    def test_managed_containerd_rejects_host_socket_foreign_process_and_config(self):
        f=namespace_fixture();p=f['value']['plan'];i=f['value']['readback']['isolation'];a=i['admission'];managed=i['managed']
        members=[a['supervisor']['process'],i['process'],managed['containerd'],*managed['shims']]
        cfg={'version':2,'root':managed['config']['root'],'state':managed['config']['state'],'grpc':{'address':managed['config']['address']},'disabled_plugins':['io.containerd.grpc.v1.cri']}
        import tomllib
        for key,value in [('grpc',{'address':'/run/containerd/containerd.sock'}),('root','/var/lib/containerd'),('imports',['/etc/containerd/config.toml']),('proxy_plugins',{'foreign':{}})]:
            with self.subTest(key=key),patch.object(m,'namespace_members',return_value=[v['pid'] for v in members]),patch.object(m,'namespace_process',side_effect=lambda pid:next(v for v in members if v['pid']==pid)),patch.object(m,'namespace_network',return_value=22),patch.object(m,'read_secure',return_value=b'synthetic'),patch.object(tomllib,'loads',return_value={**cfg,key:value}):
                with self.assertRaises(m.Stop):m.namespace_managed(p,a,i['process'])
        extra=copy.deepcopy(managed['containerd']);extra['pid']=88;extra['executable']='/usr/bin/runc'
        allmembers=[*members,extra]
        with patch.object(m,'namespace_members',return_value=[v['pid'] for v in allmembers]),patch.object(m,'namespace_process',side_effect=lambda pid:next(v for v in allmembers if v['pid']==pid)),patch.object(m,'namespace_network',return_value=22),patch.object(m,'read_secure',return_value=b'synthetic'),patch.object(tomllib,'loads',return_value=cfg):
            with self.assertRaisesRegex(m.Stop,'NS_SHIM_CUSTODY'):m.namespace_managed(p,a,i['process'])

    def test_daemon_no_start_request_is_reconciled_without_private_api_or_replay(self):
        p=self.plan();journal=unittest.mock.Mock();journal.find.side_effect=lambda phase:{}if phase=='DAEMON_START_INTENT' else None
        with patch.object(m,'namespace_control',return_value=Path('/proc/phub-synthetic-absent')),patch.object(m,'namespace_daemon_absent') as absent,patch.object(m,'namespace_container_lookup') as lookup,patch.object(m,'command') as cmd:
            m.namespace_daemon_stop(p,namespace_operation(),journal)
            absent.assert_called_once();lookup.assert_not_called();cmd.assert_not_called();journal.once.assert_called_with('DAEMON_STOPPED',neverStarted=True)

    def test_quiescence_reaps_adopted_zombie_then_waits_for_lingering_child(self):
        p=self.plan();order=[]
        with patch.object(m.os,'waitpid',side_effect=[(88,0),(0,0),ChildProcessError(),ChildProcessError()]) as wait,patch.object(m,'namespace_daemon_absent',side_effect=[m.Stop('NS_DAEMON_CHILDREN_REMAIN'),None]) as absent,patch.object(m.time,'sleep',side_effect=lambda _:order.append('wait')):
            m.namespace_daemon_quiescence(p,namespace_operation())
            self.assertEqual(wait.call_count,4);self.assertEqual(absent.call_count,2);self.assertEqual(order,['wait'])

    def test_child_exit_between_reap_and_empty_cgroup_read_requires_echild_before_receipt(self):
        p=self.plan()
        with patch.object(m.os,'waitpid',side_effect=[(0,0),(88,0),ChildProcessError(),ChildProcessError()]) as wait,patch.object(m,'namespace_daemon_absent') as absent,patch.object(m.time,'sleep') as delay:
            m.namespace_daemon_quiescence(p,namespace_operation())
            self.assertEqual(wait.call_count,4);self.assertEqual(absent.call_count,2);delay.assert_called_once()

    def test_quiescence_timeout_and_foreign_drift_never_publish_exit_receipt(self):
        p=self.plan()
        for code in ['NS_DAEMON_CHILDREN_REMAIN','NS_UNIT_CUSTODY']:
            with self.subTest(code=code),patch.object(m.os,'waitpid',side_effect=ChildProcessError()),patch.object(m,'namespace_daemon_absent',side_effect=m.Stop(code)),patch.object(m.time,'monotonic',side_effect=[1,12]):
                with self.assertRaises(m.Stop):m.namespace_daemon_quiescence(p,namespace_operation())
        with patch.object(m,'namespace_daemon_quiescence',side_effect=m.Stop('NS_DAEMON_QUIESCENCE_UNKNOWN')),patch.object(m,'atomic_exclusive') as write:
            with self.assertRaises(m.Stop):m.namespace_daemon_exit(p,namespace_operation(),{'process':{'pid':46}},0)
            write.assert_not_called()

    def test_exit_receipt_is_written_only_after_quiescence(self):
        p=self.plan();order=[]
        with patch.object(m,'namespace_daemon_quiescence',side_effect=lambda *a:order.append('quiescence')),patch.object(m,'read_secure',return_value=b'plan'),patch.object(m,'atomic_exclusive',side_effect=lambda *a:order.append('receipt')):
            m.namespace_daemon_exit(p,namespace_operation(),{'process':{'pid':46}},0)
        self.assertEqual(order,['quiescence','receipt'])

    def test_actual_unit_and_slice_stop_ack_loss_terminalizes_only_after_readback(self):
        from contextlib import ExitStack
        f=namespace_fixture();p=f['value']['plan'];a=f['value']['readback']['isolation']['admission'];sl=a['supervisor']['slice'];original_stat=m.os.stat;original_exists=Path.exists
        for action in ['NS_UNIT_STOP','NS_SLICE_STOP']:
            for applied in (False,True):
                with self.subTest(action=action,applied=applied):
                    events={'NAMESPACE_SLICE_START_INTENT':{},'NAMESPACE_SLICE_READY':{'identity':sl},'NAMESPACE_UNIT_START_INTENT':{},
                            'NAMESPACE_STORAGE_CLEANED':{},'DAEMON_START_INTENT':{},'DAEMON_STOPPED':{}}
                    state={'unit':True,'slice':True,'fault':True};calls=[]
                    def record(phase,**metadata):events.setdefault(phase,metadata)
                    def command(args,code,**kwargs):
                        calls.append(code)
                        if state['fault'] and code==action and not applied:raise m.Stop('SYNTHETIC_ACK_UNKNOWN')
                        state['unit'if code=='NS_UNIT_STOP' else 'slice']=False
                        if state['fault'] and code==action:raise m.Stop('SYNTHETIC_ACK_UNKNOWN')
                    journal=unittest.mock.Mock();journal.find.side_effect=events.get;journal.add.side_effect=record;journal.once.side_effect=record
                    with ExitStack()as stack:
                        stack.enter_context(patch.object(m,'namespace_frozen_source',return_value=a['sourceDaemon']))
                        stack.enter_context(patch.object(m.os,'stat',side_effect=lambda path,*args,**kwargs:SimpleNamespace(st_ino=11)if str(path)=='/proc/self/ns/mnt'else original_stat(path,*args,**kwargs)))
                        stack.enter_context(patch.object(m.os.path,'lexists',return_value=False))
                        # Synthetic PIDs/cgroups never read the real Linux runner inventory.
                        stack.enter_context(patch.object(Path,'exists',new=lambda path:False if str(path)=='/proc/45' or str(path).startswith('/sys/fs/cgroup/phubdiskrestore') else original_exists(path)))
                        stack.enter_context(patch.object(m,'namespace_admission',return_value=a))
                        stack.enter_context(patch.object(m,'namespace_unit',side_effect=lambda _:{**a['supervisor']['unit']}if state['unit']else {'LoadState':'not-found','ActiveState':'inactive','MainPID':'0'}))
                        stack.enter_context(patch.object(m,'namespace_slice',return_value=sl))
                        stack.enter_context(patch.object(m,'namespace_show',side_effect=lambda *args:sl['unit']if state['slice']else slice_terminal_fixture('not-found')))
                        stack.enter_context(patch.object(m,'namespace_require_no_unit_file'))
                        stack.enter_context(patch.object(m,'namespace_members',side_effect=lambda _: [45]if state['unit']else []))
                        stack.enter_context(patch.object(m,'command',side_effect=command))
                        with self.assertRaises(m.Stop):m.namespace_release(p,namespace_operation(True),journal)
                        self.assertNotIn('NAMESPACE_SLICE_RELEASED',events)
                        count=calls.count(action);state['fault']=False;m.namespace_release(p,namespace_operation(True),journal)
                        self.assertEqual(calls.count(action),count+(0 if applied else 1))
                        self.assertIn('NAMESPACE_RELEASED',events);self.assertIn('NAMESPACE_SLICE_RELEASED',events)

    def test_actual_daemon_stop_lost_ack_uses_same_request_and_exit_receipt_without_replay(self):
        from contextlib import ExitStack
        for applied,drift in [(False,False),(True,False),(True,True)]:
            with self.subTest(applied=applied,drift=drift),tempfile.TemporaryDirectory(prefix='phub-ns-stop-ack-') as directory:
                f=namespace_fixture();p=f['value']['plan'];p['isolation']['controlRoot']=directory
                i=f['value']['readback']['isolation'];i['managed']['shims']=[];state={'active':True,'fault':True};events={'DAEMON_START_INTENT':{}}
                for name in ['daemon-start.json','daemon-receipt.json']:Path(directory,name).write_bytes(b'{}')
                journal=unittest.mock.Mock();journal.find.side_effect=events.get
                def record(phase,**metadata):events.setdefault(phase,metadata)
                journal.add.side_effect=record;journal.once.side_effect=record
                def read(path,*args):return b'plan' if str(path).endswith('/disk-plan.json') else Path(path).read_bytes()
                def wait(path,predicate,seconds):
                    if not state['fault'] or applied:
                        state['active']=False;process=copy.deepcopy(i['process'])
                        if drift:process['startTicks']='99999'
                        Path(path).write_bytes(m.encoded({'schema':'PHUB_PRIVATE_DAEMON_EXIT_V1','operationSha256':p['operationSha256'],
                            'planSha256':m.digest(b'plan'),'process':process,'exitCode':0}))
                    if state['fault']:raise m.Stop('SYNTHETIC_ACK_UNKNOWN')
                    return json.loads(Path(path).read_bytes())
                def absent(*args):m.need(not state['active'],'NS_DAEMON_CHILDREN_REMAIN')
                with ExitStack() as stack:
                    stack.enter_context(patch.object(m,'read_secure',side_effect=read))
                    stack.enter_context(patch.object(m,'secure',side_effect=lambda path,*args:Path(path).lstat()))
                    stack.enter_context(patch.object(m,'rename_noreplace',side_effect=lambda source,dest:os.rename(source,dest)))
                    stack.enter_context(patch.object(m,'namespace_container_lookup',return_value=None))
                    stack.enter_context(patch.object(m,'namespace_daemon_identity',return_value=i))
                    stack.enter_context(patch.object(m,'namespace_wait',side_effect=wait))
                    stack.enter_context(patch.object(m,'namespace_daemon_absent',side_effect=absent))
                    command=stack.enter_context(patch.object(m,'command'))
                    with self.assertRaisesRegex(m.Stop,'SYNTHETIC_ACK_UNKNOWN'):m.namespace_daemon_stop(p,namespace_operation(True),journal)
                    request=Path(directory,'daemon-stop.json').read_bytes();state['fault']=False
                    if drift:
                        with self.assertRaisesRegex(m.Stop,'NS_DAEMON_EXIT'):m.namespace_daemon_stop(p,namespace_operation(True),journal)
                        self.assertNotIn('DAEMON_STOPPED',events)
                    else:
                        m.namespace_daemon_stop(p,namespace_operation(True),journal);self.assertIn('DAEMON_STOPPED',events)
                    self.assertEqual(Path(directory,'daemon-stop.json').read_bytes(),request);command.assert_not_called()

    def test_native_tuple_is_atomic_exact_and_matches_javascript(self):
        rows=list(m.API_WORKER_NATIVE_BOOKINGS_PATCH.values())
        raw=lambda items:b''.join((':'+v['oldMode']+' '+v['newMode']+' '+v['oldOid']+' '+v['newOid']+' '+v['status']+'\0'+v['path']+'\0').encode()for v in items)
        self.assertEqual(len(rows),20);m.validate_migration_controller_delta(raw(rows))
        for case in [rows[:-1],rows+[rows[0]],*[rows[:i]+[dict(rows[i],newOid='f'*40)]+rows[i+1:]for i in range(20)],
                     [dict(rows[0],newMode='100755')]+rows[1:], [dict(rows[0],status='D')]+rows[1:]]:
            with self.subTest(case=case[0]['path']),self.assertRaises(m.Stop):m.validate_migration_controller_delta(raw(case))
        import subprocess
        js="import {API_WORKER_NATIVE_BOOKINGS_PATCH as p} from './scripts/timeweb-api-worker-contract.js';process.stdout.write(JSON.stringify(p));"
        result=subprocess.run([shutil.which('node'),'--input-type=module','-e',js],cwd=Path(__file__).parents[1],env={'PATH':os.environ.get('PATH','')},capture_output=True,check=True)
        self.assertEqual(json.loads(result.stdout),rows)


class NamespaceScenario(DiskScenario):
    """Real source/backup journal and publication; all kernel/daemon primitives are mocks."""
    def __init__(self,directory,post=False,fault=None):
        super().__init__(directory,post,fault)
        self.op['schema']=m.NS_POST_SCHEMA if post else m.NS_PRE_SCHEMA
        self.op['confirmation']=namespace_operation(post)['confirmation'];self.request.write_bytes(m.encoded(self.op))
        with patch.object(m,'ROOT',self.root):self.plan=m.namespace_plan(self.op,m.encoded(self.op),m.namespace_sizing(1024,10**12,50*1024**3,NS_IMAGE),NS_IMAGE)
        self.unit=False;self.daemon=False;self.private=False;self.privcalls=[];self.host_collision=False;self.unit_receipt=False

    def docker(self,args,code='DOCKER_READ',**kwargs):
        if args[:2]==['image','inspect']:
            return m.encoded(NS_IMAGE if m.NS_IMAGE_FORMAT in args else {'Os':'linux','Architecture':'amd64','RepoDigests':[m.PG_IMAGE]})
        if args[0]=='ps' and '--filter' not in args:
            return ('\n'.join([self.runtime_api['id'],m.PG_ID]+([self.container] if self.host_collision and self.created else []))).encode()
        return super().docker(args,code,**kwargs)

    def private_docker(self,plan,args,code='NS_READ',**kwargs):
        assert self.unit and self.daemon and self.private, 'private client before daemon/readiness'
        assert m.PG_ID not in args and m.SOURCE_DUMP not in args, 'source crossed private socket'
        self.privcalls.append(args)
        if args[0]=='ps':return self.container.encode() if self.created else b''
        return DiskScenario.docker(self,args,code,**kwargs)

    def row(self,plan,image_id=None):
        if not self.created:return None
        state='running'if self.running else 'exited'if self.stopped else 'created'
        row=disk_restore_row({**plan,'mount':plan['isolation']['pgdata']},self.container,state)
        row['Image']=row['Config']['Image']=image_id or NS_IMAGE['Id'];row['HostConfig'].update(CgroupParent=plan['isolation']['slice'],CgroupnsMode='private')
        return row

    def start(self,p,op,j):
        Path(p['isolation']['controlRoot']).mkdir(mode=0o700)
        j.add('NAMESPACE_SLICE_START_INTENT');self.trip('NS_SLICE_START');self.trip('NS_SLICE_START',True)
        j.add('NAMESPACE_SLICE_READY',identity={'synthetic':True})
        j.add('NAMESPACE_UNIT_START_INTENT');self.trip('NS_UNIT_START');self.unit=True;self.trip('NS_UNIT_START',True)
        self.unit_receipt=True;j.add('NAMESPACE_READY',receipt={'synthetic':True})

    def enter(self,p,op):
        from contextlib import contextmanager
        @contextmanager
        def owned():
            assert self.unit
            self.private=True
            try:yield {'synthetic':True}
            finally:self.private=False
        return owned()

    def admission(self,*args):
        m.need(self.unit_receipt,'NS_NAMESPACE_RECEIPT_MANUAL_STOP')
        return {'synthetic':True}

    def alias_baseline(self,*args):
        return {'dev':64775,'ino':7002,'uid':0,'gid':0,'mode':0o40755,'nlink':2}

    def alias_mount(self,p,j):
        j.add('ALIAS_MOUNT_INTENT');j.add('ALIAS_MOUNTED',alias={'synthetic':True})

    def alias_unmount(self,p,j):
        if j.find('ALIAS_MOUNT_INTENT') is not None:
            j.once('ALIAS_UNMOUNT_INTENT');j.once('ALIAS_UNMOUNTED')

    def mask_baseline(self,*args):
        return {'dev':28,'ino':3582,'uid':0,'gid':0,'mode':0o40711}

    def mask_mount(self,p,j):
        j.add('CONTAINERD_MASK_INTENT');j.add('CONTAINERD_MASKED',mask={'synthetic':True})

    def mask_unmount(self,p,j):
        if j.find('CONTAINERD_MASK_INTENT') is not None:
            j.once('CONTAINERD_MASK_UNMOUNT_INTENT');j.once('CONTAINERD_MASK_UNMOUNTED')

    def daemon_start(self,p,op,j):
        assert self.mounted and self.private
        j.add('DAEMON_START_INTENT');self.trip('NS_DAEMON_REQUEST')
        m.atomic_exclusive(m.namespace_control(p,'daemon-start.json'),b'{}');self.daemon=True;self.trip('NS_DAEMON_REQUEST',True)
        m.atomic_exclusive(m.namespace_control(p,'daemon-receipt.json'),b'{}');j.add('DAEMON_READY',identity={'synthetic':True})

    def image_transfer(self,p,op,j):
        assert self.daemon;j.add('IMAGE_TRANSFER_INTENT');self.trip('NS_IMAGE_TRANSFER');self.trip('NS_IMAGE_TRANSFER',True);j.add('IMAGE_LOADED',source=NS_IMAGE,imported=NS_IMAGE)

    def attest(self,p,op,j):
        return {'storage':m.disk_storage_attest(p,j),'container':self.row(p,m.namespace_current_image_id(p,j)),'synthetic':True}

    def daemon_stop(self,p,op,j):
        assert not self.created
        j.once('DAEMON_STOP_INTENT');self.daemon=False;j.once('DAEMON_STOPPED')

    def release(self,p,op,j):
        assert not self.private and not self.created and not self.daemon and not self.mounted and self.loop is None and self.mapper is None
        assert j.find('NAMESPACE_STORAGE_CLEANED') is not None
        j.once('NAMESPACE_RELEASE_INTENT');self.unit=False;j.once('NAMESPACE_RELEASED');j.once('NAMESPACE_SLICE_RELEASE_INTENT');j.once('NAMESPACE_SLICE_RELEASED')

    def invoke(self,reconcile=False):
        from contextlib import ExitStack
        original_stat=m.os.stat
        def stat_value(path,*args,**kwargs):
            if str(path)=='/proc/self/ns/mnt':return SimpleNamespace(st_ino=11)
            return original_stat(path,*args,**kwargs)
        with ExitStack() as stack:
            for name,fn in [('namespace_source_daemon',lambda:{'pid':44,'startTicks':'123','mountNamespace':11}),
                ('namespace_frozen_source',lambda p:{'pid':44,'startTicks':'123','mountNamespace':11}),('namespace_start',self.start),
                ('namespace_enter',self.enter),('namespace_admission',self.admission),('namespace_daemon_start',self.daemon_start),
                ('namespace_docker',self.private_docker),('namespace_container_lookup',self.row),('namespace_image_transfer',self.image_transfer),
                ('namespace_running_attestation',self.attest),('namespace_daemon_stop',self.daemon_stop),('namespace_release',self.release)]:
                stack.enter_context(patch.object(m,name,side_effect=fn))
            stack.enter_context(patch.object(m,'namespace_alias_baseline',side_effect=self.alias_baseline))
            stack.enter_context(patch.object(m,'namespace_alias_mount',side_effect=self.alias_mount))
            stack.enter_context(patch.object(m,'namespace_alias_unmount',side_effect=self.alias_unmount))
            stack.enter_context(patch.object(m,'namespace_mask_baseline',side_effect=self.mask_baseline))
            stack.enter_context(patch.object(m,'namespace_mask_mount',side_effect=self.mask_mount))
            stack.enter_context(patch.object(m,'namespace_mask_unmount',side_effect=self.mask_unmount))
            stack.enter_context(patch.object(m,'namespace_runtime_mounts_empty'))
            stack.enter_context(patch.object(m,'namespace_runtime_mounts',return_value={'dataRoot':None,'network':None}))
            stack.enter_context(patch.object(m,'namespace_alias_rows',return_value=[]))
            stack.enter_context(patch.object(m,'namespace_network',return_value=21))
            stack.enter_context(patch.object(m.os,'stat',side_effect=stat_value))
            stack.enter_context(patch.object(m,'reconcile_disk',side_effect=m.reconcile_namespace))
            return super().invoke(reconcile)


class NamespacePipelineTests(unittest.TestCase):
    def scenario(self,post=False,fault=None):
        tmp=tempfile.TemporaryDirectory(prefix='phub-namespace-backup-mock-');self.addCleanup(tmp.cleanup)
        return NamespaceScenario(tmp.name,post,fault)

    def test_pre99_and_post101_use_host_dump_and_private_restore_then_publish_after_release(self):
        for post in (False,True):
            with self.subTest(post=post):
                s=self.scenario(post);result=s.invoke();self.assertEqual(result['status'],'BACKUP_RESTORE_VERIFIED')
                self.assertFalse(s.unit or s.created or s.daemon);self.assertFalse((s.root/'standard/active').exists())
                self.assertTrue(any(m.SOURCE_DUMP in args for args in s.calls))
                self.assertFalse(any(m.SOURCE_DUMP in args for args in s.privcalls))
                phases=[v['phase']for v in s.journal().events]
                self.assertLess(phases.index('NAMESPACE_SLICE_RELEASED'),phases.index('PUBLISHED'))
                for file in Path(s.plan['work']).rglob('*.json'):self.assertNotIn(s.secret,file.read_bytes())

    def test_matching_host_container_is_never_hidden_by_private_restore_reference(self):
        s=self.scenario();s.host_collision=True
        with self.assertRaisesRegex(m.Stop,'CONTAINER_BOUNDARY_DRIFT'):s.invoke()
        self.assertTrue((s.root/'standard/active').exists())
        self.assertFalse(Path(s.plan['canonical']).exists())

    def test_new_start_ack_windows_preserve_lock_and_do_not_replay_creation(self):
        for code in ['NS_SLICE_START','NS_UNIT_START','NS_DAEMON_REQUEST']:
            for after in (False,True):
                with self.subTest(code=code,after=after):
                    s=self.scenario(fault=('after:'if after else 'before:')+code)
                    with self.assertRaises(m.Stop):s.invoke()
                    self.assertTrue((s.root/'standard/active').exists());s.fault=None
                    if code=='NS_DAEMON_REQUEST' and not after:
                        s.invoke(True);self.assertFalse((s.root/'standard/active').exists())
                    else:
                        with self.assertRaises(m.Stop):s.invoke(True)
                        self.assertTrue((s.root/'standard/active').exists())
                    self.assertFalse(Path(s.plan['canonical']).exists());self.assertFalse(s.created)

    def test_private_create_start_remove_ack_loss_reconciles_by_lookup_without_replay(self):
        for code in ['DISK_RESTORE_CREATE','DISK_RESTORE_START','NS_CONTAINER_STOP','NS_CONTAINER_REMOVE']:
            for after in (False,True):
                with self.subTest(code=code,after=after):
                    s=self.scenario(fault=('after:'if after else 'before:')+code)
                    with self.assertRaises(m.Stop):s.invoke()
                    self.assertTrue((s.root/'standard/active').exists())
                    before=[a for a in s.privcalls if a[0] in ('create','start') or 'pg_restore' in a]
                    s.fault=None;s.invoke(True)
                    self.assertEqual(before,[a for a in s.privcalls if a[0] in ('create','start') or 'pg_restore' in a])
                    self.assertFalse(s.created or s.daemon or s.unit)

    def test_partial_image_transfer_never_creates_a_container_or_replays_transfer(self):
        for after in (False,True):
            with self.subTest(after=after):
                s=self.scenario(fault=('after:'if after else 'before:')+'NS_IMAGE_TRANSFER')
                with self.assertRaises(m.Stop):s.invoke()
                self.assertIsNotNone(s.journal().find('IMAGE_TRANSFER_INTENT'));self.assertIsNone(s.journal().find('IMAGE_LOADED'))
                s.fault=None;s.invoke(True)
                self.assertFalse(any(a[0]=='create' for a in s.privcalls));self.assertFalse(Path(s.plan['canonical']).exists())

    def test_phase_interruptions_preserve_lock_and_reconcile_never_replays_dump_restore(self):
        for phase in ['NAMESPACE_READY','DUMP_VERIFIED','MOUNTED','ALIAS_MOUNTED','CONTAINERD_MASKED','DAEMON_READY','IMAGE_LOADED','RESTORE_CREATED','RESTORE_STARTED',
                      'RESTORE_VERIFIED','PUBLISH_READY','CONTAINER_REMOVED','DAEMON_STOPPED','NAMESPACE_STORAGE_CLEANED','NAMESPACE_RELEASED','PUBLISHED']:
            with self.subTest(phase=phase):
                s=self.scenario(fault='after:PHASE_'+phase)
                with self.assertRaises(m.Stop):s.invoke()
                self.assertTrue((s.root/'standard/active').exists())
                before=len([a for a in s.calls if m.SOURCE_DUMP in a])+len([a for a in s.privcalls if 'pg_restore' in a])
                s.fault=None;s.invoke(True)
                after=len([a for a in s.calls if m.SOURCE_DUMP in a])+len([a for a in s.privcalls if 'pg_restore' in a])
                self.assertEqual(before,after);self.assertFalse((s.root/'standard/active').exists())




def slice_terminal_fixture(load='loaded'):
    return {'LoadState':load,'ActiveState':'inactive','SubState':'dead','ControlGroup':'',
        'Transient':'no','MemoryMax':'infinity','MemorySwapMax':'infinity','TasksMax':'infinity',
        'CPUQuotaPerSecUSec':'infinity','FragmentPath':'','SourcePath':'','DropInPaths':'',
        'UnitFileState':'','Job':'','InvocationID':''}


class NamespaceSliceTerminalTests(unittest.TestCase):
    def test_exact_implicit_and_not_found_terminal_properties(self):
        for load in ('loaded','not-found'):
            with self.subTest(load=load):
                value=slice_terminal_fixture(load)
                self.assertEqual(m.namespace_slice_terminal_properties(value),value)

    def test_every_foreign_terminal_property_and_missing_extra_fields_fail(self):
        fields={'LoadState':'error','ActiveState':'active','SubState':'running','ControlGroup':'/foreign',
            'Transient':'yes','MemoryMax':'4096','MemorySwapMax':'0','TasksMax':'384',
            'CPUQuotaPerSecUSec':'2s','FragmentPath':'/etc/systemd/system/foreign.slice',
            'SourcePath':'/run/foreign','DropInPaths':'/run/systemd/foreign.conf',
            'UnitFileState':'static','Job':'123','InvocationID':'a'*32}
        for key,value in fields.items():
            with self.subTest(key=key),self.assertRaises(m.Stop):
                m.namespace_slice_terminal_properties({**slice_terminal_fixture(),key:value})
        for value in ({k:v for k,v in slice_terminal_fixture().items()if k!='Job'},
                      {**slice_terminal_fixture(),'foreign':''},None):
            with self.subTest(value=value),self.assertRaises(m.Stop):m.namespace_slice_terminal_properties(value)

    def test_terminal_requires_existing_owned_release_history_and_absent_files_cgroups_members(self):
        from contextlib import ExitStack
        p=namespace_fixture()['value']['plan']
        initial={'NAMESPACE_SLICE_READY':{},'NAMESPACE_SLICE_RELEASE_INTENT':{},
            'NAMESPACE_STORAGE_CLEANED':{},'NAMESPACE_UNIT_START_INTENT':{},'NAMESPACE_RELEASED':{}}
        for drift in [None,*[k for k in initial if k!='NAMESPACE_UNIT_START_INTENT'],'cgroup','member','unit-file']:
            with self.subTest(drift=drift),ExitStack()as stack:
                events=dict(initial)
                if drift in events:events.pop(drift)
                journal=unittest.mock.Mock();journal.find.side_effect=events.get
                stack.enter_context(patch.object(m,'namespace_show',return_value=slice_terminal_fixture()))
                stack.enter_context(patch.object(m.os.path,'lexists',return_value=drift=='cgroup'))
                stack.enter_context(patch.object(m,'namespace_members',return_value=[99]if drift=='member'else []))
                rows=(p['isolation']['slice']+' static -\n')if drift=='unit-file'else 'system.slice static -\n'
                cmd=stack.enter_context(patch.object(m,'command',return_value=rows.encode()))
                if drift:
                    with self.assertRaises(m.Stop):m.namespace_slice_terminal(p,journal)
                else:self.assertEqual(m.namespace_slice_terminal(p,journal),slice_terminal_fixture())
                self.assertFalse(any(c.args[0][1]=='stop'for c in cmd.call_args_list))
                journal.add.assert_not_called();journal.once.assert_not_called()

    def test_actual_resume_from_slice_release_intent_is_read_only_except_journal_completion(self):
        from contextlib import ExitStack
        f=namespace_fixture();p=f['value']['plan'];a=f['value']['readback']['isolation']['admission']
        events={'NAMESPACE_SLICE_START_INTENT':{},'NAMESPACE_SLICE_READY':{'identity':a['supervisor']['slice']},
            'NAMESPACE_UNIT_START_INTENT':{},'NAMESPACE_RELEASED':{},'NAMESPACE_STORAGE_CLEANED':{},
            'NAMESPACE_SLICE_RELEASE_INTENT':{}}
        journal=unittest.mock.Mock();journal.find.side_effect=events.get;added=[]
        def record(phase,**metadata):events.setdefault(phase,metadata);added.append(phase)
        journal.once.side_effect=record;journal.add.side_effect=record;original=m.os.stat
        with ExitStack()as stack:
            stack.enter_context(patch.object(m,'namespace_frozen_source',return_value=a['sourceDaemon']))
            stack.enter_context(patch.object(m.os,'stat',side_effect=lambda path,*args,**kw:SimpleNamespace(st_ino=11)if str(path)=='/proc/self/ns/mnt'else original(path,*args,**kw)))
            stack.enter_context(patch.object(m.os.path,'lexists',return_value=False))
            stack.enter_context(patch.object(m,'namespace_members',return_value=[]))
            stack.enter_context(patch.object(m,'namespace_show',side_effect=lambda name,keys:{k:slice_terminal_fixture()[k]for k in keys}))
            stack.enter_context(patch.object(m,'command',return_value=b'system.slice static -\n'))
            stop=stack.enter_context(patch.object(m,'namespace_unit'));adopt=stack.enter_context(patch.object(m,'namespace_admission'))
            m.namespace_release(p,namespace_operation(),journal);m.namespace_release(p,namespace_operation(),journal)
            stop.assert_not_called();adopt.assert_not_called()
        self.assertEqual(added,['NAMESPACE_SLICE_RELEASED'])

    def test_canonical_reconciler_completes_metadata_after_exact_storage_release_without_repeating_cleanup(self):
        with tempfile.TemporaryDirectory(prefix='phub-slice-terminal-resume-')as directory:
            s=NamespaceScenario(directory,fault='after:DISK_MAPPER_OPEN')
            with self.assertRaises(m.Stop):s.invoke()
            s.fault=None;canonical_release=m.namespace_release
            def interrupt(p,op,j):
                j.once('NAMESPACE_RELEASE_INTENT');s.unit=False;j.once('NAMESPACE_RELEASED')
                j.once('NAMESPACE_SLICE_RELEASE_INTENT');raise m.Stop('NS_SLICE_RELEASE_UNPROVEN')
            s.release=interrupt
            with self.assertRaises(m.Stop):s.invoke(True)
            self.assertEqual(s.journal().events[-1]['phase'],'NAMESPACE_SLICE_RELEASE_INTENT')
            self.assertFalse(s.mapper or s.loop or s.unit);self.assertFalse(Path(s.plan['image']).exists())
            calls=len(s.calls);private=len(s.privcalls);s.release=canonical_release
            with patch.object(m,'namespace_require_no_unit_file'),patch.object(m,'namespace_members',return_value=[]),patch.object(m,'namespace_show',side_effect=lambda name,keys:{k:slice_terminal_fixture()[k]for k in keys}):
                result=s.invoke(True)
            self.assertEqual(result['status'],'DISK_RECONCILED');self.assertEqual(s.journal().events[-1]['phase'],'RECONCILED')
            self.assertFalse((s.root/'standard/active').exists())
            self.assertTrue((Path(s.plan['work'])/'database.pgcustom.incoming').exists());self.assertTrue((Path(s.plan['work'])/'backup-operation.json').exists())
            self.assertEqual(s.privcalls[private:],[])
            self.assertFalse(any(a[0]in (m.DISK_TOOLS['mkfs'],m.DISK_TOOLS['mount']) or 'luksFormat'in a or a[0]==m.DISK_TOOLS['crypt']and a[1]in ('open','close') or a[0]==m.DISK_TOOLS['loop']and '--detach'in a for a in s.calls[calls:]))


class MainEntryRegressionTests(unittest.TestCase):
    """Exercise the production entry point with only custody-safe memory fixtures."""

    def entry_fixture(self):
        source=b'isolated supervisor entry fixture\n'
        op=namespace_operation(True)
        op['toolFileSha256']=m.digest(source)
        raw=m.encoded(op)
        plan=m.namespace_plan(op,raw,m.namespace_sizing(3*1024**3,8*1024**3,40*1024**3,NS_IMAGE),NS_IMAGE)
        tool=m.ROOT/'operator'/'tools'/op['toolCommit']/'control-timeweb-database-backup.py'
        work=m.ROOT/'backups'/('.disk-restore-'+m.digest(raw))
        return SimpleNamespace(source=source,op=op,raw=raw,plan=plan,tool=tool,work=work,
                               now=m.utc('2026-10-10T15:20:00.000Z'))

    def run_entry(self, fixture, argv, *, nodename='msk-1-vm-z8ks', machine='x86_64',
                  hostname=b'100.77.212.57 103.88.243.171\n', intent=True, now=None):
        reads=[]
        def read(path, mode=0o600):
            path=Path(path);reads.append((path,mode))
            if path==fixture.tool:return fixture.source
            if path==m.REQUEST:return fixture.raw
            if path==fixture.work/'backup-operation.json':return fixture.raw
            if path==fixture.work/'disk-plan.json':return m.encoded(fixture.plan)
            raise AssertionError(path)
        journal=SimpleNamespace(find=lambda phase:{} if intent and phase=='NAMESPACE_UNIT_START_INTENT' else None)
        return reads,[patch.multiple(m,
            __file__=str(fixture.tool),
            read_secure=read,
            DiskJournal=lambda work, operation_sha:journal,
            tool_custody=unittest.mock.Mock(),
            namespace_supervisor=unittest.mock.Mock(),
            execute=unittest.mock.Mock()),patch.object(m.sys,'argv',argv),patch.object(
            m.sys,'flags',SimpleNamespace(optimize=0,isolated=1)),patch.object(
            m.os,'getuid',return_value=0),patch.object(m.os,'umask'),patch.object(
            m.os,'uname',return_value=SimpleNamespace(nodename=nodename,machine=machine)),patch.object(
            m.time,'time',return_value=fixture.now if now is None else now),patch.object(
            m,'command',side_effect=lambda args,code:hostname if args==['/usr/bin/hostname','-I'] else (_ for _ in ()).throw(AssertionError(args)))]

    def test_supervisor_entry_skips_host_ip_probe_after_exact_custody_validation(self):
        f=self.entry_fixture();sha=m.digest(f.raw)
        reads,patches=self.run_entry(f,[str(f.tool),'--disk-runtime-supervisor',str(m.REQUEST),sha],hostname=b'')
        with ExitStack() as stack:
            for item in patches:stack.enter_context(item)
            m.main()
            m.namespace_supervisor.assert_called_once_with(f.op,f.raw,f.plan)
            self.assertEqual(reads,[(f.tool,0o755),(m.REQUEST,0o600),(f.work/'backup-operation.json',0o600),(f.work/'disk-plan.json',0o600)])
            m.tool_custody.assert_called_once_with(f.op)

    def test_normal_execution_rejects_missing_each_required_host_ip_before_mutation(self):
        for hostname in (b'100.77.212.57\n',b'103.88.243.171\n'):
            with self.subTest(hostname=hostname):
                f=self.entry_fixture();reads,patches=self.run_entry(f,[str(f.tool),'--execute',str(m.REQUEST)],hostname=hostname)
                with ExitStack() as stack:
                    for item in patches:stack.enter_context(item)
                    with self.assertRaisesRegex(m.Stop,'HOST'):m.main()
                    m.execute.assert_not_called();m.namespace_supervisor.assert_not_called()
                    self.assertEqual(reads,[(f.tool,0o755),(m.REQUEST,0o600)])

    def test_nodename_and_architecture_remain_required_for_normal_and_supervisor_entries(self):
        for argv_kind,nodename,machine in [('supervisor','other','x86_64'),('supervisor','msk-1-vm-z8ks','arm64'),
                                           ('normal','other','x86_64'),('normal','msk-1-vm-z8ks','arm64')]:
            with self.subTest(argv_kind=argv_kind,nodename=nodename,machine=machine):
                f=self.entry_fixture();argv=([str(f.tool),'--disk-runtime-supervisor',str(m.REQUEST),m.digest(f.raw)]
                    if argv_kind=='supervisor' else [str(f.tool),'--execute',str(m.REQUEST)])
                reads,patches=self.run_entry(f,argv,nodename=nodename,machine=machine)
                with ExitStack() as stack:
                    for item in patches:stack.enter_context(item)
                    with self.assertRaisesRegex(m.Stop,'HOST'):m.main()
                    m.namespace_supervisor.assert_not_called();m.execute.assert_not_called()
                    self.assertEqual(reads,[(f.tool,0o755),(m.REQUEST,0o600)])

    def test_invalid_supervisor_arguments_and_custody_fail_before_supervisor(self):
        f=self.entry_fixture();sha=m.digest(f.raw)
        cases=[
            ('argv',[str(f.tool),'--disk-runtime-supervisor','/wrong',sha],True,None),
            ('request-hash',[str(f.tool),'--disk-runtime-supervisor',str(m.REQUEST),'0'*64],True,None),
            ('expired',[str(f.tool),'--disk-runtime-supervisor',str(m.REQUEST),sha],True,m.utc(f.op['expiresAt'])),
            ('intent',[str(f.tool),'--disk-runtime-supervisor',str(m.REQUEST),sha],False,None),
        ]
        for name,argv,intent,now in cases:
            with self.subTest(name=name):
                reads,patches=self.run_entry(f,argv,intent=intent,now=now)
                with ExitStack() as stack:
                    for item in patches:stack.enter_context(item)
                    with self.assertRaises(m.Stop):m.main()
                    m.namespace_supervisor.assert_not_called();m.execute.assert_not_called()
                    self.assertEqual(len(reads),0 if name=='argv' else 2 if name in ('request-hash','expired') else 4)


class ControllerPromotionBindingTests(unittest.TestCase):
    def promotion(self, op):
        value = {'schema': 1, 'controllerSha': op['controllerSha'], 'controllerTree': op['controllerTree'],
                 'prNumber': 402, 'headBranch': 'codex/synthetic-controller', 'baseSha': 'a'*40,
                 'prCiRunId': op['controllerSourceCiRunId'], 'mergeSha': 'b'*40, 'mergeTree': 'c'*40,
                 'mainCiRunId': '123456789', 'executableManifestSha256': 'd'*64,
                 'resolutionManifestSha256': 'e'*64}
        value['sha256'] = m.digest(m.encoded({k: value[k] for k in sorted(value)}))
        return value

    def test_optional_promotion_preserves_legacy_and_binds_pre99_post101(self):
        for factory in (disk_operation, namespace_operation):
            for post in (False, True):
                op = factory(post)
                self.assertEqual(m.validate_operation(op, NOW, '2'*64), op)
                op['controllerPromotion'] = self.promotion(op)
                self.assertEqual(m.validate_operation(op, NOW, '2'*64), op)
                self.assertEqual(m.promotion_expected(op), {'controllerPromotionSha256': op['controllerPromotion']['sha256']})
        self.assertEqual(m.promotion_expected({}), {})

    def test_promotion_cannot_be_null_partial_extra_or_digest_drifted(self):
        op = namespace_operation()
        good = self.promotion(op)
        for bad in (None, {}, {**good, 'unknown': True}, {**good, 'sha256': '0'*64}):
            with self.subTest(value=bad), self.assertRaises(m.Stop):
                m.validate_operation({**op, 'controllerPromotion': bad}, NOW, '2'*64)

    def test_promotion_identity_and_source_bindings_are_strict(self):
        op = namespace_operation()
        for key, value in [('controllerSha', 'f'*40), ('controllerTree', 'f'*40),
                           ('prCiRunId', '1234'), ('prNumber', True), ('schema', True),
                           ('headBranch', 'codex/../escape'), ('headBranch', 'main'),
                           ('mainCiRunId', op['controllerSourceCiRunId']), ('baseSha', 'F'*40),
                           ('executableManifestSha256', 'nope')]:
            bad = self.promotion(op); bad[key] = value
            bad['sha256'] = m.digest(m.encoded({k: bad[k] for k in sorted(bad) if k != 'sha256'}))
            with self.subTest(key=key, value=value), self.assertRaises(m.Stop):
                m.validate_operation({**op, 'controllerPromotion': bad}, NOW, '2'*64)

    def test_promotion_cannot_expand_legacy_tmpfs_web_schema(self):
        op = copy.deepcopy(OP)
        op['controllerPromotion'] = self.promotion({**op, 'controllerSourceCiRunId': '1234'})
        with self.assertRaisesRegex(m.Stop, 'CONTROLLER_PROMOTION_SCHEMA'):
            m.validate_operation(op, NOW, '2'*64)



class ProfileIdentity(unittest.TestCase):
    def test_beta_ignores_restart_posture_but_not_image(self):
        restarted = dict(API, id='f' * 64, restarts=2, startedAt='2026-10-21T04:00:00.000000000Z')
        self.assertFalse(m.same_api_worker_identity(restarted, API, 'production'))
        self.assertTrue(m.same_api_worker_identity(restarted, API, 'beta'))
        for key in ('image', 'imageId', 'releaseId', 'revision'):
            changed = dict(API, **{key: 'changed'})
            self.assertFalse(m.same_api_worker_identity(changed, API, 'beta'))


CURRENT_API = {**API, 'id':'9'*64, 'image':m.WEB8158_IMAGE, 'imageId':'sha256:'+'8'*64,
               'releaseId':m.API_WORKER_CANDIDATE, 'revision':m.MIGRATION_BASE_SHA,
               'startedAt':'2026-10-21T08:00:00.000000000Z'}
OP_WEB8158 = {**OP, 'schema':m.WEB8158_SCHEMA, 'profile':'production',
              'toolCommit':OP['controllerSha'], 'releaseId':OP['controllerSha']+'-11-1',
              'controllerSourceCiRunId':'11', 'expectedLedgerSha256':m.API_WORKER_LEDGER_SHA256,
              'expectedApi':CURRENT_API,
              'confirmation':'BACKUP_RESTORE_WEB8158_'+'3'*12+'_KEEP_API_8158AC445C9F'}


def current_web_scenario(directory, namespace=False, fault=None):
    if not namespace:
        return Scenario(directory, fault, OP_WEB8158, API_WORKER_LEDGER)
    scenario = NamespaceScenario(directory, post=True, fault=fault)
    scenario.op = copy.deepcopy(OP_WEB8158)
    scenario.op['schema'] = m.NS_WEB8158_SCHEMA
    scenario.op['confirmation'] = 'BACKUP_RESTORE_WEB8158_PRIVATE_NAMESPACE_'+'3'*12+'_KEEP_API_8158AC445C9F'
    scenario.runtime_api = copy.deepcopy(CURRENT_API)
    scenario.op['controllerConfigSha256'] = m.digest(scenario.config)
    scenario.op['expectedBoundarySha256'] = m.digest(m.encoded(sorted([scenario.service_row(True),scenario.service_row(False)],key=lambda r:r['Id'])))
    scenario.request.write_bytes(m.encoded(scenario.op))
    with patch.object(m,'ROOT',scenario.root):
        scenario.plan=m.namespace_plan(scenario.op,m.encoded(scenario.op),m.namespace_sizing(1024,10**12,50*1024**3,NS_IMAGE),NS_IMAGE)
    return scenario


class CurrentWebBackupTests(unittest.TestCase):
    def test_exact_strict_request_and_mode_routing(self):
        for schema in (m.WEB8158_SCHEMA,m.NS_WEB8158_SCHEMA):
            op=copy.deepcopy(OP_WEB8158);op['schema']=schema
            if schema==m.NS_WEB8158_SCHEMA:
                op['confirmation']='BACKUP_RESTORE_WEB8158_PRIVATE_NAMESPACE_'+'3'*12+'_KEEP_API_8158AC445C9F'
            self.assertEqual(m.validate_operation(op,NOW,'2'*64),op)
            self.assertEqual(m.operation_mode(op),('web',op['releaseId']))
            self.assertEqual(m.is_namespace_operation(op),schema==m.NS_WEB8158_SCHEMA)
            self.assertEqual(m.is_disk_operation(op),schema==m.NS_WEB8158_SCHEMA)
            self.assertEqual(m.disk_ledger_sha(op),m.API_WORKER_LEDGER_SHA256)
            self.assertIsNone(m.v2_migration_proof(op,b'capsule',Path('/not-used')))
            changes=[lambda v:v.pop('profile'),lambda v:v.update(profile='beta'),lambda v:v.update(profile='unknown'),
                     lambda v:v.update(expectedLedgerSha256=m.API_WORKER_PRE_LEDGER_SHA256),
                     lambda v:v['expectedApi'].update(image=API['image']),lambda v:v['expectedApi'].update(releaseId=m.BASELINE),
                     lambda v:v['expectedApi'].update(restarts=1),lambda v:v['expectedApi'].update(revision='f'*40),
                     lambda v:v['expectedApi'].update(startedAt='unbound'),lambda v:v.update(toolCommit='f'*40),
                     lambda v:v.update(controllerSourceCiRunId='12'),lambda v:v.update(confirmation='yes'),
                     lambda v:v.update(migrationPlanSha256='a'*64),lambda v:v.update(extra=True)]
            for change in changes:
                bad=copy.deepcopy(op);change(bad)
                with self.subTest(schema=schema,change=change):
                    with self.assertRaises(m.Stop):m.validate_operation(bad,NOW,'2'*64)

    def test_raw_capacity_selection_and_fail_closed_limits(self):
        self.assertEqual(m.web8158_restore_schema(1024,10**12,10**12,NS_IMAGE),m.WEB8158_SCHEMA)
        self.assertEqual(m.web8158_restore_schema(3*1024**3,8*1024**3,60*1024**3,NS_IMAGE),m.NS_WEB8158_SCHEMA)
        for db,memory,disk in [(0,10**12,10**12),(3*1024**3,1024**3,60*1024**3),(3*1024**3,8*1024**3,1024)]:
            with self.assertRaises(m.Stop):m.web8158_restore_schema(db,memory,disk,NS_IMAGE)

    def test_both_engines_publish_current_api_ledger_and_bound_request(self):
        for namespace in (False,True):
            with self.subTest(namespace=namespace),tempfile.TemporaryDirectory(prefix='phub-current-web-') as directory:
                scenario=current_web_scenario(directory,namespace)
                result=scenario.invoke()
                canonical=scenario.root/'backups'/(OP_WEB8158['releaseId']+'-web')
                receipt=json.loads((canonical/'database-backup-receipt.json').read_bytes())
                self.assertEqual(receipt['baselineReleaseId'],m.API_WORKER_CANDIDATE)
                self.assertEqual(receipt['sourceLedgerSha256'],m.API_WORKER_LEDGER_SHA256)
                self.assertEqual(receipt['restoredLedgerSha256'],m.API_WORKER_LEDGER_SHA256)
                self.assertEqual((canonical/'backup-operation.json').read_bytes(),m.encoded(scenario.op))
                self.assertEqual(receipt['backupFile'],str(canonical/'database.pgcustom'))
                self.assertFalse(result['authorizesDeploy'])
                self.assertFalse((scenario.root/'standard/active').exists())

    def test_tmpfs_wrong_ledger_stops_before_dump_and_preserves_uncertainty(self):
        with tempfile.TemporaryDirectory(prefix='phub-current-web-') as directory:
            scenario=current_web_scenario(directory);scenario.ledger=API_WORKER_LEDGER[:-1]
            with self.assertRaisesRegex(m.Stop,'API_WORKER_LEDGER'):scenario.invoke()
            self.assertTrue((scenario.root/'standard/active').exists())
            self.assertFalse(any(m.SOURCE_DUMP in a for a in scenario.calls))

    def test_current_api_runtime_drift_never_dumps_or_false_succeeds(self):
        with tempfile.TemporaryDirectory(prefix='phub-current-web-') as directory:
            scenario=current_web_scenario(directory,fault='runtime-drift')
            with self.assertRaisesRegex(m.Stop,'RUNTIME_DRIFT'):scenario.invoke()
            self.assertFalse(any(m.SOURCE_DUMP in a for a in scenario.calls))

    def test_snapshot_drift_is_detected_at_entry_and_during_guards(self):
        for namespace in (False,True):
            for field in ('id','imageId','startedAt','restarts'):
                with self.subTest(namespace=namespace,field=field),tempfile.TemporaryDirectory(prefix='phub-current-web-') as directory:
                    scenario=current_web_scenario(directory,namespace)
                    original=scenario.service_row
                    reads=[0]
                    def row(api):
                        value=original(api)
                        if api:
                            reads[0]+=1
                            if reads[0]>=3:
                                if field=='id':value['Id']='f'*64
                                elif field=='imageId':value['Image']='sha256:'+'f'*64
                                elif field=='startedAt':value['State']['StartedAt']='2026-10-21T09:00:00.000000000Z'
                                else:value['RestartCount']=1
                        return value
                    scenario.service_row=row
                    with self.assertRaises(m.Stop):scenario.invoke()
                    self.assertFalse((scenario.root/'backups'/(OP_WEB8158['releaseId']+'-web')/'database-backup-receipt.json').exists())

    def test_namespace_lost_ack_reconciles_without_replaying_dump_or_restore(self):
        for phase in ('RESTORE_STARTED','PUBLISH_READY','PUBLISHED'):
            with self.subTest(phase=phase),tempfile.TemporaryDirectory(prefix='phub-current-web-') as directory:
                scenario=current_web_scenario(directory,True,'after:PHASE_'+phase)
                with self.assertRaises(m.Stop):scenario.invoke()
                self.assertTrue((scenario.root/'standard/active').exists())
                before=[a for a in scenario.privcalls if a[0] in ('create','start') or 'pg_restore' in a]
                dumps=[a for a in scenario.calls if m.SOURCE_DUMP in a]
                scenario.fault=None;scenario.invoke(True)
                self.assertEqual(before,[a for a in scenario.privcalls if a[0] in ('create','start') or 'pg_restore' in a])
                self.assertEqual(dumps,[a for a in scenario.calls if m.SOURCE_DUMP in a])
                self.assertFalse((scenario.root/'standard/active').exists())

    def test_source_is_authenticated_before_fixed_node_import(self):
        calls=[]
        def command(args,code,**kw):
            calls.append((args,kw))
            if args[0]=='/usr/bin/node':return b'WEB8158_SOURCE_VERIFIED'
            if args[-1]=='HEAD':return OP_WEB8158['controllerSha'].encode()
            if args[-1]=='HEAD^{tree}':return OP_WEB8158['controllerTree'].encode()
            if args[-2:]==['ls-files','-z']:return b'scripts/timeweb-critical-web.js\0'
            return b''
        info=SimpleNamespace(st_mode=stat.S_IFREG|0o644)
        with patch.object(m,'command',side_effect=command),patch.object(m,'secure',return_value=info):
            m.web8158_source(OP_WEB8158)
        args,kw=calls[-1]
        self.assertEqual(args[:2],['/usr/bin/node','--input-type=module'])
        self.assertIn('/opt/phub/timeweb-beta/standard/source/scripts/timeweb-critical-web.js',args[-1])
        self.assertEqual(kw['input_data'],m.encoded(OP_WEB8158));self.assertEqual(kw['timeout'],30)
        self.assertNotIn('NODE_OPTIONS',kw['environment']);self.assertNotIn('DOCKER_HOST',kw['environment'])
        for failure in ('dirty','wrong-head','bad-output','node-failure'):
            def bad(args,code,**kw):
                if failure=='dirty' and '--porcelain' in args:return b'M scripts/timeweb-critical-web.js'
                if failure=='wrong-head' and args[-1]=='HEAD':return b'f'*40
                if args[0]=='/usr/bin/node':
                    if failure=='node-failure':raise m.Stop('WEB8158_SOURCE')
                    if failure=='bad-output':return b'WEB8158_SOURCE_VERIFIED trailing'
                return command(args,code,**kw)
            calls.clear()
            with patch.object(m,'command',side_effect=bad),patch.object(m,'secure',return_value=info):
                with self.assertRaises(m.Stop):m.web8158_source(OP_WEB8158)
            if failure in ('dirty','wrong-head'):self.assertFalse(any(a[0]=='/usr/bin/node' for a,k in calls))

if __name__=='__main__':
    if len(sys.argv)==2 and sys.argv[1]=='--emit-namespace-fixture':
        print(json.dumps(namespace_fixture()))
    elif len(sys.argv)==3 and sys.argv[1] in ('--emit-web8158-fixture','--emit-web8158-namespace-fixture'):
        destination=Path(sys.argv[2]).resolve(strict=True)
        m.need(destination.is_relative_to(Path(tempfile.gettempdir()).resolve()) and destination.name.startswith('phub-backup-consumer-'), 'TEST_FIXTURE_PATH')
        scenario=current_web_scenario(destination,sys.argv[1]=='--emit-web8158-namespace-fixture')
        scenario.invoke()
        print(json.dumps({'transaction':str(destination/'backups'/(OP_WEB8158['releaseId']+'-web'))}))
    elif len(sys.argv)==3 and sys.argv[1]=='--emit-consumer-fixture':
        destination=Path(sys.argv[2]).resolve(strict=True)
        m.need(destination.is_relative_to(Path(tempfile.gettempdir()).resolve()) and destination.name.startswith('phub-backup-consumer-'), 'TEST_FIXTURE_PATH')
        scenario=Scenario(destination)
        scenario.invoke()
        print(json.dumps({'transaction':str(destination/'backups'/(OP['releaseId']+'-web'))}))
    elif len(sys.argv)==3 and sys.argv[1]=='--emit-api-worker-consumer-fixture':
        destination=Path(sys.argv[2]).resolve(strict=True)
        m.need(destination.is_relative_to(Path(tempfile.gettempdir()).resolve()) and destination.name.startswith('phub-backup-consumer-'), 'TEST_FIXTURE_PATH')
        scenario=Scenario(destination,operation=OP_API,ledger=API_WORKER_LEDGER)
        scenario.invoke()
        print(json.dumps({'transaction':str(destination/'backups'/(m.API_WORKER_CANDIDATE+'-api-worker'))}))
    elif len(sys.argv)==3 and sys.argv[1] in ('--emit-disk-pre99-consumer-fixture','--emit-disk-post101-consumer-fixture'):
        destination=Path(sys.argv[2]).resolve(strict=True)
        m.need(destination.is_relative_to(Path(tempfile.gettempdir()).resolve()) and destination.name.startswith('phub-backup-consumer-'), 'TEST_FIXTURE_PATH')
        scenario=DiskScenario(destination,post=sys.argv[1]=='--emit-disk-post101-consumer-fixture')
        scenario.invoke()
        print(json.dumps({'transaction':scenario.plan['canonical']}))
    else:
        unittest.main()
