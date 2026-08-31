import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

type Classification = 'CRITICAL' | 'IMPORTANT' | 'EDGE';

const matrixPath = resolve(
  process.cwd(),
  'docs/audits/game-lifecycle-2026-08-28/process-matrix.csv',
);

function range(prefix: string, start: number, end: number): string[] {
  return Array.from(
    { length: end - start + 1 },
    (_, index) => `${prefix}-${String(start + index).padStart(3, '0')}`,
  );
}

export const CRITICAL_GAME_SCENARIOS = new Set([
  // Canonical readback and permission boundaries used after every write.
  'A-004',
  'A-005',
  'A-008',
  'A-010',
  'A-013',
  'A-014',
  // Free create, invalid/dependency failures, replay and projection/readback.
  'B-001',
  ...range('B', 11, 15),
  ...range('B', 17, 21),
  'B-023',
  // Free join, missing/terminal/full guards, replay and operation/readback.
  'E-001',
  'E-002',
  'E-003',
  'E-006',
  'E-007',
  'E-008',
  'E-010',
  'E-013',
  'E-033',
  'E-035',
  'E-036',
  'E-037',
  'E-040',
  // Free leave, owner policy, repeated leave and durable history.
  ...range('G', 1, 7),
  'G-022',
  // Free cancel, actor policy, after-start/terminal guards and canonical effects.
  'H-001',
  'H-003',
  'H-004',
  'H-005',
  'H-007',
  'H-023',
  'H-024',
  'H-025',
  'H-029',
  // Retry, rollback/crash, last-slot concurrency and tenant/actor isolation.
  ...range('K', 1, 8),
  'K-022',
  'K-023',
]);

export const IMPORTANT_GAME_SCENARIOS = new Set([
  // Paid reservation expiry stays blocked until generation/payment fencing exists.
  'E-027',
  'E-028',
  // Free waitlist, promotion and notification trigger subset.
  ...range('F', 1, 19),
  'G-029',
  'H-022',
  'H-021',
  'H-026',
  // Outbox/process recovery, expiry and promotion recovery.
  ...range('K', 9, 14),
]);

function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (quoted) {
      if (character === '"' && input[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
      continue;
    }
    if (character === '"') {
      quoted = true;
    } else if (character === ',') {
      row.push(field);
      field = '';
    } else if (character === '\n') {
      row.push(field.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += character;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field.replace(/\r$/, ''));
    rows.push(row);
  }
  if (quoted) throw new Error('GAME_LIFECYCLE_MATRIX_UNTERMINATED_QUOTE');
  return rows;
}

export function classifyGameScenario(scenarioId: string): Classification {
  if (CRITICAL_GAME_SCENARIOS.has(scenarioId)) return 'CRITICAL';
  if (IMPORTANT_GAME_SCENARIOS.has(scenarioId)) return 'IMPORTANT';
  return 'EDGE';
}

describe('Game Lifecycle Atlas critical classification', () => {
  it('classifies every one of the 344 canonical scenarios exactly once', () => {
    const [header, ...rows] = parseCsv(readFileSync(matrixPath, 'utf8'));
    if (!header) throw new Error('GAME_LIFECYCLE_MATRIX_HEADER_MISSING');
    expect(header).toHaveLength(101);
    expect(rows).toHaveLength(344);
    expect(rows.every((row) => row.length === header.length)).toBe(true);

    const scenarioIds = rows.map((row) => row[0]);
    expect(new Set(scenarioIds).size).toBe(344);
    expect([...CRITICAL_GAME_SCENARIOS].every((id) => scenarioIds.includes(id))).toBe(true);
    expect([...IMPORTANT_GAME_SCENARIOS].every((id) => scenarioIds.includes(id))).toBe(true);
    expect([...CRITICAL_GAME_SCENARIOS].filter((id) => IMPORTANT_GAME_SCENARIOS.has(id))).toEqual(
      [],
    );

    const counts = rows.reduce<Record<Classification, number>>(
      (current, row) => {
        current[classifyGameScenario(row[0] ?? '')] += 1;
        return current;
      },
      { CRITICAL: 0, IMPORTANT: 0, EDGE: 0 },
    );
    expect(counts).toEqual({ CRITICAL: 58, IMPORTANT: 31, EDGE: 255 });
  });

  it('keeps the mandatory core, retry, permission and Important subsets explicit', () => {
    expect(
      [
        'B-001',
        'B-011',
        'B-017',
        'B-021',
        'B-023',
        'E-001',
        'E-002',
        'E-003',
        'E-006',
        'E-008',
        'E-010',
        'E-013',
        'E-035',
        'E-036',
        'G-001',
        'G-004',
        'G-005',
        'G-022',
        'H-001',
        'H-003',
        'H-004',
        'H-023',
        'K-001',
        'K-006',
        'K-022',
        'K-023',
      ].map(classifyGameScenario),
    ).toEqual(Array.from({ length: 26 }, () => 'CRITICAL'));
    expect(
      ['E-027', 'E-028', 'F-001', 'F-011', 'F-017', 'F-019', 'K-013', 'K-014'].map(
        classifyGameScenario,
      ),
    ).toEqual(Array.from({ length: 8 }, () => 'IMPORTANT'));
  });
});
