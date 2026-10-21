# Клиентское ядро: текущее задание и следующие шаги

## Актуализация на 21 октября 2026

Это проверенный срез задачи, а не разрешение на merge, deploy или следующий auth-инкремент.
При возобновлении заново проверить текущие main, task head и владельца миграционной цепочки.

| Этап                                           | Проверенный статус                                                                                      |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| КЯ-01a: внутренние контакты                    | [PR #342](https://github.com/Z6v6e6r/lk2/pull/342) merged                                               |
| КЯ-01b: чтение собственных контактов           | [PR #344](https://github.com/Z6v6e6r/lk2/pull/344) merged                                               |
| КЯ-02a/04: отзыв сессий и enrolled-email login | [PR #347](https://github.com/Z6v6e6r/lk2/pull/347) merged                                               |
| КЯ-04: внутренний proof/reset                  | [PR #349](https://github.com/Z6v6e6r/lk2/pull/349) OPEN / Draft; интеграция с актуальным main не готова |

### Что готово и какое доказательство сохраняется

Ветка `codex/local-password-email-proof-kya04-20261005`, проверенный исходный head
`d78ac0b200ad7621d8b641ce78ef5d29de3f0ee3`, worktree
`.worktrees/consumer-session-revocation-kya02a-20261003`. Продолжать эту ветку; повторную задачу
session revocation/password login не создавать.

Внутренний reset для уже доверенно enrolled email credential реализован: одноразовый proof,
TTL/attempt limits, generation fence, atomic consume/hash update/revoke-all/receipt/audit,
отзыв локальной provider delegation. Он не выдаёт новую сессию: требуется новый consumer login.
Нет public reset/enrollment API, UI, production sender или работающего восстановления для пользователей.

[CI 37286583813](https://github.com/Z6v6e6r/lk2/actions/runs/37286583813) на исходном head SUCCESS:
5 164 tests PASS / 105 skipped, PostgreSQL 23/23, service 15/15, secret scan, source-quality,
пять Docker builds и pr-gate PASS. Security/migration source reviews завершены; две последние
коррекции меняли только synthetic PostgreSQL fixtures. Это доказательство исходного пакета,
а не нового сочетания с текущим main. LOCAL: focused 26 PASS / 23 CI-only skipped; full check
5 010 PASS / 258 skipped / одна ошибка Docker-parser при отсутствующем daemon. Повторного запуска
при актуализации нет. STAGING / PROVIDER / PRODUCTION и device acceptance не выполнялись этой задачей.

### Почему прежнее «готов к merge» устарело

Свежий `origin/main` — `0484c8159d2b21f9f2844ddcfe1bc7c0397c60f0`; общий предок —
`5393fae90d00639d9128557bb5ae67d02f84abbf`. GitHub сообщает CONFLICTING / DIRTY для #349.
Обе стороны добавляют database build/export и TypeScript path entries в
`packages/database/package.json` и `tsconfig.json`: нужно сохранить и support-tickets, и password-reset.

Main уже содержит `0098_support_tickets.sql`; PR добавляет `0098_local_password_reset_proofs.sql`.
Migrator сортирует полные имена файлов и учитывает их в ledger по filename/checksum: одинаковый
числовой префикс сам по себе не доказывает runtime-ошибку. Однако порядок/номер новой миграции
и canonical rehearsal нужно согласовать с текущей цепочкой; старое доказательство 0097→0098
не сертифицирует upgrade после support. Уже опубликованные/применённые миграции не переименовывать.

### Текущее ограниченное задание: подготовить #349 к слиянию

1. Проверить свежие main/head, чистоту собственного worktree, владельцев общих файлов и миграций;
   согласовать последовательность с support activation #400. Не менять чужие ветки/файлы.
2. Без force-push интегрировать main в собственную ветку; сохранить обе database capabilities и
   path mappings. Выбрать совместимое имя/порядок только новой reset-миграции и обновить её ссылки.
3. Проверить canonical migration apply/reapply/rollback на новой цепочке, tenant RLS, atomic reset,
   concurrency/replay, revocation и denial cases. Переиспользовать неизменённые результаты;
   для изменённой интеграции получить применимые specialist review и exact-head CI.
4. После отсутствия конфликтов и успешных обязательных gates представить один пакет на решение
   владельца о merge. Merge, публикация, реальные миграции/ACL и deploy — отдельные переходы.

Актуализация документа не выполняет пункты 1–4 и не начинает новый auth-инкремент.

### После принятия #349: отдельный продуктовый инкремент

Сначала определить trusted enrollment конкретного существующего UUID: свежий proof уже
привязанного фактора плюс proof нового email, conflict handling и server-owned credential writer.
Выбрать mail transport, delivery/notification policy и необходимые ресурсы. Затем отдельно
проектировать public Origin/intent/idempotency/body contracts, безопасные ответы/тайминги,
observability, runtime ACL/retention/capacity и клиентский сценарий. Новый scope требует нового
распределения auth/schema ownership; открытые phone confirmation/linking #244/#242 не являются
доказательством принятого enrollment и не должны получить параллельного writer.

Verified contact не является login binding. Сохранять тот же `identity.users.id` во всех способах
входа; запрещён auto-merge по телефону/email/имени. Сессия, импорт или контакт не заменяют свежий
proof. Source/CI/synthetic sender не доказывают реальную доставку, пользовательское восстановление
или production activation. Полный КЯ-04 остаётся незавершённым.

## История постановки после КЯ-01a

Статус: **Proposed prompt**, не разрешение на исполнение. КЯ-01a добавляет только внутренние `profile.contacts` и repository. Его миграцию, тесты и Draft PR нужно оценивать по фактическим LOCAL/CI результатам; этот документ не означает, что код уже merged или применён на какой-либо БД.

## КЯ-01b — авторизованное чтение собственных контактов

Один результат: после принятия КЯ-01a добавить server-owned self-only read contract для списка неподтверждённых контактов текущего `identity.users.id` из `profile.contacts`, с явным DTO для provenance. Сначала проверить существующий `GET /profile`, его User OpenAPI/SDK и реальные consumer нужды; выбрать минимальную совместимую форму read API. Авторизовать tenant/user из проверенной сессии, не из browser параметров. Проверить, что чужой user/tenant не видит PII, пустой список корректен, старый profile contract остаётся совместимым. Поле подтверждения и отдельная аттестация остаются будущей задачей с trusted proof path.

Перед подключением первого runtime consumer добавить необходимый package export, проверить закреплённый runtime bundle и явно определить минимальные ACL для `profile.contacts` и связанных audit/outbox операций под фактической runtime-ролью. КЯ-01a не экспортирует repository из корня пакета и не предоставляет live-роли новые права.

Никакой contact value не должен становиться ключом выбора аккаунта. КЯ-01b не меняет normal auth lookup по `(issuer,subject)`/provider profile ID, не создаёт login binding, verifier, восстановление, importer или staff-доступ. Изменение resolver-а допускается только в отдельной задаче после доказанной необходимости. Новый write API и UI также требуют отдельного решения. Для public contract нужны compatibility и security reviews, синтетические negative tests и фактические CI результаты.

## Реализация КЯ-01b

В инкременте выбран отдельный `GET /profile/contacts`, чтобы не менять существующий профиль.
SDK предоставляет `getProfileContacts()`, API получает reader из `@phub/database/contacts` и
проверяет текущий ACTIVE аккаунт через AuthService. Минимальная ACL и условия активации описаны в
[домене profiles](../../domains/profiles.md#own-unverified-contacts-кя-01b).
Фактические LOCAL/CI результаты фиксируются в Draft PR; эта запись не означает merge, деплой,
применение `0096` или изменение прав на реальном target. Следующий продуктовый инкремент требует
отдельного выбора: подтверждение контактов нельзя добавлять без trusted proof path.

## Текущий инкремент КЯ-02a

После merge КЯ-01b выбран первый consumer security инкремент: server-side проверка отзыва
access-сессии на защищённых API маршрутах и сериализация refresh/logout. Контракт и пределы
описаны в [ARCHITECTURE.md](ARCHITECTURE.md#кя-02a-отзыв-access-сессии-на-api).
Новые login/recovery/contact verification/staff API не входят в этот результат.
В той же task branch/Draft PR следующий инкремент добавляет внутренний revoke-all persistence
primitive и выравнивает user-lock при создании сессии. Он вызывается на client уже открытого
tenant transaction и может войти в будущий atomic reset; сам reset и public command не выпущены.
[Proof/reset contract](ARCHITECTURE.md#кя-02a-внутренний-массовый-отзыв-и-proof-contract) фиксирует
account/method/purpose/generation binding, single consume и общий transaction/receipt.
Для КЯ-04 остаётся выбрать trusted LOCAL proof/delivery contract и реализовать конкретные
credential/proof writers с generation fence, same-client replacement policy и negative tests.
До этого public reset/revoke-all остаются недоступны. Разработка не означает merge или деплой.

## Текущий инкремент КЯ-04 — email + пароль

Первый LOCAL способ выбран: **email + пароль**. Additive consumer `POST /auth/password/login`
и SDK `loginWithPassword()` работают только с заранее доверенно enrolled login binding,
не с `profile.contacts`/email профиля. Реализованы фиксированный scrypt, независимые Redis
лимиты, process admission, generation/hash recheck под user lock и atomic session/receipt/audit.
Refresh-token replay использует прежний HMAC hash и проверяет exact root/expiry/revoke/rotation.
Схема 0097 expand-only и не заселяет credentials. Инварианты, ACL и recovery описаны в
[ADR 0004](../../adr/0004-provider-neutral-authentication.md#кя-04-additive-emailpassword-consumer-login).

Следующий результат: trusted email delivery/proof и server-owned enrollment конкретного UUID,
затем atomic password reset/recovery с generation fence/revoke-all. Setup/recovery/public
register пока отсутствуют. До этого не создавать production credentials из контактов, импорта
или ручного backfill и не активировать LOCAL login для пользователей. Runtime роль login не
получает запись credentials. Фактические LOCAL/CI/review результаты фиксируются в Draft PR.
Разработка не означает merge, применение 0097, real ACL, публикацию или деплой.

## Следующий инкремент КЯ-04 — внутренний email-proof/reset

PR #347 слит в `main` как `5393fae90d00639d9128557bb5ae67d02f84abbf`.
Следующий ограниченный результат — внутренний одноразовый proof для **уже доверенно enrolled**
email credential и atomic password reset, без public API/runtime sender. Его контракт описан в
[ADR 0004](../../adr/0004-provider-neutral-authentication.md#кя-04-internal-enrolled-email-recovery-proof-and-reset).
Почтовый сервис ещё не выбран и не настроен. SMTP/API transport и реальная отправка — отдельная
граница. Source/local fixtures не доказывают доставку или production activation.

Initial enrollment нового email к прежнему UUID остаётся следующим результатом: нужна свежая
проверка уже привязанного фактора, а затем proof нового адреса. Существующая consumer-сессия,
контакт, импорт или совпадение email этого не заменяют. Reset не создаёт новую сессию: после
атомарного отзыва прежних семей и локальных provider delegations нужен новый consumer login.
Никакие реальные credentials, grants или migration/backfill не выполнены этой разработкой.
