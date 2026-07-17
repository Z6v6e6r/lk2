import { createHash } from 'node:crypto';

import type { GameRepository, StoredGameCardProjection } from '@phub/database';
import {
  GAME_PLAYER_LEVELS,
  projectGameCard,
  projectPublicGameCard,
  type GameCardView,
  type GameKind,
  type GamePlayerLevel,
  type PublicGameCardView,
} from '@phub/games';

type CardReadRepository = Pick<
  GameRepository,
  'getCardProjection' | 'listPublicCardProjections' | 'listViewerCardProjections'
>;

export interface PublicGameFilters {
  readonly stationId?: string;
  readonly startsFrom?: string;
  readonly startsTo?: string;
  readonly kind?: GameKind;
  readonly levelFrom?: GamePlayerLevel;
  readonly levelTo?: GamePlayerLevel;
  readonly availability: 'JOINABLE' | 'INCLUDE_FULL';
}

export interface ViewerGameCard extends GameCardView {
  readonly conversation: null;
}

interface CursorPayload {
  readonly v: 1;
  readonly queryHash: string;
  readonly startsAt: string;
  readonly gameId: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const MAX_SCAN_PAGES = 5;
const SCAN_PAGE_SIZE = 100;

function queryHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeCursor(value: string, expectedHash: string): CursorPayload {
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
      throw new Error('shape');
    }
    const payload = decoded as Record<string, unknown>;
    if (
      Object.keys(payload).sort().join(',') !== 'gameId,queryHash,startsAt,v' ||
      payload.v !== 1 ||
      typeof payload.queryHash !== 'string' ||
      !HASH_PATTERN.test(payload.queryHash) ||
      payload.queryHash !== expectedHash ||
      typeof payload.startsAt !== 'string' ||
      Number.isNaN(Date.parse(payload.startsAt)) ||
      typeof payload.gameId !== 'string' ||
      !UUID_PATTERN.test(payload.gameId)
    ) {
      throw new Error('fields');
    }
    return payload as unknown as CursorPayload;
  } catch {
    throw new Error('GAME_CURSOR_INVALID');
  }
}

function levelIndex(level: GamePlayerLevel): number {
  return GAME_PLAYER_LEVELS.indexOf(level);
}

function matchesPublicFilters(card: PublicGameCardView, filters: PublicGameFilters): boolean {
  if (filters.stationId && card.station.id !== filters.stationId) return false;
  if (filters.kind && card.kind !== filters.kind) return false;
  if (filters.startsFrom && Date.parse(card.startsAt) < Date.parse(filters.startsFrom))
    return false;
  if (filters.startsTo && Date.parse(card.startsAt) >= Date.parse(filters.startsTo)) return false;
  if (
    filters.availability === 'JOINABLE' &&
    !card.allowedActions.some((action) => action === 'JOIN' || action === 'JOIN_WAITLIST')
  ) {
    return false;
  }
  if (filters.levelFrom || filters.levelTo) {
    const cardFrom = card.levelRange?.from ? levelIndex(card.levelRange.from) : 0;
    const cardTo = card.levelRange?.to
      ? levelIndex(card.levelRange.to)
      : GAME_PLAYER_LEVELS.length - 1;
    const requestedFrom = filters.levelFrom ? levelIndex(filters.levelFrom) : 0;
    const requestedTo = filters.levelTo
      ? levelIndex(filters.levelTo)
      : GAME_PLAYER_LEVELS.length - 1;
    if (cardTo < requestedFrom || cardFrom > requestedTo) return false;
  }
  return true;
}

function cursorTuple(projection: StoredGameCardProjection, hash: string): CursorPayload {
  return { v: 1, queryHash: hash, startsAt: projection.startsAt, gameId: projection.gameId };
}

export async function listPublicGameCards(input: {
  readonly repository: CardReadRepository;
  readonly tenantId: string;
  readonly now: string;
  readonly limit: number;
  readonly filters: PublicGameFilters;
  readonly cursor?: string;
}): Promise<{ readonly items: readonly PublicGameCardView[]; readonly nextCursor: string | null }> {
  const hash = queryHash({ surface: 'DISCOVER', ...input.filters });
  let after = input.cursor ? decodeCursor(input.cursor, hash) : undefined;
  const matches: {
    readonly card: PublicGameCardView;
    readonly projection: StoredGameCardProjection;
  }[] = [];
  let lastScanned: StoredGameCardProjection | undefined;
  let moreCandidates = false;

  for (let pageNumber = 0; pageNumber < MAX_SCAN_PAGES; pageNumber += 1) {
    const page = await input.repository.listPublicCardProjections({
      tenantId: input.tenantId,
      limit: SCAN_PAGE_SIZE,
      ...(after ? { after: { startsAt: after.startsAt, gameId: after.gameId } } : {}),
    });
    for (const projection of page.items) {
      lastScanned = projection;
      const card = projectPublicGameCard(projection.basePayload, {
        surface: 'DISCOVER',
        now: input.now,
      });
      if (matchesPublicFilters(card, input.filters)) {
        matches.push({ card, projection });
        if (matches.length > input.limit) break;
      }
    }
    if (matches.length > input.limit) {
      moreCandidates = true;
      break;
    }
    if (!page.next) {
      moreCandidates = false;
      break;
    }
    moreCandidates = true;
    after = { v: 1, queryHash: hash, ...page.next };
  }

  const visible = matches.slice(0, input.limit);
  const cursorProjection = visible.at(-1)?.projection ?? lastScanned;
  return {
    items: visible.map((item) => item.card),
    nextCursor:
      moreCandidates && cursorProjection ? encodeCursor(cursorTuple(cursorProjection, hash)) : null,
  };
}

export async function getPublicGameCard(input: {
  readonly repository: CardReadRepository;
  readonly tenantId: string;
  readonly gameId: string;
  readonly now: string;
}): Promise<PublicGameCardView | undefined> {
  const projection = await input.repository.getCardProjection(input.tenantId, input.gameId);
  if (
    !projection ||
    projection.visibility !== 'PUBLIC' ||
    projection.lifecycleState !== 'SCHEDULED'
  ) {
    return undefined;
  }
  return projectPublicGameCard(projection.basePayload, { surface: 'DISCOVER', now: input.now });
}

export async function listViewerGameCards(input: {
  readonly repository: CardReadRepository;
  readonly tenantId: string;
  readonly viewerUserId: string;
  readonly scope: 'UPCOMING' | 'HISTORY';
  readonly now: string;
  readonly limit: number;
  readonly cursor?: string;
}): Promise<{ readonly items: readonly ViewerGameCard[]; readonly nextCursor: string | null }> {
  const hash = queryHash({ surface: 'VIEWER', scope: input.scope, userId: input.viewerUserId });
  const after = input.cursor ? decodeCursor(input.cursor, hash) : undefined;
  const page = await input.repository.listViewerCardProjections({
    tenantId: input.tenantId,
    viewerUserId: input.viewerUserId,
    scope: input.scope,
    limit: input.limit,
    ...(after ? { after: { startsAt: after.startsAt, gameId: after.gameId } } : {}),
  });
  const surface = input.scope === 'HISTORY' ? 'HISTORY' : 'MY_UPCOMING';
  return {
    items: page.items.map((projection) => ({
      ...projectGameCard(projection.basePayload, {
        surface,
        now: input.now,
        viewerUserId: input.viewerUserId,
      }),
      conversation: null,
    })),
    nextCursor: page.next ? encodeCursor({ v: 1, queryHash: hash, ...page.next }) : null,
  };
}

export async function getViewerGameCard(input: {
  readonly repository: CardReadRepository;
  readonly tenantId: string;
  readonly viewerUserId: string;
  readonly gameId: string;
  readonly now: string;
}): Promise<ViewerGameCard | undefined> {
  const projection = await input.repository.getCardProjection(input.tenantId, input.gameId);
  if (!projection) return undefined;
  const surface =
    projection.lifecycleState === 'FINISHED' || projection.lifecycleState === 'CANCELLED'
      ? 'HISTORY'
      : 'MY_UPCOMING';
  const card = projectGameCard(projection.basePayload, {
    surface,
    now: input.now,
    viewerUserId: input.viewerUserId,
  });
  if (card.viewerRelation === 'NONE' || card.viewerRelation === 'ANONYMOUS') return undefined;
  return { ...card, conversation: null };
}
