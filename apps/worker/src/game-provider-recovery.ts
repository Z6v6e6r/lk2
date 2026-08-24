import type {
  GameProviderRecoveryAdapter,
  GameProviderReadBackResult,
  GameProviderSubmitResult,
} from '@phub/games';
import type { GameProviderOperationRepository } from '@phub/database';
import { metrics } from '@opentelemetry/api';

export interface GameProviderRecoveryMetric {
  readonly name:
    | 'game_provider_submit_total'
    | 'game_provider_timeout_after_submit_total'
    | 'game_provider_readback_total'
    | 'game_provider_recovered_total'
    | 'game_provider_retry_exhausted_total';
  readonly phase: 'SUBMIT' | 'READBACK';
  readonly outcome: string;
}

const gameProviderMeter = metrics.getMeter('@phub/worker.game-provider-recovery');
const gameProviderCounters = new Map<string, ReturnType<typeof gameProviderMeter.createCounter>>();

export function recordGameProviderRecoveryMetric(metric: GameProviderRecoveryMetric): void {
  let counter = gameProviderCounters.get(metric.name);
  if (!counter) {
    counter = gameProviderMeter.createCounter(metric.name);
    gameProviderCounters.set(metric.name, counter);
  }
  counter.add(1, { phase: metric.phase, outcome: metric.outcome });
}

export async function runGameProviderRecoveryCycle(input: {
  readonly tenantId: string;
  readonly repository: GameProviderOperationRepository;
  readonly adapter: GameProviderRecoveryAdapter;
  readonly leaseSeconds?: number;
  readonly maxSubmitAttempts?: number;
  readonly maxReadBackAttempts?: number;
  readonly providerTimeoutMs?: number;
  readonly onMetric?: (metric: GameProviderRecoveryMetric) => void;
  readonly submitEnabled?: boolean;
  readonly readBackEnabled?: boolean;
}): Promise<{ readonly submitted: boolean; readonly reconciled: boolean }> {
  const leaseSeconds = input.leaseSeconds ?? 30;
  const providerTimeoutMs = input.providerTimeoutMs ?? 10_000;
  const maxSubmitAttempts = input.maxSubmitAttempts ?? 3;
  const maxReadBackAttempts = input.maxReadBackAttempts ?? 8;
  const submit =
    input.submitEnabled === false
      ? undefined
      : await input.repository.claimSubmit({
          tenantId: input.tenantId,
          leaseSeconds,
          maxAttempts: maxSubmitAttempts,
        });
  if (submit) {
    let result: GameProviderSubmitResult;
    try {
      result = await input.adapter.submit(submit, {
        signal: AbortSignal.timeout(providerTimeoutMs),
        timeoutMs: providerTimeoutMs,
      });
    } catch {
      result = { outcome: 'UNKNOWN', code: 'ADAPTER_THROW_AFTER_DISPATCH' };
    }
    const applied = await input.repository.completeSubmit({
      tenantId: input.tenantId,
      operationId: submit.operationId,
      leaseToken: submit.leaseToken,
      startedAt: submit.startedAt,
      result,
      maxAttempts: maxSubmitAttempts,
    });
    if (applied === 'applied')
      input.onMetric?.({
        name: 'game_provider_submit_total',
        phase: 'SUBMIT',
        outcome: result.outcome,
      });
    if (applied === 'applied' && result.outcome === 'UNKNOWN') {
      input.onMetric?.({
        name: 'game_provider_timeout_after_submit_total',
        phase: 'SUBMIT',
        outcome: 'UNKNOWN',
      });
    }
  }

  const readBack =
    input.readBackEnabled === false
      ? undefined
      : await input.repository.claimReadBack({
          tenantId: input.tenantId,
          leaseSeconds,
          maxAttempts: maxReadBackAttempts,
        });
  if (!readBack) return { submitted: Boolean(submit), reconciled: false };
  let result: GameProviderReadBackResult;
  try {
    result = await input.adapter.readBack(readBack, {
      signal: AbortSignal.timeout(providerTimeoutMs),
      timeoutMs: providerTimeoutMs,
    });
  } catch {
    result = { outcome: 'UNAVAILABLE', code: 'ADAPTER_READBACK_THROW' };
  }
  const applied = await input.repository.completeReadBack({
    tenantId: input.tenantId,
    operationId: readBack.operationId,
    leaseToken: readBack.leaseToken,
    startedAt: readBack.startedAt,
    result,
    maxAttempts: maxReadBackAttempts,
  });
  if (applied === 'applied')
    input.onMetric?.({
      name: 'game_provider_readback_total',
      phase: 'READBACK',
      outcome: result.outcome,
    });
  if (
    applied === 'applied' &&
    (result.outcome === 'MATCHED_ACCEPTED' || result.outcome === 'MATCHED_REJECTED')
  ) {
    input.onMetric?.({
      name: 'game_provider_recovered_total',
      phase: 'READBACK',
      outcome: result.outcome,
    });
  }
  if (
    applied === 'applied' &&
    readBack.attempt >= maxReadBackAttempts &&
    !result.outcome.startsWith('MATCHED_')
  ) {
    input.onMetric?.({
      name: 'game_provider_retry_exhausted_total',
      phase: 'READBACK',
      outcome: result.outcome,
    });
  }
  return { submitted: Boolean(submit), reconciled: true };
}
