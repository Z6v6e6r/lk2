# Следующее ограниченное задание после КЯ-01a

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
