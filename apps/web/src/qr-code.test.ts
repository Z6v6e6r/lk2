import { describe, expect, it } from 'vitest';

import {
  createQrCode,
  QR_QUIET_ZONE_MODULES,
  qrByteCapacity,
  qrCodePath,
  tryCreateQrCode,
} from './qr-code.js';
import type { QrCode } from './qr-code.js';

const REFERENCE_PAYLOAD = 'https://padelhab.ru/profile/14f15c0a-b6b6-4701-86a6-0c789c81a815';

/**
 * Recorded from an independent encoder (`QRCode.create([{ data, mode: 'byte' }], {
 * errorCorrectionLevel: 'M' })` from the `qrcode` package) for the payload above and confirmed
 * decodable before being frozen here. It pins version, error correction, mask selection and module
 * placement, so any regression in the encoder fails loudly instead of producing a broken symbol.
 */
const REFERENCE_MATRIX = [
  '#######..#...#.#..........#...#######',
  '#.....#......#.#.##.##.###.##.#.....#',
  '#.###.#.#.##.####....###......#.###.#',
  '#.###.#.###########...####.#..#.###.#',
  '#.###.#.##..#.##.#.###.#.#..#.#.###.#',
  '#.....#.#.###..###..##..#..##.#.....#',
  '#######.#.#.#.#.#.#.#.#.#.#.#.#######',
  '........#######.###.####...#.........',
  '#.#####..#.##..##....#...#.#..#####..',
  '#...#..#.#####.#..#.#.#.###.#....#.#.',
  '##.#..###..#.####.##.##..####.#.##.##',
  '#.#.#...#.#.#.##..####..#..#..##.#..#',
  '.....##.#####..#.#.##.#.###..####.###',
  '#.......#####.....##...#..#.#..#...#.',
  '#.....#.....####..#.#.#....#.#.###..#',
  '#..#.#.#.##..#..#......#..##.####..#.',
  '.....##.#...####..#.#######.#.###.###',
  '..####.##.##.#.##....#.......#...#.#.',
  '#.###.#.....##....#.######.#..##...##',
  '..#.#..#.#..#.#.#....###...#.##..#..#',
  '......#......#..###.#..####..##.###..',
  '#.#.....#..##....###.#.#..#.#....#.#.',
  '..#.#########..#.#...#..#..#..####..#',
  '##.##..#..#......########.###.###...#',
  '..#.#.###....####....#..##..###.#.###',
  '####...#....##.#.##.#.#.#.#....#..#..',
  '#.##..##...#.#.##..#..#...#####.#..##',
  '#.###.......####...####...#.#.##.#..#',
  '#.#####.#..###.#.#.#.....#.######.#.#',
  '........##...##.#.###.##.#.##...##.#.',
  '#######.....####..#...#.#...#.#.#.#.#',
  '#.....#.#####.#.#...#...#...#...##.##',
  '#.###.#.#.#...##..#.###..#.######.##.',
  '#.###.#.##.#.#.##....#.####..##.###.#',
  '#.###.#.#...###..##.##...##......#.##',
  '#.....#...#...#.#.#..##.#.#.#.#.##..#',
  '#######.#...#...###.#....###.#..#.###',
];

const FINDER_PATTERN = [
  '#######',
  '#.....#',
  '#.###.#',
  '#.###.#',
  '#.###.#',
  '#.....#',
  '#######',
];

function matrixRows(qr: QrCode): string[] {
  return qr.modules.map((row) => row.map((dark) => (dark ? '#' : '.')).join(''));
}

function cornerRows(qr: QrCode, top: number, left: number): string[] {
  return Array.from({ length: 7 }, (_, row) =>
    Array.from({ length: 7 }, (_, column) =>
      qr.modules[top + row]?.[left + column] ? '#' : '.',
    ).join(''),
  );
}

describe('qr-code', () => {
  it('encodes a profile link exactly like the recorded reference symbol', () => {
    const qr = createQrCode(REFERENCE_PAYLOAD);

    expect(qr.size).toBe(37);
    expect(matrixRows(qr)).toEqual(REFERENCE_MATRIX);
  });

  it('places the finder patterns, timing tracks and fixed dark module', () => {
    const qr = createQrCode('HELLO WORLD');

    expect(qr.modules).toHaveLength(qr.size);
    expect(cornerRows(qr, 0, 0)).toEqual(FINDER_PATTERN);
    expect(cornerRows(qr, 0, qr.size - 7)).toEqual(FINDER_PATTERN);
    expect(cornerRows(qr, qr.size - 7, 0)).toEqual(FINDER_PATTERN);
    expect(qr.modules[qr.size - 8]?.[8]).toBe(true);

    for (let index = 8; index < qr.size - 8; index += 1) {
      expect(qr.modules[6]?.[index]).toBe(index % 2 === 0);
      expect(qr.modules[index]?.[6]).toBe(index % 2 === 0);
    }
  });

  it('selects the smallest version that fits a byte payload', () => {
    expect(qrByteCapacity(1)).toBe(14);
    expect(qrByteCapacity(5)).toBe(84);
    expect(qrByteCapacity(6)).toBe(106);
    expect(qrByteCapacity(10)).toBe(213);

    expect(createQrCode('A'.repeat(62)).size).toBe(33);
    expect(createQrCode('A'.repeat(63)).size).toBe(37);
    expect(createQrCode('A'.repeat(84)).size).toBe(37);
    expect(createQrCode('A'.repeat(85)).size).toBe(41);
    expect(createQrCode('A'.repeat(106)).size).toBe(41);
    expect(createQrCode('A'.repeat(107)).size).toBe(45);
  });

  it('keeps a realistic profile link inside one symbol', () => {
    const qr = createQrCode('https://app.padelhab.ru/profile/6a81e965-c508-4321-812c-4be323606a70');

    expect(qr.size).toBe(37);
  });

  it('rejects a payload beyond the supported versions without throwing from optional UI', () => {
    expect(() => createQrCode('A'.repeat(214))).toThrow(RangeError);
    expect(tryCreateQrCode('A'.repeat(214))).toBeNull();
    expect(tryCreateQrCode('HELLO WORLD')).not.toBeNull();
  });

  it('draws one path segment per dark module behind the quiet zone', () => {
    const qr = createQrCode('HELLO WORLD');
    const path = qrCodePath(qr);
    const darkModules = qr.modules.flat().filter(Boolean).length;
    const coordinates = [...path.matchAll(/M(\d+) (\d+)h1v1h-1z/g)];
    const limit = qr.size + QR_QUIET_ZONE_MODULES;

    expect(path.match(/M/g)).toHaveLength(darkModules);
    expect(coordinates).toHaveLength(darkModules);
    expect(path.startsWith(`M${QR_QUIET_ZONE_MODULES} ${QR_QUIET_ZONE_MODULES}h1v1h-1z`)).toBe(
      true,
    );
    expect(
      coordinates.every(
        ([, column, row]) =>
          Number(column) >= QR_QUIET_ZONE_MODULES &&
          Number(row) >= QR_QUIET_ZONE_MODULES &&
          Number(column) < limit &&
          Number(row) < limit,
      ),
    ).toBe(true);
  });
});
