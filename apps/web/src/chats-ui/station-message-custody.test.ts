import { webcrypto } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { StationMessageCustody } from './station-message-custody.js';
const cryptoApi = webcrypto as unknown as Crypto;
function storage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
  };
}
describe('same-tab original station request metadata', () => {
  it('preserves unresolved originals across edits/reload with no plaintext and actor/community isolation', async () => {
    const store = storage();
    const original = new StationMessageCustody('tenant/user', 'community', store, cryptoApi);
    const a = await original.original('first private body');
    const b = await original.original('edited private body');
    expect(a.requestId).not.toBe(b.requestId);
    expect(await original.original('first private body')).toEqual(a);
    const restored = new StationMessageCustody('tenant/user', 'community', store, cryptoApi);
    expect(restored.pending()).toHaveLength(2);
    expect(await restored.original('first private body')).toEqual(a);
    expect(store.getItem(store.key(0)!)).not.toContain('private body');
    expect(
      new StationMessageCustody('tenant/other', 'community', store, cryptoApi).pending(),
    ).toEqual([]);
    expect(new StationMessageCustody('tenant/user', 'other', store, cryptoApi).pending()).toEqual(
      [],
    );
    restored.confirmed(a.requestId);
    expect(restored.pending()).toEqual([b]);
  });
  it('full and corrupt custody deny new intents without evicting unresolved keys', async () => {
    const store = storage();
    const custody = new StationMessageCustody('actor', 'community', store, cryptoApi);
    const first = await custody.original('0');
    for (let i = 1; i < 16; i++) await custody.original(String(i));
    await expect(custody.original('new')).rejects.toThrow('FULL');
    expect(custody.pending()).toHaveLength(16);
    expect(await custody.original('0')).toEqual(first);
    store.setItem(store.key(0)!, 'broken');
    await expect(custody.original('anything')).rejects.toThrow();
    expect(store.getItem(store.key(0)!)).toBe('broken');
  });
});
