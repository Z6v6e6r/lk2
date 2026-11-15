export const NATIVE_REVIEW_SCHEMA: string;
export const NATIVE_TRACE_SCHEMA: string;
export function nativeRedactorSha256(): string;
export function verifyNativeCaptureReview(
  reviewBytes: string | Uint8Array,
  bundleBytes: string | Uint8Array,
  traceBytes: string | Uint8Array,
  sourceSha: string,
  adapterSourceSha256: string,
  now?: string,
): {
  reviewSha256: string;
  actualTraceSha256: string;
  captureBundleSha256: string;
  reviewedAt: string;
};
