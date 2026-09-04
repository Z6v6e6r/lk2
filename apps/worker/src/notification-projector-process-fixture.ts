import { Pool } from 'pg';
import { notificationSourceEventSchema } from '@phub/notifications';

import { applyNotificationSourceEvent } from './notification-projector.js';

async function main(): Promise<void> {
  const connectionString = process.env.NOTIFICATION_RESILIENCE_TEST_DATABASE_URL;
  const eventJson = process.env.NOTIFICATION_RESILIENCE_TEST_EVENT;
  if (!connectionString || !eventJson)
    throw new Error('NOTIFICATION_RESILIENCE_FIXTURE_INPUT_REQUIRED');
  const event = notificationSourceEventSchema.parse(JSON.parse(eventJson));
  const pool = new Pool({
    connectionString,
    max: 1,
    application_name: `notification-projector-process-${process.pid}`,
  });
  try {
    const result = await applyNotificationSourceEvent({ pool, event });
    process.send?.({ ok: true, result });
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  process.send?.({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
});
