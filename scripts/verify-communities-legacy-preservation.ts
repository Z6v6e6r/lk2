import { constants, promises as fs } from 'node:fs';
import { createHash, timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  assertCommunitiesPreservationManifestSize,
  buildCommunitiesLegacyPreservationReport,
  communitiesLegacyPreservationManifestSchema,
  trustedCommunitiesLegacyMappingBaselineSchema,
} from './communities-legacy-preservation-support.js';
import { communitiesLegacyWriterInventoryReportSchema } from './communities-legacy-writer-inventory-support.js';

const MANIFEST_MAX_BYTES = 32 * 1024 * 1024;
const BASELINE_MAX_BYTES = 64 * 1024;
const WRITER_REPORT_MAX_BYTES = 1024 * 1024;
const INPUT_ERROR = 'COMMUNITIES_LEGACY_PRESERVATION_INVALID_INPUT';
const INTERNAL_ERROR = 'COMMUNITIES_LEGACY_PRESERVATION_INCONCLUSIVE';

type CliResult = {
  readonly exitCode: 0 | 1 | 2 | 3;
  readonly stdout: string;
  readonly stderr: string;
};
type FileIdentity = {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
  readonly mode: bigint;
  readonly uid: bigint;
};

class InputError extends Error {}

function inputError(): never {
  throw new InputError();
}

function parseArguments(arguments_: readonly string[]): {
  manifest: string;
  baseline: string;
  writerReport: string;
} {
  let manifest: string | undefined;
  let baseline: string | undefined;
  let writerReport: string | undefined;
  for (let index = 0; index < arguments_.length; index += 1) {
    const flag = arguments_[index];
    const value = arguments_[index + 1];
    if (
      (flag !== '--manifest' && flag !== '--baseline' && flag !== '--writer-report') ||
      !value ||
      value.startsWith('--') ||
      !value.startsWith('/')
    )
      inputError();
    if (flag === '--manifest') {
      if (manifest) inputError();
      manifest = value;
    } else if (flag === '--baseline') {
      if (baseline) inputError();
      baseline = value;
    } else {
      if (writerReport) inputError();
      writerReport = value;
    }
    index += 1;
  }
  if (!manifest || !baseline || !writerReport) inputError();
  return { manifest, baseline, writerReport };
}

function identity(stat: {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  mode: bigint;
  uid: bigint;
}): FileIdentity {
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
    mode: stat.mode,
    uid: stat.uid,
  };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.mode === right.mode &&
    left.uid === right.uid
  );
}

async function readPrivateRegularFile(path: string, maxBytes: number): Promise<Buffer> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    const preOpen = await fs.lstat(path, { bigint: true });
    const expectedUid = process.getuid?.();
    if (
      !preOpen.isFile() ||
      preOpen.isSymbolicLink() ||
      (preOpen.mode & 0o077n) !== 0n ||
      (expectedUid !== undefined && preOpen.uid !== BigInt(expectedUid))
    )
      inputError();
    handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const fdBefore = await handle.stat({ bigint: true });
    const before = identity(fdBefore);
    if (
      !fdBefore.isFile() ||
      (fdBefore.mode & 0o077n) !== 0n ||
      (expectedUid !== undefined && fdBefore.uid !== BigInt(expectedUid)) ||
      before.size < 0n ||
      before.size > BigInt(maxBytes) ||
      !sameIdentity(identity(preOpen), before)
    )
      inputError();
    if (maxBytes === MANIFEST_MAX_BYTES)
      assertCommunitiesPreservationManifestSize(Number(before.size));
    const buffer = Buffer.alloc(Number(before.size) + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const afterStat = await handle.stat({ bigint: true });
    if (
      !afterStat.isFile() ||
      (afterStat.mode & 0o077n) !== 0n ||
      (expectedUid !== undefined && afterStat.uid !== BigInt(expectedUid)) ||
      offset !== Number(before.size) ||
      !sameIdentity(before, identity(afterStat))
    )
      inputError();
    return buffer.subarray(0, offset);
  } catch (error) {
    if (error instanceof InputError) throw error;
    inputError();
  } finally {
    await handle?.close().catch(() => undefined);
  }
  return inputError();
}

export async function runCommunitiesLegacyPreservationVerification(
  arguments_: readonly string[],
  requiredBaselineSha256: string | undefined,
  requiredWriterReportSha256: string | undefined,
): Promise<CliResult> {
  try {
    if (!requiredBaselineSha256 || !/^[0-9a-f]{64}$/.test(requiredBaselineSha256)) inputError();
    if (!requiredWriterReportSha256 || !/^[0-9a-f]{64}$/.test(requiredWriterReportSha256))
      inputError();
    const {
      manifest: manifestPath,
      baseline: baselinePath,
      writerReport: writerReportPath,
    } = parseArguments(arguments_);
    const [manifestBytes, baselineBytes, writerReportBytes] = await Promise.all([
      readPrivateRegularFile(manifestPath, MANIFEST_MAX_BYTES),
      readPrivateRegularFile(baselinePath, BASELINE_MAX_BYTES),
      readPrivateRegularFile(writerReportPath, WRITER_REPORT_MAX_BYTES),
    ]);
    const actualBaselineSha256 = createHash('sha256').update(baselineBytes).digest();
    const actualWriterReportSha256 = createHash('sha256').update(writerReportBytes).digest();
    if (!timingSafeEqual(actualBaselineSha256, Buffer.from(requiredBaselineSha256, 'hex')))
      inputError();
    if (!timingSafeEqual(actualWriterReportSha256, Buffer.from(requiredWriterReportSha256, 'hex')))
      inputError();
    let manifestPayload: unknown;
    let baselinePayload: unknown;
    let writerReportPayload: unknown;
    try {
      manifestPayload = JSON.parse(manifestBytes.toString('utf8')) as unknown;
      baselinePayload = JSON.parse(baselineBytes.toString('utf8')) as unknown;
      writerReportPayload = JSON.parse(writerReportBytes.toString('utf8')) as unknown;
    } catch {
      inputError();
    }
    const manifest = communitiesLegacyPreservationManifestSchema.safeParse(manifestPayload);
    const baseline = trustedCommunitiesLegacyMappingBaselineSchema.safeParse(baselinePayload);
    const writerReport =
      communitiesLegacyWriterInventoryReportSchema.safeParse(writerReportPayload);
    if (!manifest.success || !baseline.success || !writerReport.success) inputError();
    const reportSha256 = actualWriterReportSha256.toString('hex');
    if (
      writerReport.data.outcome !== 'NODE_RED_WRITER_INVENTORY_COMPLETE' ||
      writerReport.data.total < 1 ||
      writerReport.data.unknown !== 0 ||
      Object.values(writerReport.data.unknownByReason).some((count) => count !== 0) ||
      writerReport.data.duplicateHandlers !== 0 ||
      writerReport.data.blockers.length !== 0 ||
      manifest.data.writeRoutes.reportSha256 !== reportSha256 ||
      manifest.data.writeRoutes.sourceFlowSha256 !== writerReport.data.sourceFlowSha256 ||
      manifest.data.writeRoutes.functionAllowlistSha256 !==
        writerReport.data.functionAllowlistSha256 ||
      manifest.data.writeRoutes.total !== writerReport.data.total ||
      manifest.data.writeRoutes.inventoryDigest !== writerReport.data.inventoryDigest ||
      manifest.data.writeRoutes.unknown !== writerReport.data.unknown ||
      manifest.data.writeRoutes.duplicateHandlers !== writerReport.data.duplicateHandlers
    )
      inputError();
    const report = buildCommunitiesLegacyPreservationReport(manifest.data, baseline.data);
    return {
      exitCode: report.outcome === 'INVENTORY_STRUCTURALLY_CONSISTENT' ? 0 : 1,
      stdout: `${JSON.stringify(report)}\n`,
      stderr: '',
    };
  } catch (error) {
    if (error instanceof InputError) return { exitCode: 2, stdout: '', stderr: `${INPUT_ERROR}\n` };
    return { exitCode: 3, stdout: '', stderr: `${INTERNAL_ERROR}\n` };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await runCommunitiesLegacyPreservationVerification(
    process.argv.slice(2),
    process.env.COMMUNITIES_LEGACY_BASELINE_SHA256_REQUIRED,
    process.env.COMMUNITIES_LEGACY_WRITER_REPORT_SHA256_REQUIRED,
  );
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}
