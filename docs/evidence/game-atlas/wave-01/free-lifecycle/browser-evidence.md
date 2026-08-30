# Browser evidence

## Status

`PARTIAL_REAL_BROWSER_EVIDENCE`: a real headed Chromium run passed against the bind-mounted local Web source, local API, RabbitMQ worker/projector and disposable PostgreSQL 16.15. It used only synthetic dev identity and synthetic free games. The remaining gap is a real second authenticated user performing join/waitlist/promotion; route mocks are not represented as browser evidence.

## Real local browser observations

1. Synthetic dev authentication reached `/games/new?new=1`; the one-shot `new` query was replaced immediately with `/games/new` before any create command.
2. A FREE/NO_PAYMENT create returned HTTP `202`, navigated with `revision=1`, and displayed `Операция выполнена, данные обновляются…` while detail returned `404` before projection.
3. After the local worker processed `game.created.v1`, detail returned `200`, the card reached revision 1, and the page displayed `Создана игра. Бронирование корта не выполняется автоматически.`
4. Organizer cancel returned HTTP `202`; revision-aware reads returned `200`; the page displayed `Игра отменена` and removed the cancel action. No provider/refund text or request appeared.
5. At 390x844 the measured values were `innerWidth=390`, `scrollWidth=390`, so no horizontal overflow was present. A keyboard Tab step produced a visible-focus screenshot.
6. Two-tab lost-response recovery used a real backend commit. Tab A sent K1; the browser response and its automatic retry response were aborted, so the page stayed at `результат неизвестен`. Tab B loaded the same principal ledger, displayed the pending-attempt notice, sent the same observed K1, received canonical replay G1, and opened G1. Reloading tab A issued no create POST and opened the same G1. Read-only PostgreSQL verification returned one idempotency row and one distinct aggregate for K1.

The request diagnostic briefly displayed a short-lived synthetic local dev JWT in local tool output. It was not copied into source, evidence artifacts, Git, screenshots, or PR text; the browser session was closed after the run.

## Component/source evidence

- `CreateGamePage.test.tsx`: double-click suppression, lost-response replay with K1, cross-tab resolved K1 convergence, real `/games/new?new=1` one-shot consumption, close/reopen, principal isolation, and stable terminal errors.
- `game-revision-readback.test.ts`: convergence after the former two-second window plus distinct stale/updating and unavailable outcomes.
- `GamesPage.test.tsx`: create/read/action surfaces and revision-aware gateway readback.
- Production Web build passed after the changes.

## Screenshot inventory

Synthetic local evidence images included with this packet:

- `screenshots/narrow-converged-detail.png` — 390x844 converged game detail.
- `screenshots/narrow-keyboard-focus.png` — narrow keyboard-focus step.

## Remaining real-browser closure

Use a second authenticated synthetic user for join, full/waitlist, free leave/promotion and post-cancel hidden join actions. Add 200% zoom and an explicitly delayed live projector longer than the client polling boundary. The two-tab K1/G1 path, refresh, organizer cancel, keyboard step and narrow no-overflow checks are already covered above.
