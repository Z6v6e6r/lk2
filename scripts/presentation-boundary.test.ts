import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const verify = (path: string, before: string, after: string) => {
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import { verifyPresentationSources } from './scripts/presentation-boundary.js';
    import { readFileSync } from 'node:fs';
    process.stdout.write(JSON.stringify(verifyPresentationSources(...JSON.parse(readFileSync(0, 'utf8')))));
  `,
    ],
    { input: JSON.stringify([path, before, after]), encoding: 'utf8' },
  );
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as boolean;
};

describe('existing presentation module boundaries', () => {
  const profile = 'apps/web/src/ProfilePage.tsx';
  const tournament = 'apps/web/src/TournamentSummaryCard.tsx';
  const before = readFileSync(profile, 'utf8');
  it('subscription card copy is presentation without changing entitlement', () => {
    expect(
      verify(profile, before, before.replace('Подписки и абонементы</h2>', 'Мои подписки</h2>')),
    ).toBe(true);
  });
  it('tournament styling is presentation without changing signup', () => {
    const source = readFileSync(tournament, 'utf8');
    expect(
      verify(
        tournament,
        source,
        source.replace(
          'className="tournament-summary-card__organizer"',
          'className="tournament-summary-card__organizer presentation-compact"',
        ),
      ),
    ).toBe(true);
    expect(
      verify(
        tournament,
        source,
        source.replace('href={tournament.route}', 'onClick={() => purchase()}'),
      ),
    ).toBe(false);
  });
  it.each([
    ['price', 'subscription.remainingUnits > 0', 'subscription.remainingUnits > 10'],
    ['entitlement', "['active', 'scheduled', 'paused']", "['active']"],
    ['purchase handler', 'href={subscription.route}', 'onClick={() => purchase()}'],
    ['auth import', "from 'react'", "from './auth-write.js'"],
  ])('rejects %s changes', (_name, oldText, newText) => {
    expect(before).toContain(oldText);
    expect(verify(profile, before, before.replace(oldText, newText))).toBe(false);
  });
  it('new executable code in an allowlisted render module is not presentation', () => {
    const source = readFileSync(tournament, 'utf8');
    expect(verify(tournament, source, source + '\nfetch("/purchase", {method:"POST"});')).toBe(
      false,
    );
  });
  it.each([
    'scripts/select-pr-ci-profile.js',
    'scripts/verify-ci-plan.js',
    '.github/workflows/pull-request.yaml',
    'scripts/presentation-boundary.js',
    'apps/api/src/auth/auth-routes.ts',
    'packages/database/migrations/new.sql',
  ])('classifier control or mixed critical change uses full jobs: %s', (path) => {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const result = spawnSync(
      process.execPath,
      [
        'scripts/select-pr-ci-profile.js',
        '--event',
        'pull_request',
        '--ref',
        'refs/pull/1/merge',
        '--base',
        sha,
        '--head',
        sha,
      ],
      {
        input: `${tournament}\0${path}\0`,
        encoding: 'utf8',
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ fullQuality: true, webQuality: false });
  });
});

describe('bounded decorative stylesheet changes', () => {
  const style = (before: string, after: string) => {
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import {verifyPresentationStyles} from './scripts/presentation-boundary.js';
      import {readFileSync} from 'node:fs';
      console.log(JSON.stringify(verifyPresentationStyles(...JSON.parse(readFileSync(0,'utf8')))));
    `,
      ],
      { input: JSON.stringify([before, after]), encoding: 'utf8' },
    );
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout) as boolean;
  };
  it('accepts bounded spacing for an explicit decorative class', () => {
    expect(
      style('', '.presentation-compact { padding: 8px; gap: 4px; border-radius: 12px; }'),
    ).toBe(true);
  });
  it.each([
    '.game-card__price { font-size: 0; }',
    '.profile-subscriptions { font-size: 1px; }',
    '@import "https://example.invalid/style.css";',
    '.presentation-box { background-color: url(https://example.invalid/a); }',
    '.presentation-box, .auth-layout { padding: 8px; }',
    '.presentation-box :is(button) { padding: 8px; }',
    '.presentation-box { gap: -8px; }',
    '.presentation-box { padding: 9999px; }',
    '.presentation-box { font-size: 0; line-height: 0; }',
    '.presentation-box { opacity: 0; }',
  ])('rejects unsafe or global style %s', (after) => expect(style('', after)).toBe(false));
  it('rejects hiding utilities and new classes on price/command nodes', () => {
    const path = 'apps/web/src/GameCard.tsx',
      before = readFileSync(path, 'utf8');
    expect(before).toContain('className="game-card__price"');
    for (const value of ['sr-only', 'game-card__price presentation-hide']) {
      expect(
        verify(
          path,
          before,
          before.replace('className="game-card__price"', `className="${value}"`),
        ),
      ).toBe(false);
    }
  });
});
