import {
  parseTournamentChatReadRequest,
  parseTournamentChatReadReceipt,
  tournamentChatReadHash,
  tournamentChatUuid,
  type TournamentChatReadRequest,
} from '@phub/api-sdk';
import type { TournamentChatLocks } from './tournament-chat-custody.js';
export type PendingTournamentRead = TournamentChatReadRequest & { readonly requestHash: string };
/** Only read-command metadata, never message bodies or private participant witnesses. */
export class TournamentReadCustody {
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
      throw Error('TOURNAMENT_CHAT_CUSTODY_INVALID');
    this.key =
      'phub.tournament-read.v1:' +
      JSON.stringify([principal.tenantId, principal.userId, tournamentId]);
  }
  private active() {
    if (!this.current()) throw Error('AUTH_PRINCIPAL_CHANGED');
  }
  pending(): readonly PendingTournamentRead[] {
    this.active();
    const raw = this.storage.getItem(this.key);
    if (raw === null) return [];
    if (raw.length > 12000) throw Error('TOURNAMENT_CHAT_CUSTODY_INVALID');
    const values: unknown = JSON.parse(raw);
    if (!Array.isArray(values) || values.length > 16)
      throw Error('TOURNAMENT_CHAT_CUSTODY_INVALID');
    const seen = new Set<string>();
    return values.map((v: unknown) => {
      if (
        !v ||
        typeof v !== 'object' ||
        Array.isArray(v) ||
        Object.keys(v).sort().join(',') !==
          'requestHash,requestId,streamId,throughSequence,witnessHash' ||
        !('requestHash' in v) ||
        typeof v.requestHash !== 'string' ||
        !/^[a-f0-9]{64}$/.test(v.requestHash)
      )
        throw Error('TOURNAMENT_CHAT_CUSTODY_INVALID');
      const copy = { ...v } as Record<string, unknown>;
      delete copy.requestHash;
      const request = parseTournamentChatReadRequest(copy);
      if (seen.has(request.requestId)) throw Error('TOURNAMENT_CHAT_CUSTODY_INVALID');
      seen.add(request.requestId);
      return { ...request, requestHash: v.requestHash };
    });
  }
  async original(
    input: Omit<TournamentChatReadRequest, 'requestId'>,
  ): Promise<PendingTournamentRead> {
    return this.locks.request(this.key, { mode: 'exclusive' }, async () => {
      this.active();
      const values = this.pending();
      const old = values.find(
        (v) =>
          v.streamId === input.streamId &&
          v.witnessHash === input.witnessHash &&
          v.throughSequence === input.throughSequence,
      );
      if (old) {
        const request = {
          requestId: old.requestId,
          streamId: old.streamId,
          witnessHash: old.witnessHash,
          throughSequence: old.throughSequence,
        };
        if (
          (await tournamentChatReadHash(this.tournamentId, request, this.cryptoApi)) !==
          old.requestHash
        )
          throw Error('TOURNAMENT_CHAT_CUSTODY_INVALID');
        this.active();
        return old;
      }
      if (values.length >= 16) throw Error('TOURNAMENT_CHAT_CUSTODY_FULL');
      const request = parseTournamentChatReadRequest({
        requestId: this.cryptoApi.randomUUID(),
        ...input,
      });
      const original = {
        ...request,
        requestHash: await tournamentChatReadHash(this.tournamentId, request, this.cryptoApi),
      };
      this.active();
      this.storage.setItem(this.key, JSON.stringify([...values, original]));
      if (
        !this.pending().some(
          (v) => v.requestId === original.requestId && v.requestHash === original.requestHash,
        )
      )
        throw Error('TOURNAMENT_CHAT_CUSTODY_UNAVAILABLE');
      return original;
    });
  }
  async accept(raw: unknown, requestId: string, stillCurrent: () => boolean) {
    return this.locks.request(this.key, { mode: 'exclusive' }, async () => {
      this.active();
      if (!stillCurrent()) throw Error('AUTH_PRINCIPAL_CHANGED');
      const pending = this.pending(),
        original = pending.find((v) => v.requestId === requestId);
      if (!original) throw Error('TOURNAMENT_CHAT_ORIGINAL_REQUIRED');
      if (
        (await tournamentChatReadHash(
          this.tournamentId,
          {
            requestId: original.requestId,
            streamId: original.streamId,
            witnessHash: original.witnessHash,
            throughSequence: original.throughSequence,
          },
          this.cryptoApi,
        )) !== original.requestHash
      )
        throw Error('TOURNAMENT_CHAT_CUSTODY_INVALID');
      const r = parseTournamentChatReadReceipt(
        raw,
        this.tournamentId,
        requestId,
        original.requestHash,
      );
      if (r.status !== 'CONFIRMED') return false;
      if (
        r.streamId !== original.streamId ||
        r.witnessHash !== original.witnessHash ||
        r.throughSequence !== original.throughSequence
      )
        throw Error('TOURNAMENT_CHAT_CUSTODY_INVALID');
      this.active();
      if (!stillCurrent()) throw Error('AUTH_PRINCIPAL_CHANGED');
      this.storage.setItem(
        this.key,
        JSON.stringify(pending.filter((v) => v.requestId !== requestId)),
      );
      return true;
    });
  }
}
