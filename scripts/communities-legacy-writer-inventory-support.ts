import { createHash } from 'node:crypto';

import { z } from 'zod';

import { COMMUNITIES_LEGACY_REQUIRED_COLLECTIONS } from './communities-legacy-preservation-support.js';

const safeToken = z.string().min(1).max(256);
const optionalToken = z.string().max(256);

const nodeSchema = z
  .object({
    id: safeToken,
    z: optionalToken.optional(),
    type: safeToken,
    wires: z.array(z.array(safeToken).max(1_000)).max(100).optional(),
    links: z.array(safeToken).max(10_000).optional(),
    in: z
      .array(
        z
          .object({
            wires: z
              .array(z.object({ id: safeToken, port: z.number().int().nonnegative().optional() }))
              .max(10_000),
          })
          .passthrough(),
      )
      .max(100)
      .optional(),
    method: optionalToken.optional(),
    url: z.string().max(2_048).optional(),
    collection: optionalToken.optional(),
    operation: optionalToken.optional(),
    func: z
      .string()
      .max(1024 * 1024)
      .optional(),
    d: z.boolean().optional(),
    disabled: z.boolean().optional(),
  })
  .passthrough();

export const communitiesLegacyNodeRedFlowSchema = z.array(nodeSchema).min(1).max(100_000);
export type CommunitiesLegacyNodeRedNode = z.infer<typeof nodeSchema>;

export const communitiesLegacyFunctionAllowlistSchema = z
  .object({
    schemaVersion: z.literal('communities-node-red-function-allowlist-v1'),
    sourceFlowSha256: z.string().regex(/^[0-9a-f]{64}$/),
    functionDigests: z.array(z.string().regex(/^[0-9a-f]{64}$/)).max(100_000),
  })
  .strict();

const writerUnknownReasonSchema = z.enum([
  'UNSUPPORTED_OPERATION',
  'OUT_OF_CONTRACT_COLLECTION',
  'MISSING_INGRESS',
  'UNAPPROVED_INGRESS',
  'ROUTE_CONTRACT_MISMATCH',
  'UNKNOWN_SINK_TYPE',
  'DIRECT_DRIVER_CODE',
  'UNREVIEWED_FUNCTION',
  'FUNCTION_ALLOWLIST_EXTRA',
]);
const writerBlockerSchema = z.enum([
  'NODE_RED_DUPLICATE_IDS',
  'NODE_RED_DANGLING_WIRES',
  'NODE_RED_DUPLICATE_HANDLERS',
  'NODE_RED_UNKNOWN_WRITERS',
  'NODE_RED_WRITERS_EMPTY',
  'NODE_RED_FUNCTION_ALLOWLIST_MISMATCH',
]);

export const communitiesLegacyWriterInventoryReportSchema = z
  .object({
    schemaVersion: z.literal('communities-node-red-writer-inventory-report-v1'),
    outcome: z.enum(['NODE_RED_WRITER_INVENTORY_COMPLETE', 'NO_GO']),
    authorizesMutation: z.literal(false),
    total: z.number().int().nonnegative(),
    inventoryDigest: z.string().regex(/^[0-9a-f]{64}$/),
    sourceFlowSha256: z.string().regex(/^[0-9a-f]{64}$/),
    functionAllowlistSha256: z.string().regex(/^[0-9a-f]{64}$/),
    unknown: z.number().int().nonnegative(),
    unknownByReason: z.record(writerUnknownReasonSchema, z.number().int().nonnegative()),
    duplicateHandlers: z.number().int().nonnegative(),
    blockers: z.array(writerBlockerSchema),
  })
  .strict();

const REQUIRED_COLLECTIONS = new Set<string>(COMMUNITIES_LEGACY_REQUIRED_COLLECTIONS);
const READ_OPERATIONS = new Set(['count', 'countDocuments', 'distinct', 'find', 'findOne']);
const WRITE_OPERATIONS = new Set([
  'bulkWrite',
  'deleteMany',
  'deleteOne',
  'findOneAndDelete',
  'findOneAndReplace',
  'findOneAndUpdate',
  'insertMany',
  'insertOne',
  'replaceOne',
  'updateMany',
  'updateOne',
]);
const INGRESS_TYPES = new Set([
  'amqp in',
  'catch',
  'http in',
  'inject',
  'mqtt in',
  'status',
  'tcp in',
  'udp in',
  'websocket in',
]);

type WriterEvidence = {
  readonly nodeId: string;
  readonly flowId: string;
  readonly collection: string;
  readonly operation: string;
  readonly ingress: readonly string[];
  readonly unknownReasons: readonly UnknownReason[];
  readonly unknown: boolean;
};

type UnknownReason =
  | 'UNSUPPORTED_OPERATION'
  | 'OUT_OF_CONTRACT_COLLECTION'
  | 'MISSING_INGRESS'
  | 'UNAPPROVED_INGRESS'
  | 'ROUTE_CONTRACT_MISMATCH'
  | 'UNKNOWN_SINK_TYPE'
  | 'DIRECT_DRIVER_CODE'
  | 'UNREVIEWED_FUNCTION'
  | 'FUNCTION_ALLOWLIST_EXTRA';

export type CommunitiesLegacyWriterInventoryReport = z.infer<
  typeof communitiesLegacyWriterInventoryReportSchema
> & {
  readonly blockers: readonly (
    | 'NODE_RED_DUPLICATE_IDS'
    | 'NODE_RED_DANGLING_WIRES'
    | 'NODE_RED_DUPLICATE_HANDLERS'
    | 'NODE_RED_UNKNOWN_WRITERS'
    | 'NODE_RED_WRITERS_EMPTY'
    | 'NODE_RED_FUNCTION_ALLOWLIST_MISMATCH'
  )[];
};

const ROUTE_WRITER_CONTRACT = new Map<string, ReadonlySet<string>>([
  [
    'post\0/lk/communities',
    new Set([
      'lk_communities\0updateOne',
      'lk_community_feed\0insertOne',
      'lk_community_rankings\0updateOne',
      'lk_community_events\0insertOne',
    ]),
  ],
  [
    'patch\0/lk/communities/:communityId',
    new Set(['lk_communities\0updateOne', 'lk_community_events\0insertOne']),
  ],
  ...[
    '/lk/communities/:communityId/join',
    '/lk/communities/:communityId/add-member',
    '/lk/communities/join-by-invite',
    '/lk/communities/:communityId/members/manage',
  ].map(
    (url) =>
      [
        `post\0${url}`,
        new Set([
          'lk_communities\0updateOne',
          'lk_community_rankings\0updateOne',
          'lk_community_feed\0insertOne',
          'lk_community_events\0insertOne',
        ]),
      ] as const,
  ),
  [
    'post\0/lk/communities/:communityId/feed',
    new Set([
      'lk_community_feed\0insertOne',
      'lk_community_events\0insertOne',
      'lk_communities\0updateOne',
    ]),
  ],
  [
    'post\0/lk/communities/:communityId/feed/:postId/archive',
    new Set([
      'lk_community_feed\0updateOne',
      'lk_communities\0updateOne',
      'lk_community_events\0insertOne',
    ]),
  ],
  [
    'post\0/lk/communities/:communityId/feed/:postId/comments',
    new Set(['lk_community_feed_comments\0insertOne', 'lk_community_events\0insertOne']),
  ],
  [
    'post\0/lk/communities/:communityId/feed/:postId/reaction',
    new Set([
      'lk_community_feed_reactions\0updateOne',
      'lk_community_feed\0updateOne',
      'lk_community_events\0insertOne',
    ]),
  ],
  [
    'post\0/lk/communities/:communityId/messages',
    new Set(['lk_community_chat_messages\0insertOne', 'lk_community_events\0insertOne']),
  ],
]);

function digest(lines: readonly string[]): string {
  const hash = createHash('sha256');
  for (const line of lines) hash.update(`${line.length}:${line}\n`);
  return hash.digest('hex');
}

export function calculateCommunitiesNodeRedFunctionDigest(
  node: Pick<CommunitiesLegacyNodeRedNode, 'id' | 'z' | 'type' | 'func'>,
): string {
  return digest([
    'communities-node-red-function-v1',
    node.id,
    node.z ?? '',
    node.type,
    node.func ?? '',
  ]);
}

function outgoing(node: CommunitiesLegacyNodeRedNode): readonly string[] {
  return [
    ...(node.wires ?? []).flat(),
    ...(node.type === 'link out' || node.type === 'link call' ? (node.links ?? []) : []),
  ];
}

function ingressSignature(node: CommunitiesLegacyNodeRedNode): string {
  if (node.type === 'http in')
    return `http\0${(node.method ?? '').toLowerCase()}\0${node.url ?? ''}`;
  return `${node.type}\0${node.id}`;
}

function isApprovedCommunityHttpIngress(node: CommunitiesLegacyNodeRedNode): boolean {
  return (
    node.type === 'http in' &&
    typeof node.url === 'string' &&
    (node.url === '/lk/communities' ||
      node.url.startsWith('/lk/communities/') ||
      node.url === '/lk/media/community-logo' ||
      node.url.startsWith('/lk/media/community-logo/')) &&
    typeof node.method === 'string' &&
    ['delete', 'patch', 'post', 'put'].includes(node.method.toLowerCase())
  );
}

function routeAllowsWriter(
  node: CommunitiesLegacyNodeRedNode,
  collection: string,
  operation: string,
): boolean {
  if (!isApprovedCommunityHttpIngress(node)) return false;
  return (
    ROUTE_WRITER_CONTRACT.get(`${(node.method ?? '').toLowerCase()}\0${node.url ?? ''}`)?.has(
      `${collection}\0${operation}`,
    ) ?? false
  );
}

function containsDirectMongoWrite(node: CommunitiesLegacyNodeRedNode): boolean {
  if (node.type !== 'function' || !node.func) return false;
  return /(?:MongoClient|\.collection\s*\(|\.(?:bulkWrite|deleteMany|deleteOne|findOneAndDelete|findOneAndReplace|findOneAndUpdate|insertMany|insertOne|replaceOne|updateMany|updateOne)\s*\()/u.test(
    node.func,
  );
}

function isPotentialWriter(node: CommunitiesLegacyNodeRedNode): boolean {
  if (node.type === 'mongodb4') return !READ_OPERATIONS.has(node.operation ?? '');
  return node.type.toLowerCase().includes('mongo') || containsDirectMongoWrite(node);
}

function isRuntimeActive(
  node: CommunitiesLegacyNodeRedNode,
  byId: ReadonlyMap<string, CommunitiesLegacyNodeRedNode>,
): boolean {
  if (node.d === true) return false;
  const parent = node.z ? byId.get(node.z) : undefined;
  return !(parent?.type === 'tab' && parent.disabled === true);
}

function findIngress(
  writer: CommunitiesLegacyNodeRedNode,
  byId: ReadonlyMap<string, CommunitiesLegacyNodeRedNode>,
  predecessors: ReadonlyMap<string, readonly string[]>,
): readonly CommunitiesLegacyNodeRedNode[] {
  const pending = [writer.id];
  const visited = new Set<string>();
  const ingress = new Map<string, CommunitiesLegacyNodeRedNode>();
  while (pending.length > 0) {
    const currentId = pending.pop();
    if (!currentId || visited.has(currentId)) continue;
    visited.add(currentId);
    const current = byId.get(currentId);
    if (!current) continue;
    const upstream = predecessors.get(currentId) ?? [];
    if (INGRESS_TYPES.has(current.type)) {
      ingress.set(current.id, current);
      continue;
    }
    pending.push(...upstream);
  }
  return [...ingress.values()].sort((left, right) => left.id.localeCompare(right.id));
}

export function buildCommunitiesLegacyWriterInventoryReport(
  nodes: readonly CommunitiesLegacyNodeRedNode[],
  sourceFlowSha256: string,
  reviewedFunctionDigests: ReadonlySet<string>,
  functionAllowlistSha256: string,
): CommunitiesLegacyWriterInventoryReport {
  if (!/^[0-9a-f]{64}$/.test(sourceFlowSha256))
    throw new Error('COMMUNITIES_NODE_RED_FLOW_SHA256_INVALID');
  if (!/^[0-9a-f]{64}$/.test(functionAllowlistSha256))
    throw new Error('COMMUNITIES_NODE_RED_FUNCTION_ALLOWLIST_SHA256_INVALID');
  const blockers: CommunitiesLegacyWriterInventoryReport['blockers'][number][] = [];
  const byId = new Map<string, CommunitiesLegacyNodeRedNode>();
  let duplicateIds = 0;
  for (const node of nodes) {
    if (byId.has(node.id)) duplicateIds += 1;
    else byId.set(node.id, node);
  }
  if (duplicateIds > 0) blockers.push('NODE_RED_DUPLICATE_IDS');

  const predecessors = new Map<string, string[]>();
  let danglingWires = 0;
  const addEdge = (source: string, target: string) => {
    if (!byId.has(target)) danglingWires += 1;
    const current = predecessors.get(target) ?? [];
    current.push(source);
    predecessors.set(target, current);
  };
  for (const node of nodes) {
    for (const target of outgoing(node)) addEdge(node.id, target);
  }
  for (const instance of nodes.filter((node) => node.type.startsWith('subflow:'))) {
    const subflowId = instance.type.slice('subflow:'.length);
    const definition = nodes.find((node) => node.id === subflowId && node.type === 'subflow');
    for (const input of definition?.in ?? [])
      for (const target of input.wires) addEdge(instance.id, target.id);
    for (const entry of nodes.filter((node) => node.z === subflowId && node.type === 'subflow in'))
      addEdge(instance.id, entry.id);
  }
  if (danglingWires > 0) blockers.push('NODE_RED_DANGLING_WIRES');

  const writerEvidence: WriterEvidence[] = [];
  for (const node of nodes) {
    if (!node.z || !isRuntimeActive(node, byId) || !isPotentialWriter(node)) continue;
    const unknownSinkType = node.type.toLowerCase().includes('mongo') && node.type !== 'mongodb4';
    const directDriverCode = containsDirectMongoWrite(node);
    const operation = node.operation ?? '';
    const collection = node.collection ?? '';
    const ingress = findIngress(node, byId, predecessors);
    const unknownReasons: UnknownReason[] = [];
    if (unknownSinkType) unknownReasons.push('UNKNOWN_SINK_TYPE');
    if (directDriverCode) unknownReasons.push('DIRECT_DRIVER_CODE');
    if (!WRITE_OPERATIONS.has(operation)) unknownReasons.push('UNSUPPORTED_OPERATION');
    if (!REQUIRED_COLLECTIONS.has(collection)) unknownReasons.push('OUT_OF_CONTRACT_COLLECTION');
    if (ingress.length === 0) unknownReasons.push('MISSING_INGRESS');
    if (ingress.some((source) => !isApprovedCommunityHttpIngress(source)))
      unknownReasons.push('UNAPPROVED_INGRESS');
    if (
      ingress.some(
        (source) =>
          isApprovedCommunityHttpIngress(source) &&
          !routeAllowsWriter(source, collection, operation),
      )
    )
      unknownReasons.push('ROUTE_CONTRACT_MISMATCH');
    writerEvidence.push({
      nodeId: node.id,
      flowId: node.z,
      collection,
      operation,
      ingress: ingress.map(ingressSignature),
      unknownReasons,
      unknown: unknownReasons.length > 0,
    });
  }

  const handlerCounts = new Map<string, number>();
  for (const node of nodes) {
    if (!isRuntimeActive(node, byId) || node.type !== 'http in') continue;
    if (!node.url || !node.method) continue;
    const signature = ingressSignature(node);
    handlerCounts.set(signature, (handlerCounts.get(signature) ?? 0) + 1);
  }
  const duplicateHandlers = [...handlerCounts.values()].reduce(
    (total, count) => total + Math.max(0, count - 1),
    0,
  );
  if (duplicateHandlers > 0) blockers.push('NODE_RED_DUPLICATE_HANDLERS');

  const unknownWriters = writerEvidence.filter((writer) => writer.unknown).length;
  const unknownByReason: Record<UnknownReason, number> = {
    UNSUPPORTED_OPERATION: 0,
    OUT_OF_CONTRACT_COLLECTION: 0,
    MISSING_INGRESS: 0,
    UNAPPROVED_INGRESS: 0,
    ROUTE_CONTRACT_MISMATCH: 0,
    UNKNOWN_SINK_TYPE: 0,
    DIRECT_DRIVER_CODE: 0,
    UNREVIEWED_FUNCTION: 0,
    FUNCTION_ALLOWLIST_EXTRA: 0,
  };
  for (const writer of writerEvidence)
    for (const reason of writer.unknownReasons) unknownByReason[reason] += 1;
  if (unknownWriters > 0) blockers.push('NODE_RED_UNKNOWN_WRITERS');
  const activeFunctionDigests = new Set(
    nodes
      .filter((node) => isRuntimeActive(node, byId) && node.type === 'function')
      .map(calculateCommunitiesNodeRedFunctionDigest),
  );
  const unreviewedFunctions = [...activeFunctionDigests].filter(
    (functionDigest) => !reviewedFunctionDigests.has(functionDigest),
  ).length;
  const extraFunctionDigests = [...reviewedFunctionDigests].filter(
    (functionDigest) => !activeFunctionDigests.has(functionDigest),
  ).length;
  unknownByReason.UNREVIEWED_FUNCTION = unreviewedFunctions;
  unknownByReason.FUNCTION_ALLOWLIST_EXTRA = extraFunctionDigests;
  if (unreviewedFunctions > 0 || extraFunctionDigests > 0)
    blockers.push('NODE_RED_FUNCTION_ALLOWLIST_MISMATCH');
  if (writerEvidence.length === 0) blockers.push('NODE_RED_WRITERS_EMPTY');
  const unknown =
    unknownWriters +
    duplicateIds +
    danglingWires +
    unreviewedFunctions +
    extraFunctionDigests +
    (writerEvidence.length === 0 ? 1 : 0);
  const inventoryDigest = digest([
    'communities-node-red-writer-inventory-v1',
    `sourceFlowSha256\0${sourceFlowSha256}`,
    `functionAllowlistSha256\0${functionAllowlistSha256}`,
    `reviewedFunctions\0${[...reviewedFunctionDigests].sort().join(',')}`,
    ...writerEvidence
      .map((writer) =>
        [
          writer.flowId,
          writer.nodeId,
          writer.collection,
          writer.operation,
          writer.unknownReasons.join(','),
          ...writer.ingress,
        ].join('\0'),
      )
      .sort(),
    `duplicateIds\0${duplicateIds}`,
    `danglingWires\0${danglingWires}`,
    `duplicateHandlers\0${duplicateHandlers}`,
    `total\0${writerEvidence.length}`,
    `unknown\0${unknown}`,
    `unknownByReason\0${Object.entries(unknownByReason)
      .map(([reason, count]) => `${reason}:${count}`)
      .join(',')}`,
    `blockers\0${[...blockers].sort().join(',')}`,
    `outcome\0${blockers.length === 0 ? 'NODE_RED_WRITER_INVENTORY_COMPLETE' : 'NO_GO'}`,
  ]);

  return {
    schemaVersion: 'communities-node-red-writer-inventory-report-v1',
    outcome: blockers.length === 0 ? 'NODE_RED_WRITER_INVENTORY_COMPLETE' : 'NO_GO',
    authorizesMutation: false,
    total: writerEvidence.length,
    inventoryDigest,
    sourceFlowSha256,
    functionAllowlistSha256,
    unknown,
    unknownByReason,
    duplicateHandlers,
    blockers,
  };
}
