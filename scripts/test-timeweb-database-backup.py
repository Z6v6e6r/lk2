"""Mock-only regression scenarios; no Docker, provider or database is contacted."""
import copy
import importlib.util
import io
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
    def __init__(self, directory, fault=None):
        self.root=Path(directory);self.fault=fault;self.calls=[];self.container='e'*64
        self.created=False;self.running=False;self.query_count=0;self.api_reads=0
        for path in ['operator','standard','backups','standard/source','standard/source/.git']:(self.root/path).mkdir(parents=True,exist_ok=True)
        self.request=self.root/'operator/database-backup-restore.json'
        self.request.write_bytes(m.encoded(OP))
        self.config=m.encoded({'controllerSha':OP['controllerSha'],'enabled':True})
        self.op=copy.deepcopy(OP);self.op['controllerConfigSha256']=m.digest(self.config)
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
                return m.encoded([['0001_changed.sql','f'*64]]) if self.fault=='source-ledger-drift' and self.query_count>1 else m.encoded(LEDGER)
            if 'pg_restore' in args:
                assert args[2]==self.container
                kwargs['stdin'].read()
                return b''
            if 'pg_isready' in args:return b''
            if '--command='+m.LEDGER_SQL in args:
                return m.encoded([['0001_changed.sql','f'*64]]) if self.fault=='restore-ledger-mismatch' else m.encoded(LEDGER)
        raise AssertionError('unmocked docker command: '+repr(args))

    def assert_no_environment(self,args):
        assert '.Config.Env' not in args[args.index('--format')+1]

    def invoke(self):
        real_read_text=Path.read_text
        def read_text(path,*args,**kwargs):
            return 'MemAvailable: 10000000 kB\n' if str(path)=='/proc/meminfo' else real_read_text(path,*args,**kwargs)
        with patch.object(m,'ROOT',self.root),patch.object(m,'REQUEST',self.request),patch.object(m,'LOCK',self.root/'standard/active'),patch.object(m,'secure',side_effect=lambda path,*args,**kwargs:Path(path).lstat()),patch.object(m,'read_secure',side_effect=self.read),patch.object(m,'docker',side_effect=self.docker),patch.object(m,'command',side_effect=self.command),patch.object(m,'tool_custody',return_value=b'validated-installation'),patch.object(m.time,'time',return_value=NOW),patch.object(m.os,'statvfs',return_value=SimpleNamespace(f_bavail=50*1024**3,f_frsize=1)),patch.object(Path,'read_text',new=read_text):
            return m.execute(copy.deepcopy(self.op),m.encoded(self.op),'2'*64)


class PipelineTests(unittest.TestCase):
    def scenario(self,fault=None):
        tmp=tempfile.TemporaryDirectory(prefix='phub-backup-mock-')
        self.addCleanup(tmp.cleanup)
        return Scenario(tmp.name,fault)

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


if __name__=='__main__':
    if len(sys.argv)==3 and sys.argv[1]=='--emit-consumer-fixture':
        destination=Path(sys.argv[2]).resolve(strict=True)
        m.need(destination.is_relative_to(Path(tempfile.gettempdir()).resolve()) and destination.name.startswith('phub-backup-consumer-'), 'TEST_FIXTURE_PATH')
        scenario=Scenario(destination)
        scenario.invoke()
        print(json.dumps({'transaction':str(destination/'backups'/(OP['releaseId']+'-web'))}))
    else:
        unittest.main()
