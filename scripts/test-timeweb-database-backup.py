"""Mock-only regression scenarios; no Docker, provider or database is contacted."""
import base64
import copy
import importlib.util
import io
import re
import shutil
import json
import os
from pathlib import Path
import stat
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
API_WORKER_LEDGER=[[path.name,m.digest(path.read_bytes())] for path in sorted(Path(__file__).parents[1].glob('packages/database/migrations/*.sql'))]
assert len(API_WORKER_LEDGER)==101
assert m.digest(m.encoded(API_WORKER_LEDGER))==m.API_WORKER_LEDGER_SHA256
OP_API={**OP,'schema':'PHUB_TIMEWEB_BACKUP_OPERATION_API_WORKER_V2','candidateReleaseId':m.API_WORKER_CANDIDATE,
        'expectedLedgerSha256':m.API_WORKER_LEDGER_SHA256,
        'controllerSourceCiRunId':'38170498441','migrationPlanSha256':'a'*64,'migrationSuccessSha256':'b'*64,
        'confirmation':'BACKUP_RESTORE_API_WORKER_11954FFD6D7B_KEEP_API_0D6078BE7A50'}
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
        for key,value in [('candidateReleaseId','4'*40+'-38144582876-1'),('expectedLedgerSha256','f'*64),
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
        pair=list(m.API_WORKER_CI_DOWNLOAD_PATCH.values())
        def raw(rows):return b''.join((':'+v['oldMode']+' '+v['newMode']+' '+v['oldOid']+' '+v['newOid']+' '+v['status']+'\0'+v['path']+'\0').encode()for v in rows)
        m.validate_migration_controller_delta(raw(pair))
        invalid=[pair[:1],pair+[pair[0]],pair+[dict(pair[0],path='.github/workflows/other.yaml')]]
        for field,value in [('oldOid','a'*40),('newOid','b'*40),('newMode','100755'),('newMode','120000'),('oldMode','000000'),('status','A'),('status','D'),('status','R100')]:
            invalid.append([dict(pair[0],**{field:value}),pair[1]])
        for rows in invalid:
            with self.assertRaises(m.Stop):m.validate_migration_controller_delta(raw(rows))
        contract=(Path(__file__).parent/'timeweb-api-worker-contract.js').read_text()
        section=contract.split('export const API_WORKER_CI_DOWNLOAD_PATCH = Object.freeze([',1)[1].split(']);',1)[0]
        js={}
        for item in re.findall(r'Object.freeze\(\{(.*?)\}\)',section,re.S):
            value=dict(re.findall(r"(path|status|oldMode|newMode|oldOid|newOid):\s*'([^']+)'",item));js[value['path']]=value
        self.assertEqual(js,m.API_WORKER_CI_DOWNLOAD_PATCH)

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
        self.root=Path(directory);self.fault=fault;self.calls=[];self.container='e'*64
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
            if args[-1]=='HEAD':return (OP['controllerSha']+'\n').encode()
            if args[-1]=='HEAD^{tree}':return (OP['controllerTree']+'\n').encode()
            return b''
        raise AssertionError('unmocked command: '+repr(args))

    def service_row(self,api):
        v=API if api else PG
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
                return API['id'].encode() if 'service=api' in filters else m.PG_ID.encode()
            return ('\n'.join([API['id'],m.PG_ID]+([self.container]if self.created else []))).encode()
        if args[0]=='inspect':
            target=args[-1]
            self.assert_no_environment(args)
            if target==self.container:
                row=restore_row(self.container,m.digest(m.encoded(self.op)),self.tmpfs,'running' if self.running else 'created')
                if not self.running and any(a[1]=='stop' for a in self.calls if len(a)>1):row['State']['Status']='exited'
            else:
                row=self.service_row(target==API['id'])
                if target==API['id']:
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
                'confirmation': 'BACKUP_RESTORE_API_WORKER_DISK_LUKS2_11954FFD6D7B_KEEP_API_0D6078BE7A50'}
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
        super().__init__(directory,None,disk_operation(post),API_WORKER_LEDGER if post else API_WORKER_LEDGER[:-2])
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




if __name__=='__main__':
    if len(sys.argv)==3 and sys.argv[1]=='--emit-consumer-fixture':
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
