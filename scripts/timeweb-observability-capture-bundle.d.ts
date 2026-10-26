import type { TimewebObservabilityContract } from './verify-timeweb-api-web-observability.js';
import type {
  TimewebMonitorReadback,
  TimewebAlertReadback,
} from './produce-timeweb-api-web-observability-evidence.js';

export class TimewebCaptureError extends Error {
  readonly code: string;
}
export interface TimewebRawCapture {
  role: string;
  kind: string;
  tool: string;
  callId: string;
  reader: string;
  source: { origin: string; immutableId: string; url: string | null };
  capturedAt: string;
  rawFile: string;
  rawSize: number;
  rawSha256: string;
  raw: Buffer;
}
export type TimewebCaptureAdapter = (
  raw: Uint8Array,
  capture: Omit<TimewebRawCapture, 'raw'>,
) => unknown;
export function parseTimewebCaptureBundle(
  manifestBytes: string | Uint8Array,
  files: Map<string, Uint8Array>,
): Map<string, TimewebRawCapture>;
/** Pure test surface; omitted adapters always STOP. No writer or operational CLI. */
export function deriveTimewebObservabilityReadbacks(
  manifestBytes: string | Uint8Array,
  files: Map<string, Uint8Array>,
  contract: TimewebObservabilityContract,
  observedAt: string,
  adapters?: Record<string, TimewebCaptureAdapter>,
): {
  monitorReadback: TimewebMonitorReadback;
  alertReadback: TimewebAlertReadback;
  captureCount: number;
  operationalWriter: false;
};
