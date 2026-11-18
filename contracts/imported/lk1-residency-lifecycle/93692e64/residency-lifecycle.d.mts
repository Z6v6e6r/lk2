export declare const RESIDENCY_PRODUCT_ID: string;
export declare const ORDER_STATES: Readonly<Record<string, string>>;
export declare const RESIDENCY_STATES: Readonly<Record<string, string>>;
export declare class ResidencyLifecycleError extends Error {
  readonly statusCode: number;
  readonly code: string;
}
export declare function createResidencyLifecycle(deps: Record<string, unknown>): Record<
  string,
  (...args: never[]) => Promise<unknown>
>;
