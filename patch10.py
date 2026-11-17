import pathlib
p=pathlib.Path('scripts/timeweb-production-cutover.js')
s=p.read_text()
old='  const derivedIdentity =\n    /^[0-9a-f]{40}-[1-9][0-9]*-1$/u.test(value.installedReleaseId ?? \'\') &&'
assert old in s, 'derived head'
new='  const derivedIdentity =\n    value.installedReleaseId !== CANONICAL_BASELINE_RELEASE &&\n    /^[0-9a-f]{40}-[1-9][0-9]*-1$/u.test(value.installedReleaseId ?? \'\') &&'
s=s.replace(old,new,1)
p.write_text(s)
print('patched derived guard')