import pathlib
p=pathlib.Path('scripts/timeweb-api-web-upgrade.js')
s=p.read_text()
old="!['PHUB_TIMEWEB_API_WORKER_WEB_OWNER_DIRECTED_CUTOVER_V4', CANONICAL_PLAN].includes("
assert old in s, 'includes block'
s=s.replace(old, "!['PHUB_TIMEWEB_API_WORKER_WEB_OWNER_DIRECTED_CUTOVER_V4', 'PHUB_TIMEWEB_API_WORKER_WEB_CANONICAL_UPGRADE_V5'].includes(",1)
p.write_text(s)
print('patched schema')