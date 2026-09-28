import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const boundary = fileURLToPath(new URL('./safe-web-boundary.js', import.meta.url));

function verify(path: string, before: string, after: string): boolean {
  const program = `
    import { verifySafeWebSources } from ${JSON.stringify(boundary)};
    import { readFileSync } from 'node:fs';
    process.stdout.write(JSON.stringify(verifySafeWebSources(...JSON.parse(readFileSync(0, 'utf8')))));`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', program], {
    input: JSON.stringify([path, before, after]),
    encoding: 'utf8',
  });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as boolean;
}

function verifyRange(paths: readonly string[], base: string, head: string, cwd?: string): boolean {
  const program = `
    import { verifySafeWebRange } from ${JSON.stringify(boundary)};
    import { readFileSync } from 'node:fs';
    process.stdout.write(JSON.stringify(verifySafeWebRange(...JSON.parse(readFileSync(0, 'utf8')))));`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', program], {
    input: JSON.stringify([paths, base, head]),
    encoding: 'utf8',
    ...(cwd ? { cwd } : {}),
  });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as boolean;
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

describe('safe-Web delivery class', () => {
  it('accepts a reviewed module when only literal values change', () => {
    expect(verify(modulePath, moduleSource, moduleSource)).toBe(true);
    expect(verify(modulePath, moduleSource, moduleSource.replace('1_600', '1_800'))).toBe(true);
    expect(
      verify(
        modulePath,
        moduleSource,
        moduleSource.replace('CHAT_IMAGE_WEBP_QUALITY = 0.82', 'CHAT_IMAGE_WEBP_QUALITY = 0.85'),
      ),
    ).toBe(true);
    expect(
      verify(modulePath, moduleSource, moduleSource.replace("'фото.webp'", "'снимок.webp'")),
    ).toBe(true);
  });

  it('accepts a literal change inside the named shell function and nothing structural', () => {
    expect(verify(appPath, appSource, appSource)).toBe(true);
    expect(verify(appPath, appSource, appSource.replace('progress: 100', 'progress: 99'))).toBe(
      true,
    );
    // A structural edit inside the same function is not tuning.
    expect(
      verify(
        appPath,
        appSource,
        appSource.replace(
          'const fileName = normalizeAttachmentFileName(file.name);',
          'const fileName = normalizeAttachmentFileName(file.name).trim();',
        ),
      ),
    ).toBe(false);
    // A literal change outside the named functions is not tuning either.
    expect(verify(appPath, appSource, appSource.replace('unreadCount: 0', 'unreadCount: 1'))).toBe(
      false,
    );
  });

  it('accepts an import of another allowlisted module and refuses a target outside it', () => {
    const specifier = "import { prepareChatPhotoForUpload } from './chats-ui/chat-image-webp.js';";
    expect(
      verify(
        appPath,
        appSource,
        appSource.replace(
          specifier,
          "import { prepareChatPhotoForUpload, chatWebpFileName } from './chats-ui/chat-image-webp.js';",
        ),
      ),
    ).toBe(true);
    expect(
      verify(
        appPath,
        appSource,
        appSource.replace(
          specifier,
          `${specifier}\nimport { CommunityFeed } from './CommunityFeed.js';`,
        ),
      ),
    ).toBe(false);
  });

  it.each([
    ['a new browser API', `${moduleSource}\nvoid new Image().src;\n`],
    [
      'an image egress through an existing API',
      `${moduleSource}\nvoid (new Image().src = 'https://example.invalid/');\n`,
    ],
    ['a new navigation call', `${moduleSource}\nvoid window.open('https://example.invalid/');\n`],
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
      moduleSource.replace('if (encoded.size < 1 || encoded.size >= file.size) return file;', ''),
    ],
  ])('rejects %s in an allowlisted module', (_label, after) => {
    expect(verify(modulePath, moduleSource, after)).toBe(false);
  });

  it('rejects a statement smuggled onto an import line', () => {
    const line = "import { normalizePhoneE164 } from '@phub/auth';";
    expect(verify(appPath, appSource, appSource.replace(line, `${line} void (0);`))).toBe(false);
  });

  it('rejects a re-export whose target leaves the allowlist', () => {
    const before = "export { a } from './other.js';\nexport const b = 1;\n";
    const after = "export { a } from './evil.js';\nexport const b = 1;\n";
    expect(verify(modulePath, before, before)).toBe(true);
    expect(verify(modulePath, before, after)).toBe(false);
  });

  it('rejects a second declaration of the named shell function', () => {
    expect(
      verify(appPath, appSource, `${appSource}\nfunction uploadChatAttachment(): void {}\n`),
    ).toBe(false);
  });

  it('never claims a module that is not on the allowlist', () => {
    const other = readFileSync('apps/web/src/CommunityDetailPage.tsx', 'utf8');
    expect(verify('apps/web/src/CommunityDetailPage.tsx', other, other)).toBe(false);
  });

  it('verifies ranges: a first landing fails closed, a later tuning revision passes', () => {
    const { cwd, commits } = rangeRepo();
    expect(verifyRange([modulePath, moduleTestPath], commits.added, commits.tuned, cwd)).toBe(true);
    expect(verifyRange([modulePath], commits.tuned, commits.added, cwd)).toBe(true);
    expect(verifyRange([modulePath], commits.base, commits.added, cwd)).toBe(false);
    expect(verifyRange([modulePath], 'f'.repeat(40), commits.tuned, cwd)).toBe(false);
    expect(verifyRange([modulePath], 'not-a-sha', commits.tuned, cwd)).toBe(false);
    expect(verifyRange([modulePath], commits.added, 'f'.repeat(40), cwd)).toBe(false);
  });

  it('verifies the repository range when nothing changed', () => {
    expect(verifyRange([modulePath, moduleTestPath], head, head)).toBe(true);
  });
});
