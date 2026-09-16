import { describe, expect, it } from 'vitest';

import { vivaProfileViewerPhone } from './index.js';

describe('provider viewer phone extraction on the client', () => {
  const profile = (phone: unknown) => ({
    id: '11111111-1111-4111-8111-111111111111',
    firstName: 'Анна',
    middleName: null,
    lastName: 'Петрова',
    phone,
    photo: null,
    deposit: 0,
    customFields: [],
  });

  it('normalizes the russian forms the server accepts', () => {
    expect(vivaProfileViewerPhone(profile('+7 999 000-00-01'))).toBe('+79990000001');
    expect(vivaProfileViewerPhone(profile('8 (910) 430-31-90'))).toBe('+79104303190');
    expect(vivaProfileViewerPhone(profile('9104303190'))).toBe('+79104303190');
  });

  it('returns nothing for a foreign, truncated or absent number', () => {
    expect(vivaProfileViewerPhone(profile('4155552671'))).toBeUndefined();
    expect(vivaProfileViewerPhone(profile('7910430319'))).toBeUndefined();
    expect(vivaProfileViewerPhone(profile(null))).toBeUndefined();
    expect(vivaProfileViewerPhone(profile(undefined))).toBeUndefined();
  });
});
