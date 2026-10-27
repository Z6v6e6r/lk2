# Android release signing (mobile R1)

Status: **prepared mechanism, not activated.** This runbook describes how to produce and record one
signed Android release candidate. It is not evidence that a signed build, environment, secret,
dispatch or store submission exists.

Prepared in the mobile R1 (JOIN) signing change. Companion facts:

- `apps/mobile/android/app/build.gradle` defines a fail-closed release `signingConfigs.release`.
- `.github/workflows/mobile-android.yaml` decodes one environment secret, runs `bundleRelease` and
  uploads the AAB, its SHA256 and `build-info.json`. It never publishes.
- Historical Draft **DEBUG** APKs (2026-10-10 and 2026-10-12) are **non-evidence** for mobile R1:
  debug-signed, Draft, and they predate the JOIN consent/custody code.
- Store status is **UNKNOWN** until separately observed. A build artifact is not a store release.

Activation of the workflow on a real release requires owner approval and independent review.

## Required GitHub environment and secrets

The job already declares `environment: mobile-android`. Only these four names are read:

| Secret                      | Meaning                                       |
| --------------------------- | --------------------------------------------- |
| `ANDROID_KEYSTORE_BASE64`   | Base64 (single line or wrapped) of the `.jks` |
| `ANDROID_KEYSTORE_PASSWORD` | Keystore password                             |
| `ANDROID_KEY_ALIAS`         | Release key alias inside the keystore         |
| `ANDROID_KEY_PASSWORD`      | Private-key password for that alias           |

No other secret is read. Values never enter Git, logs, artifacts or the app bundle.

### How to create them (needs credential/signing-material authority)

Repository: `Z6v6e6r/lk2`. Do this from an operator workstation, never from a PR branch.

```sh
# 1. Release keystore, created once and then stored in the approved secret manager.
#    Keytool prompts for the passwords; do not pass them on the argv.
keytool -genkeypair -v -keystore release-upload.jks -alias padlhub-release \
  -keyalg RSA -keysize 4096 -validity 10000

# 2. Create the environment (once).
gh api --method PUT repos/Z6v6e6r/lk2/environments/mobile-android

# 3. Store the four secrets in that environment, then delete the local base64 copy.
base64 < release-upload.jks > /tmp/padlhub-release.jks.b64
gh secret set ANDROID_KEYSTORE_BASE64 --env mobile-android --repo Z6v6e6r/lk2 \
  < /tmp/padlhub-release.jks.b64
rm -f /tmp/padlhub-release.jks.b64
gh secret set ANDROID_KEYSTORE_PASSWORD --env mobile-android --repo Z6v6e6r/lk2
gh secret set ANDROID_KEY_ALIAS --env mobile-android --repo Z6v6e6r/lk2
gh secret set ANDROID_KEY_PASSWORD --env mobile-android --repo Z6v6e6r/lk2

# 4. Record the public signing identity for later comparison.
keytool -list -v -keystore release-upload.jks -storepass:env ANDROID_KEYSTORE_PASSWORD \
  -alias padlhub-release | grep -E 'SHA256:'
```

Do not enable "protected branches only" deployment policy unless the policy also admits the
`mobile-v*` tag ref this workflow triggers on; otherwise the tag run is blocked before the job.
Requiring a reviewer on the environment is encouraged: activation then needs the review anyway.

## Signing-material handling

- One release keystore. Keep the `.jks` in the approved secret manager and the local operator
  machine only. `.gitignore` excludes `apps/mobile/android/keystore.properties`, `*.jks`,
  `*.keystore` and `*.p12`.
- Never commit, never print, never `cat` a properties file, never pass passwords as CLI arguments
  that appear in logs or process lists. Use `-storepass:env` / `-keypass:env` and CI secrets.
- Local builders may use the gitignored `apps/mobile/android/keystore.properties` with keys
  `storeFile`, `storePassword`, `keyAlias`, `keyPassword`; a relative `storeFile` resolves against
  `apps/mobile/android`. CI uses the environment variables instead. Never both with different keys.
- The CI keystore is decoded into `$RUNNER_TEMP` only, mode `0600`, and is never uploaded. The only
  artifacts are the AAB, `SHA256SUMS` and `build-info.json`.
- Rotation plan: if exposure is suspected, or at the planned cadence, create a new release keystore,
  rotate the Play upload key if Play App Signing is in use, replace all four environment secrets in
  one change, rebuild and record the new certificate SHA256. Old artifacts stay non-authoritative;
  never "re-sign" an existing authorized artifact with a new key.

## Fail-closed behavior

- Gradle: if any input is blank or the keystore file is missing, `bundleRelease`/`assembleRelease`/
  `packageRelease*`/`signRelease*` fail during task-graph setup with one message listing the missing
  inputs and pointing here. There is no debug-signing fallback and no unsigned release output. Debug
  configuration is unchanged.
- Workflow: if a secret is absent, the "Prepare release signing material" step fails before Gradle.
  If no AAB is produced, the identity step fails before upload. `permissions: contents: read` and no
  `gh release`, tag or store step exists, so the job cannot publish.
- Local check without signing material (expected RED):

```sh
cd apps/mobile/android && ./gradlew --no-daemon :app:bundleRelease
# > Task ... Android release signing is not configured: missing storeFile (ANDROID_KEYSTORE_PATH), ...
```

## Produce and record one signed release candidate

Prerequisites: JOIN source merged to `main`, a new `versionCode`/`versionName` decided for the RC
(the current `14`/`1.13` predates JOIN), `mobile-android` environment and its four secrets created,
and activation approved by the owner after independent review.

1. Dispatch (requires dispatch authority; neither this runbook nor the prepared PR grants it):
   `gh workflow run mobile-android.yaml --ref <approved-source-ref>`.
2. From the run record, capture: source SHA, ref, workflow run URL, artifact name/URL,
   `versionCode`/`versionName`, AAB SHA256, signing certificate SHA256 (`build-info.json` plus
   `SHA256SUMS` inside the artifact).
3. Verify the artifact: `sha256sum -c SHA256SUMS` matches, and the certificate SHA256 equals the
   approved release certificate recorded above.
4. Device matrix uses an installable APK derived from that exact AAB and signed with the same
   release key, not a debug build. bundletool cannot recover the key from the bundle, so pass the
   keystore explicitly and let it prompt for the passwords (nothing enters shell history):

```sh
bundletool build-apks --bundle app-release.aab --output rc.apks --mode=universal \
  --ks release-upload.jks --ks-key-alias padlhub-release
unzip -o rc.apks universal.apk
sha256sum universal.apk                                  # record this too
apksigner verify --print-certs universal.apk             # must equal the recorded release cert
adb install -r universal.apk
```

5. Record the signed RC in the task's evidence file under `output/` with evidence label `CI`, and
   never claim `STAGING`/`PRODUCTION` from a workflow artifact.

## Device matrix (mobile R1 acceptance)

Run every row on a real device and/or the owned `padlhub_api36` emulator, on the installed APK whose
SHA256/versionCode is recorded above. Capture per row: APK SHA256 + `versionCode`, device model/OS
and WebView version, PASS/FAIL/NOT RUN, and the raw evidence (adb/logcat excerpt, screenshot/video
file name, and the HTTP method + route + status after removing tokens/PII). `NOT RUN` is not PASS;
any missing row keeps mobile R1 open.

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
