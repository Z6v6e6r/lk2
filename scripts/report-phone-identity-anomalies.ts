import { pathToFileURL } from 'node:url';

import { createDatabasePool, withTenantTransaction } from '@phub/database';

/**
 * Read-only operator report over the phone identity that the CUP recipient resolver depends on.
 *
 * A phone reaches an account two ways: `profile.user_summaries.phone_e164` holds a phone that a phone
 * login verified (it wins, and the schema now keeps it unique per tenant), and
 * `integration.external_entity_map` holds the provider viewer phone the client relayed (fallback
 * only). When the two live on different accounts of one person, a campaign addressed by phone
 * resolves to the account that cannot receive Web Push. Nothing is written here: the report only
 * names the four shapes of that problem so an operator can resolve them.
 *
 * Endpoint reachability is counted exactly like the resolver counts it
 * (`packages/database/src/admin-notification-repository.ts`): an `ACTIVE` `PUSH` endpoint whose
 * provider account is an `ACTIVE` Web Push account for the configured app and environment.
 *
 * Usage:
 *   npm run identity:phone-anomalies:report
 *   npm run identity:phone-anomalies:report -- --tenant local-padel --show-phones
 *   npm run identity:phone-anomalies:report -- --fail-on-anomalies   # duplicates only (blocks the migration)
 *   npm run identity:phone-anomalies:report -- --fail-on-any         # any of the four shapes
 */

export interface ReportArguments {
  readonly tenantKey?: string;
  readonly appId: string;
  readonly environment: 'SANDBOX' | 'PRODUCTION';
  readonly showPhones: boolean;
  readonly failOnAnomalies: boolean;
  readonly failOnAny: boolean;
}

export class ReportArgumentError extends Error {}

/** Masks everything except the last four digits, matching the notification repository's mask. */
export function maskPhone(value: string): string {
  const digits = value.replace(/\D/gu, '');
  if (digits.length < 4) return '••••';
  return `•••• ${digits.slice(-4)}`;
}

export function parseReportArguments(
  argumentsList: readonly string[],
  environment: Record<string, string | undefined> = process.env,
): ReportArguments {
  function valueOf(flag: string): string {
    const index = argumentsList.indexOf(flag);
    if (index < 0) return '';
    const value = argumentsList[index + 1];
    if (!value || value.startsWith('--')) {
      throw new ReportArgumentError(`${flag} requires a value`);
    }
    return value;
  }

  const environmentName = valueOf('--environment') || environment.WEB_PUSH_ENVIRONMENT || 'SANDBOX';
  if (environmentName !== 'SANDBOX' && environmentName !== 'PRODUCTION') {
    throw new ReportArgumentError('--environment must be SANDBOX or PRODUCTION');
  }

  const tenantKey = argumentsList.includes('--tenant') ? valueOf('--tenant') : undefined;
  return {
    ...(tenantKey ? { tenantKey } : {}),
    appId: valueOf('--app-id') || environment.WEB_PUSH_APP_ID || 'padlhub-web',
    environment: environmentName,
    showPhones: argumentsList.includes('--show-phones'),
    failOnAnomalies: argumentsList.includes('--fail-on-anomalies'),
    failOnAny: argumentsList.includes('--fail-on-any'),
  };
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
  readonly display_name: string | null;
  readonly endpoints: number;
}

async function main(): Promise<void> {
  let options: ReportArguments;
  try {
    options = parseReportArguments(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'invalid arguments'}\n`);
    process.exitCode = 2;
    return;
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required');
  const renderPhone = (value: string | null): string =>
    value ? (options.showPhones ? value : maskPhone(value)) : '—';

  const pool = createDatabasePool(connectionString);
  try {
    const tenants = await pool.query<TenantRow>(
      options.tenantKey
        ? 'select id, tenant_key from identity.tenants where tenant_key = $1 order by tenant_key'
        : 'select id, tenant_key from identity.tenants order by tenant_key',
      options.tenantKey ? [options.tenantKey] : [],
    );
    if (tenants.rows.length === 0) throw new Error('TENANT_NOT_FOUND');

    // The resolver's reachability definition: an active PUSH endpoint of an active WEB_PUSH provider
    // account for this app and environment.
    const reachableEndpoints = `
           select e.user_id, count(*)::integer as count
             from integration.notification_endpoints e
             join integration.notification_provider_accounts a
               on a.tenant_id = e.tenant_id and a.id = e.provider_account_id
            where e.tenant_id = $1
              and e.channel = 'PUSH'
              and e.status = 'ACTIVE'
              and a.channel = 'PUSH'
              and a.platform = 'WEB'
              and a.provider = 'WEB_PUSH'
              and a.app_id = $2
              and a.environment = $3
              and a.status = 'ACTIVE'
            group by e.user_id`;

    let duplicates = 0;
    let advisory = 0;
    for (const current of tenants.rows) {
      const report = await withTenantTransaction(pool, current.id, async (client) => {
        const duplicateRows = await client.query<DuplicateRow>(
          `select phone_e164, count(*)::integer as accounts
             from profile.user_summaries
            where tenant_id = $1 and phone_e164 is not null
            group by phone_e164
           having count(*) > 1
            order by phone_e164`,
          [current.id],
        );
        const endpointsWithoutPhone = await client.query<EndpointOwnerRow>(
          `select u.id as user_id,
                  s.display_name,
                  s.phone_e164,
                  (
                    select m.external_id
                      from integration.external_entity_map m
                     where m.tenant_id = u.tenant_id
                       and m.external_system = 'VIVA'
                       and m.entity_type = 'legacy_viewer_phone'
                       and m.internal_id = u.id
                     order by m.external_id
                     limit 1
                  ) as provider_phone,
                  endpoints.count as endpoints
             from identity.users u
             join (${reachableEndpoints}) endpoints on endpoints.user_id = u.id
             left join profile.user_summaries s
               on s.tenant_id = u.tenant_id and s.user_id = u.id
            where u.tenant_id = $1
              and u.status = 'ACTIVE'
              and (s.phone_e164 is null or s.phone_e164 = '')
            order by endpoints.count desc, u.id`,
          [current.id, options.appId, options.environment],
        );
        const phonesWithoutEndpoint = await client.query<PhoneOwnerRow>(
          `select s.user_id,
                  s.display_name,
                  s.phone_e164,
                  coalesce(endpoints.count, 0) as endpoints
             from profile.user_summaries s
             join identity.users u on u.tenant_id = s.tenant_id and u.id = s.user_id
             left join (${reachableEndpoints}) endpoints on endpoints.user_id = s.user_id
            where s.tenant_id = $1
              and s.phone_e164 is not null
              and u.status = 'ACTIVE'
              and coalesce(endpoints.count, 0) = 0
            order by s.phone_e164`,
          [current.id, options.appId, options.environment],
        );
        const providerOnly = await client.query<ProviderOnlyRow>(
          `select m.internal_id,
                  s.display_name,
                  coalesce(endpoints.count, 0) as endpoints
             from integration.external_entity_map m
             join identity.users u on u.tenant_id = m.tenant_id and u.id = m.internal_id
             left join profile.user_summaries s
               on s.tenant_id = u.tenant_id and s.user_id = u.id
             left join (${reachableEndpoints}) endpoints on endpoints.user_id = m.internal_id
            where m.tenant_id = $1
              and m.external_system = 'VIVA'
              and m.entity_type = 'legacy_viewer_phone'
              and u.status = 'ACTIVE'
              and (s.phone_e164 is null or s.phone_e164 = '')
            order by endpoints.count desc, m.internal_id`,
          [current.id, options.appId, options.environment],
        );
        return {
          duplicates: duplicateRows.rows,
          endpointsWithoutPhone: endpointsWithoutPhone.rows,
          phonesWithoutEndpoint: phonesWithoutEndpoint.rows,
          providerOnly: providerOnly.rows,
        };
      });

      duplicates += report.duplicates.length;
      advisory +=
        report.endpointsWithoutPhone.length +
        report.phonesWithoutEndpoint.length +
        report.providerOnly.length;

      process.stdout.write(`\n=== ${current.tenant_key} (${current.id}) ===\n`);
      process.stdout.write(
        `app ${options.appId} · environment ${options.environment}\n` +
          `verified phone claimed by more than one account: ${report.duplicates.length}\n`,
      );
      for (const row of report.duplicates) {
        process.stdout.write(`  ${renderPhone(row.phone_e164)} — ${row.accounts} accounts\n`);
      }
      process.stdout.write(
        `\nactive Web Push endpoint but no verified phone: ${report.endpointsWithoutPhone.length}\n`,
      );
      for (const row of report.endpointsWithoutPhone) {
        process.stdout.write(
          `  ${row.user_id} · ${row.display_name ?? '—'} · reachable by id only` +
            (row.provider_phone ? ` · provider phone ${renderPhone(row.provider_phone)}` : '') +
            ` · endpoints ${row.endpoints}\n`,
        );
      }
      process.stdout.write(
        `\nverified phone whose owner has no active Web Push endpoint: ${report.phonesWithoutEndpoint.length}\n`,
      );
      for (const row of report.phonesWithoutEndpoint) {
        process.stdout.write(
          `  ${renderPhone(row.phone_e164)} → ${row.user_id} · ${row.display_name ?? '—'}` +
            ` · endpoints 0\n`,
        );
      }
      process.stdout.write(
        `\nprovider phone whose account has no verified phone: ${report.providerOnly.length}\n`,
      );
      for (const row of report.providerOnly) {
        process.stdout.write(
          `  ${row.internal_id} · ${row.display_name ?? '—'} · endpoints ${row.endpoints}` +
            ` · provider-only reachability\n`,
        );
      }
    }

    process.stdout.write(
      `\n${duplicates} duplicate verified phone pair(s) (block the uniqueness migration), ` +
        `${advisory} advisory row(s) across ${tenants.rows.length} tenant(s).\n`,
    );
    if (options.failOnAnomalies && duplicates > 0) process.exitCode = 1;
    if (options.failOnAny && duplicates + advisory > 0) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  await main();
}
