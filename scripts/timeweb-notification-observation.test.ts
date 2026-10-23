import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  observeNotificationRollout,
  probeNotificationPublicReadiness,
  validateApiWorkerReceipt,
} from './timeweb-api-worker-upgrade.js';
import {
  NOTIFICATION_OBSERVATION_POLICY,
  NOTIFICATION_OBSERVATION_POLICY_SHA256,
  validateNotificationObservation,
} from './timeweb-notification-profile.js';
const operationSha256 = 'a'.repeat(64),
  planSha256 = 'b'.repeat(64);
const start = Date.parse('2026-10-23T00:00:00.000Z');
async function collect() {
  let clock = start;
  const attest = vi.fn(() => Promise.resolve()),
    sleep = vi.fn((ms: number) => {
      clock += ms;
      return Promise.resolve();
    });
  const value = await observeNotificationRollout({
    attest,
    sleep,
    now: () => clock,
    operationSha256,
    planSha256,
    probePublic: () => Promise.resolve({ publicApiMs: 10, publicWebMs: 20 }),
  });
  return {
    value: value as {
      samples: { observedAt: string; publicApiMs: number; publicWebMs: number }[];
      [key: string]: unknown;
    },
    attest,
    sleep,
  };
}
afterEach(() => vi.unstubAllGlobals());
describe('closed notification V2 observation', () => {
  it('runs the real round sequence with all readiness attestations and sixty waits', async () => {
    const { value, attest, sleep } = await collect();
    expect(attest).toHaveBeenCalledTimes(61);
    expect(sleep).toHaveBeenCalledTimes(60);
    expect(sleep.mock.calls.every(([ms]) => ms === 15000)).toBe(true);
    expect(value.observationPolicy).toEqual(NOTIFICATION_OBSERVATION_POLICY);
    expect(validateNotificationObservation(value, operationSha256, planSha256)).toEqual(value);
    expect(JSON.stringify(value)).not.toContain('providerReadback');
  });
  it('rejects missing/short/regressing rounds, policy drift, fake history and altered binding', async () => {
    const { value } = await collect();
    const bad = [
      { ...value, samples: value.samples.slice(1) },
      { ...value, completedAt: new Date(start + 899999).toISOString() },
      { ...value, startedAt: 'invalid' },
      { ...value, completedAt: 'invalid' },
      { ...value, operationSha256: 'c'.repeat(64) },
      { ...value, planSha256: 'd'.repeat(64) },
      { ...value, schema: 'PHUB_TIMEWEB_API_WORKER_OBSERVATION_V1' },
      { ...value, providerReadback: {} },
      {
        ...value,
        observationPolicy: { ...NOTIFICATION_OBSERVATION_POLICY, providerHistory: 'PASS' },
      },
    ];
    const regressed = structuredClone(value);
    regressed.samples[1]!.observedAt = regressed.samples[0]!.observedAt;
    bad.push(regressed);
    const latency = structuredClone(value);
    latency.samples.forEach((s) => {
      s.publicApiMs = 1501;
    });
    bad.push(latency);
    const outside = structuredClone(value);
    outside.samples[0]!.observedAt = new Date(start - 1).toISOString();
    bad.push(outside);
    for (const v of bad)
      expect(() => validateNotificationObservation(v, operationSha256, planSha256)).toThrow();
  });
  it('does not manufacture observation after failed readiness or fake sleep', async () => {
    const options = {
      operationSha256,
      planSha256,
      now: () => start,
      sleep: () => Promise.resolve(),
      probePublic: () => Promise.resolve({ publicApiMs: 1, publicWebMs: 1 }),
    };
    await expect(
      observeNotificationRollout({
        ...options,
        attest: () => Promise.reject(Error('identity/restart/readiness')),
      }),
    ).rejects.toThrow('identity/restart/readiness');
    await expect(
      observeNotificationRollout({ ...options, attest: () => Promise.resolve() }),
    ).rejects.toThrow('OBSERVATION');
  });
  it('requires actual public HTTP ready JSON and Web app marker, with bounded no-redirect requests', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response('{"status":"ready"}'))
      .mockResolvedValueOnce(new Response('<div id="phub-app"></div>'));
    vi.stubGlobal('fetch', fetch);
    const timings = await probeNotificationPublicReadiness();
    expect(timings.publicApiMs).toBeGreaterThanOrEqual(0);
    expect(timings.publicWebMs).toBeGreaterThanOrEqual(0);
    expect(fetch.mock.calls[0]![0]).toBe('https://lk2.padlhub.su/health/ready');
    expect(fetch.mock.calls[1]![0]).toBe('https://lk2.padlhub.su/');
    expect(fetch.mock.calls[0]![1]?.redirect).toBe('error');
    expect(fetch.mock.calls[0]![1]?.signal instanceof AbortSignal).toBe(true);
    for (const response of [
      new Response('{"status":"not_ready"}'),
      new Response('{"status":"ready"}', { status: 503 }),
      new Response('invalid'),
    ]) {
      fetch.mockReset().mockResolvedValueOnce(response);
      await expect(probeNotificationPublicReadiness()).rejects.toThrow();
    }
    fetch
      .mockReset()
      .mockResolvedValueOnce(new Response('{"status":"ready"}'))
      .mockResolvedValueOnce(new Response('wrong web'));
    await expect(probeNotificationPublicReadiness()).rejects.toThrow('PUBLIC_READINESS');
    fetch.mockReset().mockRejectedValueOnce(Error('timeout'));
    await expect(probeNotificationPublicReadiness()).rejects.toThrow('timeout');
  });
  it('binds V2 SUCCESS/reconciliation to fixed excluded-history policy and rejects old receipt fields', () => {
    const op = { schema: 'PHUB_TIMEWEB_API_WORKER_NOTIFICATION_0105_OPERATION_V2' };
    const receipt = {
      schema: 'PHUB_TIMEWEB_NOTIFICATION_0105_ROLLOUT_RECEIPT_V2',
      status: 'SUCCESS',
      planSha256,
      observedAt: new Date(start).toISOString(),
      installedBaselineSha256: 'c'.repeat(64),
      observationSha256: 'd'.repeat(64),
      observationPolicySha256: NOTIFICATION_OBSERVATION_POLICY_SHA256,
    };
    expect(validateApiWorkerReceipt(receipt, planSha256, op)).toEqual(receipt);
    expect(
      validateApiWorkerReceipt(
        { ...receipt, status: 'RECONCILED', reconciledStatus: 'SUCCESS' },
        planSha256,
        op,
      ),
    ).toBeDefined();
    for (const bad of [
      { ...receipt, schema: 'PHUB_TIMEWEB_NOTIFICATION_0105_ROLLOUT_RECEIPT_V1' },
      { ...receipt, providerReadbackSha256: 'e'.repeat(64) },
      { ...receipt, observationPolicySha256: 'f'.repeat(64) },
    ])
      expect(() => validateApiWorkerReceipt(bad, planSha256, op)).toThrow();
  });
});
