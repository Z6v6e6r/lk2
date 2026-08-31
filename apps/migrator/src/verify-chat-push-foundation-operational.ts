import { stdin } from 'node:process';

import {
  assertFoundationPrometheusCollectionSuccess,
  assertFoundationPrometheusGaugePresent,
  assertFoundationPrometheusHeartbeat,
  assertFoundationPrometheusRules,
  assertFoundationPrometheusTargets,
  assertFoundationRabbitInventory,
  ChatPushFoundationOperationalError,
} from './chat-push-foundation-operational.js';

const MAX_INPUT_BYTES = 2 * 1024 * 1024;

async function readInput(): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of stdin) {
    const chunkValue: unknown = chunk;
    const buffer = Buffer.isBuffer(chunkValue)
      ? chunkValue
      : typeof chunkValue === 'string' || chunkValue instanceof Uint8Array
        ? Buffer.from(chunkValue)
        : (() => {
            throw new Error('CHAT_PUSH_FOUNDATION_OPERATIONAL_INPUT_INVALID');
          })();
    bytes += buffer.length;
    if (bytes > MAX_INPUT_BYTES)
      throw new Error('CHAT_PUSH_FOUNDATION_OPERATIONAL_INPUT_TOO_LARGE');
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  const input = await readInput();
  if (mode === 'rabbit-optional' || mode === 'rabbit-required' || mode === 'rabbit-inert') {
    const result = assertFoundationRabbitInventory(input, {
      mode:
        mode === 'rabbit-required' ? 'required' : mode === 'rabbit-inert' ? 'inert' : 'optional',
    });
    process.stdout.write(`${JSON.stringify({ status: 'verified', kind: 'rabbit', ...result })}\n`);
    return;
  }
  if (mode === 'prometheus') {
    const result = assertFoundationPrometheusRules(input, { nowMs: Date.now() });
    process.stdout.write(
      `${JSON.stringify({ status: 'verified', kind: 'prometheus', ...result })}\n`,
    );
    return;
  }
  if (mode === 'prometheus-targets') {
    const result = assertFoundationPrometheusTargets(input, { nowMs: Date.now() });
    process.stdout.write(
      `${JSON.stringify({ status: 'verified', kind: 'prometheus-targets', ...result })}\n`,
    );
    return;
  }
  if (mode === 'prometheus-heartbeat') {
    const minimumUnixTime = Number(process.env.CHAT_PUSH_FOUNDATION_MIN_HEARTBEAT_UNIXTIME);
    if (!Number.isInteger(minimumUnixTime) || minimumUnixTime <= 0) {
      throw new Error('CHAT_PUSH_FOUNDATION_MIN_HEARTBEAT_REQUIRED');
    }
    const result = assertFoundationPrometheusHeartbeat(input, {
      nowMs: Date.now(),
      minimumUnixTime,
    });
    process.stdout.write(
      `${JSON.stringify({ status: 'verified', kind: 'prometheus-heartbeat', ...result })}\n`,
    );
    return;
  }
  if (mode === 'prometheus-collection-success') {
    assertFoundationPrometheusCollectionSuccess(input);
    process.stdout.write(
      `${JSON.stringify({ status: 'verified', kind: 'prometheus-collection-success' })}\n`,
    );
    return;
  }
  if (mode === 'prometheus-gauge-present') {
    assertFoundationPrometheusGaugePresent(input);
    process.stdout.write(
      `${JSON.stringify({ status: 'verified', kind: 'prometheus-gauge-present' })}\n`,
    );
    return;
  }
  throw new Error('CHAT_PUSH_FOUNDATION_OPERATIONAL_MODE_INVALID');
}

main().catch((error: unknown) => {
  const code =
    error instanceof ChatPushFoundationOperationalError
      ? error.code
      : error instanceof Error
        ? error.message
        : 'CHAT_PUSH_FOUNDATION_OPERATIONAL_FAILED';
  process.stderr.write(`${code}\n`);
  process.exitCode = 1;
});
