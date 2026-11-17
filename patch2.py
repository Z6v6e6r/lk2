import pathlib
p=pathlib.Path('scripts/build-timeweb-canonical-backup-request.py')
s=p.read_text()
s=s.replace('import argparse\n', 'import argparse\nimport subprocess\n', 1)
old='''    baseline = dict(op['canonicalBaseline'])
    now = datetime.datetime.now(datetime.UTC)
    baseline['capturedAt'] = now.strftime('%Y-%m-%dT%H:%M:%S.') + f'{now.microsecond // 1000:03d}Z'
    op['canonicalBaseline'] = baseline'''
assert old in s, 'baseline block'
new='''    derived = json.loads(
        subprocess.run(
            ['/usr/bin/python3', '-I', '-S', '-B', str(tool), '--baseline', args.template],
            capture_output=True,
            check=True,
            env={'PATH': '/usr/bin:/bin'},
        ).stdout
    )
    baseline = derived['baseline']
    now = datetime.datetime.now(datetime.UTC)
    op['canonicalBaseline'] = baseline
    op.update(
        {
            'expectedApi': derived['expectedApi'],
            'expectedPostgres': derived['expectedPostgres'],
            'expectedBoundarySha256': derived['expectedBoundarySha256'],
            'expectedLedgerSha256': derived['expectedLedgerSha256'],
            'expectedDatabaseTarget': derived['expectedDatabaseTarget'],
        }
    )'''
s=s.replace(old,new,1)
p.write_text(s)
print('builder patched')

q=pathlib.Path('scripts/control-timeweb-database-backup.py')
t=q.read_text()
marker='def main():'
assert marker in t, 'main marker'
modes='''def main():
    if len(sys.argv)==3 and sys.argv[1]=='--baseline':
        need(os.getuid()==0 and sys.flags.isolated==1 and sys.flags.dont_write_bytecode,'BASELINE_ENTRY')
        derive_installed_mode(sys.argv[2]);return
    if len(sys.argv)==3 and sys.argv[1]=='--plan':
        need(os.getuid()==0 and sys.flags.isolated==1 and sys.flags.dont_write_bytecode,'PLAN_ENTRY')
        plan_mode(sys.argv[2]);return'''
t=t.replace(marker,modes,1)
q.write_text(t)
print('main patched')