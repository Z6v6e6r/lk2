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

  /**
   * LK1 games created from the split widget keep no phones at all: `participants[].phone` is null,
   * `participantPhones` is empty and the roster snapshot carries no phone. Resolving teams from the
   * game document alone therefore failed with `LK1_GAME_TEAMS_UNAVAILABLE` and the score never
   * arrived, so the composition has to travel with the result.
   */
  const runNode = (
    id: string,
    msg: Record<string, unknown>,
    envValues: Record<string, string> = {},
  ): unknown => {
    const node = functions.find((candidate) => candidate.id === id);
    const script = new Script(
      `(function (msg, env, node, flow, global, context) {${node?.func ?? ''}\n})`,
    );
    const env = { get: (key: string) => envValues[key] ?? '' };
    const fn = script.runInNewContext({}, { timeout: 2000 }) as (
      msg: unknown,
      env: unknown,
      node: unknown,
      flow: unknown,
      global: unknown,
      context: unknown,
    ) => unknown;
    return fn(msg, env, {}, {}, {}, {});
  };

  const TOKEN = 'x'.repeat(40);
  const PHONES = {
    submitter: '+79161234567',
    partner: '+79161234568',
    opponentA: '+79161234569',
    opponentB: '+79161234570',
  };

  const authorize = (teams?: Record<string, readonly string[]>) => {
    const msg: Record<string, unknown> = {
      req: { headers: { authorization: `Bearer ${TOKEN}` } },
      payload: {
        gameId: 'pay_7c1f3cec-e61d-4ceb-909f-273516cdbffe',
        externalResultId: '775ae214-2ce9-412e-94e1-77aeac076fb5',
        externalResultRevision: 1,
        submitterPhone: PHONES.submitter,
        scoreA: 0,
        scoreB: 3,
        ...(teams ? { teams } : {}),
      },
    };
    const [next] = runNode('lk2res_fn_auth_001', msg, { LK1_RESULT_BRIDGE_TOKEN: TOKEN }) as [
      Record<string, unknown>,
      unknown,
    ];
    return next;
  };

  it('carries the LK2 pairing into a game whose LK1 document has no phones', () => {
    const authorized = authorize({
      teamA: [PHONES.submitter, PHONES.partner],
      teamB: [PHONES.opponentA, PHONES.opponentB],
    });
    const ctx = authorized._lk2Import as {
      teams: { teamA: string[]; teamB: string[] };
    };
    expect(ctx.teams.teamA).toHaveLength(2);
    expect(ctx.teams.teamB).toHaveLength(2);

    const gameWithoutPhones = {
      id: 'pay_7c1f3cec-e61d-4ceb-909f-273516cdbffe',
      participants: [
        { id: '831ab3b7-adc4-455d-9f74-da5bf9c3d381', name: 'Дмитрий', phone: null },
        { id: '83756527-cfbe-4b7f-b143-1a6ac96d2a93', name: 'Alexey', phone: null },
        { id: '6a758cce-23ab-4ffd-9c57-a1bc5d4aab70', name: 'Константин', phone: null },
        { id: 'c68f263e-4a54-4472-9254-103e3b332538', name: 'Артём', phone: null },
      ],
      participantPhones: [],
    };

    const [next, failure] = runNode('lk2res_fn_check_game_001', {
      ...authorized,
      payload: [gameWithoutPhones],
    }) as [Record<string, unknown>, unknown];

    expect(failure).toBeNull();
    expect(next._lk2SubmitterTeam).toBe('A');
    expect((next._lk2Teams as { teamA: unknown[]; teamB: unknown[] }).teamB).toHaveLength(2);
  });

  it('matches payload entries to LK1 participants by client id when no phone exists', () => {
    const authorized = authorize({
      teamA: [
        { clientId: '831ab3b7-adc4-455d-9f74-da5bf9c3d381', phone: PHONES.submitter },
        { clientId: '83756527-cfbe-4b7f-b143-1a6ac96d2a93', phone: null },
      ],
      teamB: [
        { clientId: '6a758cce-23ab-4ffd-9c57-a1bc5d4aab70', phone: null },
        { clientId: 'c68f263e-4a54-4472-9254-103e3b332538', phone: null },
      ],
    });
    const msg = authorized as Record<string, unknown> & {
      _lk2Import: { submitterClientId: string | null };
    };
    msg._lk2Import.submitterClientId = '831ab3b7-adc4-455d-9f74-da5bf9c3d381';
    msg.payload = [
      {
        id: 'pay_7c1f3cec-e61d-4ceb-909f-273516cdbffe',
        participants: [
          { id: '83756527-cfbe-4b7f-b143-1a6ac96d2a93', name: 'Alexey', phone: null },
          { id: '831ab3b7-adc4-455d-9f74-da5bf9c3d381', name: 'Дмитрий', phone: null },
          { id: 'c68f263e-4a54-4472-9254-103e3b332538', name: 'Артём', phone: null },
          { id: '6a758cce-23ab-4ffd-9c57-a1bc5d4aab70', name: 'Константин', phone: null },
        ],
      },
    ];

    const [next, failure] = runNode('lk2res_fn_check_game_001', msg) as [
      Record<string, unknown>,
      unknown,
    ];

    expect(failure).toBeNull();
    expect(next._lk2SubmitterTeam).toBe('A');
    const teams = next._lk2Teams as { teamA: { id: string; name: string }[]; teamB: unknown[] };
    expect(teams.teamA.map((member) => member.name)).toEqual(['Дмитрий', 'Alexey']);
    expect(teams.teamB).toHaveLength(2);
  });

  it('refuses a game that has neither payload teams nor its own phones', () => {
    const authorized = authorize();
    expect((authorized._lk2Import as { teams: unknown }).teams).toBeNull();

    const [, failure] = runNode('lk2res_fn_check_game_001', {
      ...authorized,
      payload: [{ id: 'pay_1', participants: [{ name: 'Игрок', phone: null }] }],
    }) as [unknown, { payload: { code: string } }];

    expect(failure.payload.code).toBe('LK1_GAME_TEAMS_UNAVAILABLE');
  });
});
