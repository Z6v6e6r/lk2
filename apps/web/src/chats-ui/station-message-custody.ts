// Original request metadata only. Plaintext is never stored here, including after an unknown ACK.
export interface StationMessagePending {
  readonly requestId: string;
  readonly fingerprint: string;
}
const validId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export class StationMessageCustody {
  private readonly key: string;
  constructor(
    scope: string,
    communityId: string,
    private readonly storage: Storage,
    private readonly cryptoApi: Pick<Crypto, 'subtle' | 'randomUUID'> = crypto,
  ) {
    this.key = `lk2:station-message:1:${JSON.stringify([scope, communityId])}`;
  }
  pending(): readonly StationMessagePending[] {
    const raw = this.storage.getItem(this.key);
    if (raw === null) return [];
    if (raw.length > 4096) throw new Error('STATION_MESSAGE_CUSTODY_INVALID');
    const values: unknown = JSON.parse(raw);
    if (
      !Array.isArray(values) ||
      values.length > 16 ||
      !values.every(
        (v: unknown) =>
          typeof v === 'object' &&
          v !== null &&
          Object.keys(v).length === 2 &&
          'requestId' in v &&
          typeof v.requestId === 'string' &&
          validId.test(v.requestId) &&
          'fingerprint' in v &&
          typeof v.fingerprint === 'string' &&
          /^[a-f0-9]{64}$/.test(v.fingerprint),
      )
    )
      throw new Error('STATION_MESSAGE_CUSTODY_INVALID');
    const result = values as StationMessagePending[];
    if (
      new Set(result.map((v) => v.requestId)).size !== result.length ||
      new Set(result.map((v) => v.fingerprint)).size !== result.length
    )
      throw new Error('STATION_MESSAGE_CUSTODY_INVALID');
    return result;
  }
  async original(
    text: string,
    isCurrent: () => boolean = () => true,
    requireEmpty = false,
  ): Promise<StationMessagePending> {
    if (!isCurrent()) throw new Error('AUTH_PRINCIPAL_CHANGED');
    const canonical = text.trim();
    if (!canonical || text.length > 8000) throw new Error('STATION_MESSAGE_BODY_INVALID');
    const fingerprint = await this.fingerprint(canonical);
    if (!isCurrent()) throw new Error('AUTH_PRINCIPAL_CHANGED');
    // Read after hashing: two distinct edited intents cannot overwrite one another's metadata.
    const pending = this.pending();
    // A native pending request that appeared while hashing also blocks a replacement POST.
    if (requireEmpty && pending.length > 0) throw new Error('STATION_MESSAGE_RECOVERY_REQUIRED');
    const original = pending.find((v) => v.fingerprint === fingerprint);
    if (original) return original;
    if (pending.length >= 16) throw new Error('STATION_MESSAGE_CUSTODY_FULL');
    const value = { requestId: this.cryptoApi.randomUUID(), fingerprint };
    this.storage.setItem(this.key, JSON.stringify([...pending, value]));
    if (!this.pending().some((v) => v.requestId === value.requestId))
      throw new Error('STATION_MESSAGE_CUSTODY_UNAVAILABLE');
    if (!isCurrent()) throw new Error('AUTH_PRINCIPAL_CHANGED');
    return value;
  }
  private async fingerprint(canonical: string): Promise<string> {
    const digest = await this.cryptoApi.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(canonical),
    );
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(
      '',
    );
  }
  async matchesOriginal(requestId: string, body: string): Promise<boolean> {
    const expected = this.pending().find((value) => value.requestId === requestId);
    return Boolean(expected && expected.fingerprint === (await this.fingerprint(body)));
  }
  confirmed(requestId: string): void {
    this.storage.setItem(
      this.key,
      JSON.stringify(this.pending().filter((v) => v.requestId !== requestId)),
    );
  }
}
