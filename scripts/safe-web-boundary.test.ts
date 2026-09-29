import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const boundary = fileURLToPath(new URL('./safe-web-boundary.js', import.meta.url));
const SPAWN_TIMEOUT_MS = 60_000;

type SourceCase = readonly [path: string, before: string, after: string];

/**
 * One subprocess for many cases: parsing the application shell with TypeScript is not cheap, and a
 * process per assertion is what made this suite exceed the default test timeout on a loaded runner.
 */
function verifyMany(cases: readonly SourceCase[]): boolean[] {
  const program = `
    import { verifySafeWebSources } from ${JSON.stringify(boundary)};
    import { readFileSync } from 'node:fs';
    const cases = JSON.parse(readFileSync(0, 'utf8'));
    process.stdout.write(JSON.stringify(cases.map((args) => verifySafeWebSources(...args))));`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', program], {
    input: JSON.stringify(cases),
    encoding: 'utf8',
    timeout: SPAWN_TIMEOUT_MS,
  });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as boolean[];
}

function verify(path: string, before: string, after: string): boolean {
  return verifyMany([[path, before, after]])[0] as boolean;
}

function verifyRangeMany(
  cases: ReadonlyArray<readonly [readonly string[], string, string]>,
  cwd?: string,
): boolean[] {
  const program = `
    import { verifySafeWebRange } from ${JSON.stringify(boundary)};
    import { readFileSync } from 'node:fs';
    const cases = JSON.parse(readFileSync(0, 'utf8'));
    process.stdout.write(JSON.stringify(cases.map((args) => verifySafeWebRange(...args))));`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', program], {
    input: JSON.stringify(cases),
    encoding: 'utf8',
    timeout: SPAWN_TIMEOUT_MS,
    ...(cwd ? { cwd } : {}),
  });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as boolean[];
}

const modulePath = 'apps/web/src/chats-ui/chat-image-webp.ts';
const moduleTestPath = 'apps/web/src/chats-ui/chat-image-webp.test.ts';
const appPath = 'apps/web/src/App.tsx';
const moduleSource = readFileSync(modulePath, 'utf8');
const appSource = readFileSync(appPath, 'utf8');
const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

interface RangeCommits {
  readonly base: string;
  readonly added: string;
  readonly tuned: string;
}

/** A throwaway repository so the range rules never depend on the real, possibly shallow, history. */
function rangeRepo(): { readonly cwd: string; readonly commits: RangeCommits } {
  const cwd = mkdtempSync(path.join(tmpdir(), 'safe-web-range-'));
  const file = path.join(cwd, modulePath);
  mkdirSync(path.dirname(file), { recursive: true });
  const git = (args: readonly string[]): string =>
    execFileSync('git', [...args], { cwd, encoding: 'utf8' }).trim();
  git(['init', '-q']);
  git(['config', 'user.email', 'review@example.test']);
  git(['config', 'user.name', 'review']);
  writeFileSync(path.join(cwd, 'README.md'), 'fixture\n');
  git(['add', '.']);
  git(['commit', '-qm', 'base']);
  const base = git(['rev-parse', 'HEAD']);
  writeFileSync(file, moduleSource);
  git(['add', '.']);
  git(['commit', '-qm', 'add module']);
  const added = git(['rev-parse', 'HEAD']);
  writeFileSync(file, moduleSource.replace('1_600', '1_800'));
  git(['add', '.']);
  git(['commit', '-qm', 'tune module']);
  return { cwd, commits: { base, added, tuned: git(['rev-parse', 'HEAD']) } };
}

/** True-vs-false comparison that names the offending case instead of only its index. */
function expectAll(cases: ReadonlyArray<readonly [string, boolean]>, expected: boolean): void {
  expect(Object.fromEntries(cases)).toEqual(
    Object.fromEntries(cases.map(([label]) => [label, expected])),
  );
}

describe('safe-Web delivery class', () => {
  it(
    'accepts a reviewed module when only literal values change',
    () => {
      const cases: ReadonlyArray<readonly [string, SourceCase]> = [
        ['unchanged', [modulePath, moduleSource, moduleSource]],
        ['dimension cap', [modulePath, moduleSource, moduleSource.replace('1_600', '1_800')]],
        [
          'quality factor',
          [
            modulePath,
            moduleSource,
            moduleSource.replace(
              'CHAT_IMAGE_WEBP_QUALITY = 0.82',
              'CHAT_IMAGE_WEBP_QUALITY = 0.85',
            ),
          ],
        ],
        [
          'display name',
          [modulePath, moduleSource, moduleSource.replace("'фото.webp'", "'снимок.webp'")],
        ],
      ];
      const results = verifyMany(cases.map(([, value]) => value));
      expectAll(
        cases.map(([label], index): readonly [string, boolean] => [
          label,
          results[index] as boolean,
        ]),
        true,
      );
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    'accepts a literal change inside the named shell function and nothing structural',
    () => {
      const cases: ReadonlyArray<readonly [string, SourceCase, boolean]> = [
        ['unchanged shell', [appPath, appSource, appSource], true],
        [
          'literal inside the allowed function',
          [appPath, appSource, appSource.replace('progress: 100', 'progress: 99')],
          true,
        ],
        [
          'structural edit inside the same function',
          [
            appPath,
            appSource,
            appSource.replace(
              'const fileName = normalizeAttachmentFileName(file.name);',
              'const fileName = normalizeAttachmentFileName(file.name).trim();',
            ),
          ],
          false,
        ],
        [
          'literal outside the named functions',
          [appPath, appSource, appSource.replace('unreadCount: 0', 'unreadCount: 1')],
          false,
        ],
      ];
      const results = verifyMany(cases.map(([, value]) => value));
      expect(results).toEqual(cases.map(([, , expected]) => expected));
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    'accepts an import of another allowlisted module and refuses a target outside it',
    () => {
      const specifier =
        "import { prepareChatPhotoForUpload } from './chats-ui/chat-image-webp.js';";
      const results = verifyMany([
        [
          appPath,
          appSource,
          appSource.replace(
            specifier,
            "import { prepareChatPhotoForUpload, chatWebpFileName } from './chats-ui/chat-image-webp.js';",
          ),
        ],
        [
          appPath,
          appSource,
          appSource.replace(
            specifier,
            `${specifier}\nimport { CommunityFeed } from './CommunityFeed.js';`,
          ),
        ],
      ]);
      expect(results).toEqual([true, false]);
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    'rejects every capability, dependency and shape change in an allowlisted module',
    () => {
      const cases: ReadonlyArray<readonly [string, string]> = [
        ['a new browser API', `${moduleSource}\nvoid new Image().src;\n`],
        [
          'an image egress through an existing API',
          `${moduleSource}\nvoid (new Image().src = 'https://example.invalid/');\n`,
        ],
        [
          'a new navigation call',
          `${moduleSource}\nvoid window.open('https://example.invalid/');\n`,
        ],
        ['a new DOM walker', `${moduleSource}\nvoid document.createTreeWalker(document.body);\n`],
        [
          'an aliased computed capability',
          `${moduleSource}\nconst gg = globalThis as Record<string, unknown>;\nvoid gg['fe' + 'tch']('https://example.invalid/');\n`,
        ],
        ['a new dependency', `import sharp from 'sharp';\n${moduleSource}`],
        ['a network capability', `${moduleSource}\nvoid fetch('https://example.invalid/');\n`],
        ['a dynamic import', `${moduleSource}\nvoid import('node:fs');\n`],
        ['persistent storage', `${moduleSource}\nvoid globalThis.localStorage;\n`],
        [
          'a capability name hidden in a string literal',
          `${moduleSource}\nvoid window['fetch']('https://example.invalid/');\n`,
        ],
        ['a CommonJS require', `${moduleSource}\nimport sharp = require('sharp');\n`],
        [
          'a first navigation capability',
          `${moduleSource}\nvoid location.assign('https://example.invalid/');\n`,
        ],
        ['a new export', `${moduleSource}\nexport const extra = 1;\n`],
        [
          'a removed export',
          moduleSource.replace(
            'export async function prepareChatPhotoForUpload',
            'async function prepareChatPhotoForUpload',
          ),
        ],
        [
          'a removed guard',
          moduleSource.replace(
            'if (encoded.size < 1 || encoded.size >= file.size) return file;',
            '',
          ),
        ],
      ];
      const results = verifyMany(
        cases.map(([, after]): SourceCase => [modulePath, moduleSource, after]),
      );
      expectAll(
        cases.map(([label], index): readonly [string, boolean] => [
          label,
          results[index] as boolean,
        ]),
        false,
      );
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    'rejects a smuggled statement, a retargeted re-export and a duplicate shell function',
    () => {
      const line = "import { normalizePhoneE164 } from '@phub/auth';";
      const results = verifyMany([
        [appPath, appSource, appSource.replace(line, `${line} void (0);`)],
        [
          modulePath,
          "export { a } from './other.js';\nexport const b = 1;\n",
          "export { a } from './other.js';\nexport const b = 1;\n",
        ],
        [
          modulePath,
          "export { a } from './other.js';\nexport const b = 1;\n",
          "export { a } from './evil.js';\nexport const b = 1;\n",
        ],
        [appPath, appSource, `${appSource}\nfunction uploadChatAttachment(): void {}\n`],
      ]);
      expect(results).toEqual([false, true, false, false]);
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    'never claims a module that is not on the allowlist',
    () => {
      const other = readFileSync('apps/web/src/CommunityDetailPage.tsx', 'utf8');
      expect(verify('apps/web/src/CommunityDetailPage.tsx', other, other)).toBe(false);
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    'verifies ranges: a first landing fails closed, a later tuning revision passes',
    () => {
      const { cwd, commits } = rangeRepo();
      const short = 'f'.repeat(40);
      const results = verifyRangeMany(
        [
          [[modulePath, moduleTestPath], commits.added, commits.tuned],
          [[modulePath], commits.tuned, commits.added],
          [[modulePath], commits.base, commits.added],
          [[modulePath], short, commits.tuned],
          [[modulePath], 'not-a-sha', commits.tuned],
          [[modulePath], commits.added, short],
        ],
        cwd,
      );
      expect(results).toEqual([true, true, false, false, false, false]);
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    'verifies the repository range when nothing changed',
    () => {
      expect(verifyRangeMany([[[modulePath, moduleTestPath], head, head]])).toEqual([true]);
    },
    SPAWN_TIMEOUT_MS,
  );
});
