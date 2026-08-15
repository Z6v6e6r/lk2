import type { Pool, PoolClient, QueryResultRow } from 'pg';

import { queryOne, withTenantTransaction } from './connection.js';

export type WebPushEnvironment = 'SANDBOX' | 'PRODUCTION';

export interface WebPushProviderSelector {
  readonly appId: string;
  readonly environment: WebPushEnvironment;
}

export interface WebPushEndpointCapabilities {
  readonly tenantEnabled: boolean;
  readonly providerConfigured: boolean;
}

export type WebPushEndpointCommandResult =
  | { readonly outcome: 'provider_unavailable' }
  | { readonly outcome: 'not_found' }
  | { readonly outcome: 'idempotency_conflict' }
  | { readonly outcome: 'endpoint_limit_reached' }
  | {
      readonly outcome: 'updated';
      readonly endpointId: string;
      readonly installationId: string;
      readonly status: 'ACTIVE' | 'REVOKED';
      readonly replayed: boolean;
    };

export interface NotificationEndpointRepository {
  getWebPushCapabilities(
    tenantId: string,
    selector: WebPushProviderSelector,
  ): Promise<WebPushEndpointCapabilities>;
  registerWebPush(input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly selector: WebPushProviderSelector;
    readonly installationId: string;
    readonly ciphertext: Buffer;
    readonly addressHash: string;
    readonly encryptionKeyId: string;
    readonly endpointsPerUserMax: number;
    readonly requestHash: string;
    readonly idempotencyKey: string;
    readonly correlationId: string;
  }): Promise<WebPushEndpointCommandResult>;
  revokeWebPush(input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly selector: WebPushProviderSelector;
    readonly installationId: string;
    readonly requestHash: string;
    readonly idempotencyKey: string;
    readonly correlationId: string;
  }): Promise<WebPushEndpointCommandResult>;
}

interface CapabilitiesRow extends QueryResultRow {
  readonly web_push_enabled: boolean;
  readonly provider_configured: boolean;
}

interface ProviderRow extends QueryResultRow {
  readonly id: string;
}

interface EndpointRow extends QueryResultRow {
  readonly id: string;
  readonly user_id: string;
  readonly installation_id: string | null;
  readonly address_hash: string;
  readonly status: 'ACTIVE' | 'INVALID' | 'REVOKED' | 'SUSPENDED_POLICY';
}

interface EndpointCountRow extends QueryResultRow {
  readonly endpoint_count: number;
}

interface CommandRow extends QueryResultRow {
  readonly command_type: 'REGISTER' | 'REVOKE';
  readonly installation_id: string;
  readonly request_hash: string;
  readonly endpoint_id: string | null;
  readonly result_status: 'PENDING' | 'ACTIVE' | 'REVOKED';
}

class EndpointLimitReachedError extends Error {
  public constructor() {
    super('WEB_PUSH_ENDPOINT_LIMIT_REACHED');
    this.name = 'EndpointLimitReachedError';
  }
}

async function claimCommand(
  client: PoolClient,
  input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly idempotencyKey: string;
    readonly commandType: 'REGISTER' | 'REVOKE';
    readonly installationId: string;
    readonly requestHash: string;
  },
): Promise<
  | { readonly outcome: 'claimed' }
  | { readonly outcome: 'conflict' }
  | {
      readonly outcome: 'replayed';
      readonly endpointId: string;
      readonly status: 'ACTIVE' | 'REVOKED';
    }
> {
  const claimed = await client.query(
    `insert into integration.notification_endpoint_commands (
       tenant_id, user_id, idempotency_key, command_type, installation_id, request_hash
     ) values ($1, $2, $3, $4, $5, $6)
     on conflict (tenant_id, user_id, idempotency_key) do nothing
     returning idempotency_key`,
    [
      input.tenantId,
      input.userId,
      input.idempotencyKey,
      input.commandType,
      input.installationId,
      input.requestHash,
    ],
  );
  if (claimed.rowCount && claimed.rowCount > 0) return { outcome: 'claimed' };

  const previous = await queryOne<CommandRow>(
    client,
    `select command_type, installation_id, request_hash, endpoint_id, result_status
       from integration.notification_endpoint_commands
      where tenant_id = $1 and user_id = $2 and idempotency_key = $3`,
    [input.tenantId, input.userId, input.idempotencyKey],
  );
  if (
    !previous ||
    previous.command_type !== input.commandType ||
    previous.installation_id !== input.installationId ||
    previous.request_hash !== input.requestHash ||
    previous.result_status === 'PENDING' ||
    !previous.endpoint_id
  ) {
    return { outcome: 'conflict' };
  }
  return {
    outcome: 'replayed',
    endpointId: previous.endpoint_id,
    status: previous.result_status,
  };
}

async function completeCommand(
  client: PoolClient,
  input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly idempotencyKey: string;
    readonly endpointId: string;
    readonly status: 'ACTIVE' | 'REVOKED';
  },
): Promise<void> {
  await client.query(
    `update integration.notification_endpoint_commands
        set endpoint_id = $4, result_status = $5, completed_at = now()
      where tenant_id = $1 and user_id = $2 and idempotency_key = $3`,
    [input.tenantId, input.userId, input.idempotencyKey, input.endpointId, input.status],
  );
}

async function activeProvider(
  client: PoolClient,
  tenantId: string,
  selector: WebPushProviderSelector,
): Promise<ProviderRow | undefined> {
  return queryOne<ProviderRow>(
    client,
    `select id
       from integration.notification_provider_accounts
      where tenant_id = $1
        and channel = 'PUSH'
        and platform = 'WEB'
        and provider = 'WEB_PUSH'
        and app_id = $2
        and environment = $3
        and status = 'ACTIVE'`,
    [tenantId, selector.appId, selector.environment],
  );
}

export function createNotificationEndpointRepository(pool: Pool): NotificationEndpointRepository {
  return {
    getWebPushCapabilities(tenantId, selector) {
      return withTenantTransaction(pool, tenantId, async (client) => {
        const row = await queryOne<CapabilitiesRow>(
          client,
          `select
             coalesce(s.web_push_enabled, false) as web_push_enabled,
             exists (
               select 1
                 from integration.notification_provider_accounts a
                where a.tenant_id = $1
                  and a.channel = 'PUSH'
                  and a.platform = 'WEB'
                  and a.provider = 'WEB_PUSH'
                  and a.app_id = $2
                  and a.environment = $3
                  and a.status = 'ACTIVE'
             ) as provider_configured
             from (select $1::uuid as tenant_id) input
             left join notifications.tenant_runtime_settings s
               on s.tenant_id = input.tenant_id`,
          [tenantId, selector.appId, selector.environment],
        );
        return {
          tenantEnabled: row?.web_push_enabled ?? false,
          providerConfigured: row?.provider_configured ?? false,
        };
      });
    },

    async registerWebPush(input) {
      try {
        return await withTenantTransaction(pool, input.tenantId, async (client) => {
          const provider = await activeProvider(client, input.tenantId, input.selector);
          if (!provider) return { outcome: 'provider_unavailable' };

          // Serialize physical subscription ownership before the target-user lock.
          await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
            `notification-endpoint-address:${input.tenantId}:${provider.id}:${input.addressHash}`,
          ]);
          await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
            `notification-endpoint:${input.userId}`,
          ]);

          const command = await claimCommand(client, {
            tenantId: input.tenantId,
            userId: input.userId,
            idempotencyKey: input.idempotencyKey,
            commandType: 'REGISTER',
            installationId: input.installationId,
            requestHash: input.requestHash,
          });
          if (command.outcome === 'conflict') return { outcome: 'idempotency_conflict' };
          if (command.outcome === 'replayed') {
            return {
              outcome: 'updated',
              endpointId: command.endpointId,
              installationId: input.installationId,
              status: command.status,
              replayed: true,
            };
          }

          const existingInstallation = await queryOne<EndpointRow>(
            client,
            `select id, installation_id, address_hash, status
             from integration.notification_endpoints
            where tenant_id = $1
              and user_id = $2
              and provider_account_id = $3
              and channel = 'PUSH'
              and installation_id = $4
            for update`,
            [input.tenantId, input.userId, provider.id, input.installationId],
          );
          const liveAddressOwner = await queryOne<EndpointRow>(
            client,
            `select id, user_id, installation_id, address_hash, status
             from integration.notification_endpoints
            where tenant_id = $1
              and provider_account_id = $2
              and address_hash = $3
              and channel = 'PUSH'
              and status in ('ACTIVE', 'SUSPENDED_POLICY')
            for update`,
            [input.tenantId, provider.id, input.addressHash],
          );
          const existingAddressForTarget =
            liveAddressOwner?.user_id === input.userId
              ? liveAddressOwner
              : await queryOne<EndpointRow>(
                  client,
                  `select id, user_id, installation_id, address_hash, status
                   from integration.notification_endpoints
                  where tenant_id = $1
                    and user_id = $2
                    and provider_account_id = $3
                    and address_hash = $4
                    and channel = 'PUSH'
                  for update`,
                  [input.tenantId, input.userId, provider.id, input.addressHash],
                );
          const existingLiveTarget = [existingInstallation, existingAddressForTarget].some(
            (endpoint) =>
              endpoint && (endpoint.status === 'ACTIVE' || endpoint.status === 'SUSPENDED_POLICY'),
          );
          const quota = await queryOne<EndpointCountRow>(
            client,
            `select count(*)::integer as endpoint_count
             from integration.notification_endpoints
            where tenant_id = $1
              and user_id = $2
              and provider_account_id = $3
              and channel = 'PUSH'
              and status in ('ACTIVE', 'SUSPENDED_POLICY')`,
            [input.tenantId, input.userId, provider.id],
          );
          if (!existingLiveTarget && (quota?.endpoint_count ?? 0) >= input.endpointsPerUserMax) {
            // Roll back the newly claimed PENDING command. A capacity rejection is not a durable
            // idempotency conflict, so the exact key may succeed after the user frees a slot.
            throw new EndpointLimitReachedError();
          }

          if (liveAddressOwner && liveAddressOwner.user_id !== input.userId) {
            // Do not transfer a row: pending deliveries retain the original endpoint owner.
            const revokedOwner = await client.query(
              `update integration.notification_endpoints
                set installation_id = null, status = 'REVOKED', updated_at = now()
              where tenant_id = $1 and user_id = $2 and id = $3`,
              [input.tenantId, liveAddressOwner.user_id, liveAddressOwner.id],
            );
            if (revokedOwner.rowCount === 1) {
              await client.query(
                `insert into audit.audit_log (
                   tenant_id, actor_id, action, resource_type, resource_id,
                   result, reason, correlation_id, old_value, new_value
                 ) values ($1, $2, 'WEB_PUSH_ENDPOINT_OWNERSHIP_REVOKED',
                           'NOTIFICATION_ENDPOINT', $3, 'SUCCESS', 'OWNERSHIP_TRANSFER',
                           $4, $5::jsonb, $6::jsonb)`,
                [
                  input.tenantId,
                  input.userId,
                  liveAddressOwner.id,
                  input.correlationId,
                  JSON.stringify({
                    status: liveAddressOwner.status,
                    addressHash: liveAddressOwner.address_hash,
                  }),
                  JSON.stringify({ status: 'REVOKED', installationId: null }),
                ],
              );
            }
          }
          if (
            existingInstallation &&
            existingAddressForTarget &&
            existingInstallation.id !== existingAddressForTarget.id
          ) {
            await client.query(
              `update integration.notification_endpoints
                set installation_id = null, status = 'REVOKED', updated_at = now()
              where tenant_id = $1 and user_id = $2 and id = $3`,
              [input.tenantId, input.userId, existingInstallation.id],
            );
          }
          const existing =
            existingAddressForTarget && existingAddressForTarget.id !== existingInstallation?.id
              ? existingAddressForTarget
              : (existingInstallation ?? existingAddressForTarget);
          const endpoint = existing
            ? await queryOne<EndpointRow>(
                client,
                `update integration.notification_endpoints
                  set installation_id = $4,
                      address_ciphertext = $5,
                      address_hash = $6,
                      encryption_key_id = $7,
                      status = 'ACTIVE',
                      last_confirmed_at = now(),
                      updated_at = now()
                where tenant_id = $1 and user_id = $2 and id = $3
                returning id, installation_id, address_hash, status`,
                [
                  input.tenantId,
                  input.userId,
                  existing.id,
                  input.installationId,
                  input.ciphertext,
                  input.addressHash,
                  input.encryptionKeyId,
                ],
              )
            : await queryOne<EndpointRow>(
                client,
                `insert into integration.notification_endpoints (
                 tenant_id, user_id, provider_account_id, channel, installation_id,
                 address_ciphertext, address_hash, encryption_key_id, status, last_confirmed_at
               ) values ($1, $2, $3, 'PUSH', $4, $5, $6, $7, 'ACTIVE', now())
               returning id, installation_id, address_hash, status`,
                [
                  input.tenantId,
                  input.userId,
                  provider.id,
                  input.installationId,
                  input.ciphertext,
                  input.addressHash,
                  input.encryptionKeyId,
                ],
              );
          if (!endpoint) throw new Error('NOTIFICATION_ENDPOINT_WRITE_LOST');

          await completeCommand(client, {
            tenantId: input.tenantId,
            userId: input.userId,
            idempotencyKey: input.idempotencyKey,
            endpointId: endpoint.id,
            status: 'ACTIVE',
          });
          await client.query(
            `insert into audit.audit_log (
             tenant_id, actor_id, action, resource_type, resource_id,
             result, correlation_id, old_value, new_value
           ) values ($1, $2, 'WEB_PUSH_ENDPOINT_REGISTERED', 'NOTIFICATION_ENDPOINT', $3,
                     'SUCCESS', $4, $5::jsonb, $6::jsonb)`,
            [
              input.tenantId,
              input.userId,
              endpoint.id,
              input.correlationId,
              JSON.stringify(
                existing ? { status: existing.status, addressHash: existing.address_hash } : null,
              ),
              JSON.stringify({
                installationId: input.installationId,
                status: 'ACTIVE',
                addressHash: input.addressHash,
                encryptionKeyId: input.encryptionKeyId,
              }),
            ],
          );
          return {
            outcome: 'updated',
            endpointId: endpoint.id,
            installationId: input.installationId,
            status: 'ACTIVE',
            replayed: false,
          };
        });
      } catch (error) {
        if (error instanceof EndpointLimitReachedError) {
          return { outcome: 'endpoint_limit_reached' };
        }
        throw error;
      }
    },

    revokeWebPush(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
          `notification-endpoint:${input.userId}`,
        ]);
        const endpoint = await queryOne<EndpointRow>(
          client,
          `select e.id, e.installation_id, e.address_hash, e.status
             from integration.notification_endpoints e
             join integration.notification_provider_accounts a
               on a.tenant_id = e.tenant_id and a.id = e.provider_account_id
            where e.tenant_id = $1
              and e.user_id = $2
              and e.installation_id = $3
              and e.channel = 'PUSH'
              and a.platform = 'WEB'
              and a.provider = 'WEB_PUSH'
              and a.app_id = $4
              and a.environment = $5
            for update of e`,
          [
            input.tenantId,
            input.userId,
            input.installationId,
            input.selector.appId,
            input.selector.environment,
          ],
        );
        if (!endpoint) return { outcome: 'not_found' };

        const command = await claimCommand(client, {
          tenantId: input.tenantId,
          userId: input.userId,
          idempotencyKey: input.idempotencyKey,
          commandType: 'REVOKE',
          installationId: input.installationId,
          requestHash: input.requestHash,
        });
        if (command.outcome === 'conflict') return { outcome: 'idempotency_conflict' };
        if (command.outcome === 'replayed') {
          return {
            outcome: 'updated',
            endpointId: command.endpointId,
            installationId: input.installationId,
            status: command.status,
            replayed: true,
          };
        }

        await client.query(
          `update integration.notification_endpoints
              set status = 'REVOKED', updated_at = now()
            where tenant_id = $1 and user_id = $2 and id = $3`,
          [input.tenantId, input.userId, endpoint.id],
        );
        await completeCommand(client, {
          tenantId: input.tenantId,
          userId: input.userId,
          idempotencyKey: input.idempotencyKey,
          endpointId: endpoint.id,
          status: 'REVOKED',
        });
        await client.query(
          `insert into audit.audit_log (
             tenant_id, actor_id, action, resource_type, resource_id,
             result, correlation_id, old_value, new_value
           ) values ($1, $2, 'WEB_PUSH_ENDPOINT_REVOKED', 'NOTIFICATION_ENDPOINT', $3,
                     'SUCCESS', $4, $5::jsonb, $6::jsonb)`,
          [
            input.tenantId,
            input.userId,
            endpoint.id,
            input.correlationId,
            JSON.stringify({ status: endpoint.status, addressHash: endpoint.address_hash }),
            JSON.stringify({ installationId: input.installationId, status: 'REVOKED' }),
          ],
        );
        return {
          outcome: 'updated',
          endpointId: endpoint.id,
          installationId: input.installationId,
          status: 'REVOKED',
          replayed: false,
        };
      });
    },
  };
}
