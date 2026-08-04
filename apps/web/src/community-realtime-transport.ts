const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const AUTHENTICATION_CLOSE_CODE = 4401;
const RATE_LIMIT_CLOSE_CODE = 4429;
const CAPACITY_CLOSE_CODE = 1013;
const MAX_ACTIVE_SUBSCRIPTIONS = 20;

export interface CommunityRealtimeTicket {
  readonly ticket: string;
  readonly expiresAt: string;
}

export interface CommunityRealtimeSocket {
  onopen: (() => void) | null;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  onclose: ((event: { readonly code: number }) => void) | null;
  onerror: (() => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface CommunityRealtimeLifecycle {
  isOnline(): boolean;
  isVisible(): boolean;
  now(): number;
  random(): number;
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
  onOnline(callback: () => void): () => void;
  onVisibilityChange(callback: () => void): () => void;
}

export interface CommunityRealtimeTransportError {
  readonly kind: 'TICKET_ISSUE_FAILED' | 'CONNECTION_FAILED' | 'PROTOCOL_ERROR' | 'SERVER_ERROR';
  readonly code: string;
  readonly retrying: boolean;
  readonly communityId?: string;
}

export interface CommunityRealtimeSubscriptionState {
  readonly communityId: string;
  readonly communityRevision: number;
  readonly membershipRevision: number;
  readonly latestSequence: number;
}

export interface CommunityRealtimeSubscriptionCallbacks {
  readonly onSubscribed: (state: CommunityRealtimeSubscriptionState) => void | Promise<void>;
  readonly onHint: (hint: {
    readonly communityId: string;
    readonly sequence: number;
  }) => void | Promise<void>;
  readonly onUnavailable?: (failure: {
    readonly communityId: string;
    readonly code: string;
  }) => void;
}

export interface CommunityRealtimeTransport {
  start(): void;
  stop(): void;
  clear(): void;
  isStarted(): boolean;
  subscribe(communityId: string, callbacks: CommunityRealtimeSubscriptionCallbacks): () => void;
}

type ConnectionPhase = 'AWAITING_OPEN' | 'AWAITING_READY' | 'READY';
type SubscriptionPhase = 'PENDING' | 'AWAITING_ACK' | 'SUBSCRIBED';

interface ActiveConnection {
  readonly socket: CommunityRealtimeSocket;
  readonly generation: number;
  phase: ConnectionPhase;
  expectedClose: boolean;
  deadline?: ReturnType<typeof setTimeout>;
  stableTimer?: ReturnType<typeof setTimeout>;
  messageTail: Promise<void>;
}

interface ActiveSubscription {
  readonly callbacks: Set<CommunityRealtimeSubscriptionCallbacks>;
  phase: SubscriptionPhase;
  snapshot?: CommunityRealtimeSubscriptionState;
  deadline?: ReturnType<typeof setTimeout>;
}

function defaultLifecycle(): CommunityRealtimeLifecycle {
  return {
    isOnline: () => (typeof navigator === 'undefined' ? true : navigator.onLine),
    isVisible: () =>
      typeof document === 'undefined' ? true : document.visibilityState === 'visible',
    now: () => Date.now(),
    random: () => Math.random(),
    setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
    clearTimeout: (timer) => globalThis.clearTimeout(timer),
    onOnline(callback) {
      if (typeof window === 'undefined') return () => undefined;
      window.addEventListener('online', callback);
      return () => window.removeEventListener('online', callback);
    },
    onVisibilityChange(callback) {
      if (typeof document === 'undefined') return () => undefined;
      document.addEventListener('visibilitychange', callback);
      return () => document.removeEventListener('visibilitychange', callback);
    },
  };
}

function validateUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error('COMMUNITY_REALTIME_URL_INVALID');
  }
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(url.hostname);
  if (
    (url.protocol !== 'wss:' && !(url.protocol === 'ws:' && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error('COMMUNITY_REALTIME_URL_INVALID');
  }
  return url.toString();
}

function objectMessage(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'string' || value.length < 2 || value.length > 16_384) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function validSequence(value: unknown, positive = false): value is number {
  return Number.isSafeInteger(value) && (positive ? (value as number) > 0 : (value as number) >= 0);
}

function validEvent(message: Record<string, unknown>, communityId: string): boolean {
  return (
    message.type === 'community.event' &&
    message.communityId === communityId &&
    validSequence(message.sequence, true) &&
    typeof message.eventType === 'string' &&
    message.eventType.length > 0 &&
    ['POST', 'COMMENT', 'REACTION'].includes(String(message.targetType)) &&
    typeof message.targetId === 'string' &&
    UUID_PATTERN.test(message.targetId) &&
    validSequence(message.targetRevision, true) &&
    (message.targetStatus === null || typeof message.targetStatus === 'string') &&
    typeof message.occurredAt === 'string' &&
    Number.isFinite(Date.parse(message.occurredAt))
  );
}

const terminalTransportCodes = new Set([
  'COMMUNITIES_REALTIME_DISABLED',
  'REALTIME_COMMAND_INVALID',
  'REALTIME_PROTOCOL_UNSUPPORTED',
]);
const terminalSubscriptionCodes = new Set(['COMMUNITY_NOT_FOUND', 'REALTIME_SUBSCRIPTION_LIMIT']);

function rejectedTicketCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

export function createCommunityRealtimeTransport(options: {
  readonly url: string;
  readonly issueTicket: () => Promise<CommunityRealtimeTicket>;
  readonly createSocket: (url: string) => CommunityRealtimeSocket;
  readonly onError?: (error: CommunityRealtimeTransportError) => void;
  readonly onFatalAuth?: (failure: {
    readonly closeCode: 4401;
    readonly retrying: boolean;
  }) => void;
  readonly lifecycle?: CommunityRealtimeLifecycle;
  readonly baseReconnectDelayMs?: number;
  readonly maximumReconnectDelayMs?: number;
  readonly authReconnectDelayMs?: number;
  readonly rateLimitReconnectDelayMs?: number;
  readonly capacityReconnectDelayMs?: number;
  readonly handshakeTimeoutMs?: number;
  readonly subscriptionTimeoutMs?: number;
  readonly stableConnectionMs?: number;
  readonly jitterRatio?: number;
}): CommunityRealtimeTransport {
  const url = validateUrl(options.url);
  const lifecycle = options.lifecycle ?? defaultLifecycle();
  const baseDelay = options.baseReconnectDelayMs ?? 1_000;
  const maximumDelay = options.maximumReconnectDelayMs ?? 30_000;
  const authDelay = options.authReconnectDelayMs ?? 30_000;
  const rateLimitDelay = options.rateLimitReconnectDelayMs ?? 60_000;
  const capacityDelay = options.capacityReconnectDelayMs ?? 5_000;
  const handshakeTimeout = options.handshakeTimeoutMs ?? 4_000;
  const subscriptionTimeout = options.subscriptionTimeoutMs ?? 5_000;
  const stableConnectionMs = options.stableConnectionMs ?? 30_000;
  const jitterRatio = options.jitterRatio ?? 0.2;
  if (
    ![baseDelay, maximumDelay, authDelay, rateLimitDelay, capacityDelay].every(Number.isInteger) ||
    ![handshakeTimeout, subscriptionTimeout, stableConnectionMs].every(Number.isInteger) ||
    baseDelay < 100 ||
    maximumDelay < baseDelay ||
    authDelay < maximumDelay ||
    rateLimitDelay < 60_000 ||
    capacityDelay < 5_000 ||
    handshakeTimeout < 1_000 ||
    subscriptionTimeout < 1_000 ||
    stableConnectionMs < 1_000 ||
    jitterRatio < 0 ||
    jitterRatio > 0.5
  ) {
    throw new Error('COMMUNITY_REALTIME_POLICY_INVALID');
  }

  const subscriptions = new Map<string, ActiveSubscription>();
  let started = false;
  let terminal = false;
  let generation = 0;
  let failures = 0;
  let authenticationFailures = 0;
  let connection: ActiveConnection | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let removeOnlineListener: (() => void) | undefined;
  let removeVisibilityListener: (() => void) | undefined;

  const report = (
    kind: CommunityRealtimeTransportError['kind'],
    code: string,
    retrying: boolean,
    communityId?: string,
  ): void => {
    try {
      options.onError?.({ kind, code, retrying, ...(communityId ? { communityId } : {}) });
    } catch {
      // Observability must never control transport state.
    }
  };

  const clearTimer = (timer: ReturnType<typeof setTimeout> | undefined): void => {
    if (timer !== undefined) lifecycle.clearTimeout(timer);
  };

  const resetSubscriptionsForReconnect = (): void => {
    for (const subscription of subscriptions.values()) {
      clearTimer(subscription.deadline);
      delete subscription.deadline;
      subscription.phase = 'PENDING';
      delete subscription.snapshot;
    }
  };

  const clearConnectionTimers = (current: ActiveConnection): void => {
    clearTimer(current.deadline);
    clearTimer(current.stableTimer);
    delete current.deadline;
    delete current.stableTimer;
  };

  const canConnect = (): boolean =>
    started && !terminal && subscriptions.size > 0 && lifecycle.isOnline() && lifecycle.isVisible();

  const retryDelay = (): number => {
    const exponential = Math.min(maximumDelay, baseDelay * 2 ** Math.min(failures, 16));
    const jitter = 1 + (lifecycle.random() * 2 - 1) * jitterRatio;
    return Math.max(baseDelay, Math.min(maximumDelay, Math.round(exponential * jitter)));
  };

  const scheduleReconnect = (minimumDelay = 0): void => {
    if (!canConnect() || reconnectTimer !== undefined || connection) return;
    const delay = Math.max(minimumDelay, retryDelay());
    failures += 1;
    reconnectTimer = lifecycle.setTimeout(() => {
      reconnectTimer = undefined;
      connect();
    }, delay);
  };

  const closeConnection = (
    current: ActiveConnection,
    code: number,
    reason: string,
    reconnectDelay?: number,
  ): void => {
    if (connection !== current) return;
    current.expectedClose = true;
    clearConnectionTimers(current);
    connection = undefined;
    generation += 1;
    resetSubscriptionsForReconnect();
    current.socket.close(code, reason);
    if (reconnectDelay !== undefined) scheduleReconnect(reconnectDelay);
  };

  const stopTerminal = (code: string): void => {
    terminal = true;
    started = false;
    if (reconnectTimer !== undefined) lifecycle.clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
    removeOnlineListener?.();
    removeVisibilityListener?.();
    removeOnlineListener = undefined;
    removeVisibilityListener = undefined;
    const current = connection;
    if (current) closeConnection(current, 1002, 'Realtime unavailable');
    report('PROTOCOL_ERROR', code, false);
    for (const [communityId, subscription] of subscriptions) {
      for (const callbacks of subscription.callbacks) {
        try {
          callbacks.onUnavailable?.({ communityId, code });
        } catch {
          // A consumer cannot revive or mutate terminal transport state.
        }
      }
    }
  };

  const failSubscription = (communityId: string, code: string): void => {
    const subscription = subscriptions.get(communityId);
    if (!subscription) return;
    clearTimer(subscription.deadline);
    subscriptions.delete(communityId);
    report('SERVER_ERROR', code, false, communityId);
    for (const callbacks of subscription.callbacks) {
      try {
        callbacks.onUnavailable?.({ communityId, code });
      } catch {
        // A consumer cannot retain a denied server subscription.
      }
    }
    if (subscriptions.size === 0 && connection) {
      closeConnection(connection, 1000, 'No active subscriptions');
    }
  };

  const callbackFailure = (current: ActiveConnection, communityId: string): void => {
    if (connection !== current) return;
    report('CONNECTION_FAILED', 'REALTIME_CANONICAL_CALLBACK_FAILED', true, communityId);
    closeConnection(current, 1011, 'Canonical recovery failed', retryDelay());
  };

  const invokeCallbacks = async (
    current: ActiveConnection,
    communityId: string,
    operation: (callbacks: CommunityRealtimeSubscriptionCallbacks) => void | Promise<void>,
  ): Promise<void> => {
    const subscription = subscriptions.get(communityId);
    if (!subscription || connection !== current) return;
    try {
      for (const callbacks of subscription.callbacks) await operation(callbacks);
    } catch {
      callbackFailure(current, communityId);
    }
  };

  const armSubscriptionDeadline = (
    current: ActiveConnection,
    communityId: string,
    subscription: ActiveSubscription,
  ): void => {
    clearTimer(subscription.deadline);
    subscription.deadline = lifecycle.setTimeout(() => {
      if (connection !== current || subscriptions.get(communityId) !== subscription) return;
      report('CONNECTION_FAILED', 'REALTIME_SUBSCRIPTION_TIMEOUT', true, communityId);
      closeConnection(current, 1002, 'Subscription timeout', retryDelay());
    }, subscriptionTimeout);
  };

  const sendSubscription = (
    current: ActiveConnection,
    communityId: string,
    subscription: ActiveSubscription,
  ): void => {
    if (connection !== current || current.phase !== 'READY' || subscription.phase !== 'PENDING')
      return;
    subscription.phase = 'AWAITING_ACK';
    current.socket.send(JSON.stringify({ type: 'community.subscribe', communityId }));
    armSubscriptionDeadline(current, communityId, subscription);
  };

  const handleServerError = (current: ActiveConnection, message: Record<string, unknown>): void => {
    const code =
      typeof message.code === 'string' && message.code.length <= 128
        ? message.code
        : 'REALTIME_SERVER_ERROR_INVALID';
    const communityId =
      typeof message.communityId === 'string' && UUID_PATTERN.test(message.communityId)
        ? message.communityId
        : undefined;
    if (code === 'REALTIME_RATE_LIMITED') {
      report('SERVER_ERROR', code, true, communityId);
      closeConnection(current, 1008, 'Rate limited', rateLimitDelay);
      return;
    }
    if (terminalTransportCodes.has(code)) {
      stopTerminal(code);
      return;
    }
    if (communityId && terminalSubscriptionCodes.has(code)) {
      failSubscription(communityId, code);
      return;
    }
    if (code === 'REALTIME_STORE_UNAVAILABLE') {
      report('SERVER_ERROR', code, true, communityId);
      closeConnection(current, 1011, 'Store unavailable', retryDelay());
      return;
    }
    stopTerminal(code);
  };

  const handleMessage = async (current: ActiveConnection, raw: unknown): Promise<void> => {
    if (connection !== current) return;
    const message = objectMessage(raw);
    if (!message || typeof message.type !== 'string') {
      stopTerminal('REALTIME_MESSAGE_MALFORMED');
      return;
    }
    if (message.type === 'error') {
      handleServerError(current, message);
      return;
    }
    if (current.phase === 'AWAITING_READY') {
      if (message.type !== 'connection.ready' || message.communitySubscriptions !== true) {
        stopTerminal('REALTIME_READY_INVALID');
        return;
      }
      clearTimer(current.deadline);
      delete current.deadline;
      current.phase = 'READY';
      current.stableTimer = lifecycle.setTimeout(() => {
        if (connection === current) {
          failures = 0;
          authenticationFailures = 0;
        }
      }, stableConnectionMs);
      for (const [communityId, subscription] of subscriptions) {
        sendSubscription(current, communityId, subscription);
      }
      return;
    }
    if (current.phase !== 'READY') {
      stopTerminal('REALTIME_MESSAGE_PHASE_INVALID');
      return;
    }
    if (message.type === 'community.subscribed') {
      const communityId = typeof message.communityId === 'string' ? message.communityId : '';
      const subscription = subscriptions.get(communityId);
      if (
        !subscription ||
        subscription.phase !== 'AWAITING_ACK' ||
        !validSequence(message.communityRevision, true) ||
        !validSequence(message.membershipRevision, true) ||
        !validSequence(message.latestSequence) ||
        message.delivery !== 'DURABLE_SEQUENCE_HTTP_RECOVERY'
      ) {
        stopTerminal('REALTIME_SUBSCRIPTION_INVALID');
        return;
      }
      clearTimer(subscription.deadline);
      delete subscription.deadline;
      subscription.phase = 'SUBSCRIBED';
      subscription.snapshot = {
        communityId,
        communityRevision: message.communityRevision,
        membershipRevision: message.membershipRevision,
        latestSequence: message.latestSequence,
      };
      await invokeCallbacks(current, communityId, (callbacks) =>
        callbacks.onSubscribed(subscription.snapshot as CommunityRealtimeSubscriptionState),
      );
      return;
    }
    if (message.type === 'community.unsubscribed') return;
    const communityId = typeof message.communityId === 'string' ? message.communityId : '';
    const subscription = subscriptions.get(communityId);
    if (!subscription || subscription.phase !== 'SUBSCRIBED' || !validEvent(message, communityId)) {
      stopTerminal('REALTIME_EVENT_INVALID');
      return;
    }
    await invokeCallbacks(current, communityId, (callbacks) =>
      callbacks.onHint({ communityId, sequence: message.sequence as number }),
    );
  };

  const armConnectionDeadline = (current: ActiveConnection, code: string): void => {
    clearTimer(current.deadline);
    current.deadline = lifecycle.setTimeout(() => {
      if (connection !== current) return;
      report('CONNECTION_FAILED', code, true);
      closeConnection(current, 1002, 'Handshake timeout', retryDelay());
    }, handshakeTimeout);
  };

  function connect(): void {
    if (!canConnect() || connection || reconnectTimer !== undefined) return;
    const attemptGeneration = ++generation;
    void options.issueTicket().then(
      (issued) => {
        if (!canConnect() || generation !== attemptGeneration || connection) return;
        const expiresAt =
          typeof issued === 'object' && issued !== null && typeof issued.expiresAt === 'string'
            ? Date.parse(issued.expiresAt)
            : Number.NaN;
        if (
          typeof issued !== 'object' ||
          issued === null ||
          typeof issued.ticket !== 'string' ||
          issued.ticket.length < 32 ||
          issued.ticket.length > 4_096 ||
          !Number.isFinite(expiresAt) ||
          expiresAt <= lifecycle.now() + 1_000
        ) {
          report('TICKET_ISSUE_FAILED', 'REALTIME_TICKET_INVALID', true);
          scheduleReconnect();
          return;
        }
        let socket: CommunityRealtimeSocket;
        try {
          // Credentials never enter the URL or WebSocket subprotocol.
          socket = options.createSocket(url);
        } catch {
          report('CONNECTION_FAILED', 'REALTIME_SOCKET_CREATE_FAILED', true);
          scheduleReconnect();
          return;
        }
        if (!canConnect() || generation !== attemptGeneration) {
          socket.close(1000, 'Stale connection');
          return;
        }
        const current: ActiveConnection = {
          socket,
          generation: attemptGeneration,
          phase: 'AWAITING_OPEN',
          expectedClose: false,
          messageTail: Promise.resolve(),
        };
        connection = current;
        armConnectionDeadline(current, 'REALTIME_OPEN_TIMEOUT');
        const isCurrent = (): boolean =>
          started && generation === current.generation && connection === current;
        socket.onopen = () => {
          if (!isCurrent()) return;
          current.phase = 'AWAITING_READY';
          armConnectionDeadline(current, 'REALTIME_READY_TIMEOUT');
          socket.send(JSON.stringify({ type: 'authenticate', ticket: issued.ticket }));
        };
        socket.onmessage = (event) => {
          if (!isCurrent()) return;
          current.messageTail = current.messageTail
            .then(() => handleMessage(current, event.data))
            .catch(() => callbackFailure(current, 'unknown'));
        };
        socket.onerror = () => {
          if (isCurrent()) report('CONNECTION_FAILED', 'REALTIME_SOCKET_ERROR', true);
        };
        socket.onclose = (event) => {
          if (!isCurrent()) return;
          clearConnectionTimers(current);
          connection = undefined;
          generation += 1;
          resetSubscriptionsForReconnect();
          if (current.expectedClose || !started || terminal) return;
          if (event.code === AUTHENTICATION_CLOSE_CODE) {
            authenticationFailures += 1;
            const retrying = authenticationFailures < 2;
            try {
              options.onFatalAuth?.({ closeCode: AUTHENTICATION_CLOSE_CODE, retrying });
            } catch {
              // Re-auth UI failures must not disable transport backoff or cleanup.
            }
            report('CONNECTION_FAILED', 'REALTIME_AUTHENTICATION_FAILED', retrying);
            if (retrying) scheduleReconnect(authDelay);
            else stopTerminal('REALTIME_REAUTH_REQUIRED');
            return;
          }
          if (event.code === RATE_LIMIT_CLOSE_CODE) {
            report('SERVER_ERROR', 'REALTIME_RATE_LIMITED', true);
            scheduleReconnect(rateLimitDelay);
            return;
          }
          if (event.code === CAPACITY_CLOSE_CODE) {
            report('CONNECTION_FAILED', 'REALTIME_CAPACITY', true);
            scheduleReconnect(capacityDelay);
            return;
          }
          report('CONNECTION_FAILED', 'REALTIME_SOCKET_CLOSED', true);
          scheduleReconnect();
        };
      },
      (error: unknown) => {
        if (!canConnect() || generation !== attemptGeneration) return;
        const code = rejectedTicketCode(error);
        if (code && terminalTransportCodes.has(code)) {
          stopTerminal(code);
          return;
        }
        report('TICKET_ISSUE_FAILED', 'REALTIME_TICKET_ISSUE_FAILED', true);
        scheduleReconnect();
      },
    );
  }

  const availabilityChanged = (): void => {
    if (!started || terminal) return;
    if (!lifecycle.isOnline()) {
      if (reconnectTimer !== undefined) lifecycle.clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
      if (connection) closeConnection(connection, 1000, 'Client offline');
      return;
    }
    // Hiding a mobile tab does not churn a ticket or a healthy socket. Visibility only gates a
    // new connection after the browser or network has already closed it.
    if (lifecycle.isVisible()) {
      if (reconnectTimer !== undefined) lifecycle.clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
      connect();
    }
  };

  const detachLifecycle = (): void => {
    removeOnlineListener?.();
    removeVisibilityListener?.();
    removeOnlineListener = undefined;
    removeVisibilityListener = undefined;
  };

  const stopTransport = (): void => {
    if (!started && !connection && reconnectTimer === undefined) return;
    started = false;
    generation += 1;
    if (reconnectTimer !== undefined) lifecycle.clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
    detachLifecycle();
    if (connection) closeConnection(connection, 1000, 'Client stopped');
    resetSubscriptionsForReconnect();
  };

  return {
    start() {
      if (started || terminal) return;
      started = true;
      failures = 0;
      authenticationFailures = 0;
      removeOnlineListener = lifecycle.onOnline(availabilityChanged);
      removeVisibilityListener = lifecycle.onVisibilityChange(availabilityChanged);
      connect();
    },
    stop: stopTransport,
    clear() {
      stopTransport();
      for (const subscription of subscriptions.values()) clearTimer(subscription.deadline);
      subscriptions.clear();
    },
    isStarted: () => started,
    subscribe(communityId, callbacks) {
      if (!UUID_PATTERN.test(communityId)) throw new Error('COMMUNITY_REALTIME_COMMUNITY_INVALID');
      let subscription = subscriptions.get(communityId);
      if (!subscription) {
        if (subscriptions.size >= MAX_ACTIVE_SUBSCRIPTIONS) {
          throw new Error('COMMUNITY_REALTIME_CLIENT_SUBSCRIPTION_LIMIT');
        }
        subscription = { callbacks: new Set(), phase: 'PENDING' };
        subscriptions.set(communityId, subscription);
      }
      subscription.callbacks.add(callbacks);
      if (subscription.phase === 'SUBSCRIBED' && subscription.snapshot && connection) {
        const current = connection;
        current.messageTail = current.messageTail
          .then(() =>
            callbacks.onSubscribed(subscription.snapshot as CommunityRealtimeSubscriptionState),
          )
          .catch(() => callbackFailure(current, communityId));
      }
      if (started) {
        if (connection?.phase === 'READY') sendSubscription(connection, communityId, subscription);
        else connect();
      }
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        const current = subscriptions.get(communityId);
        if (!current) return;
        current.callbacks.delete(callbacks);
        if (current.callbacks.size > 0) return;
        clearTimer(current.deadline);
        subscriptions.delete(communityId);
        if (connection?.phase === 'READY') {
          connection.socket.send(JSON.stringify({ type: 'community.unsubscribe', communityId }));
        }
        if (subscriptions.size === 0 && connection) {
          closeConnection(connection, 1000, 'No active subscriptions');
        }
      };
    },
  };
}
