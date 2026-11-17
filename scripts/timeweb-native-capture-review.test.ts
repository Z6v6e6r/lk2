import { describe, expect, it } from 'vitest';
import {
  NOW,
  SOURCE,
  NATIVE_ADAPTER_SHA256 as ADAPTER,
  encodedNativeFixture as bytes,
  nativeFixtureHash as hash,
  reviewedNativeFixture as reviewedFixture,
} from './timeweb-native-observability-fixtures.js';
import { verifyNativeCaptureReview } from './timeweb-native-capture-review.js';

function verify(value: ReturnType<typeof reviewedFixture>) {
  return verifyNativeCaptureReview(
    bytes(value.review),
    bytes(value.f.bundle),
    bytes(value.trace),
    SOURCE,
    ADAPTER,
    NOW,
  );
}
describe('root-attested review of the complete public CUA I/O projection', () => {
  it('binds the real public I/O fields while explicitly excluding framework metadata and origin claims', () => {
    const f = reviewedFixture();
    expect(verify(f)).toEqual({
      reviewSha256: hash(bytes(f.review)),
      actualTraceSha256: hash(bytes(f.trace)),
      captureBundleSha256: hash(bytes(f.f.bundle)),
      reviewedAt: NOW,
    });
  });
  const negatives: Array<[string, (value: ReturnType<typeof reviewedFixture>) => void]> = [
    [
      'wrong source',
      (f) => {
        f.review.producerSourceSha = 'e'.repeat(40);
      },
    ],
    [
      'wrong adapter',
      (f) => {
        f.review.adapterSourceSha256 = 'e'.repeat(64);
      },
    ],
    [
      'wrong redactor',
      (f) => {
        f.review.redactorSha256 = 'e'.repeat(64);
      },
    ],
    [
      'unreviewed bundle',
      (f) => {
        f.review.captureBundleSha256 = 'e'.repeat(64);
      },
    ],
    [
      'wrong reviewer role',
      (f) => {
        f.review.reviewer.kind = 'HUMAN_OWNER';
      },
    ],
    [
      'invented task shape',
      (f) => {
        f.review.reviewer.taskPath = 'person';
      },
    ],
    [
      'review before captures',
      (f) => {
        f.review.reviewedAt = '2026-11-14T12:00:24.000Z';
      },
    ],
    [
      'future review',
      (f) => {
        f.review.reviewedAt = '2026-11-14T12:00:31.000Z';
      },
    ],
    [
      'no approval',
      (f) => {
        f.review.conclusion = 'PENDING';
      },
    ],
    [
      'raw transcript claim',
      (f) => {
        f.review.tracePolicy = 'RAW_AUTHENTICATED_FRAMEWORK_TRANSCRIPT';
      },
    ],
    [
      'missing public call field',
      (f) => {
        Reflect.deleteProperty(f.trace.calls[0]!.request, 'namespace');
      },
    ],
    [
      'internal routing metadata',
      (f) => {
        Object.assign(f.trace.calls[0]!.request, {
          internal_chat_message_metadata_passthrough: 'forbidden',
        });
      },
    ],
    [
      'extra response field',
      (f) => {
        Object.assign(f.trace.calls[0]!.response, { status: 'completed' });
      },
    ],
    [
      'wrong tool namespace',
      (f) => {
        f.trace.calls[0]!.request.namespace = 'other';
      },
    ],
    [
      'wrong call ID',
      (f) => {
        f.trace.calls[0]!.request.call_id = 'call_' + 'f'.repeat(32);
      },
    ],
    [
      'missing output block',
      (f) => {
        f.trace.calls[0]!.response.output.pop();
      },
    ],
    [
      'reordered output',
      (f) => {
        f.trace.calls[0]!.response.output.reverse();
      },
    ],
    [
      'extra output',
      (f) => {
        f.trace.calls[0]!.response.output.push({ type: 'input_text', text: 'extra' });
      },
    ],
    [
      'changed output text',
      (f) => {
        f.trace.calls[1]!.response.output[1]!.text = '{}';
      },
    ],
    [
      'changed approved role',
      (f) => {
        f.review.captures[1]!.role = 'statistics-web';
      },
    ],
    [
      'changed approved URL',
      (f) => {
        f.review.captures[1]!.url = 'https://example.com/';
      },
    ],
    [
      'changed approved timestamp',
      (f) => {
        f.review.captures[1]!.capturedAt = '2026-11-14T12:00:26.000Z';
      },
    ],
    [
      'changed native response hash',
      (f) => {
        f.review.captures[1]!.responseSha256 = 'e'.repeat(64);
      },
    ],
    [
      'credential in output',
      (f) => {
        f.trace.calls[0]!.response.output[1]!.text = 'Basic synthetic-forbidden-token';
      },
    ],
    [
      'credential in code',
      (f) => {
        f.trace.calls[1]!.request.arguments = JSON.stringify({
          code: 'Bearer fixture',
          title: 'fixture',
        });
      },
    ],
  ];
  it.each(negatives)(
    'rejects %s even when a substituted trace hash is supplied',
    (name, mutate) => {
      const f = reviewedFixture();
      mutate(f);
      f.review.actualTraceSha256 = hash(bytes(f.trace));
      expect(() => verify(f), name).toThrow();
    },
  );
  it.each(['code', 'title', 'timeout_ms'] as const)(
    'binds the original arguments string, including %s',
    (key) => {
      const f = reviewedFixture();
      const call = f.trace.calls[1]!;
      const args = JSON.parse(call.request.arguments) as {
        code: string;
        title: string;
        timeout_ms: number;
      };
      if (key === 'timeout_ms') args.timeout_ms = 1000;
      else args[key] += ' changed';
      call.request.arguments = JSON.stringify(args);
      f.review.actualTraceSha256 = hash(bytes(f.trace));
      expect(() => verify(f)).toThrow();
    },
  );
  it('rejects trace reserialization after review without inventing an origin-authentication claim', () => {
    const f = reviewedFixture();
    expect(() =>
      verifyNativeCaptureReview(
        bytes(f.review),
        bytes(f.f.bundle),
        JSON.stringify(f.trace),
        SOURCE,
        ADAPTER,
        NOW,
      ),
    ).toThrow(/hash/);
  });
});
