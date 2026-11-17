#!/usr/bin/env python3
"""Disposable PG16 snapshot/zstd rehearsal. No production configuration or credentials."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time

spec=importlib.util.spec_from_file_location('backup',Path(__file__).with_name('control-timeweb-database-backup.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

def run(args,**kwargs):
    return subprocess.run(['/usr/bin/docker',*args],check=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=120,**kwargs).stdout

def sql(cid,query):
    return run(['exec','-i',cid,'psql','-X','--username=phub_restore','--dbname=phub_restore','-qAt','--set=ON_ERROR_STOP=1'],input=query.encode()).strip()

def main():
    containers=[]
    run(['pull','--platform=linux/amd64',m.PG_IMAGE])
    with tempfile.TemporaryDirectory(prefix='phub-cutover-pg16-') as directory:
        root=Path(directory)
        try:
            plans=[]
            for index in range(2):
                mount=root/str(index);mount.mkdir(mode=0o1777);mount.chmod(0o1777)
                plan={'schema':m.CUTOVER_DISK_PLAN,'operationSha256':str(index+1)*64,'mount':str(mount),'memoryBytes':m.DISK_MEMORY,
                      'containerName':'phub-timeweb-restore-'+str(index+1)*12+'-'+str(os.getpid())+'-1'}
                args=m.disk_container_args(plan)
                cid=run(args).decode().strip();containers.append(cid);plans.append(plan)
                run(['start',cid])
                for attempt in range(45):
                    ready=subprocess.run(['/usr/bin/docker','exec',cid,'pg_isready','--username=phub_restore','--dbname=phub_restore'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode
                    if ready==0:break
                    time.sleep(1)
                else:raise RuntimeError('rehearsal_not_ready')
            source,restore=containers
            schema="""
create schema identity;create schema integration;create schema profile;
create table public.schema_migrations(filename text,checksum text);
insert into public.schema_migrations select lpad(n::text,4,'0')||'_fixture.sql',repeat('a',64) from generate_series(1,122) n;
create table identity.users(tenant_id text,id text,status text);
insert into identity.users values('fixture','user1','ACTIVE');
create table integration.external_identity_map(tenant_id text,id text,user_id text,provider text,issuer text,subject text);
create table profile.user_summaries(tenant_id text,user_id text);
create table identity.refresh_sessions(tenant_id text,id text,user_id text,family_id text,parent_session_id text,replaced_by_session_id text,expires_at timestamptz,rotated_at timestamptz,revoked_at timestamptz);
create table integration.user_delegations(tenant_id text,id text,user_id text,provider text,issuer text,subject text,encryption_key_version text,refresh_expires_at timestamptz,revoked_at timestamptz);
"""
            sql(source,schema)
            target=m.strict(sql(source,m.CUTOVER_TARGET_SQL))
            op={'expectedPostgres':{'id':source,'image':m.PG_IMAGE},'expectedDatabaseTarget':{k:target[k] for k in ['databaseName','systemIdentifier']},
                'expectedLedgerSha256':m.digest(m.ledger_bytes(sql(source,m.LEDGER_SQL)))}
            # Reserve checks target only the owned temporary directory in this rehearsal.
            m.ROOT=root
            dump=root/'fixture.pgcustom'
            with m.cutover_source_snapshot(op,'a'*64) as snapshot:
                sql(source,"insert into identity.users values('fixture','user2','ACTIVE')")
                with dump.open('wb') as output:
                    m.cutover_blocking_docker(['exec',source,'/bin/sh','-eu','-c',m.cutover_snapshot_dump_shell('a'*64,snapshot['token'])],
                                             'REHEARSAL_DUMP',stdout=output,file_limit=m.CUTOVER_DUMP_LIMIT,timeout=120)
            with dump.open('rb') as stream:
                m.cutover_blocking_docker(['exec','-i',restore,'/usr/bin/timeout','-s','TERM','-k','10','100','pg_restore','--username=phub_restore','--dbname=phub_restore','--no-owner','--no-acl','--single-transaction','--exit-on-error'],
                                         'REHEARSAL_RESTORE',stdin=stream,timeout=120)
            assert m.digest(m.encoded(m.strict(sql(restore,m.CUTOVER_ACCOUNTS_SQL))))==snapshot['accountsSha256']
            assert sql(source,'select count(*) from identity.users')==b'2'
            assert sql(restore,'select count(*) from identity.users')==b'1'
            assert m.ledger_bytes(sql(restore,m.LEDGER_SQL))==snapshot['ledger']
            settings=m.strict(sql(restore,"select json_build_array(current_setting('wal_level'),current_setting('max_wal_senders'),current_setting('max_replication_slots'),current_setting('archive_mode'),current_setting('fsync'),current_setting('full_page_writes'),current_setting('synchronous_commit'))::text"))
            assert settings==['minimal','0','0','off','on','on','on']
            m.cutover_disk_source_stopped(op,'a'*64)
            print(json.dumps({'status':'CUTOVER_SNAPSHOT_PG16_PASS','fullFixtureRestore':True,'concurrentSourceChangeExcluded':True,'zstdLevel':3}))
        finally:
            for cid in reversed(containers):
                subprocess.run(['/usr/bin/docker','rm','--force','--volumes',cid],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=30)
            # PGDATA belongs to the image's postgres UID. Remove only the two owned
            # fixture directories through that same unprivileged image identity.
            for plan in plans:
                run(['run','--rm','--pull','never','--network','none','--read-only','--user','postgres',
                     '--cap-drop','ALL','--security-opt','no-new-privileges','--entrypoint','/bin/sh',
                     '--mount','type=bind,src='+plan['mount']+',dst=/var/lib/postgresql/data,bind-propagation=rprivate',
                     m.PG_IMAGE,'-eu','-c','rm -rf -- /var/lib/postgresql/data/phub-restore'])

if __name__=='__main__':main()
