# Locations editorial domain

## Boundary and ownership

`locations.profiles` is the `LOCAL_ONLY` source of truth for the public presentation of a PadlHub
location. It owns the name, slug, city, court count, address, coordinates, timezone, metro hint,
public phone, weekly hours, ordered amenities, ordered gallery, publication state and Home order.

It does not own Viva stations, spaces, coaches, timetable, availability or booking inventory. Those
operational aggregates remain `VIVA_PRIMARY` until their ownership is changed separately. A public
location profile has only a PadlHub UUID and deliberately contains no Viva identifier. Clients call
only PadlHub Location and Home APIs and never select or merge a station source.

## Invariants

- Every profile and command ledger row is tenant-scoped and protected by forced PostgreSQL RLS.
- A gallery contains at most 12 distinct HTTPS URLs and exactly one cover when non-empty.
- Weekly hours contain at most one entry per weekday and at most three intervals per day. The
  server calculates `openNow` in the profile IANA timezone, including an interval crossing midnight.
- Latitude and longitude are either both present or both absent. Navigation links are derived by
  the server from coordinates.
- Publication requires a cover, city, positive court count, address, coordinates, public phone and
  all seven weekdays. Drafts may remain incomplete.
- Slugs are tenant-unique. Updates require the last observed positive version and fail on a stale
  version instead of overwriting another operator.
- Create and update commands require a dedicated admin JWT, CUP platform, administrative
  permission, `Idempotency-Key`, correlation ID and audit record. Reusing a key with another payload
  is a stable conflict.
- User reads return only `PUBLISHED` profiles. `ARCHIVED` and `DRAFT` data never reaches user clients.

## API and presentation

The CUP uses the Admin API list, detail, create and update operations under
`/admin/api/v1/{tenantKey}/locations`. The settings workspace exposes the `Станции` tab next to
`Общие настройки` and `Быстрые ответы`; the previous Split-action entry point is not part of this
surface. Operators can search, create, edit, archive, publish, choose Home visibility and order, and
see completeness plus a mobile preview.

The authenticated cabinet uses `GET /user/api/v1/{tenantKey}/locations` for the directory and
`GET /user/api/v1/{tenantKey}/locations/{padlHubLocationId}` for a detail card. Open status,
working-hours copy and Yandex navigation URL are server-owned computed fields. Favorite and review
state are separate future aggregates and are not stored on the editorial profile.

The first media slice accepts existing HTTPS delivery URLs. Binary uploads, object validation,
derivatives and garbage collection must be added as a separate storage-backed command before CUP
can accept files; clients must never be given storage credentials.

## Events and Home projection

A successful profile command writes business state, audit metadata and
`locations.profile.changed.v1` to the outbox in one PostgreSQL transaction. The event contains only
the PadlHub location UUID and a monotonic component revision. The locations worker loads at most
eight published profiles marked for Home, builds one strict `locations` component, and fans it out
to existing tenant Home users through `home.projection.component.changed.v1`.

The Home API continues to read one complete stored snapshot. It never overlays live location rows
onto another snapshot version. Replays are deduplicated through the inbox and same-revision changes
with different payloads remain conflicts.

## Operations

Apply migration `0021_location_profiles.sql` with the migrator, grant the minimum location
permission, create a draft, publish only after completeness reaches 100%, and verify both User API
reads and the next Home projection revision. The operational procedure and rollback gates are in
[the location publication runbook](../runbooks/location-publication.md).
