import { describe, expect, it } from 'vitest';

import { selectLk1GameId } from './lk1-result-bridge-repository.js';

/**
 * One imported game carries two `LK_LEGACY_SNAPSHOT`/`game` aliases: the id LK1 uses for its own
 * record (`pay_…`) and a pseudonymous 64-hex hash produced inside the legacy adapter. LK1 answers
 * `LK1_GAME_NOT_FOUND` for the hash, so the handoff must never send it.
 */
const lk1GameId = 'pay_7c1f3cec-e61d-4ceb-909f-273516cdbffe';
const pseudonymousAlias = '56c57228bebda76dac83335834daa40da35375376b0f902f22581a9bc85ac513';

describe('selectLk1GameId', () => {
  it('prefers the provider game id over the pseudonymous alias', () => {
    expect(selectLk1GameId([pseudonymousAlias, lk1GameId])).toBe(lk1GameId);
    expect(selectLk1GameId([lk1GameId, pseudonymousAlias])).toBe(lk1GameId);
  });

  it('keeps slot-scoped provider ids', () => {
    const slotId =
      'slot_ed0e3bd4-6edb-43a9-8fe4-8fc3e7febec8_655358b2-6b6c-4e03-a8a9-c88250464f08_2026-03-06_07_00_08_00_535c7c3e-af2e-4aeb';
    expect(selectLk1GameId([pseudonymousAlias, slotId])).toBe(slotId);
  });

  it('answers null when only the pseudonymous alias exists', () => {
    expect(selectLk1GameId([pseudonymousAlias])).toBeNull();
    expect(selectLk1GameId([])).toBeNull();
  });

  it('is deterministic for repeated aliases and mixed case hashes', () => {
    expect(selectLk1GameId([lk1GameId, lk1GameId, pseudonymousAlias])).toBe(lk1GameId);
    // An upper-case 64-hex string is not the adapter's lower-case hash shape, so it stays usable.
    expect(selectLk1GameId([pseudonymousAlias.toUpperCase()])).toBe(
      pseudonymousAlias.toUpperCase(),
    );
  });

  it('ignores empty entries', () => {
    expect(selectLk1GameId(['', lk1GameId])).toBe(lk1GameId);
    expect(selectLk1GameId([''])).toBeNull();
  });
});
