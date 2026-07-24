import { describe, expect, it } from 'vitest';

import { renderGiftCertificatePdf } from './gift-certificate-pdf.js';

describe('gift certificate PDF', () => {
  it('renders a bounded single-page artwork with an activation code and denomination', async () => {
    const input = {
      certificateNumber: 'PH-GC-0123456789ABCDEF',
      activationCode: 'PHGC-1234-5678-90AB-CDEF-1234-5678',
      recipientName: 'Александра',
      recipientMessage: 'Пусть каждая игра приносит новые победы!',
      designTitle: 'Энергия корта',
      amountMinor: 500_000,
      codeXPercent: 5.1,
      codeYPercent: 88,
      amountXPercent: 78.3,
      amountYPercent: 88,
      validityStart: 'ISSUE',
      validityDays: 365,
      activationDeadlineDays: null,
    } as const;
    const pdf = await renderGiftCertificatePdf(input);
    const retry = await renderGiftCertificatePdf(input);

    expect(pdf.subarray(0, 5).toString('ascii')).toBe('%PDF-');
    expect(pdf.length).toBeGreaterThan(4_000);
    expect(pdf.length).toBeLessThan(8 * 1_024 * 1_024);
    expect(pdf.toString('latin1').match(/\/Type \/Page\b/g)).toHaveLength(1);
    expect(retry).toEqual(pdf);
  });
});
