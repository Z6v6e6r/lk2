export type TimewebCorsOriginsResult =
  { readonly ok: true; readonly value: string } | { readonly ok: false; readonly reason: string };

export function readTimewebCorsOrigins(target: {
  readonly hostname?: unknown;
  readonly cupOrigins?: unknown;
}): TimewebCorsOriginsResult;
