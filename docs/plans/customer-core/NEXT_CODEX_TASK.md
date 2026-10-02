# Следующее ограниченное задание после КЯ-01a

Статус: **Proposed prompt**, не разрешение на исполнение. КЯ-01a добавляет только внутренние `profile.contacts` и repository. Его миграцию, тесты и Draft PR нужно оценивать по фактическим LOCAL/CI результатам; этот документ не означает, что код уже merged или применён на какой-либо БД.

## КЯ-01b — авторизованное чтение собственных контактов

Один результат: после принятия КЯ-01a добавить server-owned self-only read contract для списка неподтверждённых контактов текущего `identity.users.id` из `profile.contacts`, с явным DTO для provenance. Сначала проверить существующий `GET /profile`, его User OpenAPI/SDK и реальные consumer нужды; выбрать минимальную совместимую форму read API. Авторизовать tenant/user из проверенной сессии, не из browser параметров. Проверить, что чужой user/tenant не видит PII, пустой список корректен, старый profile contract остаётся совместимым. Поле подтверждения и отдельная аттестация остаются будущей задачей с trusted proof path.

Перед подключением первого runtime consumer добавить необходимый package export, проверить закреплённый runtime bundle и явно определить минимальные ACL для `profile.contacts` и связанных audit/outbox операций под фактической runtime-ролью. КЯ-01a не экспортирует repository из корня пакета и не предоставляет live-роли новые права.

Никакой contact value не должен становиться ключом выбора аккаунта. КЯ-01b не меняет normal auth lookup по `(issuer,subject)`/provider profile ID, не создаёт login binding, verifier, восстановление, importer или staff-доступ. Изменение resolver-а допускается только в отдельной задаче после доказанной необходимости. Новый write API и UI также требуют отдельного решения. Для public contract нужны compatibility и security reviews, синтетические negative tests и фактические CI результаты.
