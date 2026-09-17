import { createDatabasePool, withTenantTransaction } from '@phub/database';

/**
 * Read-only operator report over the phone identity that the CUP recipient resolver depends on.
 *
 * A phone reaches an account two ways: `profile.user_summaries.phone_e164` holds a phone that a phone
 * login verified (it wins), and `integration.external_entity_map` holds the provider viewer phone the
 * client relayed (fallback only). When the two live on different accounts of one person, a campaign
 * addressed by phone resolves to the account that cannot receive Web Push. Nothing is written here:
 * the report only names the four shapes of that problem so an operator can resolve them.
 *
 * Usage:
 *   npm run identity:phone-anomalies:report                 # every tenant, phones masked
 *   npm run identity:phone-anomalies:report -- --tenant local-padel --show-phones
 *   npm run identity:phone-anomalies:report -- --fail-on-anomalies
 */

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');

const argumentsList = process.argv.slice(2);
const tenantArgumentIndex = argumentsList.indexOf('--tenant');
const tenantKey = tenantArgumentIndex >= 0 ? argumentsList[tenantArgumentIndex + 1] : undefined;
const showPhones = argumentsList.includes('--show-phones');
const failOnAnomalies = argumentsList.includes('--fail-on-anomalies');

function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/gu, '');
  if (digits.length < 5) return '••••';
  return `+${digits.slice(0, 1)} ••• •••-${digits.slice(-4)}`;
}

function phone(phoneE164: string | null): string {
  if (!phoneE164) return '—';
  return showPhones ? phoneE164 : maskPhone(phoneE164);
}

interface TenantRow {
  readonly id: string;
  readonly tenant_key: string;
}

interface DuplicateRow {
  readonly phone_e164: string;
  readonly accounts: number;
}

interface EndpointOwnerRow {
  readonly user_id: string;
  readonly display_name: string | null;
  readonly phone_e164: string | null;
  readonly provider_phone: string | null;
  readonly endpoints: number;
}

interface PhoneOwnerRow {
  readonly user_id: string;
  readonly display_name: string | null;
  readonly phone_e164: string;
  readonly endpoints: number;
}

interface ProviderOnlyRow {
  readonly internal_id: string;
  readonly phone_e164: string | null;
  readonly endpoints: number;
}

const pool = createDatabasePool(connectionString);

try {
  const tenants = await pool.query<TenantRow>(
    tenantKey
      ? 'select id, tenant_key from identity.tenants where tenant_key = $1 order by tenant_key'
      : 'select id, tenant_key from identity.tenants order by tenant_key',
    tenantKey ? [tenantKey] : [],
  );
  if (tenants.rows.length === 0) throw new Error('TENANT_NOT_FOUND');

  let anomalies = 0;
  for (const tenant of tenants.rows) {
    const report = await withTenantTransaction(pool, tenant.id, async (client) => {
      const duplicates = await client.query<DuplicateRow>(
        `select phone_e164, count(*)::integer as accounts
           from profile.user_summaries
          where tenant_id = $1 and phone_e164 is not null
          group by phone_e164
         having count(*) > 1
          order by phone_e164`,
        [tenant.id],
      );
      // Accounts that own an active Web Push endpoint but cannot be reached by phone at all.
      const endpointsWithoutPhone = await client.query<EndpointOwnerRow>(
        `select u.id as user_id,
                s.display_name,
                s.phone_e164,
                (
                  select m.external_id
                    from integration.external_entity_map m
                   where m.tenant_id = u.tenant_id
                     and m.internal_id = u.id
                     and m.entity_type = 'legacy_viewer_phone'
                   order by m.external_id
                   limit 1
                ) as provider_phone,
                endpoints.count as endpoints
           from identity.users u
           join (
             select user_id, count(*)::integer as count
               from integration.notification_endpoints
              where tenant_id = $1 and status = 'ACTIVE'
              group by user_id
           ) endpoints on endpoints.user_id = u.id
           left join profile.user_summaries s
             on s.tenant_id = u.tenant_id and s.user_id = u.id
          where u.tenant_id = $1
            and u.status = 'ACTIVE'
            and (s.phone_e164 is null or s.phone_e164 = '')
          order by endpoints.count desc, u.id`,
        [tenant.id],
      );
      // Verified phones whose owner has no active endpoint, while the provider mapping may point at
      // another account of the same person: the exact shape that made a phone campaign miss.
      const phonesWithoutEndpoint = await client.query<PhoneOwnerRow>(
        `select s.user_id,
                s.display_name,
                s.phone_e164,
                coalesce(endpoints.count, 0) as endpoints
           from profile.user_summaries s
           join identity.users u on u.tenant_id = s.tenant_id and u.id = s.user_id
           left join (
             select user_id, count(*)::integer as count
               from integration.notification_endpoints
              where tenant_id = $1 and status = 'ACTIVE'
              group by user_id
           ) endpoints on endpoints.user_id = s.user_id
          where s.tenant_id = $1
            and s.phone_e164 is not null
            and u.status = 'ACTIVE'
            and coalesce(endpoints.count, 0) = 0
          order by s.phone_e164`,
        [tenant.id],
      );
      const providerOnly = await client.query<ProviderOnlyRow>(
        `select m.internal_id,
                s.phone_e164,
                coalesce(endpoints.count, 0) as endpoints
           from integration.external_entity_map m
           join identity.users u on u.tenant_id = m.tenant_id and u.id = m.internal_id
           left join profile.user_summaries s
             on s.tenant_id = u.tenant_id and s.user_id = u.id
           left join (
             select user_id, count(*)::integer as count
               from integration.notification_endpoints
              where tenant_id = $1 and status = 'ACTIVE'
              group by user_id
           ) endpoints on endpoints.user_id = m.internal_id
          where m.tenant_id = $1
            and m.entity_type = 'legacy_viewer_phone'
            and u.status = 'ACTIVE'
            and (s.phone_e164 is null or s.phone_e164 = '')
          order by endpoints.count desc, m.internal_id`,
        [tenant.id],
      );
      return {
        duplicates: duplicates.rows,
        endpointsWithoutPhone: endpointsWithoutPhone.rows,
        phonesWithoutEndpoint: phonesWithoutEndpoint.rows,
        providerOnly: providerOnly.rows,
      };
    });

    const tenantAnomalies =
      report.duplicates.length +
      report.endpointsWithoutPhone.length +
      report.phonesWithoutEndpoint.length +
      report.providerOnly.length;
    anomalies += tenantAnomalies;

    process.stdout.write(`\n=== ${tenant.tenant_key} (${tenant.id}) ===\n`);
    process.stdout.write(
      `verified phone claimed by more than one account: ${report.duplicates.length}\n`,
    );
    for (const row of report.duplicates) {
      process.stdout.write(`  ${phone(row.phone_e164)} — ${row.accounts} accounts\n`);
    }
    process.stdout.write(
      `\nactive Web Push endpoint but no verified phone: ${report.endpointsWithoutPhone.length}\n`,
    );
    for (const row of report.endpointsWithoutPhone) {
      process.stdout.write(
        `  ${row.user_id} · ${row.display_name ?? '—'} · reachable by id only` +
          (row.provider_phone ? ` · provider phone ${phone(row.provider_phone)}` : '') +
          ` · endpoints ${row.endpoints}\n`,
      );
    }
    process.stdout.write(
      `\nverified phone whose owner has no active endpoint: ${report.phonesWithoutEndpoint.length}\n`,
    );
    for (const row of report.phonesWithoutEndpoint) {
      process.stdout.write(
        `  ${phone(row.phone_e164)} → ${row.user_id} · ${row.display_name ?? '—'} · endpoints 0\n`,
      );
    }
    process.stdout.write(
      `\nprovider phone whose account has no verified phone: ${report.providerOnly.length}\n`,
    );
    for (const row of report.providerOnly) {
      process.stdout.write(
        `  ${row.internal_id} · endpoints ${row.endpoints} · provider-only reachability\n`,
      );
    }
  }

  process.stdout.write(
    `\n${anomalies === 0 ? 'No phone identity anomalies found.' : `${anomalies} phone identity anomaly row(s) found.`}\n`,
  );
  if (failOnAnomalies && anomalies > 0) process.exitCode = 1;
} finally {
  await pool.end();
}
