export class StrictJsonError extends Error {
  readonly reason: string;
}

export function decodeJsonUtf8(bytes: Uint8Array): string;
export function parseStrictJson<T = unknown>(input: string | Uint8Array): T;
