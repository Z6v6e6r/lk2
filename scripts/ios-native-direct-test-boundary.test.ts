import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const guard = '#if DEBUG && targetEnvironment(simulator) && PADLHUB_B07_TEST_HOST';

describe('native DIRECT acceptance custody', () => {
  it('keeps fixture files in AppTests and out of application source/resources', () => {
    const project = read('apps/mobile/ios/App/App.xcodeproj/project.pbxproj');
    const appSources = project.match(
      /504EC3001FED79650016851F \/\* Sources \*\/ = \{[\s\S]*?\n\t\t\};/,
    )?.[0];
    const appResources = project.match(
      /504EC3021FED79650016851F \/\* Resources \*\/ = \{[\s\S]*?\n\t\t\};/,
    )?.[0];
    expect(appSources).toBeDefined();
    expect(appResources).toBeDefined();
    expect(appSources).not.toContain('A10D');
    expect(appResources).not.toContain('A10D');
    expect(project).not.toContain('PADLHUB_B07_TEST_HOST');
    expect(read('apps/mobile/src/main.tsx')).not.toContain('testing/');
    expect(read('apps/mobile/capacitor.config.ts')).not.toContain('PADLHUB_B07_TEST_HOST');
  });

  it('exposes no synthetic command through the native JavaScript method table', () => {
    const plugin = read('apps/mobile/ios/App/App/PadlHubSessionPlugin.swift');
    const registry = plugin.match(/public let pluginMethods:[\s\S]*?\n {2}\]/)?.[0];
    expect(registry).toBeDefined();
    expect(registry?.match(/name: "([^"]+)"/g)).toEqual([
      'name: "configuration"',
      'name: "request"',
    ]);
    expect(plugin).toContain(`${guard}\n  // Swift-only`);
    expect(plugin).not.toMatch(/@objc[^\n]*installDirectIntegrationTransport/);
    for (const filename of [
      'DirectIntegrationFixture.swift',
      'PadlHubDirectIntegrationTests.swift',
    ]) {
      const source = read(`apps/mobile/ios/App/AppTests/${filename}`);
      expect(source.startsWith(`${guard}\n`)).toBe(true);
      expect(source.trimEnd().endsWith('#endif')).toBe(true);
    }
    const fixture = read('apps/mobile/ios/App/AppTests/DirectIntegrationFixture.swift');
    expect(fixture).not.toMatch(/URLSession\(|KeychainCredentialStore\(/);
  });

  it('retains synthetic public identities and no private-account payload in the native fixture', () => {
    const fixture = JSON.parse(
      read('apps/mobile/ios/App/AppTests/direct-integration-fixtures.json'),
    ) as {
      provenance: string;
      peerId: string;
      otherProfile: {
        profile: { userId: string };
        access: { audience: string; visibleSections: string[] };
        privateAccount?: unknown;
      };
    };
    expect(fixture.provenance).toMatch(/^Synthetic #516/);
    expect(fixture.otherProfile.profile.userId).toBe(fixture.peerId);
    expect(fixture.otherProfile.access.audience).toBe('OTHER');
    expect(fixture.otherProfile).not.toHaveProperty('privateAccount');
    expect(fixture.otherProfile.access.visibleSections).not.toContain('PRIVATE_ACCOUNT');
  });
});
