import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
  NATIVE_MONITOR_BUNDLE,
  NATIVE_CUA_BATCH_RESULT,
  nativeBatchCuaArguments,
  deriveNativeMonitorReadback,
  REDACTED_PRESENT,
} from './timeweb-native-observability.js';
import {
  verifyNativeCaptureReview,
  NATIVE_REVIEW_SCHEMA,
  NATIVE_TRACE_SCHEMA,
} from './timeweb-native-capture-review.js';
import {
  NOW,
  SOURCE,
  NATIVE_ADAPTER_SHA256 as ADAPTER,
  reviewedNativeBatchFixture,
  encodedNativeFixture as bytes,
  nativeFixtureHash as hash,
} from './timeweb-native-observability-fixtures.js';

type Fixture = ReturnType<typeof reviewedNativeBatchFixture>;
function verify(value: Fixture, observedAt = NOW) {
  deriveNativeMonitorReadback(bytes(value.f.bundle), observedAt, SOURCE);
  return verifyNativeCaptureReview(
    bytes(value.review),
    bytes(value.f.bundle),
    bytes(value.trace),
    SOURCE,
    ADAPTER,
    observedAt,
  );
}
function rehash(value: Fixture) {
  value.review.captureBundleSha256 = hash(bytes(value.f.bundle));
  value.review.actualTraceSha256 = hash(bytes(value.trace));
}
function output(value: Fixture) {
  return JSON.parse(value.trace.calls[0]!.response.output[1]!.text) as {
    schema: string;
    captures: Array<Record<string, unknown>>;
  };
}
function replaceOutput(value: Fixture, returned: ReturnType<typeof output>) {
  value.trace.calls[0]!.response.output[1]!.text = JSON.stringify(returned);
}

describe('one actual CUA call, five native GET responses', () => {
  it('preserves one real trace pair and five response identities', () => {
    const f = reviewedNativeBatchFixture();
    expect(verify(f).captureBundleSha256).toBe(hash(bytes(f.f.bundle)));
    expect(f.trace.calls).toHaveLength(1);
    expect(new Set(f.f.bundle.captures.map((c) => c.toolCallId)).size).toBe(1);
    expect(
      new Set(
        f.f.bundle.captures
          .map((c) => c.nativeResponse as { response_id: string })
          .map((r) => r.response_id),
      ).size,
    ).toBe(5);
  });
  it('keeps the oldest-capture 30-second boundary', () => {
    expect(() => verify(reviewedNativeBatchFixture(), '2026-11-14T12:00:54.999Z')).not.toThrow();
    expect(() => verify(reviewedNativeBatchFixture(), '2026-11-14T12:00:55.001Z')).toThrow(
      'capture_age',
    );
  });
  const negatives: Array<[string, (f: Fixture) => void]> = [
    [
      'missing capture',
      (f) => {
        f.f.bundle.captures.pop();
      },
    ],
    [
      'extra capture',
      (f) => {
        f.f.bundle.captures.push(f.f.bundle.captures[0]!);
      },
    ],
    [
      'shuffled capture',
      (f) => {
        f.f.bundle.captures.reverse();
      },
    ],
    [
      'duplicate role',
      (f) => {
        f.f.bundle.captures[1]!.role = 'configuration';
      },
    ],
    [
      'different call ID',
      (f) => {
        f.f.bundle.captures[1]!.toolCallId = 'call_' + 'e'.repeat(32);
      },
    ],
    [
      'duplicate response ID',
      (f) => {
        f.f.statsApi.response_id = f.f.statsWeb.response_id;
      },
    ],
    [
      'non UUID response ID',
      (f) => {
        f.f.statsApi.response_id = 'not-a-uuid';
      },
    ],
    [
      'wrong monitor URL',
      (f) => {
        f.f.bundle.captures[1]!.url = f.f.bundle.captures[2]!.url;
      },
    ],
    [
      'cross origin URL',
      (f) => {
        f.f.bundle.captures[0]!.url = 'https://example.com/api/v1/probes?limit=10000&offset=0';
      },
    ],
    [
      'stale query time',
      (f) => {
        f.f.bundle.captures[1]!.url = f.f.bundle.captures[1]!.url.replace('12:00:24', '11:00:24');
      },
    ],
    [
      'future capture',
      (f) => {
        f.f.bundle.captures[0]!.capturedAt = '2026-11-14T12:00:31.000Z';
      },
    ],
    [
      'extra trace call',
      (f) => {
        f.trace.calls.push(f.trace.calls[0]!);
      },
    ],
    [
      'unmatched actual response',
      (f) => {
        f.trace.calls[0]!.response.call_id = 'call_' + 'e'.repeat(32);
      },
    ],
    [
      'wrong tool',
      (f) => {
        f.trace.calls[0]!.request.namespace = 'unknown';
      },
    ],
    [
      'extra trace field',
      (f) => {
        Object.assign(f.trace.calls[0]!, { fabricated: true });
      },
    ],
    [
      'missing output',
      (f) => {
        f.trace.calls[0]!.response.output.pop();
      },
    ],
    [
      'extra output',
      (f) => {
        f.trace.calls[0]!.response.output.push({ type: 'input_text', text: '{}' });
      },
    ],
    [
      'shuffled output capture',
      (f) => {
        const o = output(f);
        o.captures.reverse();
        replaceOutput(f, o);
      },
    ],
    [
      'missing output capture',
      (f) => {
        const o = output(f);
        o.captures.pop();
        replaceOutput(f, o);
      },
    ],
    [
      'output response drift',
      (f) => {
        const o = output(f);
        o.captures[1]!.nativeResponse = {};
        replaceOutput(f, o);
      },
    ],
    [
      'raw authorization',
      (f) => {
        f.f.config.probes[0]!.parameters.request_headers.Authorization = 'unredacted-synthetic';
      },
    ],
    [
      'extra header',
      (f) => {
        Object.assign(f.f.config.probes[0]!.parameters.request_headers, { 'X-Extra': 'unsafe' });
      },
    ],
    [
      'V1 bundle with batch IDs',
      (f) => {
        f.f.bundle.schema = NATIVE_MONITOR_BUNDLE;
      },
    ],
    [
      'V1 review with V2 bundle',
      (f) => {
        f.review.schema = NATIVE_REVIEW_SCHEMA;
      },
    ],
    [
      'V1 trace with V2 bundle',
      (f) => {
        f.trace.schema = NATIVE_TRACE_SCHEMA;
      },
    ],
  ];
  it.each(negatives)(
    'rejects %s even after untrusted container hashes are updated',
    (_name, mutate) => {
      const f = reviewedNativeBatchFixture();
      mutate(f);
      rehash(f);
      expect(() => verify(f)).toThrow();
    },
  );
  it.each(['code', 'title', 'timeout_ms'] as const)(
    'requires exact source-defined %s even with updated review hashes',
    (key) => {
      const f = reviewedNativeBatchFixture();
      const call = f.trace.calls[0]!;
      const args = nativeBatchCuaArguments();
      if (key === 'timeout_ms') args.timeout_ms += 1;
      else args[key] += ' ';
      call.request.arguments = JSON.stringify(args);
      for (const c of f.review.captures) {
        c.requestCodeSha256 = hash(args.code);
        c.requestArgumentsSha256 = hash(call.request.arguments);
      }
      rehash(f);
      expect(() => verify(f)).toThrow('batch_request_source');
    },
  );
});

async function executeBrowserBatch(
  get: (url: string, options: unknown) => Promise<unknown>,
  written: string[] = [],
) {
  const browserClient = { client: { get } };
  const phubNativeMonitorCdp = {
    async send(_method: string, input: { functionDeclaration: string }) {
      const browser = runInNewContext('(' + input.functionDeclaration + ')', {
        structuredClone,
        TextEncoder,
        Date: class extends Date {
          constructor() {
            super(NOW);
          }
        },
      }) as (this: typeof browserClient) => Promise<string>;
      try {
        return { result: { value: await browser.call(browserClient) } };
      } catch {
        return { exceptionDetails: { text: 'browser-exception' } };
      }
    },
  };
  await (runInNewContext('(async () => {' + nativeBatchCuaArguments().code + '})()', {
    phubNativeMonitorCdp,
    phubNativeTimewebClient: { result: { objectId: 'opaque-client' } },
    nodeRepl: { write: (value: string) => written.push(value) },
  }) as Promise<void>);
  return written;
}

function nativeResponses() {
  const f = reviewedNativeBatchFixture().f;
  // A configured value is redacted before the result can cross the browser boundary.
  for (const p of f.config.probes)
    p.parameters.request_headers.Authorization = 'synthetic-private-config';
  return [f.config, f.statsApi, f.statsWeb, f.incApi, f.incWeb];
}
describe('source-defined browser batch execution', () => {
  it('rejects multibyte UTF-8 overflow without emitting any output', async () => {
    const responses = nativeResponses();
    let index = 0;
    Object.assign(responses[1]!, { unicode: 'я'.repeat(1100000) });
    const written: string[] = [];
    await expect(
      executeBrowserBatch(
        () => Promise.resolve({ status: 200, data: responses[index++] }),
        written,
      ),
    ).rejects.toThrow('NATIVE_BATCH_CAPTURE_FAILED');
    expect(written).toEqual([]);
  });

  it('starts all five fixed bounded GETs together and emits only complete redacted output', async () => {
    const responses = nativeResponses();
    const requests: Array<[string, unknown]> = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const executed = executeBrowserBatch(async (url, options) => {
      const index = requests.length;
      requests.push([url, options]);
      await gate;
      return { status: 200, data: responses[index] };
    });
    expect(requests).toHaveLength(5);
    const origin = 'https://timeweb.cloud/api/v1/probes';
    const api = '26ed404e-98e5-45c5-98e3-31b9dfd6f0f2';
    const web = 'b25e28a0-02d8-49e4-a0a1-f49f62abc02c';
    expect(requests.map(([url]) => url)).toEqual([
      origin + '?limit=10000&offset=0',
      origin + '/' + api + '/statistics?time_from=' + encodeURIComponent(NOW) + '&period=6',
      origin + '/' + web + '/statistics?time_from=' + encodeURIComponent(NOW) + '&period=6',
      origin + '/' + api + '/incidents?limit=10000&offset=0',
      origin + '/' + web + '/incidents?limit=10000&offset=0',
    ]);
    expect(requests.map(([, options]) => options)).toEqual(
      Array.from({ length: 5 }, () => ({ timeout: 8000 })),
    );
    release();
    const written = await executed;
    expect(written).toHaveLength(1);
    expect(written[0]).not.toContain('synthetic-private-config');
    const result = JSON.parse(written[0]!) as {
      schema: string;
      captures: Array<Omit<Fixture['f']['bundle']['captures'][number], 'toolCallId'>>;
    };
    expect(result.schema).toBe(NATIVE_CUA_BATCH_RESULT);
    expect(result.captures).toHaveLength(5);
    expect(JSON.stringify(result.captures[0])).toContain(REDACTED_PRESENT);
    const f = reviewedNativeBatchFixture();
    f.f.bundle.captures = result.captures.map((c) => ({
      ...c,
      toolCallId: f.trace.calls[0]!.request.call_id,
    }));
    expect(deriveNativeMonitorReadback(bytes(f.f.bundle), NOW, SOURCE).monitors).toHaveLength(2);
  });
  it.each(['401', '500', 'timeout', 'malformed-config', 'contaminated-statistics'])(
    'emits no partial bundle on %s',
    async (failure) => {
      const responses = nativeResponses();
      let index = 0;
      if (failure === 'malformed-config') Object.assign(responses[0]!, { unexpected: true });
      if (failure === 'contaminated-statistics')
        Object.assign(responses[1]!, { secret: 'Bearer synthetic-private-config' });
      await expect(
        executeBrowserBatch(() => {
          const current = index++;
          if (current === 1 && failure === 'timeout') throw Error('private error config');
          return {
            status: current === 1 && /^\d/u.test(failure) ? Number(failure) : 200,
            data: responses[current],
          };
        }),
      ).rejects.toThrow('NATIVE_BATCH_CAPTURE_FAILED');
    },
  );
});
