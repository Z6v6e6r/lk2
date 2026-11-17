import pathlib
p=pathlib.Path('scripts/control-timeweb-database-backup.py')
s=p.read_text()
old='''        needle=ROOT/item['path'];secure(needle)
        need(file_digest(needle)==item['sha256'],'V6_HISTORY_FILE')'''
assert old in s, 'v6 hash block'
new='''        needle=ROOT/item['path'];secure(needle)
        need(hashlib.sha256(read_secure(needle)).hexdigest()==item['sha256'],'V6_HISTORY_FILE')'''
s=s.replace(old,new,1)
p.write_text(s)
print('patched')