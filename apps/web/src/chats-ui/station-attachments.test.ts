// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';

import {
  MAX_STATION_ATTACHMENTS,
  MAX_STATION_ATTACHMENT_BYTES,
  describeStationAttachmentRejections,
  readFileAsBase64,
  validateStationAttachmentSelection,
} from './chat-attachments.js';

function makeFile(name: string, type: string, size: number): File {
  const file = new File([new Uint8Array(Math.min(Math.max(size, 1), 8))], name, { type });
  if (file.size !== size) Object.defineProperty(file, 'size', { value: size });
  return file;
}

describe('station attachment selection', () => {
  it('accepts pictures only, up to four, and explains every refusal in Russian', () => {
    const files = [
      makeFile('корт.png', 'image/png', 1024),
      makeFile('мяч.webp', 'image/webp', 2048),
      makeFile('план.pdf', 'application/pdf', 1024),
      makeFile('огромное.jpg', 'image/jpeg', MAX_STATION_ATTACHMENT_BYTES + 1),
      makeFile('пустое.png', 'image/png', 0),
      makeFile('третье.png', 'image/png', 10),
      makeFile('четвёртое.png', 'image/png', 10),
      makeFile('пятое.png', 'image/png', 10),
    ];

    const selection = validateStationAttachmentSelection(0, files);

    expect(selection.accepted.map((file) => file.name)).toEqual([
      'корт.png',
      'мяч.webp',
      'третье.png',
      'четвёртое.png',
    ]);
    expect(selection.rejections).toEqual([
      { fileName: 'план.pdf', reason: 'NOT_IMAGE' },
      { fileName: 'огромное.jpg', reason: 'SIZE' },
      { fileName: 'пустое.png', reason: 'EMPTY' },
      { fileName: 'пятое.png', reason: 'COUNT' },
    ]);
    const notice = describeStationAttachmentRejections(selection.rejections);
    expect(notice).toContain('не более 4 фотографий');
    expect(notice).toContain('«план.pdf»: можно приложить только фотографию.');
    expect(notice).toContain('«огромное.jpg»: фото больше 8 МБ.');
  });

  it('counts the drafts that are already attached', () => {
    const files = Array.from({ length: MAX_STATION_ATTACHMENTS }, (_, index) =>
      makeFile(`фото-${index}.png`, 'image/png', 512),
    );

    expect(
      validateStationAttachmentSelection(MAX_STATION_ATTACHMENTS, files).accepted,
    ).toHaveLength(0);
    expect(describeStationAttachmentRejections([])).toBeNull();
  });

  it('encodes the picked file as the base64 the upload command carries', async () => {
    const file = new File([new Uint8Array([0, 1, 2, 250])], 'корт.png', { type: 'image/png' });

    expect(await readFileAsBase64(file)).toBe(Buffer.from([0, 1, 2, 250]).toString('base64'));
  });
});
