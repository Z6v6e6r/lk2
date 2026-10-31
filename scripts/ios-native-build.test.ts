import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const project = readFileSync('apps/mobile/ios/App/App.xcodeproj/project.pbxproj', 'utf8');
const workflowSource = readFileSync('.github/workflows/mobile-ios.yaml', 'utf8');
const workflow = parse(workflowSource) as {
  on: {
    pull_request: { paths: string[] };
    workflow_dispatch: { inputs: { operation: { default: string } } };
  };
  permissions: Record<string, string>;
  jobs: Record<
    string,
    {
      if?: string;
      needs?: string;
      environment?: unknown;
      env?: Record<string, string>;
      steps: { name?: string; run?: string; with?: Record<string, string | boolean> }[];
    }
  >;
};
function configuration(objectId: string, name: string): string {
  const start = project.indexOf(`${objectId} /* ${name} */ = {`);
  expect(start).toBeGreaterThan(-1);
  const end = project.indexOf(`name = ${name};`, start);
  expect(end).toBeGreaterThan(start);
  return project.slice(start, end);
}

describe('iOS APNs capability and native verification boundary', () => {
  it.each([
    ['504EC3171FED79650016851F', 'Debug', 'development'],
    ['504EC3181FED79650016851F', 'Release', 'production'],
  ])('wires the App %s configuration %s to its APNs environment', (objectId, name, environment) => {
    const settings = configuration(objectId, name);
    expect(settings).toContain(`CODE_SIGN_ENTITLEMENTS = App/App.${name}.entitlements;`);
    expect(settings).toContain('PRODUCT_BUNDLE_IDENTIFIER = ru.padlhub.app;');
    const entitlement = readFileSync(`apps/mobile/ios/App/App/App.${name}.entitlements`, 'utf8');
    expect(entitlement.match(/<key>[^<]+<\/key>/g)).toEqual(['<key>aps-environment</key>']);
    expect(entitlement).toContain(`<string>${environment}</string>`);
    expect(entitlement).not.toContain('$(');
    expect(project).toContain(`path = App.${name}.entitlements;`);
  });

  it('does not assign application push capability to the test target or add silent background mode', () => {
    expect(project.match(/CODE_SIGN_ENTITLEMENTS =/g)).toHaveLength(2);
    expect(configuration('A10B0000000000000000000B', 'Debug')).not.toContain(
      'CODE_SIGN_ENTITLEMENTS',
    );
    expect(configuration('A10B0000000000000000000C', 'Release')).not.toContain(
      'CODE_SIGN_ENTITLEMENTS',
    );
    expect(project).toMatch(
      /504EC3031FED79650016851F = \{[^}]*SystemCapabilities = \{\s*com\.apple\.Push = \{ enabled = 1; \};/,
    );
    expect(readFileSync('apps/mobile/ios/App/App/Info.plist', 'utf8')).not.toContain(
      'remote-notification',
    );
  });

  it('keeps runtime registration opt-in even when native capability is configured', () => {
    const capacitor = readFileSync('apps/mobile/capacitor.config.ts', 'utf8');
    expect(capacitor).toContain("enabled: process.env.PADLHUB_IOS_PUSH_ENABLED === 'true'");
    expect(workflow.jobs['unsigned-native']?.env).toEqual({
      VITE_PHUB_API_BASE_URL: '',
      VITE_PHUB_TENANT_KEY: '',
      PADLHUB_IOS_PUSH_ENABLED: 'false',
    });
  });

  it('runs real unsigned native checks on relevant PRs without signing credentials or deployment', () => {
    const unsigned = workflow.jobs['unsigned-native'];
    expect(unsigned).toBeDefined();
    expect(unsigned?.environment).toBeUndefined();
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(workflow.on.pull_request.paths).toContain('apps/mobile/ios/**');
    expect(workflow.on.pull_request.paths).toContain('package-lock.json');
    expect(workflow.on.pull_request.paths).not.toContain('**');
    const commands = unsigned?.steps.map((step) => step.run ?? '').join('\n') ?? '';
    expect(commands).toContain('swift test --package-path apps/mobile/ios/PadlHubSession');
    expect(commands).toContain('npm run ios:build:simulator -w @phub/mobile');
    const mobile = JSON.parse(readFileSync('apps/mobile/package.json', 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(mobile.scripts['ios:build:simulator']).toContain('CODE_SIGNING_ALLOWED=NO build');
    expect(workflowSource).not.toMatch(
      /secrets\.|allowProvisioningUpdates|CODE_SIGNING_ALLOWED=YES|altool|notarytool|fastlane/,
    );
    expect(workflowSource).toContain('github.event.pull_request.head.sha');
    expect(unsigned?.steps[0]?.with?.['persist-credentials']).toBe(false);
  });

  it('fails signed release requests instead of treating unsigned build as release acceptance', () => {
    expect(workflow.on.workflow_dispatch.inputs.operation.default).toBe('unsigned-verification');
    const gate = workflow.jobs['signed-release-gate'];
    expect(gate?.needs).toBe('unsigned-native');
    expect(gate?.if).toBe(
      "${{ github.event_name == 'push' || inputs.operation == 'signed-release' }}",
    );
    const commands = gate?.steps.map((step) => step.run ?? '').join('\n') ?? '';
    expect(commands).toContain('IOS_SIGNED_RELEASE_NOT_IMPLEMENTED');
    expect(commands).toContain('exit 1');
  });
});
