# Android release signing (mobile R1)

Status: **prepared mechanism, not activated.** This runbook describes how to protect, activate and
record one signed Android release candidate. It is not evidence that a signed build, environment,
secret, dispatch or store submission exists.

Prepared in mobile R1 (JOIN): `app/build.gradle` fails closed on an identity-anchored release config;
`mobile-android.yaml` matches the decoded keystore to an independent fingerprint, verifies the AAB
signature and uploads AAB/`SHA256SUMS`/`build-info.json` (never publishes). Historical Draft
**DEBUG** APKs (2026-10-10, 2026-10-12) are **non-evidence**; store status **UNKNOWN**.

**Do not activate the workflow until every mandatory prerequisite in this runbook is in place and
recorded.** Activation of a real release requires owner approval and independent review.

## Required GitHub environment and secrets

The job declares `environment: mobile-android`. Only these six environment secrets are read:

| Secret                              | Meaning                                                                                                   |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `ANDROID_KEYSTORE_BASE64`           | Base64 (single line or wrapped) of the release `.jks`                                                     |
| `ANDROID_KEYSTORE_PASSWORD`         | Keystore password                                                                                         |
| `ANDROID_KEY_ALIAS`                 | Release key alias inside the keystore                                                                     |
| `ANDROID_KEY_PASSWORD`              | Private-key password for that alias                                                                       |
| `ANDROID_RELEASE_CERT_SHA256`       | Owner-approved SHA-256 fingerprint of the release certificate, captured **outside** any build (anchor)    |
| `ANDROID_RELEASE_ACTIVATION_RECORD` | Activation evidence reference (who approved what, when, how, environment/reviewer-rule id, approval link) |

No other secret is read. The four keystore values never enter Git, logs, artifacts or the app
bundle. The two identity values are **not** secret and **are** recorded by design (job summary +
uploaded `build-info.json`/artifact). Put no credentials, tokens or PII in the activation record; it
is self-attested evidence metadata, not an approval control (the reviewer rule is).

## Mandatory activation prerequisites

Hard gates, not recommendations. Anyone able to dispatch this workflow or push a `mobile-v*` tag can
run a **modified workflow definition from their own ref** and export `secrets.ANDROID_KEYSTORE_*` (or
instrument the later JVM); a read-only token limits the token, not secret exposure. The reviewer rule
plus owner-only dispatch/tag/secret authority are the controls; **write access means the signing
material is obtainable if unprotected.**

### 1. Environment with a required reviewer rule (owner-only action)

```sh
OWNER_ID="$(gh api users/Z6v6e6r --jq .id)"
REVIEWER_ID="$(gh api users/<independent-reviewer-login> --jq .id)"
gh api --method PUT repos/Z6v6e6r/lk2/environments/mobile-android --input - <<JSON
{
  "reviewers": [
    { "type": "User", "id": $OWNER_ID },
    { "type": "User", "id": $REVIEWER_ID }
  ],
  "prevent_self_review": true
}
JSON
gh api repos/Z6v6e6r/lk2/environments/mobile-android --jq '{id, protection_rules}'
```

Both reviewers need repository read access; without a second trusted principal the rule is
meaningless. Any deployment branch/tag policy must admit the `mobile-v*` **tag** or it blocks the
tag trigger.

### 2. Owner-only authority

Only the repository owner/admin creates the environment and its six secrets (`gh secret set --env`
requires admin), creates `mobile-v*` tags and dispatches `mobile-android.yaml`. Verify and reference
this before the first dispatch (write/admin users can dispatch; rulesets govern tag creation):

```sh
gh api repos/Z6v6e6r/lk2/collaborators --jq '.[] | {login, role_name, permissions}'
gh api repos/Z6v6e6r/lk2/rulesets --jq '.[] | {id, name, target, enforcement, conditions}'
```

### 3. Signing material and identity anchor

```sh
umask 077
keytool -genkeypair -v -keystore release-upload.jks -alias padlhub-release \
  -keyalg RSA -keysize 4096 -validity 10000

# Capture the anchor from THIS creation record / the Play upload cert, independently of any build.
keytool -list -v -keystore release-upload.jks -alias padlhub-release

base64 < release-upload.jks > release-upload.jks.b64
gh secret set ANDROID_KEYSTORE_BASE64 --env mobile-android --repo Z6v6e6r/lk2 \
  < release-upload.jks.b64
rm -f release-upload.jks.b64
gh secret set ANDROID_KEYSTORE_PASSWORD --env mobile-android --repo Z6v6e6r/lk2
gh secret set ANDROID_KEY_ALIAS --env mobile-android --repo Z6v6e6r/lk2
gh secret set ANDROID_KEY_PASSWORD --env mobile-android --repo Z6v6e6r/lk2
gh secret set ANDROID_RELEASE_CERT_SHA256 --env mobile-android --repo Z6v6e6r/lk2
gh secret set ANDROID_RELEASE_ACTIVATION_RECORD --env mobile-android --repo Z6v6e6r/lk2
```

One release keystore; never commit, print, or pass passwords on argv. `.gitignore` covers
`keystore.properties`/`*.jks`/`*.keystore`/`*.p12`; the base64 copy is written under `umask 077` and
deleted immediately. Local builders may use the gitignored
`apps/mobile/android/keystore.properties` but must still export the anchor. For `-storepass:env` /
`-keypass:env` the variable must be **exported**, e.g. `read -rsp 'keystore password: '
ANDROID_KEYSTORE_PASSWORD; echo; export ANDROID_KEYSTORE_PASSWORD`. On suspected exposure (or the
planned cadence) create a new keystore, rotate the Play upload key if Play App Signing is used,
replace the material **and** expected fingerprint, rebuild and record the new certificate SHA256.
Old artifacts stay non-authoritative; never re-sign an authorized artifact.

### Activation evidence line (paste into the RC record and the activation record secret)

```
approved by/at/reference: <owner> / <independent reviewer>; <UTC timestamp>; <PR comment/approval URL/ticket>
environment: mobile-android id <id>; reviewers <logins>; prevent_self_review <bool>; policy <unrestricted | tag mobile-v*>
anchor: <fingerprint> from <creation record / Play upload cert> on <date>
dispatch/tag authority: <collaborators check + ruleset ids/output reference>
reviewer read access: <reviewers + repo permission level>
```

## Identity anchor and fail-closed behavior

A release build never falls back to debug signing, produces an unsigned artifact or accepts an
unpinned key:

- **Gradle guard.** Release packaging/signing tasks (`bundleRelease`, `assembleRelease`,
  `packageRelease*`, `signRelease*`, `build`; AGP 8.13 has no `validateSigningRelease` task) fail when
  the four keystore inputs are absent, `ANDROID_RELEASE_CERT_SHA256` is absent/malformed, the keystore
  is unreadable, the certificate is the debug cert (portable `CN=Android Debug` check plus a
  local-fingerprint layer), or the observed certificate differs from the anchor.
- **Workflow.** Fails before Gradle when a secret is absent, the anchor does not normalize to 64 hex,
  the activation record is blank/multiline/non-reference-shaped, the keystore is the debug cert, or
  its certificate differs from the anchor. The anchor tolerates colons/lowercase/line wraps; only the
  activation record must be single-line. After the build it fails before upload when the AAB is
  unsigned, has anything but exactly one signer, or its signer cert differs from the anchor; it never
  records an `UNKNOWN` cert. `jarsigner -verify` (non-strict) output is inspected, not trusted: its
  warnings on the self-signed upload cert do not fail the gate; signer count and cert are checked.

Local release runs must set `ANDROID_KEYSTORE_*` **and** `ANDROID_RELEASE_CERT_SHA256`, and use
`--no-daemon` (a reused daemon sees stale env). Expected RED with no setup:

```sh
cd apps/mobile/android && ./gradlew --no-daemon :app:bundleRelease
# * Where: Build file '.../apps/mobile/android/app/build.gradle' line: 133
# * What went wrong:
# Android release signing is not configured: missing keyAlias (ANDROID_KEY_ALIAS), keyPassword
# (ANDROID_KEY_PASSWORD), storeFile (ANDROID_KEYSTORE_PATH), storePassword (ANDROID_KEYSTORE_PASSWORD).
# Provide ANDROID_KEYSTORE_PATH, ANDROID_KEYSTORE_PASSWORD, ANDROID_KEY_ALIAS and ANDROID_KEY_PASSWORD
# as environment variables or create the gitignored apps/mobile/android/keystore.properties.
# Refusing to build an unsigned or debug-signed release. See the runbook.
# BUILD FAILED, exit 1
```

With keystore inputs but no anchor: `... missing the approved release certificate anchor ... unpinned
key`; with the debug keystore: `... rejects the Android debug certificate`.

## Produce and record one signed release candidate

Prerequisites: JOIN merged; new `versionCode`/`versionName` for the RC (current `14`/`1.13` predates
JOIN); activation prerequisites recorded; owner approval after review. Record the result under
`output/` as `CI`; never claim `STAGING`/`PRODUCTION` from it.

1. Dispatch (requires the owner-only dispatch authority; neither this runbook nor the prepared PR
   grants it): `gh workflow run mobile-android.yaml --ref <approved-source-ref>`.
2. Capture from the run: source SHA, ref, run/artifact URL, `versionCode`/`versionName`, AAB SHA256,
   expected/observed certificate SHA256 and the activation record (`build-info.json` + `SHA256SUMS`).
   Verify before device use: `sha256sum -c SHA256SUMS`; `keytool -printcert -jarfile
app-release.aab` shows exactly one signer whose SHA256 equals the approved anchor. Mismatch voids
   the RC.
3. Device matrix uses an installable APK derived from that exact AAB and signed with the same release
   key, not a debug build. bundletool cannot recover the key from the bundle, so pass the keystore
   explicitly and let it prompt (nothing enters shell history):

```sh
bundletool build-apks --bundle app-release.aab --output rc.apks --mode=universal \
  --ks release-upload.jks --ks-key-alias padlhub-release
unzip -o rc.apks universal.apk
sha256sum universal.apk                          # record this too
apksigner verify --print-certs universal.apk     # must equal the approved release cert
adb uninstall ru.padlhub.app                     # a previous debug-signed install blocks the update
adb install -r universal.apk
```

## Device matrix (mobile R1 acceptance)

Run every row on a real device and/or the owned `padlhub_api36` emulator, on the installed APK whose
SHA256/versionCode is recorded above. Capture per row: APK SHA256 + `versionCode`, device model/OS,
WebView version, PASS/FAIL/NOT RUN, raw evidence (adb/logcat, screenshot/video name, redacted
HTTP method/route/status). `NOT RUN` is not PASS.

| #   | Check                                                                     | Evidence to capture                                                         |
| --- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 1   | Explicit consent shows product, price, expiry and revision before COMMAND | Screenshot + request body keys; no command sent before consent              |
| 2   | Process kill → reopen recovers the same original key; no new POST         | Before/after screenshots, logcat, exactly one POST, GET readback of it      |
| 3   | Offline/timeout → UNKNOWN, no replacement POST                            | Airplane-mode/timeout trace, one POST, UNKNOWN state screenshot             |
| 4   | Payment deep-link / back / cancel returns to the same custody state       | Screenshot per step, no second COMMAND POST                                 |
| 5   | Double tap → one command                                                  | Two taps, exactly one POST, one resulting booking state                     |
| 6   | Logout → another tenant/user sees no prior data or custody                | Two accounts, screenshots and requests per account                          |
| 7   | New session of the same principal still recovers its custody              | Re-login screenshots, GET by original key, no new POST                      |
| 8   | No mutation replay in native/auth-refresh transport on 401/refresh        | 401/timeout logcat, single POST, refresh only re-reads                      |
| 9   | Web Locks / persisted custody inside WebView; fail closed when absent     | WebView console/logcat, custody-contention result, no localStorage fallback |
| 10  | Keyboard and accessibility: focus, labels, Back, no hidden actions        | Screenshots with keyboard, TalkBack labels, Back behaviour                  |
| 11  | Card/roster/personal booking readback matches server readback             | Server GET result vs screenshots for card, roster and My Bookings           |

Store status remains **UNKNOWN** until an operator observes Play Console / App Store Connect
separately. This runbook does not authorize store submission, publication, dispatch, tag creation or
merge.
