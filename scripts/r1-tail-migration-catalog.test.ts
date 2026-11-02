import { describe, expect, it } from 'vitest';
import { R1_TAIL_CATALOG_SQL } from './r1-tail-migration-catalog.js';
import { CLOSED_APPLICATION_CATALOG_SQL } from './closed-application-migration-catalog.js';
import { NOTIFICATION_CATALOG_SQL } from './notification-migration-catalog.js';

describe('catalog SQL composition before the owned PostgreSQL rehearsal', () => {
  it.each([
    ['notification', NOTIFICATION_CATALOG_SQL],
    ['closed application', CLOSED_APPLICATION_CATALOG_SQL],
    ['R1 tail', R1_TAIL_CATALOG_SQL],
  ])('keeps %s CTE and subquery delimiters balanced outside quoted values', (_name, sql) => {
    // Function signature keys and JSON literals contain parentheses as data.
    // This catches composition mistakes locally; actual SQL parsing/execution stays in PG16 CI.
    const structure = sql.replace(/'(?:''|[^'])*'|"(?:""|[^"])*"/g, '');
    let depth = 0;
    let minimum = 0;
    for (const token of structure.match(/[()]/g) ?? []) {
      depth += token === '(' ? 1 : -1;
      minimum = Math.min(minimum, depth);
    }
    expect(minimum).toBe(0);
    expect(depth).toBe(0);
  });
});
