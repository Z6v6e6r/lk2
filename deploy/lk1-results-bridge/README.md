# LK1 кабинет: приём подтверждённого результата из LK2

Мост `LK2 → LK1`: результат, подтверждённый в ЛК2, попадает в Mongo ЛК1 как **CONFIRMED** и игра
помечается как «результат внесён». Архитектурное решение — [ADR 0028](../../docs/adr/0028-lk1-result-import-bridge.md).

## Что нужно один раз

1. Импортировать `lk2-result-import.flow.json` в Node-RED на хосте ЛК1 (меню → Import → выбрать файл;
   появится отдельная вкладка «LK2 result import»).
2. В появившейся вкладке у трёх Mongo-узлов (`Find game`, `Find existing results`,
   `Insert confirmed result`, `Update game result status`) выбрать существующее подключение к Mongo
   (то же, что у узлов вкладки «LK game results»). В файле прописан `clientNode`
   `4e820638cc39c730` — если на хосте идентификатор другой, выбор обязателен, иначе узлы не сохранятся.
3. Задать токен моста в окружении Node-RED (`settings.js`, `functionExternalModules`/`env`).

   ```js
   process.env.LK1_RESULT_BRIDGE_TOKEN = 'LK1_RESULT_BRIDGE_TOKEN';
   ```

   Проще — в systemd-юните `node-red.service` (`Environment=LK1_RESULT_BRIDGE_TOKEN=...`) или в
   `/root/.node-red/.env`, если он подключён. Токен ≥ 32 символов, тот же самый, что
   `LK1_RESULT_BRIDGE_TOKEN` в LK2.

4. Deploy → вкладка активна. Без токена эндпоинт отвечает `503 LK1_BRIDGE_NOT_CONFIGURED`, то есть
   до настройки он безопасен.

## Ограничения функции Node-RED

В function-узлах Node-RED нет `require`, `crypto` и нет гарантированного `Buffer`: первый деплой на
147 упал на `ReferenceError: require is not defined` и запрос висел без ответа. Поэтому:

- токен сравнивается в чистом JS (XOR по charCode с проверкой длины), без `crypto.timingSafeEqual`;
- id документа результата детерминированный — `res_lk2_<externalResultId>`, без `crypto.randomUUID()`.

Правило для будущих правок этой вкладки: только `msg`, `env`, `node`, `flow`, `context` и обычный
JS. Проверка компиляции без деплоя: `new Function('msg','env','node','flow','global','context', func)`.

## Контракт

`POST /lk-bridge/api/v1/game-results/import`

```http
Authorization: Bearer <LK1_RESULT_BRIDGE_TOKEN>
Idempotency-Key: game-result:<resultId>:v<revision>
Content-Type: application/json

{
  "gameId": "<id игры в ЛК1 (Mongo _id)>",
  "externalResultId": "<resultId в ЛК2>",
  "externalResultRevision": 3,
  "submitterPhone": "+79990001122",
  "teams": {
    "teamA": ["+79990001122", "+79990001123"],
    "teamB": ["+79990001124", "+79990001125"]
  },
  "scoreA": 2,
  "scoreB": 1,
  "confirmedAt": "2026-11-09T09:05:00.000Z"
}
```

`teams` — состав команд по телефонам, как он записан в результате ЛК2 (пара из первого сета). Поле
необязательное, но обязательное по существу для игр, созданных из виджета разбивки: в их документах
ЛК1 нет ни `participants[].phone`, ни `participantPhones`, поэтому команды и отправителя не из чего
восстановить, и без `teams` flow отвечает `422 LK1_GAME_TEAMS_UNAVAILABLE`, ничего не записывая.
Если `teams` передан, он имеет приоритет над составом из документа игры; иначе flow работает по
прежней схеме (телефоны участников игры).

Ответы:

| Код                                                | Значение                                                                                                     |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `200`                                              | результат записан в `lk_game_results` (`status: CONFIRMED`, `source: LK2`) и `lk_games` помечен как resulted |
| `409 LK1_RESULT_ALREADY_IMPORTED`                  | по этой игре уже есть результат — повторная доставка, ничего не меняется                                     |
| `401 LK1_BRIDGE_UNAUTHORIZED`                      | нет/неверный токен                                                                                           |
| `404 LK1_GAME_NOT_FOUND` / `422 LK1_GAME_ARCHIVED` | игры нет или она архивная                                                                                    |
| `422 LK1_SUBMITTER_NOT_PARTICIPANT`                | телефон отправителя не из состава игры                                                                       |
| `422 LK1_GAME_TEAMS_UNAVAILABLE`                   | в игре не восстанавливаются две команды                                                                      |
| `503 LK1_BRIDGE_NOT_CONFIGURED`                    | токен не задан на хосте                                                                                      |

Идемпотентность: `externalResultId` (в паре с `gameId`) — если документ уже есть, второй не
создаётся и `409` возвращается сразу. Повтор после потерянного ответа безопасен.

Счёт: ЛК1 хранит один счёт на матч. Один сет ЛК2 переносится как есть; несколько сетов — по выигранным
сетам; при равных сетам берётся сумма очков (правило в `apps/worker/src/lk1-result-score.ts`).

## Проверка после деплоя

```sh
curl -s -X POST https://<LK1_HOST>/lk-bridge/api/v1/game-results/import \
  -H "Authorization: Bearer $LK1_RESULT_BRIDGE_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"gameId":"<id игры>","externalResultId":"<resultId>","submitterPhone":"+79990001122","scoreA":2,"scoreB":1}'

# повтор того же запроса должен вернуть 409 LK1_RESULT_ALREADY_IMPORTED
```

Затем в кабинете ЛК1 открыть этот матч: должен появиться счёт.

## Что этот flow НЕ делает

- **Пересчёт рейтинга.** В ЛК1 он живёт в отдельной функции «Confirm result + calc rating»
  (`node-red.results.grade-threshold-fix-*.json`), которая ждёт `msg._resultPending` — документ
  результата — и `msg.payload` — строки `player_ratings` по четырём телефонам. Чтобы рейтинг
  двигался, вывод `Update game result status` нужно соединить с этой функцией, передав вставленный
  документ как `_resultPending`. Это делается на стороне ЛК1 отдельным шагом, когда есть доступ к
  хосту; до этого счёт виден, рейтинг не меняется.
- **Обратное направление** (результат из ЛК1 в ЛК2) и **повторное открытие/оспоривание** уже
  импортированного результата.
- **Игры, созданные в ЛК2**: их в ЛК1 нет, мост их пропускает по определению.
