# LK2 R1 — GO / NO-GO

Дата:2026-10-31. **NO-GO для полного production release iOS + Android.** Разрешённый source merge и зелёный CI не доказывают runtime/provider/device готовность.

## Подтверждённые результаты

- Аудит трёх main и открытых PR выполнен; исходный inventory и последующие exact-head evidence разделены в [READINESS](R1-READINESS.md).
- #508 dependency fix merged, main CI success; его delivery был SKIPPED без steps, исходный flag восстановлен. #511 exacted385 merged в maina37c05a2 по отдельному разрешению; mainCI41230249442 SUCCESS, delivery41231241175 SKIPPED/steps=[], исходныйtrue восстановлен18:50:31 UTC.
- CUP canonical subscription ledger/rollback/TTL/preflight и LK/LK2 JOIN/FREE-SERVICE SELF имеют ограниченные physical CI доказательства. #519:4physicalSELF cases; #517:6location cases.
- #520c880 training Web/API: fullCI41229302637 SUCCESS,7360passed/126skipped, trainingPG6/6 и frozenPG4/4. CUP#6100a46932: CI41229595631 SUCCESS, physical Mongo owner projection1/1.
- #518f310 nativeCI41229015147:5passed/0failed/0skipped на synthetic iOS simulator; fullCI41229015245:7304passed/126skipped и frozenPG4/4. Logout screenshot blank; rendered logout и physical-device acceptance не заявлены.
- Product choices зафиксированы: CREATE по подписке только1/4корта; одно official community на station с auto-membership после confirmed game/training; MALE/FEMALE проверяют пол, MIXED не ограничивает его.

## Остатки по gate

| Gate                                   | Статус        | Что остаётся                                                                                                                                   |
| -------------------------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth/profile                           | PARTIAL       | Physical-device session/privacy/real credential acceptance                                                                                     |
| Subscriptions/JOIN                     | PARTIAL       | Compatible installed owner/consumer, provider/native acceptance и production guards B01/B02                                                    |
| CREATE                                 | BLOCKED       | Server-owned service/price/original-create receipt B03; quarter-court choice не заменяет contract                                              |
| LEAVE/CANCEL                           | PARTIAL       | SELF terminal refusal recovery, native/provider visit return; денежные LK1 commands существуют, но LK2 settlement/organizer loop не принят B04 |
| Training/tournament                    | PARTIAL       | Training native/managed/paid/LEAVE/provider; tournament admission/gender/capacity/generation-safe consumer B05                                 |
| Four chat contexts/station communities | BLOCKED       | Station mapping/auto-membership/send и tournament membership, native parity B07                                                                |
| Push/campaigns                         | PARTIAL       | Ordinary APNs source merged через#511; physical provider/device, opt-out/quiet-hour/retry acceptance B08                                       |
| Required E2E                           | PARTIAL       | 27game PG/broker physical cases пока skipped; полный device/provider matrix B10                                                                |
| Signed mobile/stores                   | BLOCKED       | Signing custody, reproducible signed artifacts, physical install/upgrade, store prerequisites B09                                              |
| Production package/restore/rollback    | UNKNOWN       | Exact immutable package/target, fresh backup/restore/rollback and runtime acceptance B11                                                       |
| High dependency fix                    | VERIFIED      | #508 source/mainCI; финальный package audit и moderate triage сохраняются B12                                                                  |
| Activation authority                   | NOT REQUESTED | Полный приемлемый release package ещё не подготовлен                                                                                           |

## Dependency-aware следующий шаг

Exact#511 flag cycle завершён; закрыть bounded SELF recovery и27requiredCI cases. Развивать CREATE owner, tournament admission и station membership из проверенных current contracts без generic refactoring и dual-write. Training/provider/native lanes не зависят от CREATE. Порядок взаимозависимых heads и migrations — в [DEPENDENCIES](R1-DEPENDENCIES.md).

## Условия GO

1. B01–B12 закрыты по exit criteria либо владелец явно изменил mandatory scope.
2. Совместимые LK2/LK/CUP versions и immutable package зафиксированы; open PR или merge count не acceptance.
3. Каждый required case [E2E matrix](R1-E2E-MATRIX.md) имеет фактический результат нужного уровня без silent skips.
4. Подтверждены signing/device/provider, fresh restore/rollback, observability и store prerequisites.
5. Новое evidence-based решение принято; владелец отдельно разрешил exact live/package transitions.

## Выполненные действия и границы

Task-branch commits, pushes, Draft PR и automatic CI выполнялись. Только #508 и точный #511 merged по отдельным разрешениям; другие PR не merged. Для этих source-only merges отдельно разрешено временное подавление automatic delivery. Публикация образов, workflow dispatch/rerun, deploy, реальные миграции/платежи/возвраты, secret/signing changes, пользовательские сообщения/push и store activation не выполнялись. LOCAL, CI, STAGING, PROVIDER и PRODUCTION не взаимозаменяемы.
