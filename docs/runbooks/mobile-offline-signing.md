# Offline Android signing preparation

This opt-in source lane builds and verifies one Android AAB using **existing owner-supplied**
material. It does not create keys, import credentials, install tools, upload to a store or prove
physical-device acceptance. Mobile releases remain separate from the server release. iOS signing
build/archive/export is deferred; existing unavailable-release workflow gates remain unchanged.

## Owner inputs

Use a clean, committed task/release checkout. Prepare a private owner-owned `0700` directory outside
that checkout, containing a `0600` JSON config, existing keystore and two password files. Paths must
be absolute, have no lexical `.`/`..` components and have no symlink components; use resolved macOS `/private/...` paths. Each password
file contains one nonempty UTF-8 line; one terminal newline is allowed, spaces are significant.
Never pass passwords through command-line properties, environment variables, Git or shared logs.

Config schema `PHUB_ANDROID_OFFLINE_SIGNING_V1` requires exactly these keys:

| Key                                    | Required value                                                                    |
| -------------------------------------- | --------------------------------------------------------------------------------- |
| `sourceSha`                            | Exact clean checkout commit, 40 lowercase hex characters                          |
| `applicationId`                        | `ru.padlhub.app`                                                                  |
| `versionCode`, `versionName`           | Approved positive integer code and numeric dotted version                         |
| `signerSha256`                         | Expected upload certificate DER SHA-256, 64 lowercase hex; owner verifies custody |
| `keystore`, `alias`                    | Existing owner keystore path and exact upload alias                               |
| `storePasswordFile`, `keyPasswordFile` | Existing private password-file paths                                              |
| `javaHome`                             | Existing JDK home, containing `bin/java`, `keytool`, `jarsigner`                  |
| `nodeExecutable`, `npmCli`             | Existing Node22 binary and npm CLI JavaScript file paths                          |
| `gradleHome`, `gradleArchive`          | Existing extracted Gradle distribution and original cached ZIP                    |
| `sdkHome`, `gradleUserHome`            | Existing Android SDK and private populated Gradle cache                           |
| `bundletool`, `bundletoolSha256`       | Existing approved bundletool JAR path and independently expected SHA-256          |
| `output`                               | New directory under a private parent outside the source checkout                  |

The Gradle ZIP must match the committed wrapper checksum. Every extracted distribution file is
compared to that ZIP, including executable and library bytes; a decoy matching ZIP is insufficient.
No wrapper download, dependency installation or tool bootstrap is performed. Bundletool is needed
to decode the AAB protobuf manifest; an APK manifest or Gradle intermediate is not AAB identity proof.
Missing cached dependencies/tools stop the operation. Installing them is a separate preparation.

The owner must distinguish the **upload key** from Google Play's app-signing certificate. This lane
pins the upload signer, not Play's eventual distributed signer. Existing debug assetlinks are not
release certificate approval. Release version allocation, Firebase configuration, app-link release
association, device upgrade and push acceptance remain separately owned.

## Explicit entry points

```sh
python3 scripts/mobile-signing/android.py --plan /absolute/private/inputs.json
python3 scripts/mobile-signing/android.py --build-offline /absolute/private/inputs.json
```

`--plan` validates local source, distribution, paths and existing keystore certificate; it does not
build, sign, create output or read the private key. It does invoke local Git and keytool.
`--build-offline` additionally runs the repository's existing `android:sync` preparation, then the
existing Gradle distribution with `--offline --no-daemon --no-configuration-cache -Pandroid.builder.sdkDownload=false :app:bundleRelease`.
SDK auto-download is disabled explicitly; Gradle offline mode alone is insufficient.
The signing config is selected only by `PHUB_ANDROID_SIGNING_INPUTS`, which carries a path, never a
password. Without that variable the existing unsigned Gradle lane is unchanged. No build is run
by this source task or by normal workflow invocation.

A prior release AAB output causes rejection rather than accepting or overwriting stale evidence.
After a failed build, inspect the private sanitized STOP code and task-owned generated outputs;
do not blindly retry, delete shared caches or replace a key. Tool stdout/stderr are captured and
never emitted because they can include private paths or signing diagnostics. Gradle's own local
cache remains private. This script is for a reviewed trusted source checkout, not untrusted PR code.

## Verification and output

Before publication of output, the lane requires strict JAR verification against the owner keystore,
one certificate with the exact expected signer fingerprint, exact AAB package/version values and
no debuggable/test-only application. It compares the artifact hash before and after verification.
Only the verified AAB and sanitized receipt are copied to the new private output directory.

Receipt `PHUB_ANDROID_OFFLINE_SIGNED_AAB_V1` binds source SHA, AAB SHA-256, signer SHA-256 and release
version; it explicitly records no store upload and device acceptance `NOT_RUN`. No keystore,
password, certificate subject, local path or tool output enters the receipt. Trust is the explicit
owner certificate pin, not a claim of public-CA trust or Play acceptance. Multiple-certificate output
is rejected; certificate-chain/key-rotation support requires a separately reviewed contract.

The script never changes the existing keystore. No automatic keychain import, signing key generation,
provider call or store command exists. Keep signed artifacts and receipts outside Git.

## Source verification

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s scripts/mobile-signing -p 'test_*.py'
```

Tests use synthetic files and substituted tool responses. They exercise build ordering, manifest,
signer, signature-failure, artifact/distribution tamper, unsafe output, source drift and secret-log
rejection. They are not a JVM/Gradle signing run or device/store evidence. Real signing execution
requires supplied material and separate mobile-release coordination; it is not needed for server GO.
