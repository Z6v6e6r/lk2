import { readFile } from 'node:fs/promises';

import * as fontkit from 'fontkit';
import PDFDocument from 'pdfkit';

const REGULAR_FONT_URL = new URL(
  '../../web/src/assets/home/InterDisplay-Regular.woff2',
  import.meta.url,
);
const DISPLAY_FONT_URL = new URL(
  '../../web/src/assets/home/rf-dewi-ultrabold.woff2',
  import.meta.url,
);

interface OutlineFont {
  readonly unitsPerEm: number;
  layout(text: string): {
    readonly glyphs: readonly { readonly path: { toSVG(): string } }[];
    readonly positions: readonly {
      readonly xAdvance: number;
      readonly yAdvance: number;
      readonly xOffset: number;
      readonly yOffset: number;
    }[];
  };
}

let fontsPromise:
  Promise<{ readonly regular: OutlineFont; readonly display: OutlineFont }> | undefined;

function fonts(): Promise<{ readonly regular: OutlineFont; readonly display: OutlineFont }> {
  fontsPromise ??= Promise.all([readFile(REGULAR_FONT_URL), readFile(DISPLAY_FONT_URL)]).then(
    ([regular, display]) => ({
      regular: fontkit.create(regular) as OutlineFont,
      display: fontkit.create(display) as OutlineFont,
    }),
  );
  return fontsPromise;
}

function rubles(amountMinor: number): string {
  return new Intl.NumberFormat('ru-RU', {
    style: 'currency',
    currency: 'RUB',
    maximumFractionDigits: 0,
  }).format(amountMinor / 100);
}

function textWidth(font: OutlineFont, text: string, size: number): number {
  const layout = font.layout(text);
  return (
    layout.positions.reduce((width, position) => width + position.xAdvance, 0) *
    (size / font.unitsPerEm)
  );
}

function wrap(font: OutlineFont, value: string, size: number, maxWidth: number): string[] {
  const output: string[] = [];
  for (const paragraph of value.split('\n')) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    let line = '';
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (line && textWidth(font, candidate, size) > maxWidth) {
        output.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    output.push(line);
  }
  return output;
}

function drawLine(input: {
  readonly document: PDFKit.PDFDocument;
  readonly font: OutlineFont;
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly size: number;
  readonly color: string;
  readonly width?: number;
  readonly align?: 'left' | 'center' | 'right';
}): void {
  const layout = input.font.layout(input.text);
  const scale = input.size / input.font.unitsPerEm;
  const width = textWidth(input.font, input.text, input.size);
  const offset =
    input.align === 'center' && input.width
      ? (input.width - width) / 2
      : input.align === 'right' && input.width
        ? input.width - width
        : 0;
  let cursor = input.x + offset;
  input.document.fillColor(input.color);
  for (let index = 0; index < layout.glyphs.length; index += 1) {
    const glyph = layout.glyphs[index];
    const position = layout.positions[index];
    if (!glyph || !position) continue;
    input.document
      .save()
      .translate(cursor + position.xOffset * scale, input.y - position.yOffset * scale)
      .scale(scale, -scale)
      .path(glyph.path.toSVG())
      .fill(input.color)
      .restore();
    cursor += position.xAdvance * scale;
  }
}

function drawText(input: {
  readonly document: PDFKit.PDFDocument;
  readonly font: OutlineFont;
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly size: number;
  readonly color: string;
  readonly width: number;
  readonly align?: 'left' | 'center' | 'right';
  readonly lineHeight?: number;
  readonly maxLines?: number;
}): void {
  const lines = wrap(input.font, input.text, input.size, input.width);
  const maxLines = input.maxLines ?? lines.length;
  const lineHeight = input.lineHeight ?? input.size * 1.25;
  lines.slice(0, maxLines).forEach((line, index) => {
    drawLine({
      document: input.document,
      font: input.font,
      text:
        index === maxLines - 1 && lines.length > maxLines
          ? `${line.replace(/[.,;:!?]?$/, '')}…`
          : line,
      x: input.x,
      y: input.y + input.size + index * lineHeight,
      size: input.size,
      color: input.color,
      width: input.width,
      ...(input.align ? { align: input.align } : {}),
    });
  });
}

export interface GiftCertificatePdfInput {
  readonly certificateNumber: string;
  readonly activationCode: string;
  readonly recipientName: string;
  readonly recipientMessage: string | null;
  readonly designTitle: string;
  readonly amountMinor: number;
  readonly codeXPercent: number;
  readonly codeYPercent: number;
  readonly amountXPercent: number;
  readonly amountYPercent: number;
  readonly validityStart: 'ISSUE' | 'ACTIVATION';
  readonly validityDays: number;
  readonly activationDeadlineDays: number | null;
  readonly designImagePng?: Buffer;
}

export async function renderGiftCertificatePdf(input: GiftCertificatePdfInput): Promise<Buffer> {
  const loadedFonts = await fonts();
  return new Promise<Buffer>((resolve, reject) => {
    const document = new PDFDocument({
      size: [842, 542],
      margin: 0,
      info: {
        Title: `Подарочный сертификат ${input.certificateNumber}`,
        Author: 'PadlHub',
        Subject: 'Подарочный сертификат PadlHub',
        Creator: 'PadlHub certificate issuer',
        CreationDate: new Date(0),
        ModDate: new Date(0),
      },
    });
    const chunks: Buffer[] = [];
    document.on('data', (chunk: Buffer) => chunks.push(chunk));
    document.on('error', reject);
    document.on('end', () => resolve(Buffer.concat(chunks)));

    const pageWidth = 842;
    const pageHeight = 542;
    document.rect(0, 0, pageWidth, pageHeight).fill('#b9bfd2');
    if (input.designImagePng) {
      document.image(input.designImagePng, 0, 0, {
        width: pageWidth,
        height: pageHeight,
        cover: [pageWidth, pageHeight],
        align: 'center',
        valign: 'center',
      });
    }

    // The uploaded artwork is the complete first page. Only the certificate code and
    // the server-priced denomination are overlaid in the reserved bottom zones.
    drawText({
      document,
      font: loadedFonts.regular,
      text: input.activationCode,
      x: (input.codeXPercent / 100) * pageWidth,
      y: (input.codeYPercent / 100) * pageHeight,
      size: 17,
      color: '#ffffff',
      width: 390,
      maxLines: 1,
    });
    drawText({
      document,
      font: loadedFonts.display,
      text: rubles(input.amountMinor),
      x: (input.amountXPercent / 100) * pageWidth,
      y: (input.amountYPercent / 100) * pageHeight,
      size: 18,
      color: '#ffffff',
      width: 148,
      align: 'center',
      maxLines: 1,
    });

    document.end();
  });
}
