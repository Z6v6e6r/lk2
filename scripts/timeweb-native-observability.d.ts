export const NATIVE_MONITOR_SCHEMA: 'PHUB_TIMEWEB_MONITOR_READBACK_V2';
export const NATIVE_MONITOR_BUNDLE: 'PHUB_TIMEWEB_NATIVE_MONITOR_CAPTURE_V1';
export const APPROVED_NATIVE_READER: string;
export const REDACTED_PRESENT: string;
export const NATIVE_MONITORS: readonly {
  service: string;
  id: string;
  name: string;
  host: string;
}[];
export type NativeMonitorReadback = {
  schema: typeof NATIVE_MONITOR_SCHEMA;
  source: string;
  readAt: string;
  projectId: number;
  producerSourceSha: string;
  readerAuditId: string;
  trust: 'APPROVED_READER_ROOT_OPERATOR_ATTESTED_V1';
  captureBundleSha256: string;
  monitors: Record<string, unknown>[];
};
export function redactNativeProbeResponse(input: unknown): unknown;
export function deriveNativeMonitorReadback(
  bytes: string | Uint8Array,
  observedAt: string,
  expectedSourceSha: string,
): NativeMonitorReadback;
export function verifyNativeMonitorReadback(
  readback: unknown,
  bundleBytes: string | Uint8Array,
  observedAt: string,
  expectedSourceSha: string,
): NativeMonitorReadback['monitors'];
