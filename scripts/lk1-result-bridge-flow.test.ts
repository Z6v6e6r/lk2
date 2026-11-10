import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const flowPath = fileURLToPath(
  new URL('../deploy/lk1-results-bridge/lk2-result-import.flow.json', import.meta.url),
);

interface FlowNode {
  readonly id: string;
  readonly type: string;
  readonly func?: string;
}

const nodes = JSON.parse(readFileSync(flowPath, 'utf8')) as FlowNode[];
const functions = nodes.filter((node) => node.type === 'function');

/**
 * Node-RED function nodes run in a sandbox without `require`, `crypto` or a guaranteed `Buffer`.
 * The first deploy to LK1 threw `ReferenceError: require is not defined` and the HTTP request hung
 * because the flow never reached its response node.
 */
describe('LK1 result-import flow functions', () => {
  it('compiles every function body the way Node-RED invokes it', () => {
    expect(functions.length).toBeGreaterThan(0);
    for (const node of functions) {
      expect(() => {
        // Node-RED runs each body as a function body; compiling it the same way catches
        // syntax errors without executing anything.
        new Script(`(function (msg, env, node, flow, global, context) {${node.func ?? ''}\n})`);
      }, node.id).not.toThrow();
    }
  });

  it('never relies on sandbox-absent globals', () => {
    for (const node of functions) {
      const body = node.func ?? '';
      expect(body, node.id).not.toMatch(/\brequire\s*\(/u);
      expect(body, node.id).not.toMatch(/\bBuffer\b/u);
      expect(body, node.id).not.toMatch(/\bcrypto\./u);
      expect(body, node.id).not.toMatch(/\bprocess\./u);
    }
  });

  it('derives the result document id from the LK2 result instead of a random one', () => {
    const decide = functions.find((node) => node.id === 'lk2res_fn_decide_001');
    expect(decide?.func).toContain('res_lk2_');
  });

  it('rejects an unconfigured bridge before any Mongo read', () => {
    const auth = functions.find((node) => node.id === 'lk2res_fn_auth_001');
    const body = auth?.func ?? '';
    expect(body).toContain("env.get('LK1_RESULT_BRIDGE_TOKEN')");
    expect(body).toContain('LK1_BRIDGE_NOT_CONFIGURED');
    expect(body.indexOf('LK1_BRIDGE_NOT_CONFIGURED')).toBeLessThan(body.indexOf('msg.payload'));
  });
});
