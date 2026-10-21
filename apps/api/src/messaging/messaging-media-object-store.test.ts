import { describe, expect, it, vi } from 'vitest';

import { contentDispositionHeader, readBoundedObjectBody } from './messaging-media-object-store.js';

function body(chunks: readonly number[]): AsyncIterable<Uint8Array> & {
  readonly destroy: ReturnType<typeof vi.fn<(error?: Error) => void>>;
} {
  const destroy = vi.fn<(error?: Error) => void>();
  return {
    destroy,
    async *[Symbol.asyncIterator]() {
      for (const size of chunks) {
        await Promise.resolve();
        yield new Uint8Array(size);
      }
    },
  };
}

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

describe('chat media bounded object reads', () => {
  it('requires a valid declared size and reads exactly that many bytes', async () => {
    const stream = body([2, 3]);
    await expect(readBoundedObjectBody(stream, undefined, 5)).rejects.toThrow(
      'MESSAGING_MEDIA_OBJECT_SIZE_INVALID',
    );
    await expect(readBoundedObjectBody(stream, 6, 5)).rejects.toThrow(
      'MESSAGING_MEDIA_OBJECT_SIZE_INVALID',
    );
    await expect(readBoundedObjectBody(body([2, 3]), 5, 5)).resolves.toHaveLength(5);
  });

  it('stops a stream that exceeds the byte cap even when the source lies about its size', async () => {
    const stream = body([3, 3]);
    await expect(readBoundedObjectBody(stream, 5, 5)).rejects.toThrow(
      'MESSAGING_MEDIA_OBJECT_TOO_LARGE',
    );
    expect(stream.destroy).toHaveBeenCalledOnce();
  });
});
