import { describe, expect, it } from 'vitest';

import {
  buildCommunitiesLegacyWriterInventoryReport as buildInventoryReport,
  calculateCommunitiesNodeRedFunctionDigest,
  communitiesLegacyNodeRedFlowSchema,
  type CommunitiesLegacyNodeRedNode,
} from './communities-legacy-writer-inventory-support.js';

const FLOW_SHA256 = 'a'.repeat(64);
const FUNCTION_ALLOWLIST_SHA256 = 'b'.repeat(64);
const buildCommunitiesLegacyWriterInventoryReport = (
  nodes: readonly CommunitiesLegacyNodeRedNode[],
) =>
  buildInventoryReport(
    nodes,
    FLOW_SHA256,
    new Set(
      nodes
        .filter(
          (node) =>
            node.d !== true &&
            node.type === 'function' &&
            !nodes.some(
              (parent) => parent.id === node.z && parent.type === 'tab' && parent.disabled === true,
            ),
        )
        .map(calculateCommunitiesNodeRedFunctionDigest),
    ),
    FUNCTION_ALLOWLIST_SHA256,
  );

function route(
  id: string,
  target: string,
  url = '/lk/communities/:communityId/messages',
): CommunitiesLegacyNodeRedNode {
  return { id, z: 'flow', type: 'http in', method: 'post', url, wires: [[target]] };
}

function writer(
  id: string,
  collection = 'lk_community_events',
  operation = 'insertOne',
): CommunitiesLegacyNodeRedNode {
  return { id, z: 'flow', type: 'mongodb4', collection, operation, wires: [] };
}

describe('Communities legacy Node-RED writer inventory', () => {
  it('accepts an exact covered community writer without emitting graph identifiers', () => {
    const report = buildCommunitiesLegacyWriterInventoryReport([
      route('secret-route-id-123', 'secret-transform-id-456'),
      {
        id: 'secret-transform-id-456',
        z: 'flow',
        type: 'function',
        wires: [['secret-database-id-789']],
      },
      writer('secret-database-id-789'),
    ]);
    expect(report).toMatchObject({
      outcome: 'NODE_RED_WRITER_INVENTORY_COMPLETE',
      authorizesMutation: false,
      total: 1,
      unknown: 0,
      unknownByReason: {
        UNSUPPORTED_OPERATION: 0,
        OUT_OF_CONTRACT_COLLECTION: 0,
        MISSING_INGRESS: 0,
        UNAPPROVED_INGRESS: 0,
        ROUTE_CONTRACT_MISMATCH: 0,
        UNKNOWN_SINK_TYPE: 0,
        DIRECT_DRIVER_CODE: 0,
      },
      duplicateHandlers: 0,
      blockers: [],
    });
    expect(JSON.stringify(report)).not.toContain('secret-route-id-123');
    expect(JSON.stringify(report)).not.toContain('secret-database-id-789');
  });

  it.each([
    ['out-of-contract collection', writer('writer', 'lk_media_assets')],
    ['unknown operation', writer('writer', 'lk_community_events', 'execute')],
    [
      'aggregation with possible $out or $merge',
      writer('writer', 'lk_community_events', 'aggregate'),
    ],
  ])('blocks %s', (_label, unsafeWriter) => {
    const report = buildCommunitiesLegacyWriterInventoryReport([
      route('route', 'writer'),
      unsafeWriter,
    ]);
    expect(report.outcome).toBe('NO_GO');
    expect(report.unknown).toBe(1);
    expect(Object.values(report.unknownByReason).some((count) => count > 0)).toBe(true);
    expect(report.blockers).toContain('NODE_RED_UNKNOWN_WRITERS');
  });

  it.each([
    [
      'unapproved HTTP ingress',
      {
        id: 'source',
        z: 'flow',
        type: 'http in',
        method: 'post',
        url: '/admin/write',
        wires: [['writer']],
      },
    ],
    ['mqtt ingress', { id: 'source', z: 'flow', type: 'mqtt in', wires: [['writer']] }],
    ['orphan root', { id: 'source', z: 'flow', type: 'function', wires: [['writer']] }],
  ] satisfies readonly [string, CommunitiesLegacyNodeRedNode][])(
    'blocks %s ancestry',
    (_label, source) => {
      const report = buildCommunitiesLegacyWriterInventoryReport([
        route('known-route', 'reader'),
        {
          id: 'reader',
          z: 'flow',
          type: 'mongodb4',
          collection: 'lk_communities',
          operation: 'find',
          wires: [],
        },
        source,
        writer('writer'),
      ]);
      expect(report.unknown).toBe(1);
      expect(report.blockers).toContain('NODE_RED_UNKNOWN_WRITERS');
    },
  );

  it('blocks a writer reachable from both an approved and an unapproved ingress', () => {
    const report = buildCommunitiesLegacyWriterInventoryReport([
      route('route', 'writer'),
      { id: 'mqtt', z: 'flow', type: 'mqtt in', wires: [['writer']] },
      writer('writer'),
    ]);
    expect(report.unknown).toBe(1);
  });

  it('follows link edges into an out-of-contract writer on another tab', () => {
    const report = buildCommunitiesLegacyWriterInventoryReport([
      {
        id: 'route',
        z: 'flow-a',
        type: 'http in',
        method: 'post',
        url: '/lk/communities/:communityId',
        wires: [['link-out']],
      },
      { id: 'link-out', z: 'flow-a', type: 'link out', links: ['link-in'], wires: [] },
      { id: 'link-in', z: 'flow-b', type: 'link in', links: ['link-out'], wires: [['writer']] },
      { ...writer('writer', 'lk_media_assets'), z: 'flow-b' },
    ]);
    expect(report.total).toBe(1);
    expect(report.outcome).toBe('NO_GO');
    expect(report.unknownByReason.OUT_OF_CONTRACT_COLLECTION).toBe(1);
  });

  it('follows a subflow boundary into an unknown sink', () => {
    const report = buildCommunitiesLegacyWriterInventoryReport([
      route('route', 'instance'),
      { id: 'instance', z: 'flow', type: 'subflow:community-subflow', wires: [] },
      { id: 'subflow-input', z: 'community-subflow', type: 'subflow in', wires: [['writer']] },
      { ...writer('writer', 'lk_media_assets'), z: 'community-subflow' },
    ]);
    expect(report.total).toBe(1);
    expect(report.unknown).toBeGreaterThan(0);
  });

  it('follows the real Node-RED subflow definition input wiring', () => {
    const report = buildCommunitiesLegacyWriterInventoryReport([
      route('route', 'instance'),
      { id: 'instance', z: 'flow', type: 'subflow:community-subflow', wires: [] },
      {
        id: 'community-subflow',
        type: 'subflow',
        in: [{ wires: [{ id: 'writer', port: 0 }] }],
      },
      { ...writer('writer'), z: 'community-subflow' },
    ]);
    expect(report.outcome).toBe('NODE_RED_WRITER_INVENTORY_COMPLETE');
    expect(report.unknown).toBe(0);
  });

  it('inventories a disconnected out-of-contract background writer globally', () => {
    const report = buildCommunitiesLegacyWriterInventoryReport([
      { id: 'inject', z: 'other-flow', type: 'inject', wires: [['writer']] },
      writer('writer', 'lk_media_assets'),
    ]);
    expect(report.outcome).toBe('NO_GO');
    expect(report.total).toBe(1);
    expect(report.unknownByReason.OUT_OF_CONTRACT_COLLECTION).toBe(1);
  });

  it('uses Node-RED d for node activity and never treats an ordinary disabled field as inactive', () => {
    const visible = buildCommunitiesLegacyWriterInventoryReport([
      route('route', 'known-writer'),
      writer('known-writer'),
      { id: 'inject', z: 'flow', type: 'inject', wires: [['hidden-writer']] },
      { ...writer('hidden-writer', 'lk_media_assets'), disabled: true },
    ]);
    expect(visible.outcome).toBe('NO_GO');
    expect(visible.total).toBe(2);
    expect(visible.unknownByReason.OUT_OF_CONTRACT_COLLECTION).toBe(1);

    const runtimeDisabled = buildCommunitiesLegacyWriterInventoryReport([
      route('route', 'known-writer'),
      writer('known-writer'),
      { id: 'inject', z: 'flow', type: 'inject', wires: [['disabled-writer']] },
      { ...writer('disabled-writer', 'lk_media_assets'), d: true },
    ]);
    expect(runtimeDisabled.outcome).toBe('NODE_RED_WRITER_INVENTORY_COMPLETE');
    expect(runtimeDisabled.total).toBe(1);
  });

  it('excludes nodes only when their containing Node-RED tab is disabled', () => {
    const report = buildCommunitiesLegacyWriterInventoryReport([
      { id: 'disabled-tab', type: 'tab', disabled: true },
      route('route', 'known-writer'),
      writer('known-writer'),
      { id: 'inject', z: 'disabled-tab', type: 'inject', wires: [['disabled-writer']] },
      { ...writer('disabled-writer', 'lk_media_assets'), z: 'disabled-tab' },
    ]);
    expect(report.outcome).toBe('NODE_RED_WRITER_INVENTORY_COMPLETE');
    expect(report.total).toBe(1);
  });

  it('blocks a graph with no writer sinks', () => {
    const report = buildCommunitiesLegacyWriterInventoryReport([
      { id: 'route', z: 'flow', type: 'http in', method: 'get', url: '', wires: [] },
    ]);
    expect(report.outcome).toBe('NO_GO');
    expect(report.blockers).toContain('NODE_RED_WRITERS_EMPTY');
  });

  it('blocks unknown Mongo sink types and direct-driver function writes on community paths', () => {
    const report = buildCommunitiesLegacyWriterInventoryReport([
      route('route', 'custom'),
      { id: 'custom', z: 'flow', type: 'mongodb out', wires: [] },
      route('route-two', 'function-writer', '/lk/communities/:communityId/feed'),
      {
        id: 'function-writer',
        z: 'flow',
        type: 'function',
        func: "global.get('db').collection('lk_community_feed').insertOne(msg.payload)",
        wires: [],
      },
    ]);
    expect(report.total).toBe(2);
    expect(report.unknownByReason.UNKNOWN_SINK_TYPE).toBe(1);
    expect(report.unknownByReason.DIRECT_DRIVER_CODE).toBe(1);
  });

  it('blocks every active function not present in the independently reviewed allowlist', () => {
    const nodes = [
      route('route', 'function-writer'),
      {
        id: 'function-writer',
        z: 'flow',
        type: 'function',
        disabled: true,
        func: "global.get('db')['collection']('lk_community_events')['insertOne'](msg.payload)",
        wires: [],
      },
      writer('writer'),
    ];
    const report = buildInventoryReport(nodes, FLOW_SHA256, new Set(), FUNCTION_ALLOWLIST_SHA256);
    expect(report.outcome).toBe('NO_GO');
    expect(report.unknownByReason.UNREVIEWED_FUNCTION).toBe(1);
    expect(report.blockers).toContain('NODE_RED_FUNCTION_ALLOWLIST_MISMATCH');
  });

  it('does not let an ordinary disabled field hide a duplicate HTTP handler', () => {
    const report = buildCommunitiesLegacyWriterInventoryReport([
      route('route-a', 'writer'),
      { ...route('route-b', 'writer'), disabled: true },
      writer('writer'),
    ]);
    expect(report.duplicateHandlers).toBe(1);
    expect(report.blockers).toContain('NODE_RED_DUPLICATE_HANDLERS');
  });

  it('enforces the exact route to collection and operation contract', () => {
    const report = buildCommunitiesLegacyWriterInventoryReport([
      route('route', 'writer', '/lk/media/community-logo'),
      writer('writer', 'community_rating_facts', 'deleteMany'),
    ]);
    expect(report.unknownByReason.ROUTE_CONTRACT_MISMATCH).toBe(1);
  });

  it('blocks duplicate handlers, duplicate ids, and dangling wires independently', () => {
    const report = buildCommunitiesLegacyWriterInventoryReport([
      route('route-a', 'writer'),
      route('route-b', 'missing'),
      { ...route('route-a', 'writer'), id: 'route-a' },
      writer('writer'),
    ]);
    expect(report.blockers).toEqual(
      expect.arrayContaining([
        'NODE_RED_DUPLICATE_IDS',
        'NODE_RED_DANGLING_WIRES',
        'NODE_RED_DUPLICATE_HANDLERS',
      ]),
    );
  });

  it('keeps the digest stable across node order and sensitive to writer changes', () => {
    const nodes = [route('route', 'writer'), writer('writer')];
    const first = buildCommunitiesLegacyWriterInventoryReport(nodes);
    const reversed = buildCommunitiesLegacyWriterInventoryReport([...nodes].reverse());
    const changed = buildCommunitiesLegacyWriterInventoryReport([
      route('route', 'writer'),
      writer('writer', 'lk_community_feed'),
    ]);
    expect(reversed.inventoryDigest).toBe(first.inventoryDigest);
    expect(changed.inventoryDigest).not.toBe(first.inventoryDigest);
  });

  it('binds the raw flow pin and graph blockers into the inventory digest', () => {
    const clean = [route('route', 'writer'), writer('writer')];
    const unrelated = {
      id: 'unrelated',
      z: 'flow',
      type: 'function',
      wires: [['missing']],
    } satisfies CommunitiesLegacyNodeRedNode;
    const broken = [...clean, unrelated];
    const cleanReport = buildInventoryReport(clean, 'a'.repeat(64), new Set(), 'c'.repeat(64));
    const repinnedReport = buildInventoryReport(clean, 'b'.repeat(64), new Set(), 'c'.repeat(64));
    const brokenReport = buildInventoryReport(
      broken,
      'a'.repeat(64),
      new Set([calculateCommunitiesNodeRedFunctionDigest(unrelated)]),
      'c'.repeat(64),
    );
    expect(repinnedReport.inventoryDigest).not.toBe(cleanReport.inventoryDigest);
    expect(brokenReport.outcome).toBe('NO_GO');
    expect(brokenReport.unknown).toBeGreaterThan(0);
    expect(brokenReport.inventoryDigest).not.toBe(cleanReport.inventoryDigest);
  });

  it('strictly bounds required graph fields while tolerating unrelated Node-RED properties', () => {
    expect(
      communitiesLegacyNodeRedFlowSchema.safeParse([
        { ...route('route', 'writer'), credentials: { secret: 'never emitted' } },
        { id: 'config', type: 'http request', z: '', url: '', method: '', wires: [] },
        writer('writer'),
      ]).success,
    ).toBe(true);
    expect(communitiesLegacyNodeRedFlowSchema.safeParse([]).success).toBe(false);
    expect(communitiesLegacyNodeRedFlowSchema.safeParse([{ type: 'http in' }]).success).toBe(false);
  });
});
