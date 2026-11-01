import type { LegacyCommunityToken } from '@phub/communities';

/** Community directory/history/owner calls share only an outstanding issuance for the exact session. */
export function createCommunityActorToken(
  issue: LegacyCommunityToken,
  options: { readonly timeoutMs?: number; readonly maxInFlight?: number } = {},
): LegacyCommunityToken {
  const pending = new Map<string, Promise<string>>();
  const timeoutMs = options.timeoutMs ?? 10_000;
  const capacity = options.maxInFlight ?? 128;
  return (actor) => {
    if (!actor.tenantKey || !actor.tenantId || !actor.userId || !actor.sessionId)
      return Promise.reject(new Error('COMMUNITY_DELEGATION_UNAVAILABLE'));
    const key = JSON.stringify([actor.tenantKey, actor.tenantId, actor.userId, actor.sessionId]);
    const existing = pending.get(key);
    if (existing) return existing;
    if (pending.size >= capacity)
      return Promise.reject(new Error('COMMUNITY_DELEGATION_UNAVAILABLE'));
    let timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('COMMUNITY_DELEGATION_UNAVAILABLE')), timeoutMs);
    });
    const issuance = Promise.resolve().then(() => issue(actor));
    const result = Promise.race([issuance, deadline]).finally(() => {
      clearTimeout(timer);
      if (pending.get(key) === result) pending.delete(key);
    });
    pending.set(key, result);
    return result;
  };
}
