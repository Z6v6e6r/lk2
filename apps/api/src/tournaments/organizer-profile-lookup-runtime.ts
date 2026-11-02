import { readFileSync } from 'node:fs';
import type { AppConfig } from '@phub/config';
import { withTenantTransaction } from '@phub/database';
import type { Pool } from 'pg';
import type Redis from 'ioredis';
import { organizerPublicKey, type OrganizerLookupOptions } from './organizer-profile-lookup.js';

/** No provisioning or profile mutation. A single SQL snapshot validates both mapping directions. */
export function organizerProfileReader(pool: Pool): OrganizerLookupOptions['findProfile'] {
  return (tenantId, tenantKey, userId) =>
    withTenantTransaction(pool, tenantId, async (client) => {
      await client.query('set local statement_timeout = 2000');
      const result = await client.query<{
        user_id: string;
        display_name: string;
        external_id: string;
        owner_tenant_key: string;
        forward_count: string;
        reverse_count: string;
      }>(
        `
      select u.id user_id, s.display_name, m.external_id, b.provider_tenant_key owner_tenant_key,
        (select count(*) from integration.external_entity_map f where f.tenant_id=u.tenant_id and f.internal_id=u.id and f.external_system='VIVA' and f.entity_type='viva_profile') forward_count,
        (select count(*) from integration.external_entity_map r where r.tenant_id=m.tenant_id and r.external_id=m.external_id and r.external_system='VIVA' and r.entity_type='viva_profile') reverse_count
      from identity.users u join identity.tenants t on t.id=u.tenant_id and t.tenant_key=$2 and t.active=true
      join integration.identity_provider_bindings b on b.tenant_id=u.tenant_id and b.provider='VIVA'
      join profile.user_summaries s on s.tenant_id=u.tenant_id and s.user_id=u.id
      join integration.external_entity_map m on m.tenant_id=u.tenant_id and m.internal_id=u.id and m.external_system='VIVA' and m.entity_type='viva_profile'
      where u.tenant_id=$1 and u.id=$3 and u.status='ACTIVE' and m.sync_status='synced'
        and m.sync_error_code is null and m.last_synced_at is not null limit 2`,
        [tenantId, tenantKey, userId],
      );
      const row = result.rows.length === 1 ? result.rows[0] : undefined;
      return row &&
        row.forward_count === '1' &&
        row.reverse_count === '1' &&
        typeof row.external_id === 'string' &&
        /^[A-Za-z0-9_-]{1,200}$/.test(row.external_id) &&
        typeof row.owner_tenant_key === 'string' &&
        /^[A-Za-z0-9_-]{1,200}$/.test(row.owner_tenant_key) &&
        typeof row.display_name === 'string' &&
        row.display_name.trim().length > 0 &&
        row.display_name.length <= 200
        ? {
            userId: row.user_id,
            displayName: row.display_name,
            ownerTenantKey: row.owner_tenant_key,
          }
        : null;
    });
}
export function createOrganizerProfileLookup(
  config: AppConfig,
  pool: Pool,
  redis: Redis,
): OrganizerLookupOptions | undefined {
  if (!config.TOURNAMENT_ORGANIZER_LOOKUP_ENABLED) return undefined;
  const {
    TOURNAMENT_ORGANIZER_LOOKUP_PUBLIC_KEYS_FILE: file,
    TOURNAMENT_ORGANIZER_LOOKUP_ISSUER: issuer,
    TOURNAMENT_ORGANIZER_LOOKUP_AUDIENCE: audience,
    TOURNAMENT_ORGANIZER_LOOKUP_SUBJECT: subject,
    TOURNAMENT_ORGANIZER_LOOKUP_TENANT_ID: tenantId,
    TOURNAMENT_ORGANIZER_LOOKUP_TENANT_KEY: tenantKey,
  } = config;
  if (!file || !issuer || !audience || !subject || !tenantId || !tenantKey)
    throw new Error('ORGANIZER_LOOKUP_CONFIG_INVALID');
  const bytes = readFileSync(file);
  if (bytes.length > 32768) throw new Error('ORGANIZER_LOOKUP_CONFIG_INVALID');
  const input: unknown = JSON.parse(bytes.toString('utf8'));
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).length < 1 ||
    Object.keys(input).length > 4
  )
    throw new Error('ORGANIZER_LOOKUP_CONFIG_INVALID');
  const publicKeys = new Map(
    Object.entries(input).map(([kid, pem]) => {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(kid) || typeof pem !== 'string')
        throw new Error('ORGANIZER_LOOKUP_CONFIG_INVALID');
      return [kid, organizerPublicKey(pem)] as const;
    }),
  );
  return {
    issuer,
    audience,
    subject,
    tenantId,
    tenantKey,
    publicKeys,
    findProfile: organizerProfileReader(pool),
    claimNonce: async (key, ttl) => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          redis.set(key, '1', 'EX', ttl, 'NX').then((value) => value === 'OK'),
          new Promise<boolean>((_, reject) => {
            timeout = setTimeout(
              () => reject(new Error('ORGANIZER_LOOKUP_NONCE_UNAVAILABLE')),
              1500,
            );
          }),
        ]);
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
