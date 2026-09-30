# КЯ-00 — переход и критерии приёмки

Статус: **Proposed**, план будущих операций, не их исполнение. Источник схемы и ограничения — [AUDIT.md](AUDIT.md); более широкий контрактный gate Viva уже описан в `ph-admin:docs/migration/viva-to-cup/viva-contract-and-break-glass.md` и здесь переиспользуется. Код адаптера и старый browser evidence не доказывают full export/delta, порядок событий, лицензии или продление доступа к Viva.

## Данные

1. **Первоначальная выгрузка**: официальный tenant-scoped full export всех клиентов, включая давно не входивших, и старых обязательств. Manifest с source schema version, временем, count, checksum, границами страниц. Шифрованный raw snapshot только в ограниченном хранилище с ACL, целью, владельцем и утверждённым сроком удаления; не в Git/логах. Если поставщик не даёт документированный полный экспорт, не объявлять coverage полной.
2. **Нормализация**: детерминированный transform в canonical types; `null/unknown/deleted/archived` раздельно. Viva ID хранится только как integration link. Никакого телефона/email как автоматического ключа слияния. Сохранять provenance поля, source version/time и transform version.
3. **Сопоставление**: сначала существующий `(tenant,external_system,external_id)` → PadlHub UUID, затем проверенные identity links. Unknown получает новый UUID без login readiness; ambiguous/duplicate → карантин, без записи поверх чужого клиента.
4. **Сверка**: count по tenant/статусу/времени, set/hash IDs, обязательства отдельно, выборка synthetic/разрешённых контрольных записей. Отчёт `total/imported/skipped/conflict/deleted/lag`, причины и sample только без PII. Финальный архив обязан обслуживать позднее обращение после отключения Viva.
5. **Регулярные изменения**: checkpoint `(source,cursor,page,version)` фиксируется вместе с применённым batch/inbox; повтор и overlap window безопасны через dedupe `(tenant,source,record_id,source_version)`. Older version не перетирает newer. Tombstone/merge требует архивной политики и явного решения, не cascade delete. Локально подтверждённый contact сохраняется, конфликт уходит в quarantine.
6. **Контролируемый переход owner**: текущий `integration.domain_ownership` меняется только после полного отчёта и отдельной авторизации target tenant/domain. Команды одного домена имеют одного writer; local-primary state + outbox в одной PG транзакции. Коммерческие копии остаются read-only с `source/asOf/completeness`; unknown balance запрещает списание.

Импорт и `VIVA/LOCAL` auth binding независимы. Текущий `identity.tenant_auth_config` и routing plans индексируются tenant, не клиентом (`lk2:packages/database/migrations/0003_identity_auth.sql:4-14`, `0011_client_routing_plans.sql:4-14`). Следовательно, **когортный rollout не подтверждён механизмом**. Возможен только tenant pilot после readiness либо отдельный одобренный server-owned per-user routing механизм. Не подменять его UI-флагом.

## Сценарии доступа

| Сценарий | Будущий безопасный путь | Отказ/конфликт |
| --- | --- | --- |
| Существующий клиент с Viva session | Подтвердить текущий PadlHub UUID и provider mapping, получить свежий proof, привязать LOCAL method транзакционно и аудировать; сохранить UUID | Иной subject/UUID, shared contact или race → quarantine/409, без merge |
| Новый клиент без Viva | Создать `identity.users` и local profile, подтвердить выбранный login method/контакт; Viva mapping не нужен | Не создавать Viva record/fallback; legal versions до session |
| Общий контакт | Хранить как contact у нескольких, для входа требовать отдельный однозначный verified login binding или account selection с сильным proof | Никакого auto-link по телефону/email; старый unique `user_summaries.phone_e164` меняется expand/contract |
| Сессия утрачена | Recovery с доказательством по заранее связанному method либо контролируемая staff-initiated процедура, которую завершает клиент | Staff не видит пароль, код или постоянный секрет; нейтральный ответ unknown account |
| Viva недоступна | Уже enrolled LOCAL user входит, восстанавливает session и открывает локальный профиль/архивные копии | Viva-only user получает понятный ограниченный recovery flow, не новый duplicate account |

Один OTP challenge связан с выбранным provider в момент выдачи. Проверять его только у него, без параллельного Viva/LOCAL verify или скрытого fallback. Прямые внешние ID не наследуют Viva subject; каждую привязку доказывать отдельно.

## Stop, восстановление и наблюдаемость

Остановить importer/новые links при росте конфликтов, расхождении coverage, нарушении порядка версий, PII leak или ошибке tenant/station. Не удалять уже выданные локальные сессии при остановке; временно отключить новые enrollment/команды через существующую server-owned политику только после отдельного решения. Сохранить checkpoint, audit/outbox, immutable link history и quarantine. После исправления — replay с checkpoint и forward correction; не down-migrate identity/не переписывать UUID. Простой возврат к Viva не обслужит созданных только локально пользователей. Для них оставлять LOCAL вход и локальный профиль. При incident компрометации сессии отзывать адресно, не массово из-за provider outage.

Метрики: полнота по tenant и старым обязательствам, lag source→local, conflict/retry/dead-letter, duplicate prevention, login success/failure/lockout, recovery completion, session revoke, provider egress, read-model stale/unknown. Логи и audit без телефона, email, кодов, токенов, raw payload; correlation ID связывает шаги. RTO/RPO, retention и go/no-go подписываются до пилота.

## Проверки будущих инкрементов и релиза

Это **план**, сейчас ни один сценарий не запускался.

| Gate | Минимальный сценарий и доказательство |
| --- | --- |
| Identity | Старый UUID совпадает до/после link; новый клиент без Viva не получает второй ID; две гонки import/login/link дают одну запись; конфликт subject/phone fail closed. |
| Isolation | Два tenant с одинаковым внешним ID/контактом разделены; staff без нужной station/permission не читает и не пишет; browser `userId/roles` игнорируются. |
| Import | Full → два delta → replay/late/out-of-order/tombstone; checkpoint resume; counts/checksums и обязательства давно не входивших совпадают; локально подтверждённое поле не перезаписано. |
| Auth | LOCAL setup/login/recovery при заблокированной Viva; expiry, attempts, idempotency replay/conflict, step-up, revoke current/other/all, cookie/CSRF/audience negative tests; ЦУП недоступен, consumer login работает. |
| Profile/commerce | Profile одна версия; отдельные read blocks имеют source/asOf; unknown balance не ноль и не позволяет purchase/write-off; приватность и consent versions сохранены. |
| Recovery | Полный encrypted backup PG + архив старых обязательств восстановлены в отдельной среде; сверка UUID/links/sessions/consents, RPO/RTO измерены; forward repair работает. |
| Evidence | `LOCAL` tests и source review, затем отдельно `CI`, `STAGING`, `PROVIDER` контракт/экспорт, `PRODUCTION` пилот/readback. 14 дней расписания не критерий ядра. |

Перед live переходом нужны отдельные target authority, backup/readiness/rollback и проверенный неизменный image digest по runbooks. Этот документ не разрешает миграции, flags, provider calls или деплой.
