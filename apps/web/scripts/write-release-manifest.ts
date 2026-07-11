import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

interface ViteManifestEntry {
  readonly file: string;
  readonly css?: readonly string[];
  readonly isEntry?: boolean;
}

const distDirectory = resolve(import.meta.dirname, '..', 'dist');
const viteManifest = JSON.parse(
  await readFile(resolve(distDirectory, 'vite-manifest.json'), 'utf8'),
) as Record<string, ViteManifestEntry>;
const entry = Object.values(viteManifest).find((candidate) => candidate.isEntry);
if (!entry) throw new Error('Vite entry was not found in manifest');

const baseUrl = (process.env.CDN_BASE_URL ?? '').replace(/\/$/, '');
const toPublicUrl = (file: string): string => `${baseUrl}/${file}`;
const files = [entry.file, ...(entry.css ?? [])];
const integrity = Object.fromEntries(
  await Promise.all(
    files.map(async (file) => {
      const digest = createHash('sha384')
        .update(await readFile(resolve(distDirectory, file)))
        .digest('base64');
      return [toPublicUrl(file), `sha384-${digest}`] as const;
    }),
  ),
);

await writeFile(
  resolve(distDirectory, 'manifest.json'),
  `${JSON.stringify(
    {
      release: process.env.PHUB_RELEASE ?? 'development',
      entry: toPublicUrl(entry.file),
      styles: (entry.css ?? []).map(toPublicUrl),
      integrity,
    },
    null,
    2,
  )}\n`,
);
