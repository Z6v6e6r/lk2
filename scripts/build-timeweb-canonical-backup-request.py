#!/usr/bin/env python3
"""Build the canonical fresh-dump request for a merged main candidate.

The producer tool stays the only authority for the operation schema; this helper only
refreshes the baseline capture time, recomputes the two baseline hashes and the owner
scope, and writes the closed request to the fixed path. It never dumps, activates or
touches the database.
"""
import argparse
import datetime
import importlib.util
import json
import os
import pathlib
import sys

ROOT = pathlib.Path('/opt/phub/timeweb-beta')


def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--candidate', required=True)
    parser.add_argument('--run', required=True)
    parser.add_argument('--template', required=True)
    parser.add_argument('--tool-dir', required=True)
    parser.add_argument('--expires-in-minutes', type=int, default=55)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()

    tool = pathlib.Path(args.tool_dir) / 'control-timeweb-database-backup.py'
    module = load(tool, 'backup_producer')
    template = json.loads(pathlib.Path(args.template).read_text())
    op = dict(template)

    baseline = dict(op['canonicalBaseline'])
    now = datetime.datetime.now(datetime.UTC)
    baseline['capturedAt'] = now.strftime('%Y-%m-%dT%H:%M:%S.') + f'{now.microsecond // 1000:03d}Z'
    op['canonicalBaseline'] = baseline

    config = pathlib.Path('/etc/phub/timeweb-beta-standard-delivery.json').read_bytes()
    tool_dir = pathlib.Path(args.tool_dir)
    op.update(
        {
            'toolCommit': args.candidate,
            'controllerSha': args.candidate,
            'controllerTree': _tree(ROOT / 'standard/source'),
            'controllerConfigSha256': _sha(config),
            'candidateSha': args.candidate,
            'publicationRunId': str(args.run),
            'releaseId': f'{args.candidate}-{args.run}-1',
            'confirmation': 'FRESH_DUMP_CANONICAL_PRIOR_RESTORE_BETA122_'
            + args.candidate[:12].upper()
            + '_KEEP_DATA_AND_ACCOUNTS',
            'toolFileSha256': _sha(tool.read_bytes()),
            'toolInstallationSha256': _sha((tool_dir / 'installation-receipt.json').read_bytes()),
            'toolProofSha256': _sha((tool_dir / 'source-proof.json').read_bytes()),
            'expiresAt': (now + datetime.timedelta(minutes=args.expires_in_minutes)).strftime(
                '%Y-%m-%dT%H:%M:%S.000Z'
            ),
        }
    )
    op['ownerRestoreDecision'] = dict(op['ownerRestoreDecision'], scopeSha256='0' * 64)
    op['predecessorAttestationSha256'] = module.canonical_baseline_hash(baseline)
    op['predecessorRuntimeSha256'] = module.legacy_runtime_hash(baseline)
    op['ownerRestoreDecision']['scopeSha256'] = module.fresh_owner_scope(op)

    raw = module.encoded(op)
    out = pathlib.Path(args.output)
    out.write_bytes(raw)
    os.chmod(out, 0o600)
    print(json.dumps({'status': 'REQUEST_WRITTEN', 'operationSha256': _sha(raw), 'expiresAt': op['expiresAt']}))


def _sha(value):
    import hashlib

    return hashlib.sha256(value).hexdigest()


def _tree(path):
    import subprocess

    result = subprocess.run(
        ['/usr/bin/git', '-C', str(path), 'rev-parse', 'HEAD^{tree}'],
        capture_output=True,
        check=True,
        env={'PATH': '/usr/bin:/bin'},
    )
    return result.stdout.decode().strip()


if __name__ == '__main__':
    sys.exit(main())
