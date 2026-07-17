# Location publication runbook

## Preconditions

1. Confirm a verified database backup and rollback path.
2. Run `npm run db:migrate:check`, then apply migration `0021_location_profiles.sql` through the
   migrator. API processes must not run migrations on startup.
3. Confirm API and worker readiness and that `phub.locations-home-projector.v1` is consuming.
4. Grant only the required `locations.read`, `locations.manage` and, when separated operationally,
   `locations.publish` permissions through the audited access command.

## Publish

1. Open ЦУП → Настройки → Станции and create a draft.
2. Fill title, unique slug, city, court count, seven-day schedule, one HTTPS cover, amenities,
   address, coordinates, metro hint and E.164 phone.
3. Keep `Показывать на Главной` off until the detail page is approved. Save the draft and reload it
   to verify versioned persistence.
4. Publish only at 100% completeness. Verify the User API list and detail contain the PadlHub UUID,
   computed open status and no provider identifiers.
5. Enable Home visibility and set order. Verify the worker inbox/outbox event, the locations Home
   component revision and the next complete Home snapshot before approving the rollout.
6. Smoke the cabinet directory, detail card, navigation link and touch/mouse Home carousel.

## Failure and rollback

- On invalid content, archive the profile or return it to draft with a new versioned command.
- On Home projection failure, turn off `showOnHome`; the directory can remain published while the
  worker is repaired. Do not overlay a live row in the Home API.
- On API regression, roll back the immutable application image. Migration 0021 is expand-only and
  can remain in place; do not drop its tables during an incident.
- On duplicate slug or version conflict, reload the current profile and resolve explicitly. Never
  bypass the optimistic predicate or reuse an idempotency key with changed input.
- Record the correlation ID, PadlHub location UUID, profile version and Home snapshot revision in
  the incident or rollout log. Do not record phone values or image credentials.
