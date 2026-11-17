import pathlib
p=pathlib.Path('scripts/control-timeweb-database-backup.py')
s=p.read_text()

helpers = '''
def installed_release_id():
    row=service('phub-timeweb-beta','api')
    value=row.get('releaseId') if isinstance(row,dict) else None
    need(isinstance(value,str) and RELEASE.fullmatch(value),'INSTALLED_RELEASE_IDENTITY')
    return value

def validate_v6_prior_restore(op):
    b=op['canonicalBaseline'];directory=ROOT/'backups'/(b['installedReleaseId']+'-api-web')
    secure(directory,'dir',0o700)
    raw=read_secure(directory/'prior-full-restore-reference.json');ref=strict(raw)
    need(ref.get('schema')==CANONICAL_HISTORY_SCHEMA
         and ref.get('historicalReadSetSha256')==op['historicalReadSetSha256'],'V6_HISTORY_REFERENCE')
    files=ref.get('files');need(isinstance(files,list) and files,'V6_HISTORY_FILES')
    for item in files:
        exact(item,['path','sha256','identity'])
        needle=ROOT/item['path'];secure(needle)
        need(file_digest(needle)==item['sha256'],'V6_HISTORY_FILE')
    need(encoded(ref)==raw,'V6_HISTORY_CANONICAL')
    return ref

def installed_baseline_derive(template):
    source=ROOT/'standard/source'
    program="import{readFileSync}from'node:fs';import{deriveInstalledCanonicalBaseline}from'./scripts/timeweb-api-web-upgrade.js';process.stdout.write(JSON.stringify(deriveInstalledCanonicalBaseline(JSON.parse(readFileSync(0,'utf8')))));"
    raw=command(['/usr/bin/node','--input-type=module','-e',program],'BASELINE_DERIVE',input_data=encoded(template),cwd=str(source),timeout=60)
    need(0<len(raw)<=65536,'BASELINE_DERIVE_SIZE')
    return strict(raw)

def canonical_baseline_attest_only(op):
    source=ROOT/'standard/source'
    program="import{readFileSync}from'node:fs';import{attestCanonicalBaseline}from'./scripts/timeweb-api-web-upgrade.js';process.stdout.write(JSON.stringify(attestCanonicalBaseline(JSON.parse(readFileSync(0,'utf8')))));"
    raw=command(['/usr/bin/node','--input-type=module','-e',program],'BASELINE_ATTEST',input_data=encoded(op['canonicalBaseline']),cwd=str(source),timeout=60)
    need(0<len(raw)<=65536,'BASELINE_ATTEST_SIZE')
    return strict(raw)

def derive_installed_mode(path):
    template=strict(read_secure(Path(path)))
    baseline=installed_baseline_derive(template['canonicalBaseline'])
    api=service('phub-timeweb-beta','api');postgres=service('phub-timeweb-beta-dependencies','postgres')
    ids=docker(['ps','-aq','--no-trunc']).decode().split()
    rows=[strict(docker(['inspect','--format',INSPECT_FORMAT,i])) for i in sorted(ids)]
    out={'baseline':baseline,'expectedApi':api,'expectedPostgres':postgres,'expectedBoundarySha256':digest(encoded(rows)),'expectedLedgerSha256':template['expectedLedgerSha256'],'expectedDatabaseTarget':template['expectedDatabaseTarget']}
    print(json.dumps(out,separators=(',',':')))

def plan_mode(path):
    file=Path(__file__);file_sha=digest(read_secure(file,0o755))
    raw=read_secure(Path(path));op=validate_operation(strict(raw),time.time(),file_sha,allow_expired=True)
    need(is_canonical_fresh(op),'PLAN_SCHEMA')
    tool_custody(op);validate_canonical_backup_baseline(op)
    validate_prior_restore(op)
    canonical_baseline_attest_only(op)
    print(json.dumps({'status':'PLAN_OK','installedReleaseId':op['canonicalBaseline']['installedReleaseId'],'predecessorAttestationSha256':op['predecessorAttestationSha256'],'historicalReadSetSha256':op['historicalReadSetSha256']}))

'''
marker='def validate_canonical_backup_baseline(op):'
assert marker in s, 'baseline marker'
s=s.replace(marker, helpers+marker, 1)

old_head='''def validate_canonical_backup_baseline(op):
    b=op['canonicalBaseline'];exact(b,CANONICAL_BASELINE_FIELDS)
    need(b['schema']=='PHUB_TIMEWEB_INSTALLED_CANONICAL_ROSTER_RUNTIME_V1'
         and b['installedReleaseId']==CANONICAL_PRIOR_RELEASE and b['sourceSha']==CANONICAL_PRIOR_SOURCE'''
assert old_head in s, 'old head'
new_head='''def validate_canonical_backup_baseline(op):
    b=op['canonicalBaseline'];exact(b,CANONICAL_BASELINE_FIELDS)
    if b['installedReleaseId']!=CANONICAL_PRIOR_RELEASE:
        need(b['schema']=='PHUB_TIMEWEB_INSTALLED_CANONICAL_ROSTER_RUNTIME_V1'
             and b['installedReleaseId']==installed_release_id()
             and b['sourceSha']==b['installedReleaseId'][:40]
             and b['databaseTarget']==op['expectedDatabaseTarget']==LOCATION_PHOTO_DATABASE_TARGET
             and b['ledgerSha256']==op['expectedLedgerSha256']
             and canonical_baseline_hash(b)==op['predecessorAttestationSha256']
             and legacy_runtime_hash(b)==op['predecessorRuntimeSha256']
             and HASH.fullmatch(op['historicalReadSetSha256'] or ''),'CANONICAL_BASELINE')
        utc(b['capturedAt']);need(RELEASE.fullmatch(b['secretSetReleaseId'] or ''),'CANONICAL_SECRET_SET')
        for k in ['installedDescriptorSha256','operationSha256','planSha256','receiptSha256','observationSha256','backupOperationSha256','backupReceiptSha256','excludedSha256']:
            need(HASH.fullmatch(b[k] or ''),'CANONICAL_CUSTODY_HASH')
        exact(b['secretHashes'],['.release-identity.json','api.env','worker.env','realtime.env','migrator.env'])
        need(all(HASH.fullmatch(v or '') for v in b['secretHashes'].values()),'CANONICAL_SECRET_HASH')
        exact(b['containers'],['api','web','worker','realtime'])
        for service_name,row in b['containers'].items():
            exact(row,['id','image','imageId','releaseId','revision','restarts','startedAt'])
            need(HASH.fullmatch(row['id'] or '') and re.fullmatch(r'ghcr\.io/z6v6e6r/phub-'+service_name+r'@sha256:[a-f0-9]{64}',row['image'] or '')
                 and row['imageId']==row['image'].split('@')[1] and row['restarts']==0
                 and row['releaseId']==(b['installedReleaseId'] if service_name in ('api','web') else None)
                 and row['revision']==(None if service_name=='realtime' else b['sourceSha']),'CANONICAL_CONTAINER')
            need(re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3,9}Z',row['startedAt'] or ''),'CANONICAL_CONTAINER_TIME')
        return
    need(b['schema']=='PHUB_TIMEWEB_INSTALLED_CANONICAL_ROSTER_RUNTIME_V1'
         and b['installedReleaseId']==CANONICAL_PRIOR_RELEASE and b['sourceSha']==CANONICAL_PRIOR_SOURCE'''
s=s.replace(old_head,new_head,1)

old_prior='''def validate_canonical_prior_restore(op):
    validate_fresh_owner(op);validate_canonical_backup_baseline(op)'''
assert old_prior in s, 'prior head'
new_prior='''def validate_canonical_prior_restore(op):
    validate_fresh_owner(op);validate_canonical_backup_baseline(op)
    if op['canonicalBaseline']['installedReleaseId']!=CANONICAL_PRIOR_RELEASE:
        return validate_v6_prior_restore(op)'''
s=s.replace(old_prior,new_prior,1)

p.write_text(s)
print('patched', len(s))