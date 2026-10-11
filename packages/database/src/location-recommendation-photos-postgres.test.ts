import { createHash, randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenantTransaction } from './connection.js';
import { createLocationRepository } from './location-repository.js';

function ciDatabase(): string | undefined {
  if (
    process.env.GITHUB_ACTIONS !== 'true' ||
    process.env.APP_ENV !== 'ci' ||
    !process.env.DATABASE_URL
  )
    return undefined;
  const url = new URL(process.env.DATABASE_URL);
  if (
    !['localhost', '127.0.0.1'].includes(url.hostname) ||
    url.username !== 'phub' ||
    url.pathname !== '/phub' ||
    url.port !== '5432'
  )
    throw new Error('LOCATION_RECOMMENDATION_PHOTOS_DISPOSABLE_DATABASE_REQUIRED');
  return url.toString();
}

const adminUrl = ciDatabase();
const suite = adminUrl ? describe : describe.skip;

suite('location recommendation card photos under a non-owner PostgreSQL role', () => {
  const admin = new Pool({ connectionString: adminUrl, max: 4 });
  const tenantId = randomUUID();
  const otherTenantId = randomUUID();
  const actorId = randomUUID();
  const otherActorId = randomUUID();
  const assetId = randomUUID();
  const otherAssetId = randomUUID();
  const role = `location_photo_test_${randomUUID().replaceAll('-', '')}`;
  const password = randomUUID();
  let runtime: Pool;
  let repository: ReturnType<typeof createLocationRepository>;
  let locationId: string;

  const profile = {
    slug: 'synthetic-location',
    title: 'Synthetic location',
    shortTitle: null,
    city: 'Moscow',
    courtCount: 1,
    address: 'Synthetic 1',
    latitude: 55.7,
    longitude: 37.6,
    timezone: 'Europe/Moscow',
    metroName: null,
    metroDistanceMeters: null,
    phoneE164: '+79990000000',
    workingHours: [],
    amenities: [],
    gallery: [],
    publicationStatus: 'DRAFT' as const,
    showOnHome: false,
    sortOrder: 0,
  };
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');

  function publishableProfile(title = profile.title) {
    return {
      ...profile,
      title,
      workingHours: (['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'] as const).map((weekday) => ({
        weekday,
        closed: false,
        intervals: [{ opensAt: '07:00', closesAt: '23:00' }],
      })),
      gallery: [
        {
          url: `/public/api/v1/location-${tenantId}/location-media/${assetId}`,
          alt: '',
          isCover: true,
          sortOrder: 0,
        },
      ],
      publicationStatus: 'PUBLISHED' as const,
    };
  }

  async function seedAsset(tenant: string, id: string, actor: string) {
    await withTenantTransaction(admin, tenant, (client) =>
      client.query(
        `insert into locations.media_assets (
           tenant_id, id, object_key, content_sha256, content_type, byte_size, width, height, created_by
         ) values ($1, $2, $3, $4, 'image/webp', 100, 10, 10, $5)`,
        [tenant, id, `location-media/${id}/${hash(id)}.webp`, hash(`asset:${id}`), actor],
      ),
    );
  }

  beforeAll(async () => {
    await admin.query(
      `create role ${role} login password '${password}' nosuperuser nobypassrls noinherit nocreatedb nocreaterole`,
    );
    await admin.query(`grant usage on schema identity, locations, audit, home to ${role}`);
    await admin.query(`grant select on identity.tenants, identity.users to ${role}`);
    await admin.query(`grant select, insert, update on locations.profiles to ${role}`);
    await admin.query(
      `grant select, insert, delete on locations.recommendation_card_photos to ${role}`,
    );
    await admin.query(`grant select on locations.media_assets to ${role}`);
    await admin.query(`grant select, insert on locations.admin_commands to ${role}`);
    await admin.query(`grant select, insert, update on locations.home_projection_state to ${role}`);
    await admin.query(`grant select on home.dashboard_components to ${role}`);
    await admin.query(`grant insert on audit.audit_log, audit.outbox_events to ${role}`);
    const runtimeUrl = new URL(adminUrl!);
    runtimeUrl.username = role;
    runtimeUrl.password = password;
    runtime = new Pool({ connectionString: runtimeUrl.toString(), max: 4 });
    repository = createLocationRepository(runtime);
    await admin.query(
      `insert into identity.tenants (id, tenant_key, display_name)
       values ($1, $2, 'Synthetic location'), ($3, $4, 'Other synthetic location')`,
      [tenantId, `location-${tenantId}`, otherTenantId, `location-${otherTenantId}`],
    );
    for (const [tenant, actor] of [
      [tenantId, actorId],
      [otherTenantId, otherActorId],
    ] as const) {
      await withTenantTransaction(admin, tenant, (client) =>
        client.query(
          `insert into identity.users (tenant_id, id, status) values ($1, $2, 'ACTIVE')`,
          [tenant, actor],
        ),
      );
    }
    await seedAsset(tenantId, assetId, actorId);
    await seedAsset(otherTenantId, otherAssetId, otherActorId);
  });

  afterAll(async () => {
    if (runtime) await runtime.end();
    for (const tenant of [tenantId, otherTenantId]) {
      await withTenantTransaction(admin, tenant, async (client) => {
        await client.query('delete from audit.outbox_events where tenant_id = $1', [tenant]);
        await client.query('delete from audit.audit_log where tenant_id = $1', [tenant]);
        await client.query('delete from locations.admin_commands where tenant_id = $1', [tenant]);
        await client.query(
          'delete from locations.recommendation_card_photos where tenant_id = $1',
          [tenant],
        );
        await client.query('delete from locations.profiles where tenant_id = $1', [tenant]);
        await client.query('delete from locations.media_assets where tenant_id = $1', [tenant]);
        await client.query('delete from locations.home_projection_state where tenant_id = $1', [
          tenant,
        ]);
        await client.query('delete from identity.users where tenant_id = $1', [tenant]);
      });
    }
    await admin.query('delete from identity.tenants where id in ($1, $2)', [
      tenantId,
      otherTenantId,
    ]);
    await admin.query(`drop owned by ${role}`);
    await admin.query(`drop role ${role}`);
    await admin.end();
  });

  it('persists, replays, preserves omitted bindings, clears explicitly, and rejects stale versions', async () => {
    const command = {
      tenantId,
      actorUserId: actorId,
      idempotencyKey: 'location-photo-create-0001',
      requestHash: hash('create'),
      correlationId: 'location-photo-test',
      profile: {
        ...profile,
        recommendationPhotos: [
          { assetId, eventType: 'GAME' as const, isActive: true, sortOrder: 0 },
          { assetId, eventType: 'TRAINING' as const, isActive: false, sortOrder: 1 },
        ],
      },
    };
    const created = await repository.create(command);
    expect(created).toMatchObject({ outcome: 'applied', replayed: false });
    if (created.outcome !== 'applied') throw new Error('LOCATION_PHOTO_CREATE_FAILED');
    locationId = created.location.id;
    expect(created.location.recommendationPhotos).toEqual(command.profile.recommendationPhotos);
    expect(await repository.readRecommendationPhotos?.(tenantId, [created.location.id])).toEqual(
      new Map(),
    );
    const published = await repository.update({
      ...command,
      locationId: created.location.id,
      expectedVersion: created.location.version,
      idempotencyKey: 'location-photo-publish-0001',
      requestHash: hash('publish'),
      profile: publishableProfile(),
    });
    expect(published).toMatchObject({ outcome: 'applied' });
    if (published.outcome !== 'applied') throw new Error('LOCATION_PHOTO_PUBLISH_FAILED');
    expect(await repository.readRecommendationPhotos?.(tenantId, [created.location.id])).toEqual(
      new Map([[created.location.id, command.profile.recommendationPhotos]]),
    );
    expect(await repository.create(command)).toMatchObject({ outcome: 'applied', replayed: true });

    const preserved = await repository.update({
      ...command,
      locationId: created.location.id,
      expectedVersion: published.location.version,
      idempotencyKey: 'location-photo-update-0001',
      requestHash: hash('preserve'),
      profile: publishableProfile('Synthetic location edited'),
    });
    expect(preserved).toMatchObject({ outcome: 'applied' });
    if (preserved.outcome !== 'applied') throw new Error('LOCATION_PHOTO_UPDATE_FAILED');
    expect(preserved.location.recommendationPhotos).toEqual(command.profile.recommendationPhotos);
    expect(
      await repository.update({
        ...command,
        locationId: created.location.id,
        expectedVersion: published.location.version,
        idempotencyKey: 'location-photo-stale-0001',
        requestHash: hash('stale'),
        profile: {
          ...publishableProfile(),
          recommendationPhotos: [
            { assetId: otherAssetId, eventType: 'GAME', isActive: true, sortOrder: 0 },
          ],
        },
      }),
    ).toMatchObject({ outcome: 'version_conflict' });
    const cleared = await repository.update({
      ...command,
      locationId: created.location.id,
      expectedVersion: preserved.location.version,
      idempotencyKey: 'location-photo-clear-0001',
      requestHash: hash('clear'),
      profile: { ...publishableProfile(), recommendationPhotos: [] },
    });
    expect(cleared).toMatchObject({ outcome: 'applied', location: { recommendationPhotos: [] } });
  });

  it('enforces tenant-bound assets and forced RLS for the runtime role', async () => {
    for (const [tenant, actor, asset] of [
      [tenantId, actorId, assetId],
      [otherTenantId, otherActorId, otherAssetId],
    ] as const) {
      const control = await repository.create({
        tenantId: tenant,
        actorUserId: actor,
        idempotencyKey: 'location-photo-rls-control-0001',
        requestHash: hash('rls-control'),
        correlationId: 'location-photo-test',
        profile: {
          ...profile,
          slug: 'tenant-rls-control',
          recommendationPhotos: [
            { assetId: asset, eventType: 'GAME', isActive: true, sortOrder: 0 },
          ],
        },
      });
      expect(control).toMatchObject({ outcome: 'applied' });
    }
    const invalid = await repository.create({
      tenantId,
      actorUserId: actorId,
      idempotencyKey: 'location-photo-foreign-0001',
      requestHash: hash('foreign'),
      correlationId: 'location-photo-test',
      profile: {
        ...profile,
        slug: 'foreign-photo',
        recommendationPhotos: [
          { assetId: otherAssetId, eventType: 'GAME', isActive: true, sortOrder: 0 },
        ],
      },
    });
    expect(invalid).toEqual({ outcome: 'media_invalid' });
    const table = await admin.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `select relrowsecurity, relforcerowsecurity from pg_class
        where oid = 'locations.recommendation_card_photos'::regclass`,
    );
    expect(table.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    const owner = await admin.query<{ runtime_is_owner: boolean }>(
      `select relowner = $1::regrole as runtime_is_owner from pg_class where oid = 'locations.recommendation_card_photos'::regclass`,
      [role],
    );
    expect(owner.rows[0]?.runtime_is_owner).toBe(false);
    const policies = await admin.query<{
      roles: string[];
      cmd: string;
      permissive: string;
      qual: string;
      with_check: string;
    }>(
      `select roles, cmd, permissive, qual, with_check from pg_policies where schemaname = 'locations' and tablename = 'recommendation_card_photos'`,
    );
    expect(policies.rows).toHaveLength(1);
    expect(policies.rows[0]).toMatchObject({
      roles: ['public'],
      cmd: 'ALL',
      permissive: 'PERMISSIVE',
    });
    expect(policies.rows[0]?.qual).toBe(
      "(tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)",
    );
    expect(policies.rows[0]?.with_check).toBe(policies.rows[0]?.qual);
    const grants = await admin.query<{
      grantee: string;
      privilege_type: string;
      is_grantable: boolean;
    }>(
      `select case when acl.grantee = 0 then 'PUBLIC' else grantee.rolname end as grantee,
              acl.privilege_type, acl.is_grantable
         from pg_class relation
         cross join lateral aclexplode(coalesce(relation.relacl, acldefault('r', relation.relowner))) acl
         left join pg_roles grantee on grantee.oid = acl.grantee
        where relation.oid = 'locations.recommendation_card_photos'::regclass
          and acl.grantee <> relation.relowner
        order by grantee, privilege_type`,
    );
    expect(grants.rows).toEqual([
      { grantee: role, privilege_type: 'DELETE', is_grantable: false },
      { grantee: role, privilege_type: 'INSERT', is_grantable: false },
      { grantee: role, privilege_type: 'SELECT', is_grantable: false },
    ]);
    const forbiddenPrivileges = await admin.query<{
      can_update: boolean;
      can_truncate: boolean;
      can_trigger: boolean;
      can_reference: boolean;
    }>(
      `select has_table_privilege($1, 'locations.recommendation_card_photos', 'UPDATE') as can_update,
              has_table_privilege($1, 'locations.recommendation_card_photos', 'TRUNCATE') as can_truncate,
              has_table_privilege($1, 'locations.recommendation_card_photos', 'TRIGGER') as can_trigger,
              has_table_privilege($1, 'locations.recommendation_card_photos', 'REFERENCES') as can_reference`,
      [role],
    );
    expect(forbiddenPrivileges.rows).toEqual([
      { can_update: false, can_truncate: false, can_trigger: false, can_reference: false },
    ]);
    await expect(
      withTenantTransaction(runtime, tenantId, (client) =>
        client.query(
          `insert into locations.recommendation_card_photos
           (tenant_id, location_id, asset_id, event_type, is_active, sort_order)
           values ($1, $2, $3, 'TOURNAMENT', true, 0)`,
          [tenantId, locationId, otherAssetId],
        ),
      ),
    ).rejects.toMatchObject({ code: '23503' });
    await expect(
      withTenantTransaction(runtime, tenantId, (client) =>
        client.query(
          `insert into locations.recommendation_card_photos
           (tenant_id, location_id, asset_id, event_type, is_active, sort_order)
           values ($1, $2, $3, 'TOURNAMENT', true, 0)`,
          [tenantId, randomUUID(), assetId],
        ),
      ),
    ).rejects.toMatchObject({ code: '23503' });
    await withTenantTransaction(runtime, tenantId, async (client) => {
      const ownRows = await client.query<{ count: number }>(
        'select count(*)::integer as count from locations.recommendation_card_photos',
      );
      expect(ownRows.rows[0]?.count).toBe(1);
      const foreignRows = await client.query<{ count: number }>(
        `select count(*)::integer as count
           from locations.recommendation_card_photos
          where tenant_id = $1`,
        [otherTenantId],
      );
      expect(foreignRows.rows[0]?.count).toBe(0);
    });
    await expect(
      withTenantTransaction(runtime, tenantId, (client) =>
        client.query(
          `insert into locations.recommendation_card_photos
           (tenant_id, location_id, asset_id, event_type, is_active, sort_order)
           values ($1, $2, $3, 'GAME', true, 0)`,
          [otherTenantId, randomUUID(), otherAssetId],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });
});
