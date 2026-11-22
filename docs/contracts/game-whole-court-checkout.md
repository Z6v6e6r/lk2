# LK2 whole-court checkout pilot

The LK2 Web create page offers a single private friendly game with four places when the
authenticated organizer has an approved court window. The offer contains the public
station/court IDs and exact RUB price. LK2 checks consent against the configured amount
and resolves the fresh approved Viva location binding before creating an operation.
The browser never receives the provider identity, mapping or transaction IDs.

The existing Games write owner stores the draft and immutable owner binding together in
PostgreSQL. The normal idempotency fence rejects a changed payload on the same key.
The pilot also serializes new keys on the same court and rejects an overlapping local
game. The draft remains PROVISIONING until confirmed. No free, subscription, tournament
or JOIN path uses this transport.

LK2 signs the exact LK1 [reserve and confirm contract from #485](https://github.com/Z6v6e6r/lk/pull/485).
An active session, current verified profile mapping, mapped station/room IDs and a
short-lived actor token are required. LK1 owns the external booking and payment. Its
original-key fence permits at most one Viva pay POST. Reserve can be replayed solely
for the original draft/key; it cannot substitute another slot, booking or transaction.

The browser stores the original operation and draft before it follows an unexpired
`https://pay.vivacrm.ru` URL in its current tab. `paymentReturn` only selects the
already saved operation. Confirmation runs through the authenticated command endpoint
using the original key. It exchanges the exact persisted private input with LK1 in
confirm mode. A mismatched, declined, timed-out or unknown response keeps that attempt
unresolved.

LK2 transactionally attaches the verified provider exercise, booking and transaction
IDs to the original game in the existing integration mapping table. The owner receipt
is captured in the original command journal. A conflicting provider mapping rolls
back; an external booking is not inserted again into a separate local booking store.
Payment state and lifecycle advance only with this receipt. The transaction stores
one scheduled event. The API uses the same projection event and inbox claim as the
Worker so that success navigates to an existing private card.

## Pilot configuration and stop condition

The API has no funded CREATE capability by default. Configure
`GAME_WHOLE_COURT_CHECKOUT_PILOT` only for a reviewed target. Its exact JSON fields are
`tenantId`, `userId`, `stationId`, `courtId`, `startsAt`, `endsAt` and `amountMinor`.
Use UUIDs and canonical UTC instants for a 60, 90 or 120 minute interval on one Moscow
date. The installed LK1 pin must designate the same actor, mapped court, interval and
amount. The Price shown by LK2 is the approved amount; LK1 rechecks the Viva full
price before dispatch. Runtime identity and OAuth configuration must already be
present. The owner origin is pinned to the approved `https://padlhub.su/` endpoint
outside explicit loopback development.

The pilot covers the approved private Web game. Before a live run, the Timeweb
runtime contract has to admit the exact pilot variables, LK1 and LK2 revisions must
be verified on their target runtimes, and the outbound provider response must match
the known proof contract. The public OpenAPI change requires the standard immutable
release path. No provider operation is performed by build, tests or this
source change. If an opaque asynchronous ID is returned, the original attempt remains
in reconciliation. Closing admission must preserve this original journal and any
existing provider booking.

Acceptance captures the current tab, the identical operation on replay, the confirmed
game card and the original IDs in the LK1, Viva and LK2 readbacks. An ambiguous provider
response, expired link or mismatched receipt is not a successful payment or a reason
to resend the Viva write.
