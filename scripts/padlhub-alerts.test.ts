import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const primaryRules = readFileSync(
  new URL('../infra/monitoring/padlhub-alerts.yaml', import.meta.url),
  'utf8',
);
const jetsonRules = readFileSync(
  new URL('../deploy/jetson/monitoring/padlhub-alerts.yaml', import.meta.url),
  'utf8',
);
const ruleTests = readFileSync(
  new URL('../infra/monitoring/padlhub-alerts.test.yaml', import.meta.url),
  'utf8',
);

describe('PadlHub monitoring alerts', () => {
  it('keeps deployment rules identical and covers push and realtime reliability signals', () => {
    expect(jetsonRules).toBe(primaryRules);
    for (const alert of [
      'PadlHubPushDeliveryDelayed',
      'PadlHubPushDeliveryStalled',
      'PadlHubPushDeliveriesDead',
      'PadlHubPushPolicySuspended',
      'PadlHubWebPushCycleFailed',
      'PadlHubWebPushTenantFailures',
      'PadlHubWebPushCircuitOpen',
      'PadlHubBookingReminderDelayed',
      'PadlHubBookingReminderSchedulerFailed',
      'PadlHubBookingRemindersMissed',
      'PadlHubRealtimeHeartbeatStale',
      'PadlHubRealtimeMetricsAbsent',
      'PadlHubRealtimeReplicaCountLow',
      'PadlHubRealtimeConsumerUnavailable',
      'PadlHubRealtimeConsumerFailures',
      'PadlHubRealtimeEventsQuarantined',
      'PadlHubRealtimeReconnects',
    ]) {
      expect(primaryRules).toContain(`alert: ${alert}`);
    }
    expect(primaryRules).toContain('time() - max(phub_realtime_process_heartbeat_unixtime) > 60');
    expect(primaryRules).toContain(
      'absent_over_time(phub_realtime_process_heartbeat_unixtime[2m])',
    );
    expect(primaryRules).toContain(
      'max by (service_instance_id) (phub_realtime_process_heartbeat_unixtime)',
    );
    expect(primaryRules).toContain(
      'max by (service_instance_id) (phub_realtime_process_expected_replicas)',
    );
    expect(primaryRules).toContain('and on (service_instance_id)');
    expect(primaryRules).toContain('increase(phub_worker_booking_reminder_failures_total[5m]) > 0');
    expect(primaryRules).toContain(
      'max by (service_instance_id) (phub_worker_booking_reminder_scheduler_success)',
    );
    expect(primaryRules).toContain(
      'max by (service_instance_id) (phub_worker_booking_reminder_scheduler_heartbeat_unixtime)',
    );
    expect(primaryRules).toContain(
      'phub_worker_notifications_booking_reminder_latest_missed_unixtime > 0',
    );
    expect(primaryRules).toContain(
      '(time() - phub_worker_notifications_booking_reminder_latest_missed_unixtime) < 300',
    );
    expect(primaryRules).toContain('max by (service_instance_id) (phub_realtime_consumer_ready)');
    for (const scenario of [
      'stale replica target is excluded and the alert resolves',
      'fresh replicas disagree on their target',
      'one fresh replica omits its target',
      'fresh replica count is below the declared target',
      'consumer readiness is isolated per fresh replica',
      'stale stopped consumer no longer masks recovery',
      'enabled tenant reminder backlog raises delayed alert',
      'scheduler failure remains a release blocker',
      'stale stopped scheduler replica does not mask healthy replacement',
      'newly missed reminder raises terminal suppression alert',
      'open Web Push provider circuit raises an immediate transport alert',
    ]) {
      expect(ruleTests).toContain(`name: ${scenario}`);
    }
    expect(ruleTests).toContain('service_instance_id="healthy"');
    expect(ruleTests).toContain('service_instance_id="broken"');
  });
});
