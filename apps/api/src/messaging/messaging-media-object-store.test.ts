import { describe, expect, it } from 'vitest';

import { contentDispositionHeader } from './messaging-media-object-store.js';

describe('chat media delivery headers', () => {
  it('serves an image inline and a file as a download', () => {
    expect(contentDispositionHeader('photo.png', true)).toBe(
      `inline; filename="photo.png"; filename*=UTF-8''photo.png`,
    );
    expect(contentDispositionHeader('report.pdf', false)).toBe(
      `attachment; filename="report.pdf"; filename*=UTF-8''report.pdf`,
    );
  });

  it('keeps a non-ASCII name intact for the download prompt', () => {
    const header = contentDispositionHeader('договор аренды.pdf', false);

    // The ASCII fallback is lossy on purpose; the RFC 5987 parameter carries the real name.
    expect(header).toContain(`filename*=UTF-8''${encodeURIComponent('договор аренды.pdf')}`);
    expect(header.startsWith('attachment; filename="')).toBe(true);
  });

  it('cannot be used to inject a header or escape the quoted name', () => {
    const header = contentDispositionHeader('bad"name\r\nX-Injected: 1\\path.pdf', false);

    expect(header).not.toContain('\r');
    expect(header).not.toContain('\n');
    expect(header).toContain('bad_name__X-Injected: 1_path.pdf');
    expect(header.match(/"/g)).toHaveLength(2);
  });
});
