import {
  parseTournamentChatReceipt,
  tournamentChatRequestHash,
  tournamentChatText,
  tournamentChatUuid,
  type TournamentChatReceipt,
} from '@phub/api-sdk';
export interface TournamentChatPending {
  readonly requestId: string;
  readonly fingerprint: string;
  readonly requestHash: string;
}
export interface TournamentChatLocks {
  request<T>(name: string, options: { mode: 'exclusive' }, callback: () => Promise<T>): Promise<T>;
}
export class TournamentChatCustody {
  private readonly key: string;
  constructor(
    readonly tournamentId: string,
    principal: { tenantId: string; userId: string },
    private readonly storage: Pick<Storage, 'getItem' | 'setItem'>,
    private readonly locks: TournamentChatLocks,
    private readonly current: () => boolean,
    private readonly cryptoApi: Pick<Crypto, 'subtle' | 'randomUUID'> = crypto,
  ) {
    if (![tournamentId, principal.tenantId, principal.userId].every(tournamentChatUuid))
      throw new Error('TOURNAMENT_CHAT_CUSTODY_INVALID');
    this.key =
      'phub.tournament-chat.v1:' +
      JSON.stringify([principal.tenantId, principal.userId, tournamentId]);
  }
  private active() {
    if (!this.current()) throw new Error('AUTH_PRINCIPAL_CHANGED');
  }
  pending(): readonly TournamentChatPending[] {
    this.active();
    const raw = this.storage.getItem(this.key);
    if (raw === null) return [];
    if (raw.length > 8192) throw new Error('TOURNAMENT_CHAT_CUSTODY_INVALID');
    const x: unknown = JSON.parse(raw);
    if (
      !Array.isArray(x) ||
      x.length > 16 ||
      !x.every(
        (v: unknown) =>
          typeof v === 'object' &&
          v !== null &&
          !Array.isArray(v) &&
          Object.keys(v).sort().join(',') === 'fingerprint,requestHash,requestId' &&
          'requestId' in v &&
          tournamentChatUuid(v.requestId) &&
          'fingerprint' in v &&
          typeof v.fingerprint === 'string' &&
          /^[a-f0-9]{64}$/.test(v.fingerprint) &&
          'requestHash' in v &&
          typeof v.requestHash === 'string' &&
          /^[a-f0-9]{64}$/.test(v.requestHash),
      )
    )
      throw new Error('TOURNAMENT_CHAT_CUSTODY_INVALID');
    const values = x as TournamentChatPending[];
    if (
      new Set(values.map((v) => v.requestId)).size !== values.length ||
      new Set(values.map((v) => v.fingerprint)).size !== values.length
    )
      throw new Error('TOURNAMENT_CHAT_CUSTODY_INVALID');
    return values;
  }
  async original(text: string): Promise<TournamentChatPending> {
    this.active();
    if (!tournamentChatText(text)) throw new Error('TOURNAMENT_CHAT_INPUT_INVALID');
    return this.locks.request(this.key, { mode: 'exclusive' }, async () => {
      this.active();
      const bytes = await this.cryptoApi.subtle.digest('SHA-256', new TextEncoder().encode(text));
      this.active();
      const fingerprint = Array.from(new Uint8Array(bytes), (b) =>
        b.toString(16).padStart(2, '0'),
      ).join('');
      const values = this.pending(),
        old = values.find((v) => v.fingerprint === fingerprint);
      if (old) return old;
      if (values.length >= 16) throw new Error('TOURNAMENT_CHAT_CUSTODY_FULL');
      const requestId = this.cryptoApi.randomUUID(),
        requestHash = await tournamentChatRequestHash(
          this.tournamentId,
          { requestId, text },
          this.cryptoApi,
        );
      this.active();
      const original = { requestId, requestHash, fingerprint };
      this.storage.setItem(this.key, JSON.stringify([...values, original]));
      if (!this.pending().some((v) => v.requestId === requestId && v.requestHash === requestHash))
        throw new Error('TOURNAMENT_CHAT_CUSTODY_UNAVAILABLE');
      return original;
    });
  }
  async accept(
    value: unknown,
    requestId: string,
    stillAuthorized: () => boolean = () => true,
  ): Promise<boolean> {
    this.active();
    return this.locks.request(this.key, { mode: 'exclusive' }, () => {
      this.active();
      if (!stillAuthorized()) throw new Error('AUTH_PRINCIPAL_CHANGED');
      const pending = this.pending(),
        original = pending.find((v) => v.requestId === requestId);
      if (!original) throw new Error('TOURNAMENT_CHAT_ORIGINAL_REQUIRED');
      const r: TournamentChatReceipt = parseTournamentChatReceipt(
        value,
        this.tournamentId,
        requestId,
        original.requestHash,
      );
      if (r.status !== 'CONFIRMED') return Promise.resolve(false);
      this.active();
      if (!stillAuthorized()) throw new Error('AUTH_PRINCIPAL_CHANGED');
      this.storage.setItem(
        this.key,
        JSON.stringify(pending.filter((v) => v.requestId !== requestId)),
      );
      return Promise.resolve(true);
    });
  }
}
