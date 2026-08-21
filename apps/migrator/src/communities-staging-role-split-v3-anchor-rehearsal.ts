import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readdir, readFile, rename, unlink } from 'node:fs/promises';
import { fork } from 'node:child_process';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  COMMUNITIES_STAGING_ROLE_SPLIT_V3_DURABLE_STATE_ENVELOPE_VERSION,
  COMMUNITIES_STAGING_ROLE_SPLIT_V3_STATE_VERSION,
  canonicalCommunitiesStagingRoleSplitV3DurableStateEnvelope,
  type CommunitiesStagingRoleSplitV3DurableStateEnvelope,
  type CommunitiesStagingRoleSplitV3State,
} from '@phub/database';

import {
  CommunitiesStagingRoleSplitV3DurableHostError,
  CommunitiesStagingRoleSplitV3DurableStateStore,
  type CommunitiesStagingRoleSplitV3DurableStateLease,
} from './communities-staging-role-split-v3-durable-host.js';
import type {
  CommunitiesStagingRoleSplitV3FileExternalPhaseAnchor,
  CommunitiesStagingRoleSplitV3ExternalPhaseAnchor,
  CommunitiesStagingRoleSplitV3ExternalPhaseAnchorObservation,
} from './communities-staging-role-split-v3-external-phase-anchor.js';
import {
  assertCommunitiesStagingRoleSplitV3ExternalAnchorRuntimeCustody,
  communitiesStagingRoleSplitV3ExternalAnchorSubjectSha256,
  createCommunitiesStagingRoleSplitV3CustodyBoundFileExternalPhaseAnchor,
  parseCommunitiesStagingRoleSplitV3ExternalAnchorSubject,
  type CommunitiesStagingRoleSplitV3ExternalAnchorSubject,
} from './communities-staging-role-split-v3-external-anchor-subject.js';

export const COMMUNITIES_STAGING_ROLE_SPLIT_V3_ANCHOR_REHEARSAL_REPORT_VERSION =
  'communities-staging-role-split-v3-anchor-rehearsal-report-v1';

export interface CommunitiesStagingRoleSplitV3AnchorRehearsalReport {
  readonly schemaVersion: typeof COMMUNITIES_STAGING_ROLE_SPLIT_V3_ANCHOR_REHEARSAL_REPORT_VERSION;
  readonly candidateCommit: string;
  readonly productionSubjectSha256: string;
  readonly rehearsalSubjectSha256: string;
  readonly beforeAnchorCrash: 'RECOVERED_TO_RESTORE_PENDING';
  readonly afterAnchorCrash: 'RECOVERED_TO_RESTORED';
  readonly completeLocalRollback: 'STATE_ROLLBACK_DETECTED';
  readonly retainedAnchorPhase: 'RESTORED';
  readonly crashDomain: 'SUPERVISED_WORKER_PROCESS';
  readonly wholeHostCrashTested: false;
  readonly productionAnchorTouched: false;
  readonly databaseAccessed: false;
  readonly authorizesCeremony: false;
  readonly authorizesLeaseRemoval: false;
  readonly authorizesDatabaseMutation: false;
  readonly authorizesProductionActivation: false;
}

type CrashPoint = 'BEFORE_ANCHOR_ADVANCE' | 'AFTER_ANCHOR_ADVANCE';
interface CrashChildInput {
  readonly subject: CommunitiesStagingRoleSplitV3ExternalAnchorSubject;
  readonly requestSha256: string;
  readonly creationReceiptSha256: string;
  readonly stateStoreSubjectSha256: string;
  readonly lease: CommunitiesStagingRoleSplitV3DurableStateLease;
  readonly expected: string;
  readonly next: CommunitiesStagingRoleSplitV3DurableStateEnvelope;
  readonly crashPoint: CrashPoint;
}

const sha256Pattern = /^[a-f0-9]{64}$/u;
const sha = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

export class CommunitiesStagingRoleSplitV3AnchorRehearsalError extends Error {
  constructor(
    readonly code:
      | 'INPUT_INVALID'
      | 'SUBJECT_INVALID'
      | 'CHILD_CRASH_NOT_OBSERVED'
      | 'RECOVERY_INVALID'
      | 'ROLLBACK_NOT_REJECTED'
      | 'REPORT_INVALID',
  ) {
    super(`COMMUNITIES_STAGING_ROLE_SPLIT_V3_ANCHOR_REHEARSAL_${code}`);
    this.name = 'CommunitiesStagingRoleSplitV3AnchorRehearsalError';
  }
}

function fail(code: CommunitiesStagingRoleSplitV3AnchorRehearsalError['code']): never {
  throw new CommunitiesStagingRoleSplitV3AnchorRehearsalError(code);
}

function canonicalReport(report: CommunitiesStagingRoleSplitV3AnchorRehearsalReport): string {
  if (
    report.schemaVersion !== COMMUNITIES_STAGING_ROLE_SPLIT_V3_ANCHOR_REHEARSAL_REPORT_VERSION ||
    !/^[a-f0-9]{40}$/u.test(report.candidateCommit) ||
    !sha256Pattern.test(report.productionSubjectSha256) ||
    !sha256Pattern.test(report.rehearsalSubjectSha256) ||
    report.beforeAnchorCrash !== 'RECOVERED_TO_RESTORE_PENDING' ||
    report.afterAnchorCrash !== 'RECOVERED_TO_RESTORED' ||
    report.completeLocalRollback !== 'STATE_ROLLBACK_DETECTED' ||
    report.retainedAnchorPhase !== 'RESTORED' ||
    report.crashDomain !== 'SUPERVISED_WORKER_PROCESS' ||
    report.wholeHostCrashTested !== false ||
    report.productionAnchorTouched !== false ||
    report.databaseAccessed !== false ||
    report.authorizesCeremony !== false ||
    report.authorizesLeaseRemoval !== false ||
    report.authorizesDatabaseMutation !== false ||
    report.authorizesProductionActivation !== false
  )
    fail('REPORT_INVALID');
  return `${JSON.stringify(report)}\n`;
}

function state(
  phase: 'OWNED' | 'RESTORE_PENDING' | 'RESTORED',
  requestSha256: string,
  restoreExecutionEvidenceSha256: string,
): CommunitiesStagingRoleSplitV3State {
  return {
    schemaVersion: COMMUNITIES_STAGING_ROLE_SPLIT_V3_STATE_VERSION,
    requestSha256,
    phase,
    cloneDatabaseOid: '900001',
    restoreExecutionEvidenceSha256,
    markerPayloadSha256: null,
  };
}

function envelope(
  phase: 'OWNED' | 'RESTORE_PENDING' | 'RESTORED',
  requestSha256: string,
  creationReceiptSha256: string,
  restoreExecutionEvidenceSha256: string,
): CommunitiesStagingRoleSplitV3DurableStateEnvelope {
  return {
    schemaVersion: COMMUNITIES_STAGING_ROLE_SPLIT_V3_DURABLE_STATE_ENVELOPE_VERSION,
    phase,
    requestSha256,
    creationReceiptSha256,
    restoreExecutionEvidenceSha256,
    cloneDatabaseOid: '900001',
    state: state(phase, requestSha256, restoreExecutionEvidenceSha256),
  };
}

class CrashInjectingAnchor implements CommunitiesStagingRoleSplitV3ExternalPhaseAnchor {
  readonly subjectSha256: string;

  constructor(
    private readonly delegate: CommunitiesStagingRoleSplitV3FileExternalPhaseAnchor,
    private readonly crashPoint: CrashPoint,
  ) {
    this.subjectSha256 = delegate.subjectSha256;
  }

  async assertIndependent(input: {
    readonly stateDirectory: string;
    readonly requestSha256: string;
    readonly creationReceiptSha256: string;
  }): Promise<void> {
    await this.delegate.assertIndependent(input);
  }

  async observe(): Promise<CommunitiesStagingRoleSplitV3ExternalPhaseAnchorObservation | null> {
    return this.delegate.observe();
  }

  async advance(input: {
    readonly expected: CommunitiesStagingRoleSplitV3ExternalPhaseAnchorObservation | null;
    readonly next: CommunitiesStagingRoleSplitV3ExternalPhaseAnchorObservation;
  }): Promise<void> {
    if (this.crashPoint === 'BEFORE_ANCHOR_ADVANCE') this.kill();
    await this.delegate.advance(input);
    this.kill();
  }

  private kill(): never {
    process.kill(process.pid, 'SIGKILL');
    throw new Error('SIGKILL did not terminate the rehearsal child');
  }
}

async function writeDurable(path: string, bytes: string): Promise<void> {
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  const handle = await open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(bytes, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
  const directory = await open(dirname(path), constants.O_RDONLY);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function runCrashChild(input: CrashChildInput): Promise<never> {
  const real = await createCommunitiesStagingRoleSplitV3CustodyBoundFileExternalPhaseAnchor(
    input.subject,
    input.requestSha256,
    input.creationReceiptSha256,
  );
  const store = new CommunitiesStagingRoleSplitV3DurableStateStore(
    input.stateStoreSubjectSha256,
    input.subject.stateDirectory,
    input.requestSha256,
    input.creationReceiptSha256,
    new CrashInjectingAnchor(real, input.crashPoint),
  );
  await store.writeCas(input.lease, input.expected, input.next);
  fail('CHILD_CRASH_NOT_OBSERVED');
}

function crashChildMain(): void {
  process.once('message', (message: CrashChildInput) => {
    void runCrashChild(message).catch(() => process.exit(70));
  });
}

async function expectKilledChild(childEntrypoint: string, input: CrashChildInput): Promise<void> {
  const child = fork(childEntrypoint, ['--crash-child'], {
    execArgv: process.execArgv,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  const outcome = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    timedOut: boolean;
    failed: boolean;
  }>((resolveOutcome) => {
    let settled = false;
    let timedOut = false;
    const finish = (inputOutcome: {
      code: number | null;
      signal: NodeJS.Signals | null;
      failed: boolean;
    }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveOutcome({ ...inputOutcome, timedOut });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, 10_000);
    child.once('error', () => finish({ code: null, signal: null, failed: true }));
    child.once('exit', (code, signal) => finish({ code, signal, failed: false }));
    child.send(input, (error) => {
      if (error !== null) {
        child.kill('SIGKILL');
        finish({ code: null, signal: null, failed: true });
      }
    });
  });
  if (outcome.failed || outcome.timedOut || outcome.code !== null || outcome.signal !== 'SIGKILL')
    fail('CHILD_CRASH_NOT_OBSERVED');
}

export async function runCommunitiesStagingRoleSplitV3AnchorRehearsal(input: {
  readonly productionSubject: CommunitiesStagingRoleSplitV3ExternalAnchorSubject;
  readonly rehearsalSubject: CommunitiesStagingRoleSplitV3ExternalAnchorSubject;
  readonly childEntrypoint: string;
}): Promise<CommunitiesStagingRoleSplitV3AnchorRehearsalReport> {
  const { productionSubject, rehearsalSubject } = input;
  if (
    productionSubject.purpose !== 'PRODUCTION' ||
    rehearsalSubject.purpose !== 'REHEARSAL' ||
    productionSubject.candidateCommit !== rehearsalSubject.candidateCommit ||
    productionSubject.anchorDirectory === rehearsalSubject.anchorDirectory ||
    !input.childEntrypoint.startsWith('/')
  )
    fail('SUBJECT_INVALID');
  await assertCommunitiesStagingRoleSplitV3ExternalAnchorRuntimeCustody(rehearsalSubject);
  if ((await readdir(rehearsalSubject.anchorDirectory)).length !== 0) fail('SUBJECT_INVALID');
  if ((await readdir(rehearsalSubject.stateDirectory)).length !== 0) fail('SUBJECT_INVALID');
  if ((await readdir(rehearsalSubject.backupDirectory)).length !== 0) fail('SUBJECT_INVALID');

  const rehearsalSubjectSha256 =
    communitiesStagingRoleSplitV3ExternalAnchorSubjectSha256(rehearsalSubject);
  const productionSubjectSha256 =
    communitiesStagingRoleSplitV3ExternalAnchorSubjectSha256(productionSubject);
  const requestSha256 = sha(`v10-rehearsal-request:${rehearsalSubjectSha256}`);
  const creationReceiptSha256 = sha(`v10-rehearsal-receipt:${rehearsalSubjectSha256}`);
  const restoreExecutionEvidenceSha256 = sha(
    `v10-rehearsal-restore-evidence:${rehearsalSubjectSha256}`,
  );
  const stateStoreSubjectSha256 = sha(`v10-state-store:${rehearsalSubjectSha256}`);
  const realAnchor = await createCommunitiesStagingRoleSplitV3CustodyBoundFileExternalPhaseAnchor(
    rehearsalSubject,
    requestSha256,
    creationReceiptSha256,
  );
  const store = new CommunitiesStagingRoleSplitV3DurableStateStore(
    stateStoreSubjectSha256,
    rehearsalSubject.stateDirectory,
    requestSha256,
    creationReceiptSha256,
    realAnchor,
  );
  const lease = await store.acquire();
  try {
    const owned = await store.writeCas(
      lease,
      null,
      envelope('OWNED', requestSha256, creationReceiptSha256, restoreExecutionEvidenceSha256),
    );
    const ownedJournal = (await readdir(rehearsalSubject.stateDirectory)).find((name) =>
      name.startsWith('v3-durable-journal-00-owned-'),
    );
    if (ownedJournal === undefined) fail('RECOVERY_INVALID');
    await writeDurable(join(rehearsalSubject.backupDirectory, 'owned-head.json'), owned);
    await writeDurable(
      join(rehearsalSubject.backupDirectory, 'owned-journal.json'),
      await readFile(join(rehearsalSubject.stateDirectory, ownedJournal), 'utf8'),
    );
    await writeDurable(
      join(rehearsalSubject.backupDirectory, 'owned-journal-name.txt'),
      `${ownedJournal}\n`,
    );

    const pendingEnvelope = envelope(
      'RESTORE_PENDING',
      requestSha256,
      creationReceiptSha256,
      restoreExecutionEvidenceSha256,
    );
    await expectKilledChild(input.childEntrypoint, {
      subject: rehearsalSubject,
      requestSha256,
      creationReceiptSha256,
      stateStoreSubjectSha256,
      lease,
      expected: owned,
      next: pendingEnvelope,
      crashPoint: 'BEFORE_ANCHOR_ADVANCE',
    });
    const recoveryStore = new CommunitiesStagingRoleSplitV3DurableStateStore(
      stateStoreSubjectSha256,
      rehearsalSubject.stateDirectory,
      requestSha256,
      creationReceiptSha256,
      realAnchor,
    );
    const pending = await recoveryStore.read(lease);
    if (pending !== canonicalCommunitiesStagingRoleSplitV3DurableStateEnvelope(pendingEnvelope))
      fail('RECOVERY_INVALID');

    const restoredEnvelope = envelope(
      'RESTORED',
      requestSha256,
      creationReceiptSha256,
      restoreExecutionEvidenceSha256,
    );
    await expectKilledChild(input.childEntrypoint, {
      subject: rehearsalSubject,
      requestSha256,
      creationReceiptSha256,
      stateStoreSubjectSha256,
      lease,
      expected: pending,
      next: restoredEnvelope,
      crashPoint: 'AFTER_ANCHOR_ADVANCE',
    });
    const restored = await recoveryStore.read(lease);
    if (restored !== canonicalCommunitiesStagingRoleSplitV3DurableStateEnvelope(restoredEnvelope))
      fail('RECOVERY_INVALID');

    const currentStateNames = await readdir(rehearsalSubject.stateDirectory);
    if (
      currentStateNames.some(
        (name) =>
          name !== 'ceremony.lock' &&
          name !== 'v3-durable-state.json' &&
          !/^v3-durable-journal-\d{2}-(owned|restore_pending|restored)-[a-f0-9]{64}\.json$/u.test(
            name,
          ),
      )
    )
      fail('RECOVERY_INVALID');
    for (const name of currentStateNames) {
      if (name !== 'ceremony.lock') await unlink(join(rehearsalSubject.stateDirectory, name));
    }
    await writeDurable(join(rehearsalSubject.stateDirectory, 'v3-durable-state.json'), owned);
    await writeDurable(
      join(rehearsalSubject.stateDirectory, ownedJournal),
      await readFile(join(rehearsalSubject.backupDirectory, 'owned-journal.json'), 'utf8'),
    );
    let rollbackRejected = false;
    try {
      await recoveryStore.read(lease);
    } catch (error) {
      rollbackRejected =
        error instanceof CommunitiesStagingRoleSplitV3DurableHostError &&
        error.code === 'STATE_ROLLBACK_DETECTED';
    }
    if (!rollbackRejected) fail('ROLLBACK_NOT_REJECTED');
    if ((await realAnchor.observe())?.phase !== 'RESTORED') fail('RECOVERY_INVALID');

    return {
      schemaVersion: COMMUNITIES_STAGING_ROLE_SPLIT_V3_ANCHOR_REHEARSAL_REPORT_VERSION,
      candidateCommit: productionSubject.candidateCommit,
      productionSubjectSha256,
      rehearsalSubjectSha256,
      beforeAnchorCrash: 'RECOVERED_TO_RESTORE_PENDING',
      afterAnchorCrash: 'RECOVERED_TO_RESTORED',
      completeLocalRollback: 'STATE_ROLLBACK_DETECTED',
      retainedAnchorPhase: 'RESTORED',
      crashDomain: 'SUPERVISED_WORKER_PROCESS',
      wholeHostCrashTested: false,
      productionAnchorTouched: false,
      databaseAccessed: false,
      authorizesCeremony: false,
      authorizesLeaseRemoval: false,
      authorizesDatabaseMutation: false,
      authorizesProductionActivation: false,
    };
  } finally {
    await store.release(lease);
  }
}

async function main(): Promise<void> {
  if (process.argv[2] === '--crash-child') {
    crashChildMain();
    return;
  }
  if (process.argv.length !== 8 || process.argv[2] !== 'run') fail('INPUT_INVALID');
  const productionSubjectSha256 = process.argv[4]!;
  const rehearsalSubjectSha256 = process.argv[6]!;
  if (!sha256Pattern.test(productionSubjectSha256) || !sha256Pattern.test(rehearsalSubjectSha256))
    fail('INPUT_INVALID');
  const productionSubject = parseCommunitiesStagingRoleSplitV3ExternalAnchorSubject(
    await readFile(process.argv[3]!, 'utf8'),
    productionSubjectSha256,
  );
  const rehearsalSubject = parseCommunitiesStagingRoleSplitV3ExternalAnchorSubject(
    await readFile(process.argv[5]!, 'utf8'),
    rehearsalSubjectSha256,
  );
  const report = await runCommunitiesStagingRoleSplitV3AnchorRehearsal({
    productionSubject,
    rehearsalSubject,
    childEntrypoint: process.argv[7]!,
  });
  process.stdout.write(canonicalReport(report));
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'UNKNOWN';
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
