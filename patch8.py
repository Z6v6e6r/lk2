import pathlib
p=pathlib.Path('/tmp/p-upgrade.js') if False else pathlib.Path('.v6-wt/scripts/timeweb-api-web-upgrade.js')
s=p.read_text()
needle="    fail('canonical_predecessor_archive_binding');"
assert needle in s
dbg='''    console.error('BIND', JSON.stringify({opHash:hash(operationBytes)===b.operationSha256,schema:op.schema,cand:op.candidateSha===b.sourceSha,tree:op.candidateTree===b.sourceTree,ci:String(op.sourceCiRunId)===String(b.sourceCiRunId),pub:String(op.publicationRunId)===String(b.publicationRunId),artId:String(op.artifactId)===String(b.artifactId),man:op.manifestSha256===b.manifestSha256,digest:'sha256:'+hash(archiveBytes)===op.artifactDigest,opSchemaOk:['PHUB_TIMEWEB_API_WORKER_WEB_OWNER_DIRECTED_CUTOVER_V4',CANONICAL_PLAN].includes(op.schema)}));\n'''
s=s.replace(needle, dbg+needle,1)
pathlib.Path('.v6-wt/scripts/timeweb-api-web-upgrade.debug.js').write_text(s)
print('debug built')