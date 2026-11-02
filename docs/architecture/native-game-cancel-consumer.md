# Native organizer game cancellation

Android game details expose CANCEL only for the canonical ORGANIZER relation and server-provided CANCEL action. Confirmation and a single in-flight invocation precede the existing command. iOS retains the same capability.

Native cancellation binds the original principal and access token before and after the bridge and after SDK response decoding. Each invocation sends one native POST with an idempotency key and `ORGANIZER_REQUEST`; it does not retry on network failure or refresh/replay after 401. Browser SDK behavior remains unchanged. Logout retires Android cancellation responses just like JOIN and SELF LEAVE.

An ambiguous ACK is resolved by the existing canonical GET through `cancelGameAndRead`, never by an automatic second cancellation. Canonical cards with a lower revision cannot overwrite a later observation, and a confirmed CANCELLED card cannot regress to an active card. This applies to initial reads, manual refresh and participation readback. A late initial response cannot resurrect the cancellation control.

The backend remains aggregate-idempotent. This change neither executes nor proves a Viva refund: cancellation state and attributable financial settlement remain separate evidence. Source tests use synthetic bridges only. Signed-device, provider and runtime acceptance remain release gates; no payment configuration, deployment, signing or store operation is included.
