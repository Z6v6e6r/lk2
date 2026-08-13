# Контекстные чаты: evidence-first матрица

Дата аудита: 2026-08-03. Статус описывает код, а не активацию в среде. Миграция и runtime-флаги
не применялись, deploy не выполнялся.

| Контекст     | Canonical UUID                                                           | Авторитетный доступ                                                                                           | Вердикт                    |
| ------------ | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- | -------------------------- |
| `GAME`       | `games.games(tenant_id, id)`                                             | `games.participations.state = 'ACTIVE'` + активный `identity.users` + актуальное `games.play`                 | **READY в коде, gate off** |
| `TOURNAMENT` | публичный summary UUID детерминирован из legacy external ID              | roster читается из legacy `/lk/tournaments/participants`; элементы не связаны с `identity.users` PadlHub UUID | **BLOCKED, fail-closed**   |
| `STATION`    | `locations.profiles.id` существует только для editorial location profile | модели участника/роли/политики доступа станции нет; базовый enum conversation не содержит `STATION`           | **BLOCKED, fail-closed**   |

## Реализованный GAME slice

- `POST /user/api/v1/{tenantKey}/conversations/game` принимает только PadlHub `gameId` UUID;
- команда требует `Idempotency-Key`, `games.play`, активную identity и текущую ACTIVE participation;
- `(tenant_id, kind='GAME', context_id=gameId)` уже защищён уникальным индексом;
- при первом создании текущий canonical roster проецируется в conversation members;
- участник, добавленный позднее, получает membership только при авторизованном get/create; stale
  membership запись сама по себе никогда не даёт read/send/read-cursor доступ;
- перед list/history/send/read-cursor повторно проверяются runtime gate, permission и текущая
  `games.participations`;
- send фиксирует message, sequence, audit и identifier-only outbox атомарно;
- создание и late-join membership пишут audit и identifier-only outbox;
- `messaging.tenant_runtime_settings.contextual_enabled` остаётся `false` по умолчанию.

## Нерешённые вопросы, которые нельзя заменить предположением

### Tournament

1. Какой LOCAL_PRIMARY агрегат турнира будет хранить tenant-local PadlHub UUID?
2. Какая таблица связывает участника турнира с `identity.users(tenant_id, id)` и кто владеет её
   актуальностью/состояниями `ACTIVE/LEFT/REMOVED`?
3. Организатор получает доступ из той же membership-таблицы или отдельной роли, и когда доступ
   закрывается после завершения/отмены?

До ответа API создания, чтения и отправки `TOURNAMENT` conversation не публикуется.

### Station

1. Что означает membership станции: сотрудник, посетитель с активной записью, участник сообщества
   станции или другой субъект?
2. Какой агрегат является canonical Station: editorial `locations.profiles` или отдельная
   operational station entity?
3. Какие роли могут читать/писать, каков срок доступа после записи и кто модерирует чат?

До утверждения модели не добавляется `STATION` kind, таблица membership или privacy fallback.

## Приёмка перед включением

1. Применить expand-only `0059_game_conversations.sql` вне startup API.
2. Проверить RLS/FORCE RLS и tenant crossover на реальном PostgreSQL.
3. При выключенном `contextual_enabled` получить 404 и ноль business writes.
4. На staging включить только `http_enabled + contextual_enabled` для тестового tenant.
5. Два ACTIVE участника одной игры получают один conversation UUID; повтор команды возвращает тот
   же UUID.
6. Пользователь вне roster, LEFT/REMOVED участник и пользователь другого tenant получают одинаковый
   fail-closed 404 на get/history/send/read cursor.
7. После удаления participation ранее созданный member немедленно теряет read/send доступ.
8. В outbox/logs нет body; повтор send с теми же ключами не увеличивает sequence.
