import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

const harness = vi.hoisted(() => ({
  query:
    vi.fn<
      (
        text: string,
        values?: readonly unknown[],
      ) => Promise<{ rows: readonly Record<string, unknown>[]; rowCount: number }>
    >(),
  end: vi.fn<() => Promise<void>>(),
}));
vi.mock('@phub/database', () => ({
  createDatabasePool: () => ({ query: harness.query, end: harness.end }),
  queryOne: async (
    client: { query: typeof harness.query },
    text: string,
    values: readonly unknown[],
  ) => (await client.query(text, values)).rows[0],
  withTenantTransaction: async (
    _pool: unknown,
    _tenantId: string,
    action: (client: { query: typeof harness.query }) => Promise<unknown>,
  ) => action({ query: harness.query }),
}));

const tenantId = '11111111-1111-4111-8111-111111111111';
const actorId = '22222222-2222-4222-8222-222222222222';
const savedArgv = process.argv;
let output: MockInstance<typeof process.stdout.write>;
let accessReads = 0,
  stateReads = 0;
let revoked = false,
  drift = false;
const runtime = {
  in_app_enabled: true,
  web_push_enabled: false,
  android_push_enabled: false,
  booking_reminders_enabled: false,
  booking_reminder_ruleset_version: null,
  booking_reminder_contract_hash: null,
};

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('DATABASE_URL', 'postgresql://synthetic.invalid/never-connect');
  accessReads = 0;
  stateReads = 0;
  revoked = false;
  drift = false;
  output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const result = (rows: readonly Record<string, unknown>[], rowCount: number) =>
    Promise.resolve({ rows, rowCount });
  harness.query.mockReset().mockImplementation((text: string) => {
    if (text.includes('from identity.tenants')) return result([{ id: tenantId }], 1);
    if (text.includes('identity.user_access_profiles')) {
      accessReads += 1;
      return result([], revoked && accessReads > 1 ? 0 : 1);
    }
    if (text.includes('select in_app_enabled')) {
      stateReads += 1;
      return result([{ ...runtime, android_push_enabled: drift && stateReads > 1 }], 1);
    }
    if (text.includes('select id, status, credential_ref')) {
      stateReads += 1;
      return result(
        drift && stateReads > 1
          ? [{ id: actorId, status: 'DISABLED', credential_ref: 'env:FCM_CREDENTIAL_FILE' }]
          : [],
        0,
      );
    }
    if (text.includes('returning id')) return result([{ id: actorId }], 1);
    return result([], 1);
  });
  harness.end.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  process.argv = savedArgv;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function execute(kind: 'provider' | 'runtime', apply = false) {
  process.argv = [
    'node',
    'synthetic-operator',
    '--tenant-key=local-padel',
    `--actor-id=${actorId}`,
    ...(kind === 'provider' ? ['--state=on'] : ['--android-push=on']),
    ...(apply
      ? [
          `--confirm=${kind === 'provider' ? 'APPLY_ANDROID_PUSH_PROVIDER' : 'APPLY_NOTIFICATION_RUNTIME'}`,
        ]
      : []),
  ];
  if (kind === 'provider') await import('./configure-android-push-provider.js');
  else await import('./set-notification-runtime.js');
}

describe('Android notification operator boundaries', () => {
  it.each(['provider', 'runtime'] as const)(
    'previews %s without writes, secrets or provider calls',
    async (kind) => {
      await execute(kind);
      expect(
        harness.query.mock.calls.some(([text]) => /insert|update|delete/iu.test(String(text))),
      ).toBe(false);
      expect(String(output.mock.calls.map(([text]) => text).join(''))).toContain(
        '"mode": "dry-run"',
      );
      expect(accessReads).toBe(1);
      expect(harness.end).toHaveBeenCalledOnce();
    },
  );

  it('applies only the exact Android/FCM selector with permission recheck, lock and audit', async () => {
    await execute('provider', true);
    const write = harness.query.mock.calls.find(([text]) =>
      String(text).includes('insert into integration.notification_provider_accounts'),
    )!;
    expect(write[0]).toContain("'PUSH', 'ANDROID', 'FCM'");
    expect(write[1]).toEqual([
      tenantId,
      'ru.padlhub.app',
      'SANDBOX',
      'env:FCM_CREDENTIAL_FILE',
      'ACTIVE',
    ]);
    expect(accessReads).toBe(2);
    expect(
      harness.query.mock.calls.some(([text]) => String(text).includes('pg_advisory_xact_lock')),
    ).toBe(true);
    expect(
      harness.query.mock.calls.some(([text]) =>
        String(text).includes('ANDROID_PUSH_PROVIDER_CHANGED'),
      ),
    ).toBe(true);
    expect(String(output.mock.calls.map(([text]) => text).join(''))).not.toContain(
      'credential_ref',
    );
  });

  it('changes Android runtime while preserving existing transport and booking settings', async () => {
    await execute('runtime', true);
    const write = harness.query.mock.calls.find(([text]) =>
      String(text).includes('insert into notifications.tenant_runtime_settings'),
    )!;
    expect(write[1]).toEqual([tenantId, true, false, false, null, null, actorId, true]);
    expect(accessReads).toBe(2);
    expect(
      harness.query.mock.calls.some(([text]) =>
        String(text).includes('NOTIFICATION_RUNTIME_CHANGED'),
      ),
    ).toBe(true);
  });

  it.each(['provider', 'runtime'] as const)(
    'refuses %s mutation after operator permission revocation',
    async (kind) => {
      revoked = true;
      await expect(execute(kind, true)).rejects.toThrow('ADMIN_PERMISSION_REQUIRED');
      expect(harness.query.mock.calls.some(([text]) => String(text).includes('insert into'))).toBe(
        false,
      );
      expect(harness.end).toHaveBeenCalledOnce();
    },
  );

  it.each(['provider', 'runtime'] as const)(
    'refuses %s mutation on concurrent state drift',
    async (kind) => {
      drift = true;
      await expect(execute(kind, true)).rejects.toThrow('CHANGED_CONCURRENTLY');
      expect(harness.query.mock.calls.some(([text]) => String(text).includes('insert into'))).toBe(
        false,
      );
    },
  );
});
