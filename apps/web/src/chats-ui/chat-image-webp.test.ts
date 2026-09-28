import { describe, expect, it, vi } from 'vitest';

import {
  CHAT_IMAGE_WEBP_MAX_DIMENSION,
  CHAT_IMAGE_WEBP_MAX_PIXELS,
  CHAT_IMAGE_WEBP_QUALITY,
  browserChatImageWebpEncoder,
  chatWebpFileName,
  fitWithinMaxDimension,
  prepareChatPhotoForUpload,
  readRasterImageDimensions,
  type ChatImageWebpEncoder,
} from './chat-image-webp.js';

function pngBytes(width: number, height: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0x00, 0x00, 0x00, 0x0d], 8);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

/** SOI, a JFIF APP0 segment and one SOF0 frame header, which is all the parser reads. */
function jpegBytes(width: number, height: number, padding = 0): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(33 + padding);
  bytes.set(
    [
      0xff,
      0xd8,
      0xff,
      0xe0,
      0x00,
      0x10,
      0x4a,
      0x46,
      0x49,
      0x46,
      0x00,
      0x01,
      0x01,
      0x00,
      0x00,
      0x01,
      0x00,
      0x01,
      0x00,
      0x00,
      0xff,
      0xc0,
      0x00,
      0x11,
      0x08,
      (height >> 8) & 0xff,
      height & 0xff,
      (width >> 8) & 0xff,
      width & 0xff,
      0x03,
      0x01,
      0x11,
      0x00,
    ],
    0,
  );
  return bytes;
}

function encoderReturning(blob: Blob | undefined) {
  const encodeWebp = vi.fn<ChatImageWebpEncoder['encodeWebp']>().mockResolvedValue(blob);
  return { encoder: { encodeWebp } satisfies ChatImageWebpEncoder, encodeWebp };
}

describe('readRasterImageDimensions', () => {
  it('reads the stored size from a PNG header', () => {
    expect(readRasterImageDimensions(pngBytes(2000, 1500), 'image/png')).toEqual({
      width: 2000,
      height: 1500,
    });
  });

  it('walks the JPEG marker chain to the frame header', () => {
    expect(readRasterImageDimensions(jpegBytes(4000, 3000), 'image/jpeg')).toEqual({
      width: 4000,
      height: 3000,
    });
  });

  it.each([
    ['a truncated PNG', pngBytes(10, 10).subarray(0, 18), 'image/png'],
    ['a PNG without an IHDR chunk', new Uint8Array(33), 'image/png'],
    ['a JPEG that starts in entropy data', jpegBytes(10, 10).subarray(0, 2), 'image/jpeg'],
    ['bytes of another format', new Uint8Array([1, 2, 3, 4]), 'image/jpeg'],
    ['a type this contour never converts', pngBytes(10, 10), 'image/webp'],
  ])('reports no dimensions for %s', (_label, bytes, contentType) => {
    expect(readRasterImageDimensions(bytes, contentType)).toBeUndefined();
  });
});

describe('fitWithinMaxDimension', () => {
  it('bounds the longer side and keeps the aspect ratio', () => {
    expect(fitWithinMaxDimension({ width: 4000, height: 3000 }, 1600)).toEqual({
      width: 1600,
      height: 1200,
    });
    expect(fitWithinMaxDimension({ width: 1500, height: 4000 }, 1600)).toEqual({
      width: 600,
      height: 1600,
    });
  });

  it('never enlarges a small picture', () => {
    expect(fitWithinMaxDimension({ width: 640, height: 480 }, 1600)).toEqual({
      width: 640,
      height: 480,
    });
  });

  it('refuses sizes it cannot scale', () => {
    expect(fitWithinMaxDimension({ width: 0, height: 10 }, 1600)).toBeUndefined();
    expect(fitWithinMaxDimension({ width: 10, height: Number.NaN }, 1600)).toBeUndefined();
    expect(fitWithinMaxDimension({ width: 10, height: 10 }, 0)).toBeUndefined();
  });
});

describe('chatWebpFileName', () => {
  it('replaces the extension of the display name', () => {
    expect(chatWebpFileName('IMG_1234.JPG')).toBe('IMG_1234.webp');
    expect(chatWebpFileName('отпуск.png')).toBe('отпуск.webp');
    expect(chatWebpFileName('без-расширения')).toBe('без-расширения.webp');
    expect(chatWebpFileName('  фото.jpeg  ')).toBe('фото.webp');
  });

  it('keeps a usable name when the original carried no basename', () => {
    expect(chatWebpFileName('.jpg')).toBe('фото.webp');
  });
});

describe('prepareChatPhotoForUpload', () => {
  it('sends the smaller WebP re-encode with a matching name and content type', async () => {
    const webp = new Blob([new Uint8Array(128)], { type: 'image/webp' });
    const { encoder, encodeWebp } = encoderReturning(webp);
    const file = new File([jpegBytes(4000, 3000, 4096)], 'IMG_1234.jpg', {
      type: 'image/jpeg',
      lastModified: 1_700_000_000_000,
    });

    const prepared = await prepareChatPhotoForUpload(file, encoder);

    expect(prepared).not.toBe(file);
    expect(prepared.name).toBe('IMG_1234.webp');
    expect(prepared.type).toBe('image/webp');
    expect(prepared.size).toBe(128);
    expect(prepared.lastModified).toBe(1_700_000_000_000);
    expect(encodeWebp).toHaveBeenCalledOnce();
    expect(encodeWebp.mock.calls[0]?.[1]).toEqual({
      maxDimension: CHAT_IMAGE_WEBP_MAX_DIMENSION,
      quality: CHAT_IMAGE_WEBP_QUALITY,
    });
    expect(encodeWebp.mock.calls[0]?.[0]?.contentType).toBe('image/jpeg');
  });

  it('converts a PNG as well', async () => {
    const { encoder, encodeWebp } = encoderReturning(
      new Blob([new Uint8Array(64)], { type: 'image/webp' }),
    );
    const file = new File([pngBytes(2000, 1500), new Uint8Array(4096)], 'скрин.png', {
      type: 'image/png',
    });

    const prepared = await prepareChatPhotoForUpload(file, encoder);

    expect(prepared.name).toBe('скрин.webp');
    expect(prepared.type).toBe('image/webp');
    expect(encodeWebp).toHaveBeenCalledOnce();
  });

  it.each([
    ['the environment cannot encode WebP', undefined],
    [
      'the engine answered with its fallback type',
      new Blob([new Uint8Array(64)], { type: 'image/png' }),
    ],
  ])('keeps the original bytes when %s', async (_label, encoded) => {
    const { encoder } = encoderReturning(encoded);
    const file = new File([jpegBytes(4000, 3000, 4096)], 'IMG_1234.jpg', { type: 'image/jpeg' });

    await expect(prepareChatPhotoForUpload(file, encoder)).resolves.toBe(file);
  });

  it('keeps the original bytes when the re-encode is not smaller', async () => {
    const { encoder } = encoderReturning(new Blob([new Uint8Array(5000)], { type: 'image/webp' }));
    const file = new File([jpegBytes(1000, 800, 1000)], 'small.jpg', { type: 'image/jpeg' });

    await expect(prepareChatPhotoForUpload(file, encoder)).resolves.toBe(file);
  });

  it.each([
    [
      'an image that is already WebP',
      new File([pngBytes(10, 10)], 'photo.webp', { type: 'image/webp' }),
    ],
    ['a document', new File([pngBytes(10, 10)], 'scan.pdf', { type: 'application/pdf' })],
    [
      'an image type the media API refuses',
      new File([pngBytes(10, 10)], 'vector.svg', { type: 'image/svg+xml' }),
    ],
  ])('never touches %s', async (_label, file) => {
    const { encoder, encodeWebp } = encoderReturning(
      new Blob([new Uint8Array(8)], { type: 'image/webp' }),
    );

    await expect(prepareChatPhotoForUpload(file, encoder)).resolves.toBe(file);
    expect(encodeWebp).not.toHaveBeenCalled();
  });

  it('never throws when the encoder fails: the upload keeps the original picture', async () => {
    const encodeWebp = vi
      .fn<ChatImageWebpEncoder['encodeWebp']>()
      .mockRejectedValue(new Error('OOM'));
    const file = new File([jpegBytes(4000, 3000, 4096)], 'IMG_1234.jpg', { type: 'image/jpeg' });

    await expect(prepareChatPhotoForUpload(file, { encodeWebp })).resolves.toBe(file);
  });

  it('never throws on bytes that only pretend to be a picture', async () => {
    const { encoder, encodeWebp } = encoderReturning(
      new Blob([new Uint8Array(8)], { type: 'image/webp' }),
    );
    const file = new File([new Uint8Array([1, 2, 3])], 'photo.jpg', { type: 'image/jpeg' });

    await expect(prepareChatPhotoForUpload(file, encoder)).resolves.toBe(file);
    expect(encodeWebp).not.toHaveBeenCalled();
  });

  it('leaves a picture above the decode budget untouched', async () => {
    const { encoder, encodeWebp } = encoderReturning(
      new Blob([new Uint8Array(64)], { type: 'image/webp' }),
    );
    const side = Math.ceil(Math.sqrt(CHAT_IMAGE_WEBP_MAX_PIXELS)) + 1;
    const file = new File([jpegBytes(side, side, 4096)], 'huge.jpg', { type: 'image/jpeg' });

    await expect(prepareChatPhotoForUpload(file, encoder)).resolves.toBe(file);
    expect(encodeWebp).not.toHaveBeenCalled();
  });

  it('converts four selected photos one after another, never four bitmaps at once', async () => {
    let active = 0;
    let peak = 0;
    const encodeWebp = vi.fn<ChatImageWebpEncoder['encodeWebp']>().mockImplementation(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return new Blob([new Uint8Array(64)], { type: 'image/webp' });
    });
    const photo = (): File =>
      new File([jpegBytes(4000, 3000, 4096)], 'IMG_1234.jpg', { type: 'image/jpeg' });

    const prepared = await Promise.all(
      [0, 1, 2, 3].map(() => prepareChatPhotoForUpload(photo(), { encodeWebp })),
    );

    expect(peak).toBe(1);
    expect(prepared.map((file) => file.name)).toEqual([
      'IMG_1234.webp',
      'IMG_1234.webp',
      'IMG_1234.webp',
      'IMG_1234.webp',
    ]);
  });
});

describe('browserChatImageWebpEncoder', () => {
  it('reports no WebP instead of throwing where no canvas exists', async () => {
    const encoder = browserChatImageWebpEncoder();

    await expect(
      encoder.encodeWebp(
        { bytes: pngBytes(2000, 1500), contentType: 'image/png' },
        { maxDimension: CHAT_IMAGE_WEBP_MAX_DIMENSION, quality: CHAT_IMAGE_WEBP_QUALITY },
      ),
    ).resolves.toBeUndefined();
  });
});
