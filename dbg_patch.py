import pathlib
src=pathlib.Path('/tmp/final-upgrade.js').read_text()
needle="    fail('canonical_predecessor_archive_binding');"
assert needle in src
dbg=("    console.error('BINDDEBUG', JSON.stringify({a:hash(operationBytes)===b.operationSha256,"
     "b:['PHUB_TIMEWEB_API_WORKER_WEB_OWNER_DIRECTED_CUTOVER_V4',CANONICAL_PLAN].includes(op.schema),"
     "c:op.candidateSha===b.sourceSha,d:op.candidateTree===b.sourceTree,"
     "e:String(op.sourceCiRunId)===String(b.sourceCiRunId),f:String(op.publicationRunId)===String(b.publicationRunId),"
     "g:String(op.artifactId)===String(b.artifactId),h:op.manifestSha256===b.manifestSha256,"
     "i:('sha256:'+hash(archiveBytes))===op.artifactDigest,"
     "j:hash(operationBytes),k:b.operationSha256}));\n")
pathlib.Path('/tmp/dbg-upgrade.js').write_text(src.replace(needle,dbg+needle,1))
print('debug written')