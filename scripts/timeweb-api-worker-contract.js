import {
  isPreservedNotificationRollout,
  PRESERVED_NOTIFICATION_PLAN_SCHEMA,
  PRESERVED_NOTIFICATION_RECEIPT_SCHEMA,
  validateFcmDrainProof,
} from './timeweb-notification-android-gates.js';
import {
  fcmGateBinding,
  fcmGateToken,
  fcmGateTokenSha256,
} from './timeweb-notification-delivery-gate.js';
import {
  isNotificationRollout,
  NOTIFICATION_POST_LEDGER,
  validateNotificationOperation,
  validateNotificationObservationPolicy,
  validateNotificationObservation,
  NOTIFICATION_OBSERVATION_POLICY_SHA256,
} from './timeweb-notification-profile.js';
import { createHash } from 'node:crypto';
import { parseStrictJson } from './strict-json.js';
import { validateControllerPromotion } from './verify-source-ci.js';
const ROOT = '/opt/phub/timeweb-beta',
  HASH = /^[a-f0-9]{64}$/,
  SHA = /^[a-f0-9]{40}$/,
  ID = /^[a-f0-9]{40}-[1-9][0-9]*-1$/;
const names = ['.release-identity.json', 'api.env', 'migrator.env', 'realtime.env', 'worker.env'];
const hash = (v) => createHash('sha256').update(v).digest('hex'),
  same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const fail = (code) => {
  throw new Error(`API_WORKER_${code}`);
};
export const API_WORKER_BRIDGE = Object.freeze({
  candidateSha: '8158ac445c9ff3e4b4bcee95bbd8e10c564b9a8d',
  candidateTree: 'b9ef484b4d0a9e5c8913cc2cdd79ee39b1800537',
  sourceCiRunId: '39341613054',
  publicationRunId: '39366813227',
  artifactId: '12239737469',
  artifactDigest: 'sha256:bee5c953ee606a107f2b052bb6c6693a007f5c97795df19c9740324e6803a029',
  manifestSha256: 'fb5425a7e48b94a14bef4dc78e6c4aa573c008414b73ba23a335294ef4fc7de8',
  apiSource: '0d6078be7a50ed3f5761d66071527be003bd568f', // gitleaks:allow public Git revision
  apiRelease: '0d6078be7a50ed3f5761d66071527be003bd568f-37038298584-1', // gitleaks:allow public OCI release label
  apiDigest: 'sha256:a2563721aa46a7785d9ad00d98f002040cbd884446761bb5d7bbdf18a7a43c69',
  workerSource: 'ff42c9e9a23895d94889f2982224d21a41be8255',
  workerDigest: 'sha256:b22baaeb97729c131c1159f55c6fc4c174b54846585cd3f7975bf5bcf9898006',
  candidateApiDigest: 'sha256:47bce1fab22cb47d99fa5391764dd20c8c1f53a31550eab2a759b512a4411839',
  candidateWorkerDigest: 'sha256:72b9a03aaf95afab5711a8f489b56affe0be4d79eb5af513abe4966eb7695416',
  ledgerSha256: 'a3cd57e09bb6cc24db4d7c4d3ec8b7a3014d4d82ae289b9179d8194dfdb266d4',
  postgresId: 'fe614a3312e446e8036243be3781590bfe90b5da037b83580abd410d4514e84c',
  postgresImage:
    'docker.io/library/postgres@sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685',
});
export const API_WORKER_CONTROLLER_FILES = new Set([
  'scripts/control-timeweb-database-backup.py',
  'scripts/control-timeweb-database-backup.test.ts',
  'scripts/test-timeweb-database-backup.py',
  'scripts/timeweb-api-worker-migration.d.ts',
  'scripts/timeweb-api-worker-migration.js',
  'scripts/timeweb-api-worker-migration.test.ts',
  'scripts/timeweb-api-worker-migration.adapter.test.ts',
  'scripts/timeweb-location-photo-profile.js',
  'scripts/timeweb-location-photo-profile.d.ts',
  'scripts/timeweb-location-photo-profile.test.ts',
  'scripts/timeweb-location-photo-controller.js',
  'scripts/timeweb-location-photo-controller.test.ts',
  'deploy/timeweb/location-photo-migration-0102.v1.json',
  'deploy/timeweb/location-photo-role-bootstrap-0102.sql',
  'deploy/timeweb/location-photo-role-cleanup-0102.sql',
  'scripts/timeweb-api-worker-migration-role.d.ts',
  'scripts/timeweb-api-worker-migration-role.js',
  'scripts/timeweb-api-worker-migration-role.test.ts',
  'scripts/timeweb-api-worker-upgrade.d.ts',
  'scripts/timeweb-api-worker-adapter.test.ts',
  'scripts/timeweb-api-worker.fixture.ts',
  'scripts/timeweb-adopt-manual-baseline.js',
  'scripts/timeweb-adopt-manual-baseline.d.ts',
  'scripts/timeweb-adopt-manual-baseline.test.ts',
  'scripts/fixtures/timeweb-api-worker-ledger-8158ac44.json',
  'scripts/timeweb-api-worker-contract.js',
  'scripts/timeweb-api-worker-upgrade.js',
  'scripts/timeweb-api-worker-upgrade.test.ts',
  'scripts/timeweb-api-web-upgrade.js',
  'scripts/timeweb-api-web-upgrade.test.ts',
  'scripts/run-timeweb-standard-delivery.js',
  'scripts/provision-timeweb-beta-runtime-secrets.js',
  'scripts/provision-timeweb-beta-runtime-secrets.d.ts',
  'scripts/provision-timeweb-beta-runtime-secrets.test.ts',
  'docs/runbooks/timeweb-standard-delivery.md',
  'docs/runbooks/android-chats-fcm.md',
  'docs/runbooks/location-publication.md',
]);
export const API_WORKER_MIGRATION_CONTROLLER_FILES = new Set([
  'scripts/timeweb-adopt-manual-baseline.js',
  'scripts/timeweb-adopt-manual-baseline.d.ts',
  'scripts/timeweb-adopt-manual-baseline.test.ts',
  'scripts/control-timeweb-database-backup.py',
  'scripts/control-timeweb-database-backup.test.ts',
  'scripts/test-timeweb-database-backup.py',
  'scripts/timeweb-api-worker-contract.js',
  'scripts/run-timeweb-standard-delivery.js',
  'scripts/timeweb-api-worker.fixture.ts',
  'scripts/fixtures/timeweb-api-worker-ledger-8158ac44.json',
  'scripts/timeweb-api-worker-migration.d.ts',
  'scripts/timeweb-api-worker-migration.js',
  'scripts/timeweb-api-worker-migration.test.ts',
  'scripts/timeweb-api-worker-migration.adapter.test.ts',
  'scripts/timeweb-location-photo-profile.js',
  'scripts/timeweb-location-photo-profile.d.ts',
  'scripts/timeweb-location-photo-profile.test.ts',
  'scripts/timeweb-location-photo-controller.js',
  'scripts/timeweb-location-photo-controller.test.ts',
  'deploy/timeweb/location-photo-migration-0102.v1.json',
  'deploy/timeweb/location-photo-role-bootstrap-0102.sql',
  'deploy/timeweb/location-photo-role-cleanup-0102.sql',
  'scripts/timeweb-api-worker-migration-role.d.ts',
  'scripts/timeweb-api-worker-migration-role.js',
  'scripts/timeweb-api-worker-migration-role.test.ts',
  'docs/runbooks/timeweb-standard-delivery.md',
  'docs/runbooks/android-chats-fcm.md',
  'docs/runbooks/location-publication.md',
]);
export const LOCATION_PHOTO_CONTROLLER_BASE = Object.freeze({
  sha: '2bf56ca8c1bc3e27db5c857dbf961ad400f2294b',
  tree: 'fd6ae8e635d325a39e5e44ba06d1ab0c3df6e757',
});
export const LOCATION_PHOTO_CONTROLLER_DELTA = Object.freeze(
  Object.fromEntries(
    [
      ['docs/runbooks/location-publication.md', 'M'],
      ['scripts/control-timeweb-database-backup.py', 'M'],
      ['scripts/test-timeweb-database-backup.py', 'M'],
      ['scripts/timeweb-api-worker-contract.js', 'M'],
      ['scripts/timeweb-api-worker-migration.d.ts', 'M'],
      ['scripts/timeweb-api-worker-migration.js', 'M'],
      ['scripts/timeweb-join-dormant-profile.test.ts', 'M'],
      ['deploy/timeweb/location-photo-migration-0102.v1.json', 'A'],
      ['deploy/timeweb/location-photo-role-bootstrap-0102.sql', 'A'],
      ['deploy/timeweb/location-photo-role-cleanup-0102.sql', 'A'],
      ['scripts/timeweb-location-photo-controller.js', 'A'],
      ['scripts/timeweb-location-photo-controller.test.ts', 'A'],
      ['scripts/timeweb-location-photo-postgres.test.ts', 'A'],
      ['scripts/timeweb-location-photo-profile.d.ts', 'A'],
      ['scripts/timeweb-location-photo-profile.js', 'A'],
      ['scripts/timeweb-location-photo-profile.test.ts', 'A'],
    ].map(([path, status]) => [path, Object.freeze({ path, status })]),
  ),
);

export function validateLocationPhotoControllerClosure(entries) {
  if (
    !Array.isArray(entries) ||
    entries.length !== Object.keys(LOCATION_PHOTO_CONTROLLER_DELTA).length
  )
    fail('LOCATION_PHOTO_CONTROLLER_DELTA');
  const seen = new Set();
  for (const entry of entries) {
    const expected = LOCATION_PHOTO_CONTROLLER_DELTA[entry?.path];
    if (
      !expected ||
      seen.has(entry.path) ||
      entry.status !== expected.status ||
      entry.newMode !== '100644' ||
      entry.oldMode !== (entry.status === 'A' ? '000000' : '100644') ||
      !SHA.test(entry.oldOid ?? '') ||
      !SHA.test(entry.newOid ?? '') ||
      /^0{40}$/.test(entry.newOid) ||
      (entry.status === 'A' ? !/^0{40}$/.test(entry.oldOid) : /^0{40}$/.test(entry.oldOid))
    )
      fail('LOCATION_PHOTO_CONTROLLER_DELTA');
    seen.add(entry.path);
  }
  if (seen.size !== Object.keys(LOCATION_PHOTO_CONTROLLER_DELTA).length)
    fail('LOCATION_PHOTO_CONTROLLER_DELTA');
  return entries;
}
// One frozen CI-download correction for the 11954 API/Worker bridge. Neither file is
// in a generic allowlist: both exact regular M blobs must travel as one atomic pair.
export const API_WORKER_CI_DOWNLOAD_PATCH = Object.freeze([
  Object.freeze({
    path: '.github/workflows/pull-request.yaml',
    status: 'M',
    oldMode: '100644',
    newMode: '100644',
    oldOid: '632bed8b410a3ac3e42a7ba7e607e80f8004f30d',
    newOid: 'bd9cba78c1d9dbcb37fd2abf93f4e8a4ae3e4f87',
  }),
  Object.freeze({
    path: 'scripts/pull-request-ci-workflow.test.ts',
    status: 'M',
    oldMode: '100644',
    newMode: '100644',
    oldOid: 'caf2f124bbc58e4225feca1ad38100ed07991787',
    newOid: 'e2abfd6adac5d742b38ea16e8cb3d1dbb90c0982',
  }),
]);
// The five reader files were already in the API/Worker closure, but the narrower
// migration BASE closure admits them only with the exact CI pair as one seven-blob unit.
export const API_WORKER_CI_READER_PATCH = Object.freeze([
  Object.freeze({
    path: 'scripts/timeweb-api-worker-upgrade.js',
    status: 'M',
    oldMode: '100644',
    newMode: '100644',
    oldOid: '6420f1d4b5d5c905563d23921c61ce68be2ca28b',
    newOid: 'e95f3bfd126eaaf0cebb63ca934cf05949f83f62',
  }),
  Object.freeze({
    path: 'scripts/timeweb-api-worker-upgrade.d.ts',
    status: 'M',
    oldMode: '100644',
    newMode: '100644',
    oldOid: '151a183b17349c57a4d23cd58b03dd33be0e1172',
    newOid: '623b76b0381e1ebef70b5731674a682f72e2b237',
  }),
  Object.freeze({
    path: 'scripts/timeweb-api-worker-upgrade.test.ts',
    status: 'M',
    oldMode: '100644',
    newMode: '100644',
    oldOid: 'e446cc167a63ee54e9352dc38589e414f1aa7247',
    newOid: '1e9e3e958b39ad80a6f68c0f51efef45308cfa86',
  }),
  Object.freeze({
    path: 'scripts/timeweb-api-worker-adapter.test.ts',
    status: 'M',
    oldMode: '100644',
    newMode: '100644',
    oldOid: 'dba09b8571260d1cb817971ce6a15a42a70f1032',
    newOid: 'e858abd81817cef9d6d62eca98b965f7bbce0c6e',
  }),
  Object.freeze({
    path: 'scripts/timeweb-api-web-upgrade.js',
    status: 'M',
    oldMode: '100644',
    newMode: '100644',
    oldOid: 'c3da47a8fa4c95d06081d1a189c28b2ec8afa55e',
    newOid: '3a9c15e1b2fcef121a82122479c80b5c83a431c7',
  }),
]);
// Controller promotion keeps the frozen release source closure unchanged. These are
// admitted only as exact, independently pinned patch groups; final OIDs are set by
// the integration owner after the verifier/test pair and Android test are frozen.
export const API_WORKER_CONTROLLER_PROMOTION_PATCH = Object.freeze([
  Object.freeze({
    path: 'scripts/verify-source-ci.js',
    status: 'M',
    oldMode: '100644',
    newMode: '100644',
    oldOid: '31b891b4856dd95ecf849af0b13e609a281cbac1',
    newOid: '1adb4919d4016495cc4b94a737d8e395515a7d6f',
  }),
  Object.freeze({
    path: 'scripts/verify-source-ci.test.ts',
    status: 'M',
    oldMode: '100644',
    newMode: '100644',
    oldOid: 'deddc6be4d875375e813abe13a345311029d71bb',
    newOid: '63f207f3c05aa12fdf852fa0f898f14f4fb53282',
  }),
]);
export const API_WORKER_ANDROID_CHAT_TEST_PATCH = Object.freeze([
  Object.freeze({
    path: 'apps/mobile/src/MobileApp.test.tsx',
    status: 'M',
    oldMode: '100644',
    newMode: '100644',
    oldOid: '35f557d6da06916e3a411129786e51a76cdd2ae0',
    newOid: '541fe96a4f895044faa123e157d4b1aa6ef38ad2',
  }),
]);
// One inert fixture-readiness correction for the frozen Android bridge; both regular blobs
// must travel together. Neither rehearsal path belongs to a generic controller allowlist.
export const API_WORKER_REHEARSAL_READINESS_PATCH = Object.freeze([
  Object.freeze({
    path: 'scripts/rehearse-timeweb-standard-compose.js',
    status: 'M',
    oldMode: '100644',
    newMode: '100644',
    oldOid: '98c63003b8736bc1da48abfa9be5ee1e7bd6b005',
    newOid: 'df0f4dd006a229a55b517043042e7715127678eb',
  }),
  Object.freeze({
    path: 'scripts/timeweb-standard-compose.test.ts',
    status: 'M',
    oldMode: '100644',
    newMode: '100644',
    oldOid: 'ba60973d95649afa3b81ac035e55b043cddc6285',
    newOid: '0e7ac3a12722d6250dd989e6d4dd9aed5b82bfac',
  }),
]);
// Frozen PR380 native-only source delta; app images stay on11954. Never widen a generic path list.
export const API_WORKER_NATIVE_BOOKINGS_PATCH = Object.freeze(
  [
    {
      path: 'apps/mobile/android/app/build.gradle',
      status: 'M',
      oldMode: '100644',
      newMode: '100644',
      oldOid: 'b5451e4334bc50c083e6b0d45cecf156d7e632e3',
      newOid: '70eb7c9f09bea9bc0aa8c26a67ae31c7595e7f15',
    },
    {
      path: 'apps/mobile/android/app/src/androidTest/java/ru/padlhub/app/AndroidHttpSenderTest.java',
      status: 'M',
      oldMode: '100644',
      newMode: '100644',
      oldOid: '03b6967ef337078b1359ea9109440fd4d41b910b',
      newOid: 'ea5763e2fce0556717f01be1e1db03200f110755',
    },
    {
      path: 'apps/mobile/android/app/src/androidTest/java/ru/padlhub/app/AndroidSessionTest.java',
      status: 'M',
      oldMode: '100644',
      newMode: '100644',
      oldOid: '35a8e40c86060544e6454949ee72db293e8b5991',
      newOid: 'd60f3d8166b3129b89c1e415be5eac656c7fbea2',
    },
    {
      path: 'apps/mobile/android/app/src/androidTest/java/ru/padlhub/app/AndroidUpcomingBookingsRefreshTest.java',
      status: 'A',
      oldMode: '000000',
      newMode: '100644',
      oldOid: '0000000000000000000000000000000000000000',
      newOid: '6772d0dd08f779352a962128d4a062af3e012e4a',
    },
    {
      path: 'apps/mobile/android/app/src/main/java/ru/padlhub/app/AndroidHttpSender.java',
      status: 'M',
      oldMode: '100644',
      newMode: '100644',
      oldOid: 'c468bcaeb1c5826de2e6e8983495eed59f9a69a6',
      newOid: 'e3610c361644fd57a48eb5e5602ba912ed1ab512',
    },
    {
      path: 'apps/mobile/android/app/src/main/java/ru/padlhub/app/AndroidSessionEngine.java',
      status: 'M',
      oldMode: '100644',
      newMode: '100644',
      oldOid: '1f939e114deb2ad04fd0be4ec7231b93a4431897',
      newOid: '58101384544473def5819106996529406dd29f13',
    },
    {
      path: 'apps/mobile/android/app/src/main/java/ru/padlhub/app/AndroidUpcomingBookingsRefresh.java',
      status: 'A',
      oldMode: '000000',
      newMode: '100644',
      oldOid: '0000000000000000000000000000000000000000',
      newOid: 'e55ef5f508ce9e99e16068adee251f1d08231ad0',
    },
    {
      path: 'apps/mobile/android/app/src/main/java/ru/padlhub/app/PadlHubAndroidSessionPlugin.java',
      status: 'M',
      oldMode: '100644',
      newMode: '100644',
      oldOid: 'd82ccb21a299ddd96c53452f2c41c33c65250430',
      newOid: 'e0f4f8cdbc016dfaeb3aca9deaaa43323ae046db',
    },
    {
      path: 'apps/mobile/src/MobileApp.tsx',
      status: 'M',
      oldMode: '100644',
      newMode: '100644',
      oldOid: 'fa598c298bfa8d95bfc8981f2e49c08862946299',
      newOid: '7e1188cc9493c6347f0ca84ca5c6cd38ad245144',
    },
    {
      path: 'apps/mobile/src/MobileSession.test.tsx',
      status: 'M',
      oldMode: '100644',
      newMode: '100644',
      oldOid: 'ca26a53526fd7488e57c6200f924ec754947e7b2',
      newOid: 'fa26d6ad05715ece43ccdc904e9cc87c0f7f5817',
    },
    {
      path: 'apps/mobile/src/native-api-fetch.test.ts',
      status: 'M',
      oldMode: '100644',
      newMode: '100644',
      oldOid: 'fd7a348bd29a52f9f8beb79c1694c7e4f0b5b6ef',
      newOid: 'a93a254f179a52294ef0ce5e5594a9bb082ae8d7',
    },
    {
      path: 'apps/mobile/src/native-api-fetch.ts',
      status: 'M',
      oldMode: '100644',
      newMode: '100644',
      oldOid: '518a35a52876e49f873b1f3c0905f7672f9d5ff3',
      newOid: '98ea1bf70dee6c3a29d35ed0d6afc091f2bbe32f',
    },
    {
      path: 'apps/mobile/src/native-bookings-refresh.test.ts',
      status: 'A',
      oldMode: '000000',
      newMode: '100644',
      oldOid: '0000000000000000000000000000000000000000',
      newOid: 'f0bc5b853fc95a220f3795b091e7a26d6dfd8e44',
    },
    {
      path: 'apps/mobile/src/native-gateway.test.ts',
      status: 'M',
      oldMode: '100644',
      newMode: '100644',
      oldOid: '7ef122ec4302588ca5c2fd75c0881376a343a182',
      newOid: '8de932302903de5bd919721b281cb20e8200ac33',
    },
    {
      path: 'apps/mobile/src/session-failure.test.ts',
      status: 'M',
      oldMode: '100644',
      newMode: '100644',
      oldOid: 'd7d19d39357faea456c02516901a6f03fa9896f3',
      newOid: '4f43d53c2319e1b304b16948d3af44e7857740f1',
    },
    {
      path: 'apps/mobile/src/session-failure.ts',
      status: 'M',
      oldMode: '100644',
      newMode: '100644',
      oldOid: 'ced9a4274220ddbfffca756d46b863c86681f210',
      newOid: '00cb9921dd089da76ed4f7520694bb1433045a07',
    },
    {
      path: 'docs/adr/0005-viva-user-delegation-and-direct-transport.md',
      status: 'M',
      oldMode: '100644',
      newMode: '100644',
      oldOid: '34869e776f45d54cf2a33cbb481013693820b91d',
      newOid: 'bb1f2c6f137392fb3533bd5f1969217bf3d2c487',
    },
    {
      path: 'docs/adr/0020-client-assisted-booking-screen-snapshots.md',
      status: 'M',
      oldMode: '100644',
      newMode: '100644',
      oldOid: '9adc609998839ae23e00e5b6f27362d07de7b73c',
      newOid: '3cc2a9089ebb201268ba138d64b191524426f14d',
    },
    {
      path: 'docs/adr/0023-browser-only-viva-end-user-transport.md',
      status: 'M',
      oldMode: '100644',
      newMode: '100644',
      oldOid: '8f875c98a5524a25497bbf26e7c983bae5804530',
      newOid: 'b7bde1f395ae00ec5b7f195065d752c4a00c3af2',
    },
    {
      path: 'docs/runbooks/android-development.md',
      status: 'M',
      oldMode: '100644',
      newMode: '100644',
      oldOid: '6ee27c15223fda5d3239db8d1693ea727b69e355',
      newOid: 'c98d269710dabda6924e1524c7d9a45a16d407f4',
    },
  ].map(Object.freeze),
);
export function parseApiWorkerControllerDiff(raw) {
  if (typeof raw !== 'string') fail('CONTROLLER_DELTA');
  const parts = raw.split('\0').filter(Boolean);
  if (!parts.length || parts.length % 2) fail('CONTROLLER_DELTA');
  return Array.from({ length: parts.length / 2 }, (_, i) => {
    const match = /^:([0-7]{6}) ([0-7]{6}) ([a-f0-9]{40}) ([a-f0-9]{40}) ([AM])$/.exec(
      parts[2 * i],
    );
    if (!match) fail('CONTROLLER_DELTA');
    return {
      oldMode: match[1],
      newMode: match[2],
      oldOid: match[3],
      newOid: match[4],
      status: match[5],
      path: parts[2 * i + 1],
    };
  });
}
function withoutPinnedControllerPatch(entries, pins) {
  if (!Array.isArray(entries) || new Set(entries.map((v) => v?.path)).size !== entries.length)
    fail('CONTROLLER_DELTA');
  const ciPaths = new Set(pins.map((v) => v.path));
  const ci = entries.filter((v) => ciPaths.has(v?.path));
  if (ci.length) {
    if (ci.length !== pins.length) fail('CI_DOWNLOAD_PATCH');
    for (const pin of pins) {
      const row = ci.find((v) => v.path === pin.path);
      if (!row) fail('CI_DOWNLOAD_PATCH');
      exact(row, Object.keys(pin));
      if (Object.keys(pin).some((key) => row[key] !== pin[key])) fail('CI_DOWNLOAD_PATCH');
    }
  }
  return entries.filter((v) => !ciPaths.has(v.path));
}
export function withoutExactCiDownloadPatch(entries) {
  if (!Array.isArray(entries) || !entries.length) fail('CONTROLLER_DELTA');
  return withoutPinnedControllerPatch(
    withoutPinnedControllerPatch(
      withoutPinnedControllerPatch(
        withoutPinnedControllerPatch(
          withoutPinnedControllerPatch(entries, API_WORKER_CONTROLLER_PROMOTION_PATCH),
          API_WORKER_ANDROID_CHAT_TEST_PATCH,
        ),
        API_WORKER_REHEARSAL_READINESS_PATCH,
      ),
      API_WORKER_NATIVE_BOOKINGS_PATCH,
    ),
    API_WORKER_CI_DOWNLOAD_PATCH,
  );
}
export function withoutExactMigrationCiPatch(entries) {
  if (!Array.isArray(entries) || !entries.length) fail('CONTROLLER_DELTA');
  return withoutPinnedControllerPatch(
    withoutPinnedControllerPatch(
      withoutPinnedControllerPatch(
        withoutPinnedControllerPatch(
          withoutPinnedControllerPatch(entries, API_WORKER_CONTROLLER_PROMOTION_PATCH),
          API_WORKER_ANDROID_CHAT_TEST_PATCH,
        ),
        API_WORKER_REHEARSAL_READINESS_PATCH,
      ),
      API_WORKER_NATIVE_BOOKINGS_PATCH,
    ),
    [...API_WORKER_CI_DOWNLOAD_PATCH, ...API_WORKER_CI_READER_PATCH],
  );
}
export function exact(v, keys) {
  if (
    !v ||
    typeof v !== 'object' ||
    Array.isArray(v) ||
    !same(Object.keys(v).sort(), [...keys].sort())
  )
    fail('FIELDS');
}
export function sameApiWorkerDeploymentIdentity(actual, expected, profile = 'production') {
  if (!actual || !expected) return false;
  if (profile === 'production') return same(actual, expected);
  return ['image', 'imageId', 'releaseId', 'revision'].every(
    (key) => actual[key] === expected[key],
  );
}
export function validateApiWorkerOperation(op, now) {
  if (isNotificationRollout(op)) return validateNotificationOperation(op, now);
  exact(op, [
    'schema',
    'target',
    'controllerSha',
    'controllerSourceCiRunId',
    ...(op?.controllerPromotion === undefined ? [] : ['controllerPromotion']),
    ...(op?.profile === undefined ? [] : ['profile']),
    'candidateSha',
    'candidateTree',
    'sourceCiRunId',
    'publicationRunId',
    'artifactId',
    'artifactDigest',
    'manifestSha256',
    'expectedApi',
    'expectedWorker',
    'expectedCurrentSecretSetReleaseId',
    'candidateSecretHashes',
    'fcmEnvironment',
    'expiresAt',
    'confirmation',
  ]);
  exact(op.target, ['hostname', 'serverId', 'projectId']);
  if (
    op.schema !== 'PHUB_TIMEWEB_API_WORKER_OPERATION_V1' ||
    (op.profile !== undefined && op.profile !== 'beta' && op.profile !== 'production') ||
    !same(op.target, { hostname: 'lk2.padlhub.su', serverId: 8886471, projectId: 262717 }) ||
    !SHA.test(op.controllerSha ?? '') ||
    !/^[1-9][0-9]*$/.test(op.controllerSourceCiRunId ?? '') ||
    op.fcmEnvironment !== 'SANDBOX' ||
    !ID.test(op.expectedCurrentSecretSetReleaseId ?? '')
  )
    fail('IDENTITY');
  if (op.controllerPromotion !== undefined)
    validateControllerPromotion(op.controllerPromotion, {
      controllerSha: op.controllerSha,
      controllerSourceCiRunId: op.controllerSourceCiRunId,
    });
  for (const key of [
    'candidateSha',
    'candidateTree',
    'sourceCiRunId',
    'publicationRunId',
    'artifactId',
    'artifactDigest',
    'manifestSha256',
  ])
    if (op[key] !== API_WORKER_BRIDGE[key]) fail('BRIDGE');
  for (const service of ['api', 'worker']) {
    const value = op[service === 'api' ? 'expectedApi' : 'expectedWorker'];
    exact(value, ['id', 'image', 'imageId', 'releaseId', 'revision', 'restarts', 'startedAt']);
    const digest = API_WORKER_BRIDGE[`${service}Digest`];
    if (
      !HASH.test(value.id ?? '') ||
      value.image !== `ghcr.io/z6v6e6r/phub-${service}@${digest}` ||
      value.imageId !== digest ||
      value.revision !== API_WORKER_BRIDGE[`${service}Source`] ||
      value.releaseId !== (service === 'api' ? API_WORKER_BRIDGE.apiRelease : null) ||
      value.restarts !== 0 ||
      !Number.isFinite(Date.parse(value.startedAt))
    )
      fail('PREVIOUS');
  }
  exact(op.candidateSecretHashes, names);
  if (!Object.values(op.candidateSecretHashes).every((v) => typeof v === 'string' && HASH.test(v)))
    fail('SECRET_HASHES');
  const expiry = Date.parse(op.expiresAt);
  if (
    !Number.isFinite(expiry) ||
    new Date(expiry).toISOString() !== op.expiresAt ||
    (now !== undefined && (expiry - now < 1200000 || expiry - now > 3600000))
  )
    fail('EXPIRY');
  if (
    op.confirmation !==
    'UPGRADE_API_WORKER_8158AC445C9F_FROM_0D6078BE7A50_FF42C9E9A238_GLOBAL_FCM_ON_TENANT_PROVIDER_GATES_OFF_NO_SEND'
  )
    fail('CONFIRMATION');
  return op;
}
export function validateApiWorkerControllerDelta(entries) {
  const ordinary = withoutExactCiDownloadPatch(entries);
  if (
    ordinary.some(
      (v) =>
        !['A', 'M'].includes(v.status) ||
        !API_WORKER_CONTROLLER_FILES.has(v.path) ||
        v.newMode !== '100644' ||
        v.oldMode !== (v.status === 'A' ? '000000' : '100644') ||
        !SHA.test(v.oldOid ?? '') ||
        !SHA.test(v.newOid ?? '') ||
        /^0{40}$/.test(v.newOid) ||
        (v.status === 'A' && !/^0{40}$/.test(v.oldOid)),
    )
  )
    fail('CONTROLLER_DELTA');
}
export function validateApiWorkerLedger(applied, packaged, operation) {
  if (isNotificationRollout(operation)) {
    validateNotificationOperation(operation);
    if (
      !Array.isArray(applied) ||
      !Array.isArray(packaged) ||
      packaged.length !== 105 ||
      !same(applied, packaged)
    )
      fail('LEDGER');
    for (const row of packaged) {
      exact(row, ['filename', 'checksum']);
      if (!/^[0-9]{4}_[a-z0-9_]+\.sql$/.test(row.filename ?? '') || !HASH.test(row.checksum ?? ''))
        fail('LEDGER');
    }
    if (
      hash(JSON.stringify(packaged.map((r) => [r.filename, r.checksum])) + '\n') !==
      NOTIFICATION_POST_LEDGER
    )
      fail('LEDGER');
    return;
  }
  if (!Array.isArray(applied) || !Array.isArray(packaged) || packaged.length !== 102)
    fail('LEDGER');
  const canonical = (values) =>
    values.map((v) => {
      exact(v, ['filename', 'checksum']);
      if (!/^[0-9]{4}_[a-z0-9_]+\.sql$/.test(v.filename ?? '') || !HASH.test(v.checksum ?? ''))
        fail('LEDGER');
      return v;
    });
  canonical(applied);
  canonical(packaged);
  const manifest = packaged.map((v) => `${v.filename}|${v.checksum}\n`).join('');
  if (hash(manifest) !== API_WORKER_BRIDGE.ledgerSha256 || !same(applied, packaged)) fail('LEDGER');
}

export function validateApiWorkerReceipt(receipt, planSha256, operation) {
  const notification = isNotificationRollout(operation),
    preserving = isPreservedNotificationRollout(operation);
  const terminal = receipt.status === 'RECONCILED' ? receipt.reconciledStatus : receipt.status;
  exact(receipt, [
    'schema',
    'status',
    'planSha256',
    'observedAt',
    ...(receipt.status === 'RECONCILED' ? ['reconciledStatus'] : []),
    ...(preserving && terminal === 'ROLLED_BACK' ? ['rollbackFcmSha256'] : []),
    ...(terminal === 'SUCCESS'
      ? [
          'installedBaselineSha256',
          'observationSha256',
          ...(preserving ? ['fcmDrainSha256', 'fcmGateHeldSha256', 'fcmGateReleasedSha256'] : []),
          ...(notification
            ? ['observationPolicySha256']
            : ['providerReadbackSha256', 'alertReadbackSha256']),
        ]
      : []),
  ]);
  const phases = [
    'PREPARING',
    'PREPARED',
    'WORKER_STOP_INTENT',
    'WORKER_STOPPED',
    'SECRET_SWAP_INTENT',
    'SECRETS_ACTIVE',
    'API_INTENT',
    'API_ACTIVE',
    'WORKER_INTENT',
    'WORKER_ACTIVE',
    'OBSERVING',
    'BASELINE_INTENT',
    'GATE_RELEASE_INTENT',
    'SUCCESS',
    'ROLLBACK_INTENT',
    'WORKER_CONTAINED',
    'PREVIOUS_SECRETS',
    'ROLLED_BACK',
    'ROLLBACK_FAILED',
    'ABORTED',
  ];
  if (
    receipt.schema !==
      (notification
        ? preserving
          ? PRESERVED_NOTIFICATION_RECEIPT_SCHEMA
          : 'PHUB_TIMEWEB_NOTIFICATION_0105_ROLLOUT_RECEIPT_V2'
        : 'PHUB_TIMEWEB_API_WORKER_RECEIPT_V1') ||
    receipt.planSha256 !== planSha256 ||
    !HASH.test(planSha256) ||
    !Number.isFinite(Date.parse(receipt.observedAt)) ||
    !(
      notification
        ? phases
            .filter(
              (p) => !['SECRET_SWAP_INTENT', 'SECRETS_ACTIVE', 'PREVIOUS_SECRETS'].includes(p),
            )
            .concat([
              'SECRETS_VERIFIED',
              'PREVIOUS_SECRETS_VERIFIED',
              ...(preserving ? ['GATE_PREPARE_INTENT', 'FCM_DRAIN_VERIFIED'] : []),
            ])
        : phases
    ).includes(terminal) ||
    (receipt.status === 'RECONCILED' && !['SUCCESS', 'ROLLED_BACK', 'ABORTED'].includes(terminal))
  )
    fail('RECEIPT');
  if (preserving && terminal === 'ROLLED_BACK' && !HASH.test(receipt.rollbackFcmSha256 ?? ''))
    fail('ROLLBACK_RECEIPT');
  if (
    terminal === 'SUCCESS' &&
    ![
      'installedBaselineSha256',
      'observationSha256',
      ...(preserving ? ['fcmDrainSha256', 'fcmGateHeldSha256', 'fcmGateReleasedSha256'] : []),
      ...(notification
        ? ['observationPolicySha256']
        : ['providerReadbackSha256', 'alertReadbackSha256']),
    ].every((k) => HASH.test(receipt[k] ?? ''))
  )
    fail('RECEIPT');
  if (
    notification &&
    terminal === 'SUCCESS' &&
    receipt.observationPolicySha256 !== NOTIFICATION_OBSERVATION_POLICY_SHA256
  )
    fail('RECEIPT_POLICY');
  return receipt;
}

export function assertPlan(plan, op, operationBytes) {
  const notification = isNotificationRollout(op),
    preserving = isPreservedNotificationRollout(op);
  exact(plan, [
    'schema',
    'operationSha256',
    'controllerSha',
    ...(op.controllerPromotion === undefined ? [] : ['controllerPromotionSha256']),
    'manifestSha256',
    'artifactDigest',
    'composeSha256',
    'baselineSha256',
    'baselinePath',
    'previous',
    'candidate',
    'excluded',
    'previousSecrets',
    'candidateSecrets',
    'credential',
    'packagedLedger',
    'unchangedImages',
    'createdAt',
    ...(notification
      ? [
          'migrationProof',
          'migratorImage',
          'fcmCredentialSource',
          'observationPolicy',
          ...(preserving ? ['androidGate', 'completedMigrationSha256'] : []),
        ]
      : []),
  ]);
  if (
    plan.schema !==
      (notification
        ? preserving
          ? PRESERVED_NOTIFICATION_PLAN_SCHEMA
          : 'PHUB_TIMEWEB_NOTIFICATION_0105_ROLLOUT_PLAN_V2'
        : 'PHUB_TIMEWEB_API_WORKER_PLAN_V1') ||
    plan.operationSha256 !== hash(operationBytes) ||
    plan.controllerSha !== op.controllerSha ||
    (op.controllerPromotion === undefined
      ? false
      : plan.controllerPromotionSha256 !== op.controllerPromotion.sha256) ||
    plan.manifestSha256 !== op.manifestSha256 ||
    plan.artifactDigest !== op.artifactDigest ||
    !same(plan.previous.api, op.expectedApi) ||
    !same(plan.previous.worker, op.expectedWorker) ||
    plan.previousSecrets.releaseId !== op.expectedCurrentSecretSetReleaseId ||
    !same(plan.candidateSecrets.files, op.candidateSecretHashes)
  )
    fail('PLAN');
  for (const service of ['api', 'worker']) {
    exact(plan.candidate[service], ['image', 'releaseId', 'revision']);
    if (
      plan.candidate[service].releaseId !==
        (service === 'api' ? `${op.candidateSha}-${op.publicationRunId}-1` : null) ||
      plan.candidate[service].revision !== op.candidateSha ||
      (notification
        ? plan.candidate[service].image !== op[service + 'Image']
        : plan.candidate[service].image !==
          `ghcr.io/z6v6e6r/phub-${service}@${API_WORKER_BRIDGE[service === 'api' ? 'candidateApiDigest' : 'candidateWorkerDigest']}`)
    )
      fail('PLAN');
  }
  if (
    ![
      `${ROOT}/releases/${op.expectedApi.releaseId}/release.env`,
      `${ROOT}/releases/${op.expectedApi.releaseId}/installed-components.env`,
    ].includes(plan.baselinePath) ||
    !['composeSha256', 'baselineSha256'].every((k) => HASH.test(plan[k] ?? ''))
  )
    fail('PLAN_PATH');
  exact(plan.previous, ['api', 'worker']);
  exact(plan.candidate, ['api', 'worker']);
  exact(plan.unchangedImages, [
    'WEB_IMAGE_DIGEST',
    'REALTIME_IMAGE_DIGEST',
    ...(notification ? [] : ['MIGRATOR_IMAGE_DIGEST']),
  ]);
  if (!Object.values(plan.unchangedImages).every((v) => /^sha256:[a-f0-9]{64}$/.test(v)))
    fail('PLAN_IMAGES');
  validateApiWorkerLedger(plan.packagedLedger, plan.packagedLedger, op);
  if (notification) {
    validateNotificationObservationPolicy(plan.observationPolicy);
    if (
      !same(plan.previousSecrets, plan.candidateSecrets) ||
      plan.fcmCredentialSource !== op.expectedFcmSource ||
      plan.migratorImage !==
        (preserving ? op.completedMigration.migratorImage : op.migratorImage) ||
      !same(plan.previousSecrets.files, op.candidateSecretHashes)
    )
      fail('PRESERVE_SECRETS');
    exact(plan.migrationProof, [
      'migrationPlanSha256',
      'migrationSuccessSha256',
      'migrationReceiptSha256',
      'catalogSha256',
      'backup',
      'target',
      ...(preserving ? ['completedMigrationSha256', 'installedMigratorImage'] : []),
    ]);
    for (const k of ['migrationPlanSha256', 'migrationSuccessSha256', 'migrationReceiptSha256'])
      if (plan.migrationProof[k] !== op[k]) fail('MIGRATION_PROOF');
    if (!HASH.test(plan.migrationProof.catalogSha256 ?? '')) fail('MIGRATION_PROOF');
    if (
      preserving &&
      (!same(plan.androidGate, op.androidGate) ||
        plan.completedMigrationSha256 !== hash(JSON.stringify(op.completedMigration) + '\n') ||
        plan.migrationProof.completedMigrationSha256 !== plan.completedMigrationSha256 ||
        plan.migrationProof.installedMigratorImage !== op.completedMigration.migratorImage ||
        plan.migrationProof.catalogSha256 !== op.completedMigration.catalogSha256 ||
        !same(plan.migrationProof.target, op.completedMigration.target) ||
        !same(plan.migrationProof.backup, op.completedMigration.backup))
    )
      fail('COMPLETED_MIGRATION');
  }
}
export function validateInstalledApiWorkerEvidence({
  releaseId,
  values,
  bytes,
  receipt,
  planBytes,
  operationBytes,
  evidence,
}) {
  const plan = parseStrictJson(planBytes.toString()),
    op = validateApiWorkerOperation(parseStrictJson(operationBytes.toString()));
  assertPlan(plan, op, operationBytes);
  validateApiWorkerReceipt(receipt, hash(planBytes), op);
  if (
    releaseId !== `${op.candidateSha}-${op.publicationRunId}-1` ||
    values.PHUB_RELEASE_ID !== releaseId ||
    values.PHUB_RELEASE_SOURCE_SHA !== undefined ||
    values.PHUB_RELEASE_SOURCE_TREE !== undefined ||
    Object.entries(plan.unchangedImages).some(([k, v]) => values[k] !== v) ||
    values.PHUB_COMPONENT_ROLLOUT_KIND !==
      (isPreservedNotificationRollout(op)
        ? 'API_WORKER_NOTIFICATION_0105_PRESERVED_ANDROID'
        : isNotificationRollout(op)
          ? 'API_WORKER_NOTIFICATION_0105'
          : 'API_WORKER') ||
    values.PHUB_COMPONENT_ROLLOUT_RECEIPT !==
      `${ROOT}/backups/${releaseId}-api-worker/rollout-receipt.json` ||
    values.PHUB_RUNTIME_SECRET_SET_RELEASE_ID !==
      (isNotificationRollout(op) ? plan.previousSecrets.releaseId : releaseId) ||
    (isNotificationRollout(op) &&
      values.MIGRATOR_IMAGE_DIGEST !==
        (isPreservedNotificationRollout(op)
          ? op.completedMigration.migratorImage
          : op.migratorImage
        ).split('@')[1]) ||
    (isPreservedNotificationRollout(op) &&
      values.PHUB_WORKER_DELIVERY_GATE_RECEIPT !==
        `${ROOT}/backups/${releaseId}-api-worker/rollout-receipt.json`) ||
    receipt.installedBaselineSha256 !== hash(bytes) ||
    !['SUCCESS', 'RECONCILED'].includes(receipt.status) ||
    (receipt.status === 'RECONCILED' && receipt.reconciledStatus !== 'SUCCESS')
  )
    fail('INSTALLED');
  for (const service of ['api', 'worker'])
    if (
      `ghcr.io/z6v6e6r/phub-${service}@${values[`${service.toUpperCase()}_IMAGE_DIGEST`]}` !==
      plan.candidate[service].image
    )
      fail('INSTALLED');
  const observation = parseStrictJson(evidence['observation.json']);
  if (isNotificationRollout(op)) {
    validateNotificationObservation(observation, hash(operationBytes), hash(planBytes));
    const preserving = isPreservedNotificationRollout(op);
    exact(evidence, [
      'observation.json',
      ...(preserving
        ? ['fcm-drain.json', 'fcm-delivery-gate/held.json', 'fcm-delivery-gate/released.json']
        : []),
    ]);
    if (preserving) {
      validateFcmDrainProof(parseStrictJson(evidence['fcm-drain.json']), op, hash(planBytes));
      const binding = fcmGateBinding(op, hash(operationBytes), hash(planBytes));
      if (
        hash(evidence['fcm-drain.json']) !== receipt.fcmDrainSha256 ||
        ['HELD', 'RELEASED'].some(
          (state) =>
            evidence[`fcm-delivery-gate/${state.toLowerCase()}.json`].toString() !==
              fcmGateToken(binding, state) ||
            receipt[state === 'HELD' ? 'fcmGateHeldSha256' : 'fcmGateReleasedSha256'] !==
              fcmGateTokenSha256(binding, state),
        )
      )
        fail('INSTALLED_FCM_GATE');
    }
    if (hash(evidence['observation.json']) !== receipt.observationSha256)
      fail('INSTALLED_EVIDENCE');
    return;
  }
  exact(observation, [
    'schema',
    'startedAt',
    'completedAt',
    'samples',
    'providerActivation',
    'deviceDelivery',
  ]);
  if (
    observation.schema !== 'PHUB_TIMEWEB_API_WORKER_OBSERVATION_V1' ||
    observation.providerActivation !== false ||
    observation.deviceDelivery !== false ||
    !Array.isArray(observation.samples) ||
    observation.samples.length !== 61 ||
    Date.parse(observation.completedAt) - Date.parse(observation.startedAt) < 900000 ||
    observation.samples.some(
      (v, i) =>
        !Number.isFinite(Date.parse(v)) ||
        (i > 0 && Date.parse(v) - Date.parse(observation.samples[i - 1]) < 15000),
    )
  )
    fail('INSTALLED_OBSERVATION');
  for (const [file, key] of [
    ['observation.json', 'observationSha256'],
    ['timeweb-monitor-readback.json', 'providerReadbackSha256'],
    ['alert-test-readback.json', 'alertReadbackSha256'],
  ])
    if (hash(evidence[file]) !== receipt[key]) fail('INSTALLED_EVIDENCE');
}
