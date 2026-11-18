export interface ResidencyLifecycleHttpResponse {
  readonly statusCode: number;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}
export declare function createResidencyLifecycleApi(deps: {
  readonly createLifecycle: (actor: { tenantId: string; userId: string }) => unknown;
  readonly allowOrigin?: string;
}): {
  handle(request: {
    method: string;
    path: string;
    headers: Record<string, string>;
    body?: unknown;
    actor?: { tenantId: string; userId: string };
  }): Promise<ResidencyLifecycleHttpResponse>;
};
