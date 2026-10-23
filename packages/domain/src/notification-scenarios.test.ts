import { describe, expect, it } from 'vitest';
import {
  notificationScenarioInputSchema,
  notificationScenarioSchedule,
  type NotificationScenarioInput,
} from './notification-scenarios.js';

export const definition: NotificationScenarioInput = {
  name: 'За два часа',
  trigger: 'BOOKING_STARTS',
  delayMinutes: -120,
  ttlMinutes: 180,
  title: 'Скоро {{serviceTitle}}',
  body: 'Начало {{startsAt}}',
  channels: ['IN_APP', 'WEB_PUSH'],
  quietHours: 'DEFER',
  dailyLimit: 1,
  goal: 'NONE',
  goalWindowMinutes: 1440,
  active: true,
};
describe('notification scenario contract', () => {
  it('caps a reminder lifetime at the actual start and does not use ingestion time', () => {
    const schedule = notificationScenarioSchedule({
      definition,
      occurredAt: '2026-10-21T09:00:00Z',
      startsAt: '2026-10-22T16:00:00Z',
    });
    expect(schedule.dueAt.toISOString()).toBe('2026-10-22T14:00:00.000Z');
    expect(schedule.expiresAt.toISOString()).toBe('2026-10-22T16:00:00.000Z');
  });
  it('schedules an event follow-up relative to the event fact', () => {
    const schedule = notificationScenarioSchedule({
      definition: { ...definition, trigger: 'BOOKING_CONFIRMED', delayMinutes: 60 },
      occurredAt: '2026-10-21T09:00:00Z',
    });
    expect(schedule.dueAt.toISOString()).toBe('2026-10-21T10:00:00.000Z');
  });
  it.each([
    { mandatory: true },
    { trigger: 'FIRST_ATTENDANCE' },
    { trigger: 'BOOKING_CONFIRMED' },
    { channels: ['IOS_PUSH'] },
    { channels: ['ANDROID_PUSH'] },
    { channels: ['PUSH'] },
    { channels: ['WEB_PUSH', 'WEB_PUSH'] },
    { goal: 'GAME_JOINED' },
    {
      trigger: 'FRIEND_GAME_PUBLISHED',
      delayMinutes: 0,
      goal: 'GAME_JOINED',
      channels: ['WEB_PUSH'],
    },
    { body: '{{phone}}' },
    { title: '{{user.token}}' },
  ])('rejects unsupported or privilege-widening configuration %j', (patch) => {
    expect(notificationScenarioInputSchema.safeParse({ ...definition, ...patch }).success).toBe(
      false,
    );
  });
  it.each([0, 30])(
    'supports at-start/after-start offset %s without immediate expiry',
    (delayMinutes) => {
      const schedule = notificationScenarioSchedule({
        definition: { ...definition, delayMinutes, ttlMinutes: 60 },
        occurredAt: '2026-10-21T09:00:00Z',
        startsAt: '2026-10-22T16:00:00Z',
      });
      expect(schedule.expiresAt.getTime()).toBeGreaterThan(schedule.dueAt.getTime());
    },
  );
  it.each(['SUBSCRIPTION_ENDS', 'BIRTHDAY'] as const)(
    'allows before/after offsets for %s',
    (trigger) => {
      for (const delayMinutes of [-60, 0, 60])
        expect(
          notificationScenarioInputSchema.safeParse({
            ...definition,
            trigger,
            delayMinutes,
            channels: ['EMAIL'],
          }).success,
        ).toBe(true);
    },
  );
  it('rejects a missing time anchor', () =>
    expect(() =>
      notificationScenarioSchedule({ definition, occurredAt: '2026-10-21T09:00:00Z' }),
    ).toThrow('SCENARIO_TIME_ANCHOR_INVALID'));
});
