import pathlib
p=pathlib.Path('scripts/timeweb-api-web-upgrade.js')
s=p.read_text()
old='    installed.values.PHUB_COMPONENT_ROLLOUT_KIND !== OWNER_KIND ||'
assert old in s, 'kind check'
s=s.replace(old,'    ![OWNER_KIND, CANONICAL_KIND].includes(installed.values.PHUB_COMPONENT_ROLLOUT_KIND) ||',1)
old2='    priorReceipt.schema !== OWNER_RECEIPT ||'
assert old2 in s, 'receipt check'
s=s.replace(old2,'    ![OWNER_RECEIPT, CANONICAL_RECEIPT].includes(priorReceipt.schema) ||',1)
p.write_text(s)
print('patched')