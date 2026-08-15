import { describe, expect, it, vi } from 'vitest';

import {
  MediaRuntimeRoleProbeError,
  verifyMediaRuntimeRole,
  type MediaRuntimeRoleProbeClient,
} from './media-runtime-role-probe.js';

function createClient(input: {
  readonly tenantFound?: boolean;
  readonly userFound?: boolean;
  readonly crossTenantReadCount?: string;
  readonly allowWrite?: boolean;
}) {
  const queries: string[] = [];
  const end = vi.fn(() => Promise.resolve());
  const query = vi.fn((text: string) => {
    queries.push(text);
    if (text.includes('from identity.tenants')) {
      return Promise.resolve({
        rows:
          input.tenantFound === false
            ? []
            : [{ tenant_id: '11111111-1111-1111-1111-111111111111' }],
      });
    }
    if (text.includes('from identity.users')) {
      return Promise.resolve({
        rows:
          input.userFound === false ? [] : [{ user_id: '22222222-2222-2222-2222-222222222222' }],
      });
    }
    if (
      text.includes('select count(*)::text as row_count') &&
      text.includes('community_logo_observation_watermarks')
    ) {
      return Promise.resolve({ rows: [{ row_count: input.crossTenantReadCount ?? '0' }] });
    }
    const crossTenantInsert =
      queries.some((candidate) => candidate === 'savepoint cross_tenant_write') &&
      text.includes('insert into integration.community_logo_observation_watermarks');
    if (crossTenantInsert && !input.allowWrite) {
      throw Object.assign(new Error('RLS denied'), { code: '42501' });
    }
    return Promise.resolve({ rows: [] });
  });
  const client: MediaRuntimeRoleProbeClient = {
    connect: vi.fn(() => Promise.resolve()),
    query,
    end,
  };
  return { client, queries, end, query };
}

describe('media runtime role probe', () => {
  it('rolls back tenant-local DML after proving cross-tenant reads and writes are denied', async () => {
    const { client, queries, end } = createClient({});

    await expect(
      verifyMediaRuntimeRole(
        {
          connectionString: 'postgresql://runtime@postgres/phub_restore_1_1',
          tenantKey: 'local-padel',
        },
        () => client,
      ),
    ).resolves.toBeUndefined();

    expect(queries).toEqual(
      expect.arrayContaining([
        expect.stringContaining('insert into integration.profile_photo_client_commands'),
        expect.stringContaining('insert into integration.profile_photo_observation_watermarks'),
        expect.stringContaining('insert into integration.community_logo_observation_watermarks'),
        expect.stringContaining('insert into integration.media_cutover_state'),
        'rollback to savepoint cross_tenant_write',
        'rollback',
      ]),
    );
    expect(end).toHaveBeenCalledOnce();
  });

  it('fails closed when a cross-tenant row is visible', async () => {
    const { client, queries } = createClient({ crossTenantReadCount: '1' });

    await expect(
      verifyMediaRuntimeRole(
        {
          connectionString: 'postgresql://runtime@postgres/phub_restore_1_1',
          tenantKey: 'local-padel',
        },
        () => client,
      ),
    ).rejects.toEqual(new MediaRuntimeRoleProbeError('MEDIA_RUNTIME_CROSS_TENANT_READ_VISIBLE'));
    expect(queries.at(-1)).toBe('rollback');
  });

  it('binds the bounded probe to one exact active tenant before reading FORCE-RLS users', async () => {
    const { client, queries, query } = createClient({});

    await expect(
      verifyMediaRuntimeRole(
        {
          connectionString: 'postgresql://runtime@postgres/phub_restore_1_1',
          tenantKey: 'local-padel',
        },
        () => client,
      ),
    ).resolves.toBeUndefined();

    const tenantIndex = queries.findIndex((query) => query.includes('from identity.tenants'));
    const firstContextIndex = queries.findIndex((query) =>
      query.includes("set_config('app.tenant_id'"),
    );
    const firstUserIndex = queries.findIndex((query) => query.includes('from identity.users'));
    expect(firstContextIndex).toBeGreaterThan(tenantIndex);
    expect(firstUserIndex).toBeGreaterThan(firstContextIndex);
    expect(queries.filter((query) => query.includes('from identity.users'))).toHaveLength(1);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('tenant_key = $1'), ['local-padel']);
  });

  it('fails closed when a cross-tenant write is allowed', async () => {
    const { client, queries } = createClient({ allowWrite: true });

    await expect(
      verifyMediaRuntimeRole(
        {
          connectionString: 'postgresql://runtime@postgres/phub_restore_1_1',
          tenantKey: 'local-padel',
        },
        () => client,
      ),
    ).rejects.toEqual(new MediaRuntimeRoleProbeError('MEDIA_RUNTIME_CROSS_TENANT_WRITE_ALLOWED'));
    expect(queries.at(-1)).toBe('rollback');
  });
});
