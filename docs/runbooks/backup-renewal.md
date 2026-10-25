# Backup renewal preflight (ADR-0026 phase 1)

Read-only plan for the conservative renewal of a **successful but unadmitted** pre-105 backup. The
controller cannot simply repeat it: the canonical directory name is occupied by the old release
identity and its global request lease is held until the final API/Worker reconciliation.

The conservative path from the incident review:

1. retire the old backup **metadata-only** and keep its canonical bytes and receipts in place;
2. create the new backup under a **new source identity** (`controllerSha-controllerCiRunId-1`), so it
   gets a new canonical path;
3. release the old lease only after the retirement receipt exists;
4. never delete the old canonical bytes, never rewrite the completed receipt, never re-run the old
   restore.

`npm run release:backup-renewal-plan -- --input renewal.json` evaluates that path and prints
GO/NO_GO by check. It never retires, releases, deletes, contacts the host or mutates custody.

## Input packet

```json
{
  "current": {
    "releaseId": "<controllerSha>-<controllerCiRunId>-1",
    "sourceSha": "<40-hex>",
    "sourceCiRunId": "<digits>",
    "operationSha256": "<64-hex>",
    "receiptSha256": "<64-hex>",
    "outcome": "SUCCESS | RECONCILED | ABORTED | FAILED",
    "admittedToMigration": false,
    "leaseHeld": true,
    "completedAt": "2026-10-24T21:06:37.000Z"
  },
  "target": {
    "controllerSha": "<40-hex>",
    "sourceSha": "<40-hex>",
    "sourceCiRunId": "<digits>"
  },
  "evidence": {
    "canonicalDirPresent": true,
    "canonicalBytesPreserved": true,
    "receiptVerified": true,
    "restoreProofVerified": true,
    "sevenCcPreserved": true
  },
  "capacity": {
    "databaseBytes": 11176434711,
    "requiredDiskBytes": 47453667687,
    "freeDiskBytes": 42928771072
  },
  "operations": { "activeMigrations": 0, "activeUpgrades": 0, "activeReconciles": 0 }
}
```

## Checks

| Check                       | GO when                                                                                                |
| --------------------------- | ------------------------------------------------------------------------------------------------------ |
| `CURRENT_SUCCESSFUL`        | the old backup outcome is `SUCCESS` or `RECONCILED`                                                    |
| `NOT_ADMITTED_TO_MIGRATION` | the old backup was never admitted to a migration                                                       |
| `EVIDENCE_INTACT`           | canonical dir and bytes are present; receipt and restore proof are verified; 7CC evidence is preserved |
| `NEW_RELEASE_IDENTITY`      | a new controller SHA/CI run yields a release id different from the occupied one                        |
| `NO_ACTIVE_OPERATION`       | no active migration, upgrade or reconcile owns the host                                                |
| `CAPACITY_READY`            | free disk covers the canonical required bytes from the readback                                        |

A GO plan lists the actions, but it is **not** execution authority: the live metadata-only retirement
mode must land as its own reviewed controller change with independent specialist review, and the
operator still needs the exact-package approval and a fresh preflight before each write.

## Current known blocker (24–25.10)

The successful `966` backup is `RECONCILED`, unadmitted, holds the lease, and its canonical bytes and
receipts are intact. The host is still short ~4.52 GB against the canonical capacity readback, so this
preflight reports `CAPACITY_READY=false` and the plan is NO_GO. Freeing/resizing the disk is the
first required action; retirement alone does not free canonical bytes and must not be used as a
capacity workaround.

## What this does not do

- Does not delete or move the old backup or its 7CC evidence.
- Does not change `receipt.completedAt` or the restore proof.
- Does not create a new backup request, acquire a lease or release one.
- Does not relax the capacity, ledger or admission gates.
