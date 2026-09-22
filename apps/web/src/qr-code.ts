/**
 * Minimal QR Code (Model 2) encoder used by the profile share sheet.
 *
 * The only payload this module ever encodes is one short absolute profile URL, so it implements
 * exactly what that requires: byte mode, error-correction level M and versions 1-10 (up to 213
 * bytes). Keeping the encoder local avoids shipping a new runtime dependency for one screen.
 *
 * The layout follows ISO/IEC 18004: function patterns, Reed-Solomon blocks over GF(256), the four
 * standard penalty rules for mask selection, format information for level M and version
 * information for versions 7-10.
 */

export interface QrCode {
  /** Module count per side, excluding the quiet zone. */
  readonly size: number;
  /** Row-major modules; `true` is a dark module. */
  readonly modules: readonly (readonly boolean[])[];
}

/** Modules of mandatory light margin around the symbol. */
export const QR_QUIET_ZONE_MODULES = 4;

const BYTE_MODE_INDICATOR = 0b0100;
/** Error-correction level M is encoded as `00` in the format information. */
const LEVEL_M_FORMAT_BITS = 0b00;

interface VersionSpec {
  readonly alignmentCenters: readonly number[];
  readonly ecCodewordsPerBlock: number;
  readonly group1Blocks: number;
  readonly group1DataCodewords: number;
  readonly group2Blocks: number;
  readonly group2DataCodewords: number;
}

/** Version index 0 is unused so the table can be addressed by version number. */
const VERSIONS: readonly (VersionSpec | null)[] = [
  null,
  {
    alignmentCenters: [],
    ecCodewordsPerBlock: 10,
    group1Blocks: 1,
    group1DataCodewords: 16,
    group2Blocks: 0,
    group2DataCodewords: 0,
  },
  {
    alignmentCenters: [6, 18],
    ecCodewordsPerBlock: 16,
    group1Blocks: 1,
    group1DataCodewords: 28,
    group2Blocks: 0,
    group2DataCodewords: 0,
  },
  {
    alignmentCenters: [6, 22],
    ecCodewordsPerBlock: 26,
    group1Blocks: 1,
    group1DataCodewords: 44,
    group2Blocks: 0,
    group2DataCodewords: 0,
  },
  {
    alignmentCenters: [6, 26],
    ecCodewordsPerBlock: 18,
    group1Blocks: 2,
    group1DataCodewords: 32,
    group2Blocks: 0,
    group2DataCodewords: 0,
  },
  {
    alignmentCenters: [6, 30],
    ecCodewordsPerBlock: 24,
    group1Blocks: 2,
    group1DataCodewords: 43,
    group2Blocks: 0,
    group2DataCodewords: 0,
  },
  {
    alignmentCenters: [6, 34],
    ecCodewordsPerBlock: 16,
    group1Blocks: 4,
    group1DataCodewords: 27,
    group2Blocks: 0,
    group2DataCodewords: 0,
  },
  {
    alignmentCenters: [6, 22, 38],
    ecCodewordsPerBlock: 18,
    group1Blocks: 4,
    group1DataCodewords: 31,
    group2Blocks: 0,
    group2DataCodewords: 0,
  },
  {
    alignmentCenters: [6, 24, 42],
    ecCodewordsPerBlock: 22,
    group1Blocks: 2,
    group1DataCodewords: 38,
    group2Blocks: 2,
    group2DataCodewords: 39,
  },
  {
    alignmentCenters: [6, 26, 46],
    ecCodewordsPerBlock: 22,
    group1Blocks: 3,
    group1DataCodewords: 36,
    group2Blocks: 2,
    group2DataCodewords: 37,
  },
  {
    alignmentCenters: [6, 28, 50],
    ecCodewordsPerBlock: 26,
    group1Blocks: 4,
    group1DataCodewords: 43,
    group2Blocks: 1,
    group2DataCodewords: 44,
  },
];

/** 18-bit version patterns; versions below 7 carry no version information. */
const VERSION_PATTERNS: Readonly<Record<number, number>> = {
  7: 0x07c94,
  8: 0x085bc,
  9: 0x09a99,
  10: 0x0a4d3,
};

/** Highest version this encoder supports. */
export const QR_MAX_VERSION = 10;

const gfExponent = new Uint8Array(512);
const gfLogarithm = new Uint8Array(256);
{
  let value = 1;
  for (let index = 0; index < 255; index += 1) {
    gfExponent[index] = value;
    gfLogarithm[value] = index;
    value <<= 1;
    if ((value & 0x100) !== 0) value ^= 0x11d;
  }
  for (let index = 255; index < 512; index += 1) {
    gfExponent[index] = gfExponent[index - 255] ?? 0;
  }
}

function gfMultiply(left: number, right: number): number {
  if (left === 0 || right === 0) return 0;
  return gfExponent[(gfLogarithm[left] ?? 0) + (gfLogarithm[right] ?? 0)] ?? 0;
}

function versionSpec(version: number): VersionSpec {
  const spec = VERSIONS[version];
  if (!spec) throw new RangeError(`QR version ${version} is not supported`);
  return spec;
}

function dataCodewordCount(spec: VersionSpec): number {
  return (
    spec.group1Blocks * spec.group1DataCodewords + spec.group2Blocks * spec.group2DataCodewords
  );
}

function byteModeCountBits(version: number): number {
  return version <= 9 ? 8 : 16;
}

/** Largest payload this encoder can carry at error-correction level M. */
export function qrByteCapacity(version: number): number {
  const spec = versionSpec(version);
  return Math.floor((dataCodewordCount(spec) * 8 - 4 - byteModeCountBits(version)) / 8);
}

function selectVersion(byteLength: number): number {
  for (let version = 1; version <= QR_MAX_VERSION; version += 1) {
    if (byteLength <= qrByteCapacity(version)) return version;
  }
  throw new RangeError(
    `Payload of ${byteLength} bytes exceeds QR version ${QR_MAX_VERSION} level M capacity`,
  );
}

function pushBits(bits: number[], value: number, length: number): void {
  for (let shift = length - 1; shift >= 0; shift -= 1) {
    bits.push((value >> shift) & 1);
  }
}

function buildDataCodewords(
  bytes: readonly number[],
  version: number,
  spec: VersionSpec,
): number[] {
  const capacityBits = dataCodewordCount(spec) * 8;
  const bits: number[] = [];
  pushBits(bits, BYTE_MODE_INDICATOR, 4);
  pushBits(bits, bytes.length, byteModeCountBits(version));
  for (const byte of bytes) pushBits(bits, byte, 8);
  pushBits(bits, 0, Math.min(4, capacityBits - bits.length));
  while (bits.length % 8 !== 0) bits.push(0);
  const padCodewords = [0xec, 0x11];
  for (let padIndex = 0; bits.length < capacityBits; padIndex += 1) {
    pushBits(bits, padCodewords[padIndex % 2] ?? 0xec, 8);
  }

  const codewords: number[] = [];
  for (let offset = 0; offset < bits.length; offset += 8) {
    let value = 0;
    for (let index = 0; index < 8; index += 1) {
      value = (value << 1) | (bits[offset + index] ?? 0);
    }
    codewords.push(value);
  }
  return codewords;
}

function reedSolomonGenerator(degree: number): Uint8Array {
  let polynomial = new Uint8Array([1]);
  for (let index = 0; index < degree; index += 1) {
    const next = new Uint8Array(polynomial.length + 1);
    for (let coefficient = 0; coefficient < polynomial.length; coefficient += 1) {
      const current = polynomial[coefficient] ?? 0;
      next[coefficient] = (next[coefficient] ?? 0) ^ current;
      next[coefficient + 1] =
        (next[coefficient + 1] ?? 0) ^ gfMultiply(current, gfExponent[index] ?? 0);
    }
    polynomial = next;
  }
  return polynomial;
}

function reedSolomonRemainder(data: readonly number[], generator: Uint8Array): Uint8Array {
  const degree = generator.length - 1;
  const remainder = new Uint8Array(degree);
  for (const codeword of data) {
    const factor = codeword ^ (remainder[0] ?? 0);
    remainder.copyWithin(0, 1);
    remainder[degree - 1] = 0;
    for (let index = 0; index < degree; index += 1) {
      remainder[index] = (remainder[index] ?? 0) ^ gfMultiply(generator[index + 1] ?? 0, factor);
    }
  }
  return remainder;
}

function buildCodewords(bytes: readonly number[], version: number, spec: VersionSpec): number[] {
  const dataCodewords = buildDataCodewords(bytes, version, spec);
  const generator = reedSolomonGenerator(spec.ecCodewordsPerBlock);
  const blocks: { readonly data: number[]; readonly ec: number[] }[] = [];
  let offset = 0;
  for (let block = 0; block < spec.group1Blocks; block += 1) {
    const data = dataCodewords.slice(offset, offset + spec.group1DataCodewords);
    offset += spec.group1DataCodewords;
    blocks.push({ data, ec: Array.from(reedSolomonRemainder(data, generator)) });
  }
  for (let block = 0; block < spec.group2Blocks; block += 1) {
    const data = dataCodewords.slice(offset, offset + spec.group2DataCodewords);
    offset += spec.group2DataCodewords;
    blocks.push({ data, ec: Array.from(reedSolomonRemainder(data, generator)) });
  }

  const codewords: number[] = [];
  const longestDataBlock = Math.max(...blocks.map((block) => block.data.length));
  for (let index = 0; index < longestDataBlock; index += 1) {
    for (const block of blocks) {
      const value = block.data[index];
      if (value !== undefined) codewords.push(value);
    }
  }
  for (let index = 0; index < spec.ecCodewordsPerBlock; index += 1) {
    for (const block of blocks) {
      codewords.push(block.ec[index] ?? 0);
    }
  }
  return codewords;
}

function formatInformation(mask: number): number {
  const data = (LEVEL_M_FORMAT_BITS << 3) | mask;
  let remainder = data << 10;
  for (let bit = 14; bit >= 10; bit -= 1) {
    if (((remainder >> bit) & 1) !== 0) remainder ^= 0x537 << (bit - 10);
  }
  return ((data << 10) | remainder) ^ 0x5412;
}

function maskCondition(mask: number, row: number, column: number): boolean {
  switch (mask) {
    case 0:
      return (row + column) % 2 === 0;
    case 1:
      return row % 2 === 0;
    case 2:
      return column % 3 === 0;
    case 3:
      return (row + column) % 3 === 0;
    case 4:
      return (Math.floor(row / 2) + Math.floor(column / 3)) % 2 === 0;
    case 5:
      return ((row * column) % 2) + ((row * column) % 3) === 0;
    case 6:
      return (((row * column) % 2) + ((row * column) % 3)) % 2 === 0;
    default:
      return (((row + column) % 2) + ((row * column) % 3)) % 2 === 0;
  }
}

function placeFinder(
  modules: boolean[][],
  reserved: boolean[][],
  top: number,
  left: number,
  size: number,
): void {
  for (let rowOffset = -1; rowOffset <= 7; rowOffset += 1) {
    for (let columnOffset = -1; columnOffset <= 7; columnOffset += 1) {
      const row = top + rowOffset;
      const column = left + columnOffset;
      if (row < 0 || column < 0 || row >= size || column >= size) continue;
      reserved[row]![column] = true;
      const inCore = rowOffset >= 0 && rowOffset <= 6 && columnOffset >= 0 && columnOffset <= 6;
      const onRing =
        inCore && (rowOffset === 0 || rowOffset === 6 || columnOffset === 0 || columnOffset === 6);
      const inCenter =
        inCore && rowOffset >= 2 && rowOffset <= 4 && columnOffset >= 2 && columnOffset <= 4;
      modules[row]![column] = onRing || inCenter;
    }
  }
}

function placeFunctionPatterns(
  version: number,
  size: number,
  modules: boolean[][],
  reserved: boolean[][],
): void {
  placeFinder(modules, reserved, 0, 0, size);
  placeFinder(modules, reserved, 0, size - 7, size);
  placeFinder(modules, reserved, size - 7, 0, size);

  for (let index = 8; index < size - 8; index += 1) {
    const dark = index % 2 === 0;
    modules[6]![index] = dark;
    reserved[6]![index] = true;
    modules[index]![6] = dark;
    reserved[index]![6] = true;
  }

  const centers = versionSpec(version).alignmentCenters;
  const last = centers[centers.length - 1];
  for (const row of centers) {
    for (const column of centers) {
      const overlapsFinder =
        (row === 6 && column === 6) ||
        (row === 6 && column === last) ||
        (row === last && column === 6);
      if (overlapsFinder) continue;
      for (let rowOffset = -2; rowOffset <= 2; rowOffset += 1) {
        for (let columnOffset = -2; columnOffset <= 2; columnOffset += 1) {
          const targetRow = row + rowOffset;
          const targetColumn = column + columnOffset;
          modules[targetRow]![targetColumn] =
            Math.max(Math.abs(rowOffset), Math.abs(columnOffset)) !== 1;
          reserved[targetRow]![targetColumn] = true;
        }
      }
    }
  }

  // Dark module and the reserved format information areas.
  modules[size - 8]![8] = true;
  reserved[size - 8]![8] = true;
  for (let index = 0; index <= 8; index += 1) {
    if (index !== 6) {
      reserved[8]![index] = true;
      reserved[index]![8] = true;
    }
  }
  for (let index = 0; index < 8; index += 1) {
    reserved[8]![size - 1 - index] = true;
    reserved[size - 1 - index]![8] = true;
  }

  const versionPattern = VERSION_PATTERNS[version];
  if (versionPattern !== undefined) {
    for (let index = 0; index < 18; index += 1) {
      const dark = ((versionPattern >> index) & 1) === 1;
      const row = Math.floor(index / 3);
      const column = size - 11 + (index % 3);
      modules[row]![column] = dark;
      reserved[row]![column] = true;
      modules[column]![row] = dark;
      reserved[column]![row] = true;
    }
  }
}

function placeFormatInformation(modules: boolean[][], size: number, mask: number): void {
  const format = formatInformation(mask);
  for (let index = 0; index < 15; index += 1) {
    const dark = ((format >> (14 - index)) & 1) === 1;
    if (index < 6) {
      modules[8]![index] = dark;
    } else if (index === 6) {
      modules[8]![7] = dark;
    } else if (index === 7) {
      modules[8]![8] = dark;
    } else if (index === 8) {
      modules[7]![8] = dark;
    } else {
      modules[14 - index]![8] = dark;
    }

    // The second copy carries seven bits up column 8 and eight bits along row 8; the module at
    // (size - 8, 8) is the fixed dark module and is never part of the format information.
    if (index < 7) {
      modules[size - 1 - index]![8] = dark;
    } else {
      modules[8]![size - 15 + index] = dark;
    }
  }
}

function placeData(
  modules: boolean[][],
  reserved: boolean[][],
  size: number,
  codewords: readonly number[],
  version: number,
): void {
  const remainderBits = version >= 2 && version <= 6 ? 7 : 0;
  const totalBits = codewords.length * 8 + remainderBits;
  let bitIndex = 0;
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let step = 0; step < size; step += 1) {
      const row = upward ? size - 1 - step : step;
      for (const column of [right, right - 1]) {
        if (reserved[row]![column] === true) continue;
        const codeword = codewords[Math.floor(bitIndex / 8)];
        const dark =
          bitIndex < totalBits && codeword !== undefined
            ? ((codeword >> (7 - (bitIndex % 8))) & 1) === 1
            : false;
        modules[row]![column] = dark;
        bitIndex += 1;
      }
    }
    upward = !upward;
  }
}

function applyMask(modules: boolean[][], reserved: boolean[][], size: number, mask: number): void {
  for (let row = 0; row < size; row += 1) {
    for (let column = 0; column < size; column += 1) {
      if (reserved[row]![column] === true) continue;
      if (maskCondition(mask, row, column)) {
        modules[row]![column] = !modules[row]![column];
      }
    }
  }
}

function isDark(modules: readonly (readonly boolean[])[], row: number, column: number): boolean {
  return modules[row]?.[column] === true;
}

function runLengthPenalty(modules: readonly (readonly boolean[])[], size: number): number {
  let penalty = 0;
  for (let index = 0; index < size; index += 1) {
    for (const horizontal of [true, false]) {
      let runColor = horizontal ? isDark(modules, index, 0) : isDark(modules, 0, index);
      let runLength = 1;
      for (let step = 1; step < size; step += 1) {
        const color = horizontal ? isDark(modules, index, step) : isDark(modules, step, index);
        if (color === runColor) {
          runLength += 1;
          if (runLength === 5) penalty += 3;
          else if (runLength > 5) penalty += 1;
        } else {
          runColor = color;
          runLength = 1;
        }
      }
    }
  }
  return penalty;
}

function blockPenalty(modules: readonly (readonly boolean[])[], size: number): number {
  let penalty = 0;
  for (let row = 0; row < size - 1; row += 1) {
    for (let column = 0; column < size - 1; column += 1) {
      const color = isDark(modules, row, column);
      if (
        color === isDark(modules, row, column + 1) &&
        color === isDark(modules, row + 1, column) &&
        color === isDark(modules, row + 1, column + 1)
      ) {
        penalty += 3;
      }
    }
  }
  return penalty;
}

const FINDER_LIKE_PATTERNS: readonly (readonly boolean[])[] = [
  [true, false, true, true, true, false, true, false, false, false, false],
  [false, false, false, false, true, false, true, true, true, false, true],
];

function finderLikePenalty(modules: readonly (readonly boolean[])[], size: number): number {
  let penalty = 0;
  for (let index = 0; index < size; index += 1) {
    for (const horizontal of [true, false]) {
      for (let start = 0; start + 11 <= size; start += 1) {
        for (const pattern of FINDER_LIKE_PATTERNS) {
          let matches = true;
          for (let offset = 0; offset < pattern.length; offset += 1) {
            const color = horizontal
              ? isDark(modules, index, start + offset)
              : isDark(modules, start + offset, index);
            if (color !== (pattern[offset] ?? false)) {
              matches = false;
              break;
            }
          }
          if (matches) penalty += 40;
        }
      }
    }
  }
  return penalty;
}

function balancePenalty(modules: readonly (readonly boolean[])[], size: number): number {
  let darkCount = 0;
  for (let row = 0; row < size; row += 1) {
    for (let column = 0; column < size; column += 1) {
      if (isDark(modules, row, column)) darkCount += 1;
    }
  }
  const percentage = (darkCount * 100) / (size * size);
  return Math.floor(Math.abs(percentage - 50) / 5) * 10;
}

function penaltyScore(modules: readonly (readonly boolean[])[], size: number): number {
  return (
    runLengthPenalty(modules, size) +
    blockPenalty(modules, size) +
    finderLikePenalty(modules, size) +
    balancePenalty(modules, size)
  );
}

function buildCandidate(version: number, codewords: readonly number[], mask: number): boolean[][] {
  const size = version * 4 + 17;
  const modules: boolean[][] = Array.from({ length: size }, () =>
    Array.from({ length: size }, () => false),
  );
  const reserved: boolean[][] = Array.from({ length: size }, () =>
    Array.from({ length: size }, () => false),
  );
  placeFunctionPatterns(version, size, modules, reserved);
  placeData(modules, reserved, size, codewords, version);
  applyMask(modules, reserved, size, mask);
  placeFormatInformation(modules, size, mask);
  return modules;
}

/**
 * Encodes `text` as a QR symbol at error-correction level M.
 *
 * Throws `RangeError` when the payload does not fit version 10 (213 bytes), which no profile link
 * reaches; callers that render optional UI should use {@link tryCreateQrCode} instead.
 */
export function createQrCode(text: string): QrCode {
  const bytes = Array.from(new TextEncoder().encode(text));
  const version = selectVersion(bytes.length);
  const codewords = buildCodewords(bytes, version, versionSpec(version));

  let bestModules = buildCandidate(version, codewords, 0);
  let bestPenalty = penaltyScore(bestModules, bestModules.length);
  for (let mask = 1; mask < 8; mask += 1) {
    const candidate = buildCandidate(version, codewords, mask);
    const penalty = penaltyScore(candidate, candidate.length);
    if (penalty < bestPenalty) {
      bestModules = candidate;
      bestPenalty = penalty;
    }
  }

  return { size: bestModules.length, modules: bestModules };
}

/** {@link createQrCode} for optional UI: returns `null` instead of throwing. */
export function tryCreateQrCode(text: string): QrCode | null {
  try {
    return createQrCode(text);
  } catch {
    return null;
  }
}

/** SVG `path` data for one dark module per unit square, including the quiet zone. */
export function qrCodePath(qr: QrCode): string {
  const offset = QR_QUIET_ZONE_MODULES;
  const segments: string[] = [];
  for (let row = 0; row < qr.size; row += 1) {
    for (let column = 0; column < qr.size; column += 1) {
      if (qr.modules[row]?.[column] === true) {
        segments.push(`M${column + offset} ${row + offset}h1v1h-1z`);
      }
    }
  }
  return segments.join('');
}
