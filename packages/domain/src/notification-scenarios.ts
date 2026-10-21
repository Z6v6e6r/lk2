import { z } from 'zod';

export const NOTIFICATION_SCENARIO_TRIGGERS = [
  'BOOKING_CONFIRMED',
  'BOOKING_CHANGED',
  'BOOKING_CANCELLED',
  'BOOKING_STARTS',
  'FRIEND_GAME_PUBLISHED',
  'SUBSCRIPTION_ENDS',
  'BIRTHDAY',
  'TRAINING_ATTENDED',
] as const;
export const notificationScenarioInputSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    trigger: z.enum(NOTIFICATION_SCENARIO_TRIGGERS),
    delayMinutes: z.number().int().min(-43_200).max(43_200),
    ttlMinutes: z.number().int().min(1).max(43_200),
    title: z.string().trim().min(1).max(300),
    body: z.string().trim().min(1).max(8_000),
    channels: z
      .array(
        z.enum([
          'IN_APP',
          'WEB_PUSH',
          'ANDROID_PUSH',
          'IOS_PUSH',
          'EMAIL',
          'STAFF_TASK',
          'SMS',
          'TELEGRAM',
        ]),
      )
      .min(1)
      .max(8)
      .refine(
        (channels) => new Set(channels).size === channels.length,
        'Каналы не должны повторяться',
      ),
    quietHours: z.enum(['DEFER', 'SKIP']),
    dailyLimit: z.number().int().min(1).max(10),
    goal: z.enum(['NONE', 'GAME_JOINED']),
    goalWindowMinutes: z.number().int().min(1).max(43_200),
    active: z.boolean(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.channels.some((c) => c === 'ANDROID_PUSH' || c === 'IOS_PUSH') &&
      !value.channels.includes('IN_APP')
    )
      ctx.addIssue({
        code: 'custom',
        path: ['channels'],
        message: 'Мобильный Push требует сообщение в центре уведомлений',
      });
    if (
      value.delayMinutes < 0 &&
      !['BOOKING_STARTS', 'SUBSCRIPTION_ENDS', 'BIRTHDAY'].includes(value.trigger)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['delayMinutes'],
        message:
          'Отрицательная задержка доступна до начала занятия, окончания абонемента или дня рождения',
      });
    }
    if (value.goal !== 'NONE' && !value.channels.includes('IN_APP'))
      ctx.addIssue({
        code: 'custom',
        path: ['channels'],
        message: 'Сценарий с целью требует сообщение в центре уведомлений',
      });
    if (value.goal !== 'NONE' && value.trigger !== 'FRIEND_GAME_PUBLISHED') {
      ctx.addIssue({
        code: 'custom',
        path: ['goal'],
        message: 'Цель присоединения доступна для приглашения в игру',
      });
    }
    for (const field of ['title', 'body'] as const) {
      const remaining = value[field].replace(
        /\{\{\s*(serviceTitle|startsAt|locationName|gameId)\s*\}\}/g,
        '',
      );
      if (remaining.includes('{{') || remaining.includes('}}')) {
        ctx.addIssue({ code: 'custom', path: [field], message: 'Неизвестная переменная шаблона' });
      }
    }
  });
export type NotificationScenarioInput = z.infer<typeof notificationScenarioInputSchema>;
export interface NotificationScenarioView {
  readonly id: string;
  readonly version: number;
  readonly definition: NotificationScenarioInput;
  readonly updatedAt: string;
}
export interface NotificationScenarioRunView {
  readonly id: string;
  readonly scenarioId: string;
  readonly scenarioVersion: number;
  readonly recipientUserId: string;
  readonly targetId: string;
  readonly state: string;
  readonly reason: string | null;
  readonly dueAt: string;
  readonly expiresAt: string;
  readonly goalState: 'NONE' | 'WAITING' | 'ACHIEVED' | 'EXPIRED';
  readonly goalAchievedAt: string | null;
  readonly deliveryStates: readonly {
    readonly channel: string;
    readonly state: string;
    readonly count: number;
    readonly errorCode?: string | null;
  }[];
}
export const NOTIFICATION_SCENARIO_CATALOG = [
  ...NOTIFICATION_SCENARIO_TRIGGERS.map((type) => ({ type, available: true, reason: null })),
  { type: 'FIRST_ATTENDANCE', available: false, reason: 'Нет подтверждённого события посещения' },
  {
    type: 'MATCHING_GAME',
    available: false,
    reason: 'Персональные рекомендации подключаются отдельным источником',
  },
] as const;

export function notificationScenarioCategory(
  definition: Pick<NotificationScenarioInput, 'trigger'>,
): string {
  return (
    (
      {
        FRIEND_GAME_PUBLISHED: 'GAME_RECOMMENDATION',
        SUBSCRIPTION_ENDS: 'SUBSCRIPTION',
        BIRTHDAY: 'BIRTHDAY',
        TRAINING_ATTENDED: 'TRAINING_ATTENDANCE',
      } as Record<string, string>
    )[definition.trigger] ?? 'BOOKING'
  );
}

export function notificationScenarioSchedule(input: {
  readonly definition: NotificationScenarioInput;
  readonly occurredAt: string;
  readonly startsAt?: string;
}): { dueAt: Date; expiresAt: Date } {
  const anchor = input.definition.trigger === 'BOOKING_STARTS' ? input.startsAt : input.occurredAt;
  if (!anchor || !Number.isFinite(Date.parse(anchor)))
    throw new Error('SCENARIO_TIME_ANCHOR_INVALID');
  const dueAt = new Date(Date.parse(anchor) + input.definition.delayMinutes * 60_000);
  const expiry = dueAt.getTime() + input.definition.ttlMinutes * 60_000;
  const timeBound =
    (input.definition.trigger === 'BOOKING_STARTS' && input.definition.delayMinutes < 0) ||
    input.definition.trigger === 'FRIEND_GAME_PUBLISHED';
  if (timeBound && (!input.startsAt || !Number.isFinite(Date.parse(input.startsAt))))
    throw new Error('SCENARIO_TIME_ANCHOR_INVALID');
  return {
    dueAt,
    expiresAt: new Date(
      timeBound ? Math.min(expiry, Date.parse(input.startsAt as string)) : expiry,
    ),
  };
}
