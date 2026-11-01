/** Server-only evidence for a room inside the exact requested studio. No mutation methods. */
export interface CreateLocationRoomEvidence {
  readonly studioId: string;
  readonly roomId: string;
  readonly observedAt: string;
}
const validId = (value: string) =>
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value) && !/[\r\n]/.test(value);
export class CreateLocationProviderContradiction extends Error {
  constructor() {
    super('CREATE_LOCATION_PROVIDER_PAIR_MISMATCH');
  }
}
export class VivaCreateLocationSource {
  private failures = 0;
  private openUntil = 0;
  constructor(
    private readonly options: {
      readonly fetchImplementation?: typeof fetch;
      readonly now?: () => number;
    } = {},
  ) {}

  async readRoomStudio(input: {
    readonly providerTenantKey: 'iSkq6G';
    readonly studioId: string;
    readonly roomId: string;
    readonly accessToken: string;
    readonly correlationId: string;
  }): Promise<CreateLocationRoomEvidence> {
    const now = this.options.now ?? Date.now;
    if (
      input.providerTenantKey !== 'iSkq6G' ||
      !validId(input.studioId) ||
      !validId(input.roomId) ||
      !/^[A-Za-z0-9._-]{1,100}$/.test(input.correlationId) ||
      input.accessToken.length < 20 ||
      input.accessToken.length > 12_000 ||
      /[\r\n]/.test(input.accessToken)
    )
      throw new Error('CREATE_LOCATION_PROVIDER_INPUT_INVALID');
    if (this.openUntil > now()) throw new Error('CREATE_LOCATION_PROVIDER_CIRCUIT_OPEN');
    const url = `https://api.vivacrm.ru/api/v1/studios/${encodeURIComponent(input.studioId)}/rooms/${encodeURIComponent(input.roomId)}`;
    for (let attempt = 0; attempt < 2; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5_000);
      try {
        const response = await (this.options.fetchImplementation ?? fetch)(url, {
          method: 'GET',
          redirect: 'error',
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${input.accessToken}`,
            'X-Correlation-ID': input.correlationId,
          },
        });
        if (attempt === 0 && (response.status === 429 || response.status >= 500)) {
          await response.body?.cancel();
          continue;
        }
        if (response.status !== 200 || response.redirected || response.url !== url)
          throw new Error('CREATE_LOCATION_PROVIDER_RESPONSE_INVALID');
        const reader = response.body?.getReader();
        if (!reader) throw new Error('CREATE_LOCATION_PROVIDER_RESPONSE_INVALID');
        const chunks: Uint8Array[] = [];
        let size = 0;
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.byteLength;
          if (size > 65_536) {
            await reader.cancel();
            throw new Error('CREATE_LOCATION_PROVIDER_RESPONSE_INVALID');
          }
          chunks.push(next.value);
        }
        const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value))
          throw new Error('CREATE_LOCATION_PROVIDER_RESPONSE_INVALID');
        const row = value as Record<string, unknown>;
        if (
          (row.id ?? row.roomId) !== input.roomId ||
          (row.id !== undefined && row.id !== input.roomId) ||
          (row.roomId !== undefined && row.roomId !== input.roomId) ||
          (row.studioId !== undefined && row.studioId !== input.studioId)
        )
          throw new CreateLocationProviderContradiction();
        this.failures = 0;
        return {
          studioId: input.studioId,
          roomId: input.roomId,
          observedAt: new Date(now()).toISOString(),
        };
      } catch (error) {
        controller.abort();
        if (error instanceof CreateLocationProviderContradiction) throw error;
        if (++this.failures >= 3) this.openUntil = now() + 30_000;
        // Transport ambiguity is not evidence of deletion, and is never persisted as a new binding.
        // eslint-disable-next-line preserve-caught-error -- Transport causes may contain private credentials; expose only the stable code.
        throw new Error('CREATE_LOCATION_PROVIDER_UNAVAILABLE');
      } finally {
        clearTimeout(timer);
      }
    }
    throw new Error('CREATE_LOCATION_PROVIDER_UNAVAILABLE');
  }
}
