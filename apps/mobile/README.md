# PadlHub iOS development

The iOS app reuses the existing React/TypeScript client in `src`, the PadlHub API SDK,
and Capacitor **8.4.1**. Its Xcode project is checked in under `ios/App/App.xcodeproj`.
The bundle identifier is `ru.padlhub.app`; the deployment target is iOS 15.0.

## Build for a simulator

Requirements: the repository's Node/npm versions, full Xcode, and an installed iOS
Simulator runtime. No Apple Developer account or signing material is needed for this build.
From the repository root:

```sh
npm ci
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
  npm run ios:build:simulator -w @phub/mobile
```

The command generates types from the existing OpenAPI contracts, builds this worktree's
web client, copies it into the iOS project, resolves the pinned Capacitor Swift package,
and builds an unsigned simulator app. The first build requires network access to fetch
that package. `DEVELOPER_DIR` only affects this command; it does not change the system's
selected developer tools. Adjust it if Xcode is installed elsewhere.

Output: `apps/mobile/ios/DerivedData/Build/Products/Debug-iphonesimulator/App.app`.

To work in Xcode after syncing the web client:

```sh
npm run ios:prepare -w @phub/mobile
npm run cap:open:ios -w @phub/mobile
```

Select the **App** scheme and an iOS simulator, then Run. Repeat `ios:prepare` after web
source changes so the native app contains the current bundle. Do not run `cap add ios`
again: the native project already exists.

## Current scope

This is the first runnable iOS shell for the existing sign-in UI. It is not a complete
personal cabinet or an authenticated native client. The default bundle has no configured
PadlHub server; simply rendering the login screen does not validate authentication.

The web client currently ends at a sign-in success message. The following work remains:

- Configure and validate the native PadlHub API origin and tenant, then verify the existing
  authentication contracts. Do not call Viva directly or invent mobile-only endpoints.
- Implement native session persistence in Keychain and the agreed OAuth return flow.
  The template's delegate forwarding does not implement an OAuth callback contract.
- Port the existing cabinet screens and navigation, including loading, empty and error states.
- Verify legal-document navigation, keyboard/safe-area behavior, accessibility, and a physical
  device. Check the existing OTP input against the current four-digit API contract.
- Add native push only after the device registration and provider contracts are established.
- Replace the Capacitor template icon/splash with approved PadlHub assets before distribution.

Keep development and distribution separate. Signing, TestFlight, App Store publication,
live OTP/provider operations, payments, and backend changes are outside this first slice.
The existing manually triggered iOS workflow is a signing placeholder; it is not native
build or TestFlight evidence.

## Source and generated files

Commit Swift, storyboards, asset catalogs, Xcode metadata, and the resolved Swift package
lockfile. Capacitor's generated `public/`, `capacitor.config.json`, `config.xml`, DerivedData,
archives, and user-specific Xcode state are ignored by `ios/.gitignore`.
Never commit tokens, provisioning profiles, certificates, or generated application bundles.
