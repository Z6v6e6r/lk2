# Booked-operation v3: доплата, оплата и отмена

Статус: **SOURCE, не активировано**. LK1 ещё не публикует v3-приёмник; LK2 v3 не вызывает.
v2 остаётся действующим контрактом для JOIN с нулевой доплатой и не меняется.

## Зачем v3

v2 умеет только `USE_SUBSCRIPTION` с `finalPriceMinor === 0`. Для 90/120 минут с частичным
покрытием нужна денежная доплата: ссылка на оплату, срок, фактическое состояние оплаты и
безопасная отмена неоплаченной попытки. Эти поля нельзя добавить в v2 без изменения его
exact-key контракта, поэтому вводится v3.

## Общая граница с CREATE

v3 использует те же `CommercialTarget`/котировку и те же состояния, что описаны в
`docs/contracts/game-create-join-shared-contract.md` (владелец — CREATE). Отличия только в
транспорте:

| Понятие   | v3                                                                                                                             |
| --------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Действие  | `JOIN_GAME` или `CREATE_GAME`                                                                                                  |
| Цель      | `GAME` (существующая) или `DRAFT_GAME` (черновик CREATE)                                                                       |
| Котировка | `quoteId`, `basis`, `durationMinutes` 60/90/120, `amountMinor`, `coveredMinutes`, `surchargeMinor`, `expiresAt`, `priceDigest` |
| Согласие  | ровно `{quoteId, amountMinor, currency}`; сервер сверяет с действующей котировкой                                              |
| Расчёт    | `settlement.mode=ZERO                                                                                                          | SURCHARGE`, `toPayMinor`, `checkoutUrl`, `expiresAt`, `state` |
| Квитанция | `receipt` только от владельца; HTTP 200 и возврат с платёжной страницы успехом не считаются                                    |

## Маршруты

- `POST /lk/integrations/v3/booked-operation-preflights`
- `POST /lk/integrations/v3/booked-operation-admissions`
- `GET  /lk/integrations/v3/booked-operations/{operationId}`
- `POST /lk/integrations/v3/booked-operations/{operationId}/cancel`

Авторизация — та же RS256-делегация ЛК2→ЛК1 и actor token; добавляются scopes
`subscription-runtime.booked-operation.preflight/admit/read/cancel`. v3 не ослабляет v2:
подпись, `request_sha256`, `idempotency_key_sha256`, TTL и exact-body сохраняются.

## Раздельные состояния

Один флаг запрещён. Read-ответ содержит независимые оси:

```text
payment.state: NOT_REQUIRED | OPEN | PAID | CLOSED | UNKNOWN
booking.state: NONE | PENDING | CONFIRMED | CANCELLED | UNKNOWN
visit.state:   NOT_CONSUMED | CONSUMED | RETURNED | NOT_APPLICABLE | UNKNOWN
```

- `payment=PAID` и `booking=PENDING` — нормальное промежуточное состояние.
- `payment=CLOSED` не означает `visit=RETURNED`.
- `booking=CONFIRMED` не означает, что отмена ожидающей оплаты разрешена.
- `visit=RETURNED` требует доказательства владельца, а не локального таймера.

## Отмена

- `cancel` принимает только `{contractVersion:3, operationId, reason:'USER_CANCEL'}`.
- Идемпотентен: `CLOSING` → `CLOSED` или `PAID`.
- `PAID` выигрывает гонку; отмена неоплаченной попытки не отменяет подтверждённое участие.
- `limitReleased` и `visitReturned` — независимые доказанные факты. `202 CLOSING` не даёт
  права объявить лимит освобождённым.
- Второго механизма отмены нет: v3 использует существующий owner release/cleanup и visit worker.

## Совместимость и порядок

1. v2 не меняется; клиенты, не знающие v3, продолжают работать.
2. LK1 публикует v3-приёмник и scopes; LK2 включает v3 только после согласованного релиза.
3. До активации LK2 отвечает `GAME_PAYMENT_REQUIRED` для `amountMinor > 0`; это безопасный
   отказ, а не «бесплатная игра».
4. Любое изменение полей v3 после старта — отдельный PR владельца схемы (JOIN), с ревью CREATE.

## Проверки

`packages/subscription-runtime-adapter/src/booked-operation-v3.test.ts`: exact keys, 120 минут,
HTTP checkout запрещён, `OPEN` без срока запрещён, раздельные состояния, идемпотентная отмена.
Это LOCAL-контракт; LK1/Viva/STAGING не проверялись.
