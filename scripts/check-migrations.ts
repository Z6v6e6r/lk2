import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const migrationsDirectory = resolve(process.cwd(), 'packages/database/migrations');
const files = (await readdir(migrationsDirectory)).filter((file) => file.endsWith('.sql')).sort();
const destructivePatterns: readonly { readonly pattern: RegExp; readonly message: string }[] = [
  { pattern: /\bdrop\s+table\b/i, message: 'DROP TABLE requires a later contract release' },
  { pattern: /\bdrop\s+column\b/i, message: 'DROP COLUMN requires a later contract release' },
  {
    pattern: /\balter\s+column\b[^;]*\btype\b/i,
    message: 'type replacement must use expand/migrate/contract',
  },
  { pattern: /\btruncate\b/i, message: 'TRUNCATE is forbidden in application migrations' },
];

const failures: string[] = [];
for (const file of files) {
  const sql = await readFile(resolve(migrationsDirectory, file), 'utf8');
  for (const rule of destructivePatterns) {
    if (rule.pattern.test(sql)) failures.push(`${file}: ${rule.message}`);
  }
}

if (failures.length > 0) throw new Error(`Unsafe migrations:\n${failures.join('\n')}`);
process.stdout.write(`Checked ${files.length} migration(s): expand-safe baseline\n`);
