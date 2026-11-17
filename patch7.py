import pathlib
p=pathlib.Path('scripts/timeweb-api-web-upgrade.js')
s=p.read_text()
old="    op.schema !== 'PHUB_TIMEWEB_API_WORKER_WEB_OWNER_DIRECTED_CUTOVER_V4' ||"
assert old in s, 'schema literal'
s=s.replace(old, "    ![\"PHUB_TIMEWEB_API_WORKER_WEB_OWNER_DIRECTED_CUTOVER_V4\", CANONICAL_PLAN].includes(op.schema) ||",1)
p.write_text(s)
print('patched')