import { z } from 'zod';

export const GAME_LIFECYCLE_STATES = [
  'DRAFT',
  'PROVISIONING',
  'SCHEDULED',
  'IN_PROGRESS',
  'FINISHED',
  'CANCELLED',
] as const;
export type GameLifecycleState = (typeof GAME_LIFECYCLE_STATES)[number];

export const GAME_ROSTER_STATES = ['OPEN', 'LAST_SPOT', 'FULL', 'WAITLIST_ONLY', 'LOCKED'] as const;
export type GameRosterState = (typeof GAME_ROSTER_STATES)[number];

export const GAME_VIEWER_RELATIONS = [
  'ANONYMOUS',
  'NONE',
  'ORGANIZER',
  'SEAT_RESERVED',
  'PARTICIPANT',
  'WAITLISTED',
] as const;
export type GameViewerRelation = (typeof GAME_VIEWER_RELATIONS)[number];

export const GAME_PAYMENT_STATES = [
  'NOT_REQUIRED',
  'REQUIRES_ACTION',
  'PROCESSING',
  'PAID',
  'FAILED',
  'EXPIRED',
  'REFUND_PENDING',
  'REFUNDED',
] as const;
export type GamePaymentState = (typeof GAME_PAYMENT_STATES)[number];

export const GAME_RESULT_STATES = [
  'NOT_AVAILABLE',
  'AWAITING_SUBMISSION',
  'PENDING_CONFIRMATION',
  'CONFIRMED',
  'DISPUTED',
  'VOID',
] as const;
export type GameResultState = (typeof GAME_RESULT_STATES)[number];

export const GAME_CARD_DISPLAY_STATES = [
  'FINDING_PLAYERS',
  'ONE_SPOT_LEFT',
  'ROSTER_READY',
  'SEAT_PAYMENT_REQUIRED',
  'STARTING_SOON',
  'REGISTRATION_CLOSED',
  'IN_PROGRESS',
  'RESULT_REQUIRED',
  'RESULT_PENDING',
  'RESULT_DISPUTED',
  'COMPLETED',
  'CANCELLED',
] as const;
export type GameCardDisplayState = (typeof GAME_CARD_DISPLAY_STATES)[number];

export const GAME_CARD_SURFACES = [
  'DISCOVER',
  'MY_UPCOMING',
  'HISTORY',
  'INVITE',
  'ADMIN_PREVIEW',
] as const;
export type GameCardSurface = (typeof GAME_CARD_SURFACES)[number];

export const GAME_ALLOWED_ACTIONS = [
  'OPEN_DETAILS',
  'JOIN',
  'JOIN_WAITLIST',
  'LEAVE_WAITLIST',
  'LEAVE',
  'PAY',
  'RETRY_PAYMENT',
  'INVITE',
  'EDIT',
  'CANCEL',
  'SUBMIT_RESULT',
  'CONFIRM_RESULT',
  'DISPUTE_RESULT',
  'OPEN_CHAT',
  'VIEW_RESULT',
  'OPEN_DISPUTE',
] as const;
export type GameAllowedAction = (typeof GAME_ALLOWED_ACTIONS)[number];

export const GAME_CARD_BADGES = [
  'RATING',
  'PRIVATE',
  'WAITLISTED',
  'VIEWER_ORGANIZER',
  'REFUND_PENDING',
] as const;
export type GameCardBadge = (typeof GAME_CARD_BADGES)[number];

export const GAME_KINDS = ['FRIENDLY', 'RATING', 'PRIVATE', 'COACH_GAME'] as const;
export type GameKind = (typeof GAME_KINDS)[number];

export const GAME_VISIBILITIES = ['PUBLIC', 'PRIVATE', 'COMMUNITY'] as const;
export type GameVisibility = (typeof GAME_VISIBILITIES)[number];

export const GAME_PLAYER_LEVELS = ['D', 'D+', 'C', 'C+', 'B', 'B+', 'A'] as const;
export type GamePlayerLevel = (typeof GAME_PLAYER_LEVELS)[number];

export const GAME_DOMAIN_ERROR_CODES = [
  'GAME_SNAPSHOT_INVALID',
  'GAME_ILLEGAL_LIFECYCLE_TRANSITION',
  'GAME_NOT_CARD_VISIBLE',
  'GAME_CAPACITY_INVARIANT_VIOLATION',
  'GAME_NOT_JOINABLE',
  'GAME_JOIN_CUTOFF_PASSED',
  'GAME_ALREADY_JOINED',
  'GAME_ALREADY_RESERVED',
  'GAME_ALREADY_WAITLISTED',
  'GAME_FULL',
  'GAME_WAITLIST_DISABLED',
  'GAME_WAITLIST_NOT_AVAILABLE',
  'GAME_NOT_LEAVABLE',
  'GAME_ORGANIZER_MUST_CANCEL',
  'GAME_NOT_WAITLISTED',
] as const;
export type GameDomainErrorCode = (typeof GAME_DOMAIN_ERROR_CODES)[number];

export class GameDomainError extends Error {
  public constructor(
    public readonly code: GameDomainErrorCode,
    message: string = code,
  ) {
    super(message);
    this.name = 'GameDomainError';
  }
}

const LIFECYCLE_TRANSITIONS: Readonly<Record<GameLifecycleState, readonly GameLifecycleState[]>> = {
  DRAFT: ['PROVISIONING', 'CANCELLED'],
  PROVISIONING: ['SCHEDULED', 'CANCELLED'],
  SCHEDULED: ['IN_PROGRESS', 'CANCELLED'],
  IN_PROGRESS: ['FINISHED', 'CANCELLED'],
  FINISHED: [],
  CANCELLED: [],
};

export function canTransitionGameLifecycle(
  from: GameLifecycleState,
  to: GameLifecycleState,
): boolean {
  return LIFECYCLE_TRANSITIONS[from].includes(to);
}

export function assertGameLifecycleTransition(
  from: GameLifecycleState,
  to: GameLifecycleState,
): void {
  if (!canTransitionGameLifecycle(from, to)) {
    throw new GameDomainError(
      'GAME_ILLEGAL_LIFECYCLE_TRANSITION',
      `Game lifecycle cannot transition from ${from} to ${to}`,
    );
  }
}

const uuid = z.string().uuid();
const dateTime = z.string().datetime({ offset: true });

const participantSchema = z
  .object({
    userId: uuid,
    displayName: z.string().trim().min(1).max(120),
    avatarUrl: z.string().url().max(2_048).nullable().optional(),
    level: z.enum(GAME_PLAYER_LEVELS).nullable().optional(),
    role: z.enum(['ORGANIZER', 'PLAYER']),
    paymentState: z
      .enum(['NOT_REQUIRED', 'PAID', 'REFUND_PENDING', 'REFUNDED'])
      .default('NOT_REQUIRED'),
  })
  .strict();

const seatReservationSchema = z
  .object({
    id: uuid,
    userId: uuid,
    expiresAt: dateTime,
    paymentState: z.enum(['REQUIRES_ACTION', 'PROCESSING', 'PAID', 'FAILED', 'EXPIRED']),
  })
  .strict();

const waitlistEntrySchema = z
  .object({
    userId: uuid,
    position: z.number().int().positive(),
  })
  .strict();

const resultSchema = z
  .object({
    state: z.enum(GAME_RESULT_STATES),
    submittedByUserId: uuid.nullable().optional(),
    requiredConfirmationUserIds: z.array(uuid).max(4).default([]),
    confirmedByUserIds: z.array(uuid).max(4).default([]),
    sets: z
      .array(
        z
          .object({
            teamA: z.number().int().min(0).max(99),
            teamB: z.number().int().min(0).max(99),
          })
          .strict(),
      )
      .min(1)
      .max(9)
      .optional(),
  })
  .strict();

export const gameCardProjectionInputSchema = z
  .object({
    id: uuid,
    tenantId: uuid,
    revision: z.number().int().nonnegative(),
    organizerUserId: uuid,
    title: z.string().trim().min(1).max(160),
    kind: z.enum(GAME_KINDS),
    visibility: z.enum(GAME_VISIBILITIES),
    lifecycleState: z.enum(GAME_LIFECYCLE_STATES),
    startsAt: dateTime,
    endsAt: dateTime,
    timezone: z.string().trim().min(1).max(64),
    station: z
      .object({
        id: uuid,
        name: z.string().trim().min(1).max(160),
        shortAddress: z.string().trim().min(1).max(240).nullable().optional(),
      })
      .strict(),
    levelRange: z
      .object({
        from: z.enum(GAME_PLAYER_LEVELS).nullable(),
        to: z.enum(GAME_PLAYER_LEVELS).nullable(),
      })
      .strict()
      .nullable()
      .optional(),
    capacity: z.number().int().min(2).max(4),
    participants: z.array(participantSchema).max(4),
    seatReservations: z.array(seatReservationSchema).max(4).default([]),
    waitlist: z.array(waitlistEntrySchema).max(100).default([]),
    waitlistEnabled: z.boolean().default(false),
    joinCutoffAt: dateTime.nullable().optional(),
    priceSummary: z
      .object({
        amountMinor: z.number().int().nonnegative(),
        currency: z.literal('RUB'),
      })
      .strict()
      .nullable()
      .optional(),
    result: resultSchema.optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (Date.parse(input.endsAt) <= Date.parse(input.startsAt)) {
      context.addIssue({
        code: 'custom',
        path: ['endsAt'],
        message: 'endsAt must be later than startsAt',
      });
    }

    const owners = [
      ...input.participants.map((participant) => participant.userId),
      ...input.seatReservations.map((reservation) => reservation.userId),
      ...input.waitlist.map((entry) => entry.userId),
    ];
    if (new Set(owners).size !== owners.length) {
      context.addIssue({
        code: 'custom',
        path: ['participants'],
        message: 'A user cannot occupy multiple roster states',
      });
    }

    const waitlistPositions = input.waitlist.map((entry) => entry.position);
    if (new Set(waitlistPositions).size !== waitlistPositions.length) {
      context.addIssue({
        code: 'custom',
        path: ['waitlist'],
        message: 'Waitlist positions must be unique',
      });
    }

    const organizerParticipants = input.participants.filter(
      (participant) => participant.role === 'ORGANIZER',
    );
    const requiresOrganizerParticipation = ['SCHEDULED', 'IN_PROGRESS', 'FINISHED'].includes(
      input.lifecycleState,
    );
    if (
      organizerParticipants.length > 1 ||
      organizerParticipants.some((participant) => participant.userId !== input.organizerUserId) ||
      (requiresOrganizerParticipation && organizerParticipants.length !== 1)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['participants'],
        message: 'An active game must have one organizer participant matching organizerUserId',
      });
    }

    if (
      input.lifecycleState !== 'SCHEDULED' &&
      (input.seatReservations.length > 0 || input.waitlist.length > 0)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['seatReservations'],
        message: 'Seat reservations and waitlist entries are active only for scheduled games',
      });
    }

    const resultState = input.result?.state ?? 'NOT_AVAILABLE';
    if (
      input.lifecycleState !== 'FINISHED' &&
      input.lifecycleState !== 'CANCELLED' &&
      resultState !== 'NOT_AVAILABLE'
    ) {
      context.addIssue({
        code: 'custom',
        path: ['result', 'state'],
        message: 'Result workflow is available only after a game has finished',
      });
    }
    if (input.lifecycleState === 'CANCELLED' && !['NOT_AVAILABLE', 'VOID'].includes(resultState)) {
      context.addIssue({
        code: 'custom',
        path: ['result', 'state'],
        message: 'A cancelled game may only have a void result',
      });
    }
    if (input.lifecycleState === 'FINISHED' && resultState === 'NOT_AVAILABLE') {
      context.addIssue({
        code: 'custom',
        path: ['result', 'state'],
        message:
          'A finished game must expose an awaiting, submitted, confirmed, disputed or void result state',
      });
    }

    const result = input.result;
    if (result) {
      const hasSubmissionFacts =
        result.submittedByUserId !== null && result.submittedByUserId !== undefined;
      const hasSets = result.sets !== undefined;
      const hasReviewFacts =
        result.requiredConfirmationUserIds.length > 0 || result.confirmedByUserIds.length > 0;
      if (
        ['NOT_AVAILABLE', 'AWAITING_SUBMISSION'].includes(result.state) &&
        (hasSubmissionFacts || hasSets || hasReviewFacts)
      ) {
        context.addIssue({
          code: 'custom',
          path: ['result'],
          message: `${result.state} cannot contain submission or confirmation facts`,
        });
      }
      if (
        ['PENDING_CONFIRMATION', 'CONFIRMED', 'DISPUTED'].includes(result.state) &&
        (!hasSubmissionFacts || !hasSets)
      ) {
        context.addIssue({
          code: 'custom',
          path: ['result'],
          message: `${result.state} requires a submitter and set scores`,
        });
      }
      if (
        result.state === 'PENDING_CONFIRMATION' &&
        result.requiredConfirmationUserIds.length === 0
      ) {
        context.addIssue({
          code: 'custom',
          path: ['result', 'requiredConfirmationUserIds'],
          message: 'A pending result requires at least one reviewer',
        });
      }
      if (
        result.state === 'CONFIRMED' &&
        result.requiredConfirmationUserIds.some(
          (userId) => !result.confirmedByUserIds.includes(userId),
        )
      ) {
        context.addIssue({
          code: 'custom',
          path: ['result', 'confirmedByUserIds'],
          message: 'A confirmed result must include every required confirmation',
        });
      }
    }

    const participantIds = new Set(input.participants.map((participant) => participant.userId));
    const resultActorIds = [
      ...(input.result?.requiredConfirmationUserIds ?? []),
      ...(input.result?.confirmedByUserIds ?? []),
      ...(input.result?.submittedByUserId ? [input.result.submittedByUserId] : []),
    ];
    if (
      new Set(input.result?.requiredConfirmationUserIds ?? []).size !==
        (input.result?.requiredConfirmationUserIds.length ?? 0) ||
      new Set(input.result?.confirmedByUserIds ?? []).size !==
        (input.result?.confirmedByUserIds.length ?? 0) ||
      resultActorIds.some((userId) => !participantIds.has(userId))
    ) {
      context.addIssue({
        code: 'custom',
        path: ['result'],
        message: 'Result actors must be unique current participants',
      });
    }
  });

export type GameCardProjectionInput = z.infer<typeof gameCardProjectionInputSchema>;

export interface GameCardProjectionContext {
  readonly surface: GameCardSurface;
  readonly now: string;
  readonly viewerUserId?: string;
  readonly startingSoonMinutes?: number;
}

export interface GameCapacityView {
  readonly total: number;
  readonly occupied: number;
  readonly reserved: number;
  readonly open: number;
  readonly waitlistCount: number;
}

export interface GameCardParticipantView {
  readonly userId: string;
  readonly displayName: string;
  readonly avatarUrl: string | null;
  readonly level: GamePlayerLevel | null;
  readonly role: 'ORGANIZER' | 'PLAYER';
}

export interface PublicGameCardParticipantView {
  readonly displayName: string;
  readonly avatarUrl: string | null;
  readonly level: GamePlayerLevel | null;
  readonly role: 'ORGANIZER' | 'PLAYER';
}

export interface GameResultSummaryView {
  readonly state: GameResultState;
  readonly sets?: readonly { readonly teamA: number; readonly teamB: number }[];
}

export interface GameCardView {
  readonly id: string;
  readonly revision: number;
  readonly surface: GameCardSurface;
  readonly displayState: GameCardDisplayState;
  readonly title: string;
  readonly kind: GameKind;
  readonly visibility: GameVisibility;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly timezone: string;
  readonly station: {
    readonly id: string;
    readonly name: string;
    readonly shortAddress: string | null;
  };
  readonly levelRange: {
    readonly from: GamePlayerLevel | null;
    readonly to: GamePlayerLevel | null;
  } | null;
  readonly rosterState: GameRosterState;
  readonly capacity: GameCapacityView;
  readonly participants: readonly GameCardParticipantView[];
  readonly priceSummary: { readonly amountMinor: number; readonly currency: 'RUB' } | null;
  readonly viewerRelation: GameViewerRelation;
  readonly viewerPaymentState: GamePaymentState;
  readonly resultSummary: GameResultSummaryView | null;
  readonly badges: readonly GameCardBadge[];
  readonly allowedActions: readonly GameAllowedAction[];
  readonly deepLink: string;
}

export interface PublicGameCardView extends Omit<
  GameCardView,
  'participants' | 'viewerRelation' | 'viewerPaymentState' | 'resultSummary'
> {
  readonly participants: readonly PublicGameCardParticipantView[];
  readonly viewerRelation: 'ANONYMOUS';
  readonly viewerPaymentState: 'NOT_REQUIRED';
}

const ACTIVE_RESERVATION_PAYMENT_STATES: readonly GamePaymentState[] = [
  'REQUIRES_ACTION',
  'PROCESSING',
  'PAID',
  'FAILED',
];

function parseProjectionInput(input: unknown): GameCardProjectionInput {
  const parsed = gameCardProjectionInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new GameDomainError('GAME_SNAPSHOT_INVALID', z.prettifyError(parsed.error));
  }
  return parsed.data;
}

function parseInstant(value: string, field: string): number {
  const instant = Date.parse(value);
  if (!Number.isFinite(instant)) {
    throw new GameDomainError('GAME_SNAPSHOT_INVALID', `${field} must be an ISO date-time`);
  }
  return instant;
}

function activeReservations(input: GameCardProjectionInput, nowMs: number) {
  return input.seatReservations.filter(
    (reservation) =>
      ACTIVE_RESERVATION_PAYMENT_STATES.includes(reservation.paymentState) &&
      parseInstant(reservation.expiresAt, 'seatReservations.expiresAt') > nowMs,
  );
}

export function deriveGameCapacity(
  rawInput: GameCardProjectionInput,
  now: string,
): GameCapacityView {
  const input = parseProjectionInput(rawInput);
  const nowMs = parseInstant(now, 'now');
  const reservations = activeReservations(input, nowMs);
  const occupied = input.participants.length;
  const reserved = reservations.length;
  const open = input.capacity - occupied - reserved;
  if (open < 0) {
    throw new GameDomainError(
      'GAME_CAPACITY_INVARIANT_VIOLATION',
      'Confirmed participants and active seat reservations exceed game capacity',
    );
  }
  return {
    total: input.capacity,
    occupied,
    reserved,
    open,
    waitlistCount: input.waitlist.length,
  };
}

export function deriveGameRosterState(
  rawInput: GameCardProjectionInput,
  now: string,
): GameRosterState {
  const input = parseProjectionInput(rawInput);
  const nowMs = parseInstant(now, 'now');
  if (
    input.lifecycleState !== 'SCHEDULED' ||
    nowMs >= parseInstant(input.startsAt, 'startsAt') ||
    (input.joinCutoffAt !== null &&
      input.joinCutoffAt !== undefined &&
      nowMs >= parseInstant(input.joinCutoffAt, 'joinCutoffAt'))
  ) {
    return 'LOCKED';
  }

  const capacity = deriveGameCapacity(input, now);
  if (capacity.open === 0) return input.waitlistEnabled ? 'WAITLIST_ONLY' : 'FULL';
  if (capacity.open === 1) return 'LAST_SPOT';
  return 'OPEN';
}

export function deriveGameViewerRelation(
  rawInput: GameCardProjectionInput,
  now: string,
  viewerUserId?: string,
): GameViewerRelation {
  const input = parseProjectionInput(rawInput);
  if (!viewerUserId) return 'ANONYMOUS';
  if (!uuid.safeParse(viewerUserId).success) {
    throw new GameDomainError('GAME_SNAPSHOT_INVALID', 'viewerUserId must be a UUID');
  }
  if (input.organizerUserId === viewerUserId) return 'ORGANIZER';
  if (input.participants.some((participant) => participant.userId === viewerUserId)) {
    return 'PARTICIPANT';
  }
  if (
    activeReservations(input, parseInstant(now, 'now')).some(
      (reservation) => reservation.userId === viewerUserId,
    )
  ) {
    return 'SEAT_RESERVED';
  }
  if (input.waitlist.some((entry) => entry.userId === viewerUserId)) return 'WAITLISTED';
  return 'NONE';
}

function deriveViewerPaymentState(
  input: GameCardProjectionInput,
  now: string,
  viewerUserId: string | undefined,
): GamePaymentState {
  if (!viewerUserId) return 'NOT_REQUIRED';
  const participant = input.participants.find((item) => item.userId === viewerUserId);
  if (participant) return participant.paymentState;
  const reservation = activeReservations(input, parseInstant(now, 'now')).find(
    (item) => item.userId === viewerUserId,
  );
  return reservation?.paymentState ?? 'NOT_REQUIRED';
}

function resultStateOf(input: GameCardProjectionInput): GameResultState {
  return (
    input.result?.state ??
    (input.lifecycleState === 'FINISHED' ? 'AWAITING_SUBMISSION' : 'NOT_AVAILABLE')
  );
}

function deriveDisplayState(input: {
  readonly game: GameCardProjectionInput;
  readonly now: string;
  readonly viewerRelation: GameViewerRelation;
  readonly viewerPaymentState: GamePaymentState;
  readonly rosterState: GameRosterState;
  readonly startingSoonMinutes: number;
}): GameCardDisplayState {
  const { game } = input;
  if (game.lifecycleState === 'DRAFT' || game.lifecycleState === 'PROVISIONING') {
    throw new GameDomainError(
      'GAME_NOT_CARD_VISIBLE',
      `${game.lifecycleState} games use the creation operation view, not GameCardView`,
    );
  }
  if (game.lifecycleState === 'CANCELLED') return 'CANCELLED';
  if (
    input.viewerRelation === 'SEAT_RESERVED' &&
    (input.viewerPaymentState === 'REQUIRES_ACTION' || input.viewerPaymentState === 'FAILED')
  ) {
    return 'SEAT_PAYMENT_REQUIRED';
  }

  const resultState = resultStateOf(game);
  if (resultState === 'DISPUTED') return 'RESULT_DISPUTED';
  if (resultState === 'PENDING_CONFIRMATION') return 'RESULT_PENDING';
  if (game.lifecycleState === 'FINISHED') {
    if (
      resultState === 'AWAITING_SUBMISSION' &&
      (input.viewerRelation === 'ORGANIZER' || input.viewerRelation === 'PARTICIPANT')
    ) {
      return 'RESULT_REQUIRED';
    }
    return 'COMPLETED';
  }
  if (game.lifecycleState === 'IN_PROGRESS') return 'IN_PROGRESS';

  const nowMs = parseInstant(input.now, 'now');
  const startsAtMs = parseInstant(game.startsAt, 'startsAt');
  const startingSoonMs = input.startingSoonMinutes * 60_000;
  if (startsAtMs > nowMs && startsAtMs - nowMs <= startingSoonMs) return 'STARTING_SOON';

  switch (input.rosterState) {
    case 'OPEN':
      return 'FINDING_PLAYERS';
    case 'LAST_SPOT':
      return 'ONE_SPOT_LEFT';
    case 'FULL':
    case 'WAITLIST_ONLY':
      return 'ROSTER_READY';
    case 'LOCKED':
      return 'REGISTRATION_CLOSED';
  }
}

function deriveAllowedActions(input: {
  readonly game: GameCardProjectionInput;
  readonly now: string;
  readonly viewerUserId?: string;
  readonly viewerRelation: GameViewerRelation;
  readonly viewerPaymentState: GamePaymentState;
  readonly rosterState: GameRosterState;
}): readonly GameAllowedAction[] {
  const actions = new Set<GameAllowedAction>(['OPEN_DETAILS']);
  const { game, viewerRelation } = input;

  if (game.lifecycleState === 'CANCELLED') return [...actions];

  if (viewerRelation === 'SEAT_RESERVED') {
    if (input.viewerPaymentState === 'REQUIRES_ACTION') actions.add('PAY');
    if (input.viewerPaymentState === 'FAILED') actions.add('RETRY_PAYMENT');
  }

  if (game.lifecycleState === 'SCHEDULED') {
    if (viewerRelation === 'ANONYMOUS' || viewerRelation === 'NONE') {
      if (input.rosterState === 'OPEN' || input.rosterState === 'LAST_SPOT') actions.add('JOIN');
      if (input.rosterState === 'WAITLIST_ONLY') actions.add('JOIN_WAITLIST');
    }
    if (viewerRelation === 'PARTICIPANT' && input.rosterState !== 'LOCKED') {
      actions.add('LEAVE');
    }
    if (viewerRelation === 'WAITLISTED') actions.add('LEAVE_WAITLIST');
    if (viewerRelation === 'ORGANIZER') {
      if (input.rosterState === 'OPEN' || input.rosterState === 'LAST_SPOT') {
        actions.add('INVITE');
      }
      actions.add('EDIT');
      actions.add('CANCEL');
    }
  }

  if (viewerRelation === 'ORGANIZER' || viewerRelation === 'PARTICIPANT') {
    if (game.lifecycleState !== 'DRAFT' && game.lifecycleState !== 'PROVISIONING') {
      actions.add('OPEN_CHAT');
    }
  }

  const resultState = resultStateOf(game);
  if (
    game.lifecycleState === 'FINISHED' &&
    resultState === 'AWAITING_SUBMISSION' &&
    (viewerRelation === 'ORGANIZER' || viewerRelation === 'PARTICIPANT')
  ) {
    actions.add('SUBMIT_RESULT');
  }
  if (game.lifecycleState === 'FINISHED' && resultState === 'PENDING_CONFIRMATION') {
    const viewerUserId = input.viewerUserId;
    if (
      viewerUserId &&
      game.result?.requiredConfirmationUserIds.includes(viewerUserId) &&
      !game.result.confirmedByUserIds.includes(viewerUserId) &&
      game.result.submittedByUserId !== viewerUserId
    ) {
      actions.add('CONFIRM_RESULT');
      actions.add('DISPUTE_RESULT');
    }
  }
  if (resultState === 'DISPUTED') actions.add('OPEN_DISPUTE');
  if (resultState === 'CONFIRMED') actions.add('VIEW_RESULT');

  return GAME_ALLOWED_ACTIONS.filter((action) => actions.has(action));
}

function deriveBadges(
  input: GameCardProjectionInput,
  viewerRelation: GameViewerRelation,
  viewerPaymentState: GamePaymentState,
): readonly GameCardBadge[] {
  const badges = new Set<GameCardBadge>();
  if (input.kind === 'RATING') badges.add('RATING');
  if (input.visibility === 'PRIVATE') badges.add('PRIVATE');
  if (viewerRelation === 'WAITLISTED') badges.add('WAITLISTED');
  if (viewerRelation === 'ORGANIZER') badges.add('VIEWER_ORGANIZER');
  if (viewerPaymentState === 'REFUND_PENDING') badges.add('REFUND_PENDING');
  return GAME_CARD_BADGES.filter((badge) => badges.has(badge));
}

export function projectGameCard(
  rawInput: GameCardProjectionInput,
  context: GameCardProjectionContext,
): GameCardView {
  const input = parseProjectionInput(rawInput);
  const nowMs = parseInstant(context.now, 'now');
  const startingSoonMinutes = context.startingSoonMinutes ?? 180;
  if (
    !Number.isInteger(startingSoonMinutes) ||
    startingSoonMinutes < 0 ||
    startingSoonMinutes > 1_440
  ) {
    throw new GameDomainError(
      'GAME_SNAPSHOT_INVALID',
      'startingSoonMinutes must be an integer between 0 and 1440',
    );
  }

  const capacity = deriveGameCapacity(input, context.now);
  const rosterState = deriveGameRosterState(input, context.now);
  const viewerRelation = deriveGameViewerRelation(input, context.now, context.viewerUserId);
  const viewerPaymentState = deriveViewerPaymentState(input, context.now, context.viewerUserId);
  const resultState = resultStateOf(input);
  const displayState = deriveDisplayState({
    game: input,
    now: new Date(nowMs).toISOString(),
    viewerRelation,
    viewerPaymentState,
    rosterState,
    startingSoonMinutes,
  });
  const allowedActions = deriveAllowedActions({
    game: input,
    now: context.now,
    ...(context.viewerUserId ? { viewerUserId: context.viewerUserId } : {}),
    viewerRelation,
    viewerPaymentState,
    rosterState,
  });

  return {
    id: input.id,
    revision: input.revision,
    surface: context.surface,
    displayState,
    title: input.title,
    kind: input.kind,
    visibility: input.visibility,
    startsAt: input.startsAt,
    endsAt: input.endsAt,
    timezone: input.timezone,
    station: {
      id: input.station.id,
      name: input.station.name,
      shortAddress: input.station.shortAddress ?? null,
    },
    levelRange: input.levelRange ?? null,
    rosterState,
    capacity,
    participants: input.participants.map((participant) => ({
      userId: participant.userId,
      displayName: participant.displayName,
      avatarUrl: participant.avatarUrl ?? null,
      level: participant.level ?? null,
      role: participant.role,
    })),
    priceSummary: input.priceSummary ?? null,
    viewerRelation,
    viewerPaymentState,
    resultSummary:
      resultState === 'NOT_AVAILABLE'
        ? null
        : {
            state: resultState,
            ...(input.result?.sets ? { sets: input.result.sets } : {}),
          },
    badges: deriveBadges(input, viewerRelation, viewerPaymentState),
    allowedActions,
    deepLink: `/games/${input.id}`,
  };
}

export function projectPublicGameCard(
  rawInput: GameCardProjectionInput,
  context: Omit<GameCardProjectionContext, 'viewerUserId'>,
): PublicGameCardView {
  if (context.surface !== 'DISCOVER' && context.surface !== 'INVITE') {
    throw new GameDomainError(
      'GAME_SNAPSHOT_INVALID',
      'Public game cards are allowed only on DISCOVER and INVITE surfaces',
    );
  }
  const input = parseProjectionInput(rawInput);
  if (
    context.surface === 'DISCOVER' &&
    (input.visibility !== 'PUBLIC' || input.lifecycleState !== 'SCHEDULED')
  ) {
    throw new GameDomainError(
      'GAME_NOT_CARD_VISIBLE',
      'Public discovery contains only public scheduled games',
    );
  }
  const card = projectGameCard(input, context);
  const { resultSummary: privateResultSummary, ...publicCard } = card;
  void privateResultSummary;
  return {
    ...publicCard,
    viewerRelation: 'ANONYMOUS',
    viewerPaymentState: 'NOT_REQUIRED',
    participants: card.participants.map((participant) => ({
      displayName: participant.displayName,
      avatarUrl: participant.avatarUrl,
      level: participant.level,
      role: participant.role,
    })),
  };
}

export interface GameJoinPolicyContext {
  readonly now: string;
  readonly viewerUserId: string;
}

export interface GameRosterCommandFacts {
  readonly lifecycleState: GameLifecycleState;
  readonly startsAt: string;
  readonly joinCutoffAt: string | null;
  readonly capacity: number;
  readonly activeParticipantCount: number;
  readonly activeReservationCount: number;
  readonly waitlistEnabled: boolean;
  readonly viewerRelation: Exclude<GameViewerRelation, 'ANONYMOUS'>;
}

function assertRosterCommandFacts(facts: GameRosterCommandFacts, now: string): void {
  if (
    !Number.isInteger(facts.capacity) ||
    facts.capacity < 2 ||
    facts.capacity > 4 ||
    !Number.isInteger(facts.activeParticipantCount) ||
    facts.activeParticipantCount < 0 ||
    !Number.isInteger(facts.activeReservationCount) ||
    facts.activeReservationCount < 0 ||
    facts.activeParticipantCount + facts.activeReservationCount > facts.capacity
  ) {
    throw new GameDomainError('GAME_CAPACITY_INVARIANT_VIOLATION');
  }
  parseInstant(now, 'now');
  parseInstant(facts.startsAt, 'startsAt');
  if (facts.joinCutoffAt !== null) parseInstant(facts.joinCutoffAt, 'joinCutoffAt');
}

function assertBeforeJoinCutoff(facts: GameRosterCommandFacts, now: string): void {
  const nowMs = parseInstant(now, 'now');
  if (
    nowMs >= parseInstant(facts.startsAt, 'startsAt') ||
    (facts.joinCutoffAt !== null && nowMs >= parseInstant(facts.joinCutoffAt, 'joinCutoffAt'))
  ) {
    throw new GameDomainError('GAME_JOIN_CUTOFF_PASSED');
  }
}

function assertNewRosterUser(facts: GameRosterCommandFacts): void {
  if (facts.viewerRelation === 'ORGANIZER' || facts.viewerRelation === 'PARTICIPANT') {
    throw new GameDomainError('GAME_ALREADY_JOINED');
  }
  if (facts.viewerRelation === 'SEAT_RESERVED') {
    throw new GameDomainError('GAME_ALREADY_RESERVED');
  }
  if (facts.viewerRelation === 'WAITLISTED') {
    throw new GameDomainError('GAME_ALREADY_WAITLISTED');
  }
}

export function assertCanJoinGameFacts(facts: GameRosterCommandFacts, now: string): void {
  assertRosterCommandFacts(facts, now);
  assertNewRosterUser(facts);
  if (facts.lifecycleState !== 'SCHEDULED') throw new GameDomainError('GAME_NOT_JOINABLE');
  assertBeforeJoinCutoff(facts, now);
  if (facts.activeParticipantCount + facts.activeReservationCount >= facts.capacity) {
    throw new GameDomainError('GAME_FULL');
  }
}

export function assertCanJoinWaitlistFacts(facts: GameRosterCommandFacts, now: string): void {
  assertRosterCommandFacts(facts, now);
  if (!facts.waitlistEnabled) throw new GameDomainError('GAME_WAITLIST_DISABLED');
  assertNewRosterUser(facts);
  if (facts.lifecycleState !== 'SCHEDULED') {
    throw new GameDomainError('GAME_WAITLIST_NOT_AVAILABLE');
  }
  assertBeforeJoinCutoff(facts, now);
  if (facts.activeParticipantCount + facts.activeReservationCount < facts.capacity) {
    throw new GameDomainError('GAME_WAITLIST_NOT_AVAILABLE');
  }
}

export function assertCanLeaveGameFacts(facts: GameRosterCommandFacts, now: string): void {
  assertRosterCommandFacts(facts, now);
  if (facts.viewerRelation === 'ORGANIZER') {
    throw new GameDomainError('GAME_ORGANIZER_MUST_CANCEL');
  }
  if (facts.viewerRelation !== 'PARTICIPANT' || facts.lifecycleState !== 'SCHEDULED') {
    throw new GameDomainError('GAME_NOT_LEAVABLE');
  }
  try {
    assertBeforeJoinCutoff(facts, now);
  } catch (error) {
    if (error instanceof GameDomainError && error.code === 'GAME_JOIN_CUTOFF_PASSED') {
      throw new GameDomainError('GAME_NOT_LEAVABLE');
    }
    throw error;
  }
}

export function assertCanLeaveWaitlistFacts(facts: GameRosterCommandFacts, now: string): void {
  assertRosterCommandFacts(facts, now);
  if (facts.viewerRelation !== 'WAITLISTED' || facts.lifecycleState !== 'SCHEDULED') {
    throw new GameDomainError('GAME_NOT_WAITLISTED');
  }
}

function rosterFactsFromCard(
  input: GameCardProjectionInput,
  context: GameJoinPolicyContext,
): GameRosterCommandFacts {
  const nowMs = parseInstant(context.now, 'now');
  return {
    lifecycleState: input.lifecycleState,
    startsAt: input.startsAt,
    joinCutoffAt: input.joinCutoffAt ?? null,
    capacity: input.capacity,
    activeParticipantCount: input.participants.length,
    activeReservationCount: activeReservations(input, nowMs).length,
    waitlistEnabled: input.waitlistEnabled,
    viewerRelation: deriveGameViewerRelation(
      input,
      context.now,
      context.viewerUserId,
    ) as GameRosterCommandFacts['viewerRelation'],
  };
}

export function assertCanJoinGame(
  rawInput: GameCardProjectionInput,
  context: GameJoinPolicyContext,
): void {
  const input = parseProjectionInput(rawInput);
  assertCanJoinGameFacts(rosterFactsFromCard(input, context), context.now);
}

export function assertCanJoinWaitlist(
  rawInput: GameCardProjectionInput,
  context: GameJoinPolicyContext,
): void {
  const input = parseProjectionInput(rawInput);
  assertCanJoinWaitlistFacts(rosterFactsFromCard(input, context), context.now);
}

export function assertCanLeaveGame(
  rawInput: GameCardProjectionInput,
  context: GameJoinPolicyContext,
): void {
  const input = parseProjectionInput(rawInput);
  assertCanLeaveGameFacts(rosterFactsFromCard(input, context), context.now);
}

export const GAME_DOMAIN_EVENT_TYPES = [
  'game.created.v1',
  'game.provisioning.requested.v1',
  'game.scheduled.v1',
  'game.published.v1',
  'game.participation.reserved.v1',
  'game.participation.confirmed.v1',
  'game.participation.expired.v1',
  'game.participation.left.v1',
  'game.waitlist.joined.v1',
  'game.waitlist.left.v1',
  'game.waitlist.promoted.v1',
  'game.roster.completed.v1',
  'game.roster.reopened.v1',
  'game.started.v1',
  'game.finished.v1',
  'game.result.submitted.v1',
  'game.result.confirmed.v1',
  'game.result.disputed.v1',
  'game.cancelled.v1',
] as const;
export type GameDomainEventType = (typeof GAME_DOMAIN_EVENT_TYPES)[number];

export const GAME_INTERNAL_COMMAND_TYPES = [
  'game.provisioning.advance.v1',
  'game.reservation.expire.v1',
  'game.waitlist.promote.v1',
  'game.lifecycle.start.v1',
  'game.lifecycle.finish.v1',
  'game.integration.reconcile.v1',
] as const;
export type GameInternalCommandType = (typeof GAME_INTERNAL_COMMAND_TYPES)[number];

export const GAME_EVENT_CONSUMERS = [
  'games-process-manager',
  'games-card-projector',
  'home-projector',
  'messaging-membership',
  'notifications-rules',
  'rating-projector',
  'realtime-invalidation',
  'integration-compatibility',
] as const;
export type GameEventConsumer = (typeof GAME_EVENT_CONSUMERS)[number];

const eventRevision = z.string().regex(/^[1-9]\d*$/);
const eventUserIds = z
  .array(uuid)
  .max(4)
  .refine((items) => new Set(items).size === items.length, {
    message: 'User identifiers must be unique',
  });
const eventEnvelopeBase = z.object({
  id: uuid,
  aggregateId: uuid,
  tenantId: uuid,
  occurredAt: dateTime,
  correlationId: z.string().min(8).max(128),
});
const gameEventPayloadBase = {
  gameId: uuid,
  aggregateRevision: eventRevision,
  causationId: uuid,
  actorUserId: uuid.nullable(),
};

const gameCreatedEventSchema = eventEnvelopeBase
  .extend({
    type: z.literal('game.created.v1'),
    payload: z
      .object({
        ...gameEventPayloadBase,
        organizerUserId: uuid,
        kind: z.enum(GAME_KINDS),
        visibility: z.enum(GAME_VISIBILITIES),
      })
      .strict(),
  })
  .strict();

const gameProvisioningRequestedEventSchema = eventEnvelopeBase
  .extend({
    type: z.literal('game.provisioning.requested.v1'),
    payload: z.object({ ...gameEventPayloadBase, operationId: uuid }).strict(),
  })
  .strict();

const gameScheduledEventSchema = eventEnvelopeBase
  .extend({
    type: z.literal('game.scheduled.v1'),
    payload: z.object({ ...gameEventPayloadBase, organizerUserId: uuid }).strict(),
  })
  .strict();

const gamePublishedEventSchema = eventEnvelopeBase
  .extend({
    type: z.literal('game.published.v1'),
    payload: z.object({ ...gameEventPayloadBase, visibility: z.enum(GAME_VISIBILITIES) }).strict(),
  })
  .strict();

const gameParticipationReservedEventSchema = eventEnvelopeBase
  .extend({
    type: z.literal('game.participation.reserved.v1'),
    payload: z
      .object({ ...gameEventPayloadBase, userId: uuid, reservationId: uuid, expiresAt: dateTime })
      .strict(),
  })
  .strict();

const gameParticipationConfirmedEventSchema = eventEnvelopeBase
  .extend({
    type: z.literal('game.participation.confirmed.v1'),
    payload: z.object({ ...gameEventPayloadBase, userId: uuid, participationId: uuid }).strict(),
  })
  .strict();

const gameParticipationExpiredEventSchema = eventEnvelopeBase
  .extend({
    type: z.literal('game.participation.expired.v1'),
    payload: z
      .object({
        ...gameEventPayloadBase,
        userId: uuid,
        reservationId: uuid,
        reasonCode: z.enum(['PAYMENT_FAILED', 'PAYMENT_EXPIRED', 'RESERVATION_EXPIRED']),
      })
      .strict(),
  })
  .strict();

const gameParticipationLeftEventSchema = eventEnvelopeBase
  .extend({
    type: z.literal('game.participation.left.v1'),
    payload: z.object({ ...gameEventPayloadBase, userId: uuid, participationId: uuid }).strict(),
  })
  .strict();

function waitlistEventSchema(type: 'game.waitlist.joined.v1' | 'game.waitlist.left.v1') {
  return eventEnvelopeBase
    .extend({
      type: z.literal(type),
      payload: z
        .object({
          ...gameEventPayloadBase,
          userId: uuid,
          waitlistEntryId: uuid,
          position: z.number().int().positive(),
        })
        .strict(),
    })
    .strict();
}

const gameWaitlistPromotedEventSchema = eventEnvelopeBase
  .extend({
    type: z.literal('game.waitlist.promoted.v1'),
    payload: z
      .object({
        ...gameEventPayloadBase,
        userId: uuid,
        waitlistEntryId: uuid,
        position: z.number().int().positive(),
        targetRelation: z.enum(['SEAT_RESERVED', 'PARTICIPANT']),
        targetId: uuid,
      })
      .strict(),
  })
  .strict();

function rosterEventSchema(type: 'game.roster.completed.v1' | 'game.roster.reopened.v1') {
  return eventEnvelopeBase
    .extend({
      type: z.literal(type),
      payload: z.object({ ...gameEventPayloadBase, participantUserIds: eventUserIds }).strict(),
    })
    .strict();
}

function lifecycleEventSchema(type: 'game.started.v1' | 'game.finished.v1') {
  return eventEnvelopeBase
    .extend({
      type: z.literal(type),
      payload: z.object({ ...gameEventPayloadBase, participantUserIds: eventUserIds }).strict(),
    })
    .strict();
}

const gameResultSubmittedEventSchema = eventEnvelopeBase
  .extend({
    type: z.literal('game.result.submitted.v1'),
    payload: z
      .object({
        ...gameEventPayloadBase,
        submissionId: uuid,
        submittedByUserId: uuid,
        requiredConfirmationUserIds: eventUserIds,
      })
      .strict(),
  })
  .strict();

const gameResultConfirmedEventSchema = eventEnvelopeBase
  .extend({
    type: z.literal('game.result.confirmed.v1'),
    payload: z
      .object({ ...gameEventPayloadBase, resultId: uuid, participantUserIds: eventUserIds })
      .strict(),
  })
  .strict();

const gameResultDisputedEventSchema = eventEnvelopeBase
  .extend({
    type: z.literal('game.result.disputed.v1'),
    payload: z
      .object({
        ...gameEventPayloadBase,
        submissionId: uuid,
        disputedByUserId: uuid,
        participantUserIds: eventUserIds,
        reasonCode: z.enum(['SCORE_INCORRECT', 'ROSTER_INCORRECT', 'GAME_NOT_PLAYED', 'OTHER']),
      })
      .strict(),
  })
  .strict();

const gameCancelledEventSchema = eventEnvelopeBase
  .extend({
    type: z.literal('game.cancelled.v1'),
    payload: z
      .object({
        ...gameEventPayloadBase,
        participantUserIds: eventUserIds,
        reasonCode: z.enum([
          'ORGANIZER_REQUEST',
          'VENUE_UNAVAILABLE',
          'WEATHER',
          'SAFETY',
          'PROVISIONING_FAILED',
          'OTHER',
        ]),
      })
      .strict(),
  })
  .strict();

export const gameDomainEventSchema = z
  .discriminatedUnion('type', [
    gameCreatedEventSchema,
    gameProvisioningRequestedEventSchema,
    gameScheduledEventSchema,
    gamePublishedEventSchema,
    gameParticipationReservedEventSchema,
    gameParticipationConfirmedEventSchema,
    gameParticipationExpiredEventSchema,
    gameParticipationLeftEventSchema,
    waitlistEventSchema('game.waitlist.joined.v1'),
    waitlistEventSchema('game.waitlist.left.v1'),
    gameWaitlistPromotedEventSchema,
    rosterEventSchema('game.roster.completed.v1'),
    rosterEventSchema('game.roster.reopened.v1'),
    lifecycleEventSchema('game.started.v1'),
    lifecycleEventSchema('game.finished.v1'),
    gameResultSubmittedEventSchema,
    gameResultConfirmedEventSchema,
    gameResultDisputedEventSchema,
    gameCancelledEventSchema,
  ])
  .superRefine((event, context) => {
    if (event.aggregateId !== event.payload.gameId) {
      context.addIssue({
        code: 'custom',
        path: ['aggregateId'],
        message: 'aggregateId must match payload.gameId',
      });
    }
  });
export type GameDomainEvent = z.infer<typeof gameDomainEventSchema>;

const internalCommandEnvelopeBase = z.object({
  id: uuid,
  aggregateId: uuid,
  tenantId: uuid,
  createdAt: dateTime,
  correlationId: z.string().min(8).max(128),
  causationId: uuid.nullable(),
  requestedBy: z.enum(['SYSTEM', 'WORKER', 'OPERATOR']),
  attempt: z.number().int().min(1).max(20),
});

export const gameInternalCommandSchema = z
  .discriminatedUnion('type', [
    internalCommandEnvelopeBase
      .extend({
        type: z.literal('game.provisioning.advance.v1'),
        payload: z.object({ gameId: uuid, operationId: uuid }).strict(),
      })
      .strict(),
    internalCommandEnvelopeBase
      .extend({
        type: z.literal('game.reservation.expire.v1'),
        payload: z.object({ gameId: uuid, reservationId: uuid }).strict(),
      })
      .strict(),
    internalCommandEnvelopeBase
      .extend({
        type: z.literal('game.waitlist.promote.v1'),
        payload: z.object({ gameId: uuid, waitlistEntryId: uuid }).strict(),
      })
      .strict(),
    internalCommandEnvelopeBase
      .extend({
        type: z.literal('game.lifecycle.start.v1'),
        payload: z.object({ gameId: uuid, expectedRevision: eventRevision }).strict(),
      })
      .strict(),
    internalCommandEnvelopeBase
      .extend({
        type: z.literal('game.lifecycle.finish.v1'),
        payload: z.object({ gameId: uuid, expectedRevision: eventRevision }).strict(),
      })
      .strict(),
    internalCommandEnvelopeBase
      .extend({
        type: z.literal('game.integration.reconcile.v1'),
        payload: z
          .object({
            gameId: uuid,
            resourceType: z.enum(['BOOKING', 'PAYMENT_OBLIGATION', 'RATING_PROJECTION']),
            resourceId: uuid,
          })
          .strict(),
      })
      .strict(),
  ])
  .superRefine((command, context) => {
    if (command.aggregateId !== command.payload.gameId) {
      context.addIssue({
        code: 'custom',
        path: ['aggregateId'],
        message: 'aggregateId must match payload.gameId',
      });
    }
  });
export type GameInternalCommand = z.infer<typeof gameInternalCommandSchema>;

const EVENT_CONSUMER_ROUTES: Readonly<Record<GameDomainEventType, readonly GameEventConsumer[]>> = {
  'game.created.v1': ['games-card-projector', 'realtime-invalidation'],
  'game.provisioning.requested.v1': ['games-process-manager'],
  'game.scheduled.v1': [
    'games-card-projector',
    'home-projector',
    'messaging-membership',
    'realtime-invalidation',
    'integration-compatibility',
  ],
  'game.published.v1': ['games-card-projector', 'notifications-rules', 'realtime-invalidation'],
  'game.participation.reserved.v1': [
    'games-card-projector',
    'notifications-rules',
    'realtime-invalidation',
  ],
  'game.participation.confirmed.v1': [
    'games-card-projector',
    'home-projector',
    'messaging-membership',
    'notifications-rules',
    'realtime-invalidation',
  ],
  'game.participation.expired.v1': [
    'games-card-projector',
    'notifications-rules',
    'realtime-invalidation',
  ],
  'game.participation.left.v1': [
    'games-card-projector',
    'home-projector',
    'messaging-membership',
    'notifications-rules',
    'realtime-invalidation',
  ],
  'game.waitlist.joined.v1': [
    'games-card-projector',
    'notifications-rules',
    'realtime-invalidation',
  ],
  'game.waitlist.left.v1': ['games-card-projector', 'notifications-rules', 'realtime-invalidation'],
  'game.waitlist.promoted.v1': [
    'games-card-projector',
    'notifications-rules',
    'realtime-invalidation',
  ],
  'game.roster.completed.v1': [
    'games-card-projector',
    'notifications-rules',
    'realtime-invalidation',
  ],
  'game.roster.reopened.v1': [
    'games-card-projector',
    'notifications-rules',
    'realtime-invalidation',
  ],
  'game.started.v1': [
    'games-card-projector',
    'home-projector',
    'notifications-rules',
    'realtime-invalidation',
  ],
  'game.finished.v1': [
    'games-card-projector',
    'home-projector',
    'notifications-rules',
    'realtime-invalidation',
  ],
  'game.result.submitted.v1': [
    'games-card-projector',
    'notifications-rules',
    'realtime-invalidation',
  ],
  'game.result.confirmed.v1': [
    'games-card-projector',
    'home-projector',
    'notifications-rules',
    'rating-projector',
    'realtime-invalidation',
    'integration-compatibility',
  ],
  'game.result.disputed.v1': [
    'games-card-projector',
    'notifications-rules',
    'realtime-invalidation',
  ],
  'game.cancelled.v1': [
    'games-card-projector',
    'home-projector',
    'messaging-membership',
    'notifications-rules',
    'realtime-invalidation',
    'integration-compatibility',
  ],
};

export function consumersForGameEvent(type: GameDomainEventType): readonly GameEventConsumer[] {
  return EVENT_CONSUMER_ROUTES[type];
}
