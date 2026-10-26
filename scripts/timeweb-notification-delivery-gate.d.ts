export const FCM_GATE_TARGET: string;
export interface FcmGateBinding {
  operationSha256: string;
  planSha256: string;
  releaseId: string;
  workerImage: string;
}
export function fcmGateBinding(
  op: unknown,
  operationSha256: string,
  planSha256: string,
): FcmGateBinding;
export function fcmGateToken(binding: FcmGateBinding, state: 'HELD' | 'RELEASED'): string;
export function fcmGateEnvironment(binding: FcmGateBinding): Record<string, string>;
export function fcmGateComposeOverride(directory: string, binding: FcmGateBinding): string;
export function holdFcmDeliveryGate(directory: string, binding: FcmGateBinding): void;
export function releaseFcmDeliveryGate(directory: string, binding: FcmGateBinding): void;
export function readFcmDeliveryGate(
  directory: string,
  binding: FcmGateBinding,
): 'HELD' | 'RELEASED';
export function validateFcmGateRuntime(
  actual: unknown,
  directory: string,
  binding: FcmGateBinding,
): boolean;
export function fcmGateTokenSha256(binding: FcmGateBinding, state: 'HELD' | 'RELEASED'): string;

export function classifyFcmGatePreparation(directory: string, binding: FcmGateBinding): string;

export function classifyFcmGateRelease(
  directory: string,
  binding: FcmGateBinding,
): 'HELD' | 'RELEASED';
