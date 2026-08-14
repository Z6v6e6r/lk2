# Communities chain integration

## Scope and authority

This runbook integrates the canonical Communities implementation without activating it. Canonical
reads and every command remain disabled unless the server advertises the explicit
`communityCanonical` capability. Legacy read-only projections remain the default migration mode.
Media, realtime, invites, worker processing and data import require their own release gates.

Database migrations are forward-only. Application rollback may restore the previous image and
runtime flags, but must never remove an applied migration or rewrite `schema_migrations`.

## Historical ledger contract

The first Communities release was applied under the shifted filenames below. These exact files and
checksums are immutable and must remain packaged:

| Filename                                     | SHA-256                                                            |
| -------------------------------------------- | ------------------------------------------------------------------ |
| `0053_profile_visibility_sections.sql`       | `b6c7603110b6c208b11b274f5b7f9ff0eb3bf0ebacdb986201b3e9c944286266` |
| `0054_community_membership_pin_commands.sql` | `e4fdedbccd25d4ffc656029dbe7220ad465b577ff2aa4ec4ee4a369cf533150e` |
| `0055_community_create_commands.sql`         | `2e55fdaf1a67cc870625d32cc7743ab0e68c8a9fc2f86a27bc18b0d7fa10d1a7` |
| `0056_community_discovery_indexes.sql`       | `59cf2f3eaf4bb65699884e9ef3702937b3c43c88bd0d3779afd3658b02b453e7` |
| `0057_community_membership_lifecycle.sql`    | `f6bd497d9445efc5b750ebd6e8412a4a35276ffc69af4c4f5a615185aa767f35` |
| `0058_community_direct_invites.sql`          | `f8c8245e25e83236587c75546b007d2fbcfc55f1e510e1770dc2e7bb0e472e10` |
| `0059_community_direct_invite_quotas.sql`    | `cf2040b77106515bbe986f503886576049bcf33dd24c303936c97dca9cff5e5d` |
| `0060_viva_home_booking_ownership.sql`       | `5b74d85ef678639694c9074f8a66eb5df6b243f60b1b6f429eced3f0b09d5f38` |
| `0061_community_mine_keyset_index.sql`       | `1caf9857dff642fb577a3713fa330b2e413670ec3f5e622582d2a6b17df78413` |
| `0062_community_ownership_transfers.sql`     | `58df5b8539a0bb29bb74e2c149d438adb4c831a0dc9295c31f13a471ff12e998` |
| `0063_community_content_foundation.sql`      | `515baca7fd0d897ee02308e4a23f5b09aef7a303bbefbe835e379a63a4f4c05d` |
| `0064_community_durable_events.sql`          | `3a7aead3d0b0c62a8a53d89a3d19a2008bee5896ae04a3bfe70a47d35d204072` |
| `0065_community_content_moderation.sql`      | `d48f63eaabcadef0d376d148ef6225cc8f5eb2423ae11d0c8a143d83d6a0ebe1` |
| `0066_community_member_count_projection.sql` | `b228b50810a62a0ba609fb7ab67d5ef9bbf60bbd875e108aae03c91035eb5e49` |
| `0067_community_media_lifecycle.sql`         | `1653d039325452ca8ef0e88fb78a96863b928fae52688e3cd20e83f1fe16f0eb` |
| `0068_community_event_retention.sql`         | `94c959a60eeb02ad7308453cf7b99fbf38919900475091e3b025133f4fc3a2f8` |

The superseded canonical filenames `0060_community_membership_pin_commands.sql` through
`0075_community_media_operational_recovery.sql` must never be inserted as aliases. Their presence
means the target has an incompatible or mixed history; both migration entrypoints fail before DDL.
Every other ledger filename must be present in the packaged release. The sole reviewed exception is
legacy `0043_messaging_runtime.sql` with checksum
`32512565880a9062a432eb68ec192b0640570f1636d2f2a946ab4ebc5bf96465`; the existing 0056 alias
migration verifies its full schema before recording the current 0057 filename.

New changes continue from:

- `0076_community_create_quota_grants.sql`
- `0077_community_media_operational_recovery.sql`

## Required preflight

1. Freeze one immutable release digest and record the target database identity.
2. Query `public.schema_migrations` read-only and compare every packaged filename checksum.
3. Stop on any unknown filename, superseded canonical filename, mixed history or checksum
   mismatch.
4. Take a verified PostgreSQL backup and record its checksum, size and restore command.
5. Restore the backup to an isolated PostgreSQL 16 clone with no application traffic.
6. Run the built `apps/migrator` image against the clone, then run it again and require no output.
7. Compare Communities row counts before and after; require all indexes valid and all Communities
   tables to have both RLS and FORCE RLS.
8. Validate existing `NOT VALID` Communities constraints in a transaction and roll it back.
9. Exercise an intentionally mixed clone and require `COMMUNITIES_CANONICAL_HISTORY_REJECTED`
   before any missing migration is written.
10. Before and after migration, count `profile.privacy_commands` rows whose `result_payload` lacks
    `visibilityMode` or `sections`. The exact historical 0053 backfill runs against a FORCE-RLS
    table; any non-zero post-count requires a separate forward tenant-scoped repair and blocks
    activation.
11. Only after CI and independent migration/security review may the code release be merged.

## Activation boundary

Merging the code and forward migrations does not authorize import or activation. Keep
`COMMUNITIES_READ_MODE=legacy`, `communityCanonical=false`, media/invite/realtime flags false, and
the canonical worker/realtime consumers stopped. Import, identity binding, ownership, Media/S3,
Realtime and write activation each require separate evidence and approval.
