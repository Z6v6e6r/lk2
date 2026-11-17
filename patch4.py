import pathlib
p=pathlib.Path('scripts/control-timeweb-database-backup.py')
s=p.read_text()
old='''        needle=ROOT/item['path'];secure(needle)
        need(hashlib.sha256(read_secure(needle)).hexdigest()==item['sha256'],'V6_HISTORY_FILE')'''
assert old in s, 'v6 read block'
new='''        needle=ROOT/item['path']
        need(v6_file_sha256(needle)==item['sha256'],'V6_HISTORY_FILE')'''
s=s.replace(old,new,1)
helper='''def v6_file_sha256(path):
    """Stream a retained read-set file without assuming a 0600 mode or small size."""
    before=secure(path)
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
    try:
        opened=os.fstat(fd);need(identity(before)==identity(opened),'V6_HISTORY_RACE')
        h=hashlib.sha256()
        with os.fdopen(os.dup(fd),'rb') as stream:
            for block in iter(lambda:stream.read(1024**2),b''):h.update(block)
        need(identity(opened)==identity(os.fstat(fd))==identity(path.lstat()),'V6_HISTORY_CHANGED')
        return h.hexdigest()
    finally:os.close(fd)

'''
marker='def validate_v6_prior_restore(op):'
assert marker in s
s=s.replace(marker, helper+marker, 1)
p.write_text(s)
print('patched')