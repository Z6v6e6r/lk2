import {
  ownerDirectedScopeSha256,
  nativeEvidenceHash,
  OWNER_DECISION_SHA256,
} from './timeweb-roster-alert-waiver.js';

// Synthetic owner references. This fixture never grants live authority.
export function ownerDirectedTestChoices(op: Record<string, unknown>) {
  const choices = {
    alertDrill: ['INDUCED_ALERT_DRILL_ONLY', 'NOT_TESTED_OWNER_DECLINED', OWNER_DECISION_SHA256],
    providerMonitoring: [
      'PRE_SWITCH_TIMEWEB_NATIVE_PROVIDER_READBACK_ONLY',
      'NOT_CHECKED_OWNER_SKIPPED',
      nativeEvidenceHash(Buffer.from('Проверку мониторинга перед переключением')),
    ],
    repeatedRestore: [
      'REPEAT_PHYSICAL_RESTORE_ONLY',
      'NOT_REPEATED_PRIOR_FULL_RESTORE_VERIFIED',
      nativeEvidenceHash(
        Buffer.from(
          'Пропусти повторное пробное восстановление базы — оно уже прошло. Исправь блокер Docker Hub и продолжай выкладку, сохранив данные, учётки, настройки и передачу результатов в ЛК1.\n',
        ),
      ),
    ],
  };
  return Object.fromEntries(
    Object.entries(choices).map(([key, [scope, status, messageSha256]]) => [
      key,
      {
        schema: 'PHUB_TIMEWEB_OWNER_PROCEDURE_DECISION_V1',
        authority: 'ROOT_OPERATOR_ATTESTED_OWNER_MESSAGE_V1',
        scope,
        status,
        messageSha256,
        scopeSha256: ownerDirectedScopeSha256(op),
        reference:
          'codex-thread:00000000-0000-4000-8000-000000000000/message:00000000-0000-4000-8000-000000000001',
        receivedAt: '2026-11-14T11:00:00.000Z',
      },
    ]),
  );
}
