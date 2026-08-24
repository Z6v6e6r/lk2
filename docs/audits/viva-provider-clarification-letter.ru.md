# Тема: запрос официального разъяснения API-контракта Viva CRM

Уважаемая команда API/Product Support Viva CRM!

PadlHub оценивает возможность серверной интеграции с Viva CRM для восстановления состояния
бронирований и платежей. Мы не просим включать интеграцию или выполнять какие-либо транзакции. До
принятия решения о реализации нам требуется официальное письменное разъяснение production-контракта
для timeout, connection reset, предотвращения дублей, authoritative recovery и безопасности
callback.

Просим отвечать непосредственно под каждым вопросом. Для каждого ответа необходимо указать:

- точную версию продукта/API Viva CRM и применимое окружение;
- название, версию и URL authoritative документа либо идентификатор вложения;
- точные endpoint/method, request headers/fields, response fields и status codes, если применимо;
- retention, consistency, retry, security, ограничения и исключения, влияющие на ответ.

Просим приложить текущие production OpenAPI/Swagger, Postman collection или эквивалентный API
reference и соответствующий changelog, а также указать, какие материалы являются contractually
authoritative. Общего утверждения «поддерживается» без точного versioned contract и environment
недостаточно.

## VIVA-Q-01 — Корреляция после потери ответа

После того как точный запрос create-booking/create-transaction/payment принят, но TCP/TLS-соединение
закрывается до получения PadlHub тела ответа, какое управляемое мерчантом значение, переданное до
запроса, позволяет получить именно созданный объект без повторения команды create?

Риск: без pre-write correlation повтор POST после неопределённого результата может создать второй
booking или payment effect.

**Ответ Viva:**

**Версия/окружение и authoritative evidence:**

## VIVA-Q-02 — Идемпотентность точной операции

Для этой точной операции create укажите header или field идемпотентности, область уникальности и
срок хранения; что происходит при одинаковом ключе и payload, одинаковом ключе и изменённом payload,
timeout/reset и повторе после окончания срока хранения?

Риск: клиентская дедупликация без provider guarantee не делает повтор неоднозначного POST безопасным.

**Ответ Viva:**

**Версия/окружение и authoritative evidence:**

## VIVA-Q-03 — Authoritative recovery lookup

Какой текущий production read endpoint ищет объект по этому управляемому мерчантом значению; может ли
он вернуть несколько совпадений; как различаются never-created, not-yet-visible, deleted, expired и
rejected? Укажите окно консистентности, срок хранения истории и rate limits.

Риск: reports/UI и общий `404` не равны authoritative recovery API и не доказывают, что write не
состоялся.

**Ответ Viva:**

**Версия/окружение и authoritative evidence:**

## VIVA-Q-04 — Жизненный цикл идентификаторов

Перечислите все генерируемые провайдером идентификаторы order, booking, payment и transaction: когда
каждый впервые появляется, где присутствует в create response/read-back/callback, его область,
правила повторного использования и различия production/demo.

Риск: общий transaction ID нельзя считать ключом одной reservation без письменной allocation
semantics.

**Ответ Viva:**

**Версия/окружение и authoritative evidence:**

## VIVA-Q-05 — State machine бронирования и платежа

Предоставьте текущую production state machine и укажите terminal/reversible статусы для accepted,
rejected, failed, cancelled, expired, authorized, captured, settled, refunded, partially refunded,
reversed и charged back.

Риск: paid fact может позднее получить partial/full refund или reversal; один UI status не
разрешает convergence.

**Ответ Viva:**

**Версия/окружение и authoritative evidence:**

## VIVA-Q-06 — Неизменяемая привязка операции

Какие неизменяемые поля read-back связывают merchant/tenant, actor/client, exercise/game,
booking/order/payment, merchant reference и provider transaction с одной и той же операцией?

Риск: совпадение только по сумме или времени может подтвердить чужую операцию.

**Ответ Viva:**

**Версия/окружение и authoritative evidence:**

## VIVA-Q-07 — Amount, currency и allocation

Укажите единицу, scale и rounding суммы, а также authoritative представление currency в write,
read-back и callback. Объясните поля authorized, captured, settled, refunded, fee, net, tip,
reversal/chargeback и multiple-transaction. Укажите, может ли одна transaction или payment покрывать
несколько positions или bookings, и назовите стабильный per-position или per-booking allocation ID.

Риск: transaction total может покрывать несколько позиций, а refunds/fees меняют отображаемые
значения; требуется точная привязка суммы и валюты к локальной операции.

**Ответ Viva:**

**Версия/окружение и authoritative evidence:**

## VIVA-Q-08 — Аутентификация и целостность callback

Сначала подтвердите, предоставляет ли Viva отдельный production payment-event callback/channel, а не
только generic notification webhook. Если предоставляет, опишите его contract аутентификации и
целостности: алгоритм подписи, canonical payload, покрываемые headers, timestamp/nonce, допустимое
replay window, распространение и rotation ключей, разделение окружений и подписанные
merchant/reference fields.

Риск: generic webhook не равен secure payment callback contract; TLS или IP allowlist сами по себе
не доказывают message integrity.

**Ответ Viva:**

**Версия/окружение и authoritative evidence:**

## VIVA-Q-09 — Семантика доставки callback

Укажите область callback event ID, расписание retry, гарантии duplicate/order, поведение
old-after-new, acknowledgement status/body и обработку non-2xx.

Риск: без event ID, dedupe и ordering невозможно безопасно обработать повторные или устаревшие
наблюдения.

**Ответ Viva:**

**Версия/окружение и authoritative evidence:**

## VIVA-Q-10 — Authoritative versioned contract

Предоставьте текущие production URL OpenAPI/API reference и changelog, точную поддерживаемую версию,
deprecation policy и письменное подтверждение parity между demo/sandbox и production.

Риск: marketing, undated examples, `401` или `404` не подтверждают private production contract.

**Ответ Viva:**

**Версия/окружение и authoritative evidence:**

## VIVA-Q-11 — Production operational contract

Определите production ожидания для connect/request timeout; 429 и `Retry-After`; retryable и
nonretryable классы HTTP/provider/transport; область rate limit; максимальную частоту и горизонт
retry; обязательные exponential backoff/jitter; circuit-breaker trip, half-open и recovery probes;
read-after-write consistency; поведение при maintenance и provider SLO.

Риск: неподтверждённые retry/backoff могут усилить отказ или повторить provider effect.

**Ответ Viva:**

**Версия/окружение и authoritative evidence:**

## VIVA-Q-12 — Logging, privacy и failure isolation

Определите, какие provider correlation values могут присутствовать в logs/traces, их retention и
redaction; какие merchant/reference/client/body fields запрещены; допустимые low-cardinality metric
labels; и как failure/rate-limit/circuit state изолируется по tenant, merchant и acquiring
integration.

Риск: callback payload может содержать клиентские PII; raw body нельзя сохранять до отдельного PII
review.

**Ответ Viva:**

**Версия/окружение и authoritative evidence:**

## Полномочность ответа

Просим указать сведения о лице, подтверждающем ответы:

- ФИО;
- должность;
- подразделение/команда;
- дата ответа;
- authoritative версия продукта/API;
- применимые окружения;
- перечень authoritative документов и вложений.

Просим не включать в ответ и примеры персональные данные клиентов, credentials, secrets или реальные
transaction identifiers. Достаточно синтетических примеров.

С уважением,

PadlHub Engineering
