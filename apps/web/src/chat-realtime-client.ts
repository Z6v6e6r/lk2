import type { MessagingRealtimeTicket } from '@phub/api-sdk';

export interface ChatRealtimeClient {
  stop(): void;
}

export type ChatRealtimeConnectionState = 'connecting' | 'connected' | 'reconnecting';

function realtimeUrl(baseUrl: string, tenantKey: string): string {
  const url = new URL(`/realtime/v1/${encodeURIComponent(tenantKey)}`, baseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

export function connectChatRealtime(options: {
  readonly baseUrl: string;
  readonly tenantKey: string;
  readonly conversationId: string;
  readonly getTicket: () => Promise<MessagingRealtimeTicket>;
  readonly getAfterSequence: () => number;
  readonly onRecoveryRequired: (afterSequence: number) => void;
  readonly onConnectionStateChange?: (state: ChatRealtimeConnectionState) => void;
  readonly createSocket?: (url: string) => WebSocket;
}): ChatRealtimeClient {
  const createSocket = options.createSocket ?? ((url: string) => new WebSocket(url));
  const reconnectDelays = [1_000, 2_000, 5_000, 10_000, 15_000] as const;
  let stopped = false;
  let socket: WebSocket | undefined;
  let reconnectTimer: number | undefined;
  let heartbeatTimer: number | undefined;
  let reconnectAttempt = 0;

  const clearHeartbeat = (): void => {
    if (heartbeatTimer !== undefined) window.clearInterval(heartbeatTimer);
    heartbeatTimer = undefined;
  };
  const scheduleReconnect = (): void => {
    if (stopped || reconnectTimer !== undefined) return;
    clearHeartbeat();
    options.onConnectionStateChange?.('reconnecting');
    options.onRecoveryRequired(options.getAfterSequence());
    const delay = reconnectDelays[Math.min(reconnectAttempt, reconnectDelays.length - 1)] ?? 15_000;
    reconnectAttempt += 1;
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = undefined;
      void connect();
    }, delay);
  };
  const connect = async (): Promise<void> => {
    if (stopped) return;
    options.onConnectionStateChange?.(reconnectAttempt > 0 ? 'reconnecting' : 'connecting');
    try {
      const issued = await options.getTicket();
      if (stopped) return;
      const nextSocket = createSocket(realtimeUrl(options.baseUrl, options.tenantKey));
      socket = nextSocket;
      nextSocket.addEventListener('open', () =>
        nextSocket.send(JSON.stringify({ type: 'authenticate', ticket: issued.ticket })),
      );
      nextSocket.addEventListener('message', (event) => {
        let message: unknown;
        try {
          message = JSON.parse(String(event.data)) as unknown;
        } catch {
          nextSocket.close(4400, 'Invalid message');
          return;
        }
        if (typeof message !== 'object' || message === null || !('type' in message)) return;
        if (message.type === 'connection.ready') {
          reconnectAttempt = 0;
          options.onConnectionStateChange?.('connected');
          nextSocket.send(
            JSON.stringify({
              type: 'conversation.subscribe',
              conversationId: options.conversationId,
              afterSequence: options.getAfterSequence(),
            }),
          );
          clearHeartbeat();
          heartbeatTimer = window.setInterval(() => {
            if (nextSocket.readyState === WebSocket.OPEN)
              nextSocket.send(JSON.stringify({ type: 'ping' }));
          }, 25_000);
          return;
        }
        if (
          (message.type === 'message.created' || message.type === 'conversation.gap') &&
          'conversationId' in message &&
          message.conversationId === options.conversationId
        ) {
          const afterSequence =
            message.type === 'conversation.gap' &&
            'afterSequence' in message &&
            typeof message.afterSequence === 'number'
              ? message.afterSequence
              : options.getAfterSequence();
          options.onRecoveryRequired(afterSequence);
        }
      });
      nextSocket.addEventListener('close', scheduleReconnect);
      nextSocket.addEventListener('error', () => nextSocket.close());
    } catch {
      scheduleReconnect();
    }
  };
  void connect();

  return {
    stop(): void {
      stopped = true;
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      clearHeartbeat();
      socket?.close(1000, 'Client stopped');
      socket = undefined;
    },
  };
}
