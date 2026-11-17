# LK2 production deploy helper

`scripts/lk2-deploy.js` wraps the manual critical API/Worker/Web route. It adds no new
authority: it only stages inputs the enrolled controller already validates and fails closed on
every drift the strict runbook lists. Run it as root on the target host from the enrolled checkout.

- `plan <sha> --run <publication-run> --artifact <zip> --manifest-sha256 <sha>`
  is read-only and returns GO/NO-GO with a category list: controller pin, leaked self-bind mounts
  of `backups`, artifact digest, backup freshness and expiry coupling, and an occupied
  manual lock.
- `enroll <sha>` installs a detached full-history clone in
  `standard/source.incoming-<sha12>`, runs `npm ci --ignore-scripts`, swaps the checkout and the pinned
  `controllerSha` atomically, keeps the previous checkout and writes an enrollment receipt. It
  never touches the backups root or runtime secrets.
- `prepare <sha> --run <run> --artifact <zip> --artifact-id <id> --source-ci-run <id>`
  stages `releases/<id>/artifact/canonical-artifact.zip`, installs the backup helper at the
  candidate commit when missing, takes the canonical fresh dump through the enrolled helper, and
  writes the V5 request with recomputed baseline capture, owner scope and an expiry that cannot
  outlive the backup operation. It prints the exact confirmation.
- `apply <sha> --confirmation <value>` runs the enrolled controller, then terminal
  reconciliation, and prints the receipt status.

A leaked self-bind mount stack under `backups` is the known EXDEV cause of
`DISK_PUBLISH_UNCERTAIN`; `plan` and `prepare` refuse to run until it is removed.

## Baseline V6

The canonical fresh dump no longer pins one frozen predecessor. When the installed
release is not the original `4b8` V4 baseline, the producer validates the runtime
baseline through the reviewed controller attestation
(`deriveInstalledCanonicalBaseline` / `attestCanonicalBaseline`) and keeps the
retained `prior-full-restore-reference` read-set unchanged. The V4 path is byte-identical
to before.

- `control-timeweb-database-backup.py --baseline <request>` (read-only) prints the
  baseline derived from the installed descriptor, its V5 transaction and the live runtime.
- `control-timeweb-database-backup.py --plan <request>` (read-only) validates the whole
  draft request, including tool custody and the controller attestation, without taking a
  lock or dumping.
