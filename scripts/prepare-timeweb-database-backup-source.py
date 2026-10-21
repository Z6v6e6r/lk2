#!/usr/bin/env python3
"""Prepare a local Git-object witness. Never installs or contacts a host/provider."""
import base64
import importlib.util
import os
from pathlib import Path
import re
import subprocess
import sys

spec = importlib.util.spec_from_file_location('backup', Path(__file__).with_name('control-timeweb-database-backup.py'))
backup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backup)


def prepare(repo, commit):
    backup.need(backup.SHA.fullmatch(commit or ''), 'SOURCE_COMMIT')
    repo = Path(repo).resolve(strict=True)
    env = {**backup.ENV, 'HOME': '/nonexistent'}
    prefix = ['git', '-C', str(repo), '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false']
    def git(args):
        try:
            result = subprocess.run(prefix+args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                    env=env, timeout=30, check=False)
        except (OSError, subprocess.TimeoutExpired):
            raise backup.Stop('LOCAL_GIT_UNCERTAIN') from None
        backup.need(result.returncode==0 and len(result.stdout)<=4*1024**2, 'LOCAL_GIT')
        return result.stdout
    backup.need(git(['remote','get-url','origin']).strip()==b'https://github.com/Z6v6e6r/lk2.git', 'SOURCE_REPOSITORY')
    backup.need(git(['rev-parse','HEAD']).decode().strip()==commit and not git(['status','--porcelain','--untracked-files=all']).strip(), 'SOURCE_NOT_CLEAN')
    backup.need(not git(['for-each-ref','--format=%(refname)','refs/replace']).strip()
                and git(['rev-parse','--is-shallow-repository']).strip()==b'false', 'SOURCE_OBJECT_OVERRIDE')
    common = Path(git(['rev-parse','--git-common-dir']).decode().strip())
    if not common.is_absolute(): common = repo/common
    backup.need(not any(os.path.lexists(common/path) for path in ['info/grafts','objects/info/alternates','shallow']), 'SOURCE_OBJECT_OVERRIDE')
    raw_commit = git(['cat-file','commit',commit])
    match = re.match(rb'tree ([a-f0-9]{40})\n',raw_commit)
    backup.need(match is not None, 'COMMIT_TREE')
    root_oid = match[1].decode()
    root = git(['cat-file','tree',root_oid])
    scripts_mode, scripts_oid = backup.tree_entries(root).get('scripts', ('',''))
    backup.need(scripts_mode=='40000', 'ROOT_TREE')
    scripts = git(['cat-file','tree',scripts_oid])
    blob_mode, blob_oid = backup.tree_entries(scripts).get('control-timeweb-database-backup.py', ('',''))
    backup.need(blob_mode=='100644', 'SCRIPT_BLOB')
    blob = git(['cat-file','blob',blob_oid])
    backup.need(blob==(repo/'scripts/control-timeweb-database-backup.py').read_bytes(), 'SOURCE_CHECKOUT_DRIFT')
    def obj(kind, raw):
        return {'oid':backup.git_oid(kind,raw),'sha256':backup.digest(raw),'base64':base64.b64encode(raw).decode()}
    proof = {'schema':'PHUB_TIMEWEB_BACKUP_SOURCE_PROOF_V1','repository':{'name':'Z6v6e6r/lk2','id':1297548073},
             'path':'scripts/control-timeweb-database-backup.py','commit':obj('commit',raw_commit),
             'rootTree':obj('tree',root),'scriptsTree':obj('tree',scripts),
             'blob':{'oid':blob_oid,'sha256':backup.digest(blob)}}
    backup.verify_source_proof(proof, {'toolCommit':commit,'toolFileSha256':backup.digest(blob),'toolProofSha256':backup.digest(backup.encoded(proof))},blob)
    return proof


def main():
    backup.need(sys.flags.isolated==1 and sys.flags.optimize==0 and len(sys.argv)==4, 'LOCAL_ENTRY')
    proof = prepare(sys.argv[1],sys.argv[2])
    output = Path(sys.argv[3])
    fd = os.open(output,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    try:
        data = backup.encoded(proof)
        with os.fdopen(os.dup(fd),'wb') as stream:
            stream.write(data);stream.flush()
        os.fsync(fd)
    finally:
        os.close(fd)
    print(backup.encoded({'status':'LOCAL_SOURCE_PROOF_PREPARED','toolCommit':proof['commit']['oid'],
                         'toolFileSha256':proof['blob']['sha256'],'toolProofSha256':backup.digest(data),
                         'authorizesInstallation':False}).decode().strip())


if __name__=='__main__':
    try:
        main()
    except Exception as error:
        print(backup.encoded({'status':'STOP','code':str(error) if isinstance(error,backup.Stop) else 'LOCAL_PREPARATION_FAILURE'}).decode().strip())
        sys.exit(1)
