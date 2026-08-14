import { constants, promises as fs } from 'node:fs';
import { createHash, timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  buildCommunitiesLegacyWriterInventoryReport,
  communitiesLegacyFunctionAllowlistSchema,
  communitiesLegacyNodeRedFlowSchema,
} from './communities-legacy-writer-inventory-support.js';

const MAX_FLOW_BYTES = 32 * 1024 * 1024;
const MAX_ALLOWLIST_BYTES = 8 * 1024 * 1024;
const INPUT_ERROR = 'COMMUNITIES_LEGACY_WRITER_INVENTORY_INVALID_INPUT';
const INTERNAL_ERROR = 'COMMUNITIES_LEGACY_WRITER_INVENTORY_INCONCLUSIVE';

type CliResult = {
  readonly exitCode: 0 | 1 | 2 | 3;
  readonly stdout: string;
  readonly stderr: string;
};

class InputError extends Error {}

function inputError(): never {
  throw new InputError();
}

function parseArguments(arguments_: readonly string[]): {
  readonly flowPath: string;
  readonly functionAllowlistPath: string;
} {
  if (
    arguments_.length !== 4 ||
    arguments_[0] !== '--flow' ||
    arguments_[2] !== '--function-allowlist'
  )
    inputError();
  const flowPath = arguments_[1];
  const functionAllowlistPath = arguments_[3];
  if (!flowPath?.startsWith('/') || !functionAllowlistPath?.startsWith('/')) inputError();
  return { flowPath, functionAllowlistPath };
}

async function readPrivateFile(path: string, maxBytes: number): Promise<Buffer> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    const expectedUid = process.getuid?.();
    const beforeOpen = await fs.lstat(path, { bigint: true });
    if (
      !beforeOpen.isFile() ||
      beforeOpen.isSymbolicLink() ||
      (beforeOpen.mode & 0o077n) !== 0n ||
      (expectedUid !== undefined && beforeOpen.uid !== BigInt(expectedUid)) ||
      beforeOpen.size < 1n ||
      beforeOpen.size > BigInt(maxBytes)
    )
      inputError();
    handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const beforeRead = await handle.stat({ bigint: true });
    if (
      !beforeRead.isFile() ||
      beforeRead.dev !== beforeOpen.dev ||
      beforeRead.ino !== beforeOpen.ino ||
      beforeRead.size !== beforeOpen.size ||
      beforeRead.mtimeNs !== beforeOpen.mtimeNs ||
      beforeRead.ctimeNs !== beforeOpen.ctimeNs ||
      beforeRead.mode !== beforeOpen.mode ||
      beforeRead.uid !== beforeOpen.uid
    )
      inputError();
    const content = Buffer.alloc(Number(beforeRead.size) + 1);
    let offset = 0;
    while (offset < content.length) {
      const { bytesRead } = await handle.read(content, offset, content.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const afterRead = await handle.stat({ bigint: true });
    if (
      offset !== Number(beforeRead.size) ||
      afterRead.dev !== beforeRead.dev ||
      afterRead.ino !== beforeRead.ino ||
      afterRead.size !== beforeRead.size ||
      afterRead.mtimeNs !== beforeRead.mtimeNs ||
      afterRead.ctimeNs !== beforeRead.ctimeNs ||
      afterRead.mode !== beforeRead.mode ||
      afterRead.uid !== beforeRead.uid
    )
      inputError();
    return content.subarray(0, offset);
  } catch (error) {
    if (error instanceof InputError) throw error;
    inputError();
  } finally {
    await handle?.close().catch(() => undefined);
  }
  return inputError();
}

export async function runCommunitiesLegacyWriterInventory(
  arguments_: readonly string[],
  requiredFlowSha256: string | undefined,
  requiredFunctionAllowlistSha256: string | undefined,
): Promise<CliResult> {
  try {
    if (!requiredFlowSha256 || !/^[0-9a-f]{64}$/.test(requiredFlowSha256)) inputError();
    if (!requiredFunctionAllowlistSha256 || !/^[0-9a-f]{64}$/.test(requiredFunctionAllowlistSha256))
      inputError();
    const { flowPath, functionAllowlistPath } = parseArguments(arguments_);
    const [bytes, functionAllowlistBytes] = await Promise.all([
      readPrivateFile(flowPath, MAX_FLOW_BYTES),
      readPrivateFile(functionAllowlistPath, MAX_ALLOWLIST_BYTES),
    ]);
    const actualFlowSha256 = createHash('sha256').update(bytes).digest();
    const actualFunctionAllowlistSha256 = createHash('sha256')
      .update(functionAllowlistBytes)
      .digest();
    if (!timingSafeEqual(actualFlowSha256, Buffer.from(requiredFlowSha256, 'hex'))) inputError();
    if (
      !timingSafeEqual(
        actualFunctionAllowlistSha256,
        Buffer.from(requiredFunctionAllowlistSha256, 'hex'),
      )
    )
      inputError();
    let payload: unknown;
    let functionAllowlistPayload: unknown;
    try {
      payload = JSON.parse(bytes.toString('utf8')) as unknown;
      functionAllowlistPayload = JSON.parse(functionAllowlistBytes.toString('utf8')) as unknown;
    } catch {
      inputError();
    }
    const parsed = communitiesLegacyNodeRedFlowSchema.safeParse(payload);
    const parsedFunctionAllowlist =
      communitiesLegacyFunctionAllowlistSchema.safeParse(functionAllowlistPayload);
    if (!parsed.success || !parsedFunctionAllowlist.success) inputError();
    const actualFlowSha256Hex = actualFlowSha256.toString('hex');
    if (parsedFunctionAllowlist.data.sourceFlowSha256 !== actualFlowSha256Hex) inputError();
    const reviewedFunctionDigests = new Set(parsedFunctionAllowlist.data.functionDigests);
    if (reviewedFunctionDigests.size !== parsedFunctionAllowlist.data.functionDigests.length)
      inputError();
    const report = buildCommunitiesLegacyWriterInventoryReport(
      parsed.data,
      actualFlowSha256Hex,
      reviewedFunctionDigests,
      actualFunctionAllowlistSha256.toString('hex'),
    );
    return {
      exitCode: report.outcome === 'NODE_RED_WRITER_INVENTORY_COMPLETE' ? 0 : 1,
      stdout: `${JSON.stringify(report)}\n`,
      stderr: '',
    };
  } catch (error) {
    if (error instanceof InputError) return { exitCode: 2, stdout: '', stderr: `${INPUT_ERROR}\n` };
    return { exitCode: 3, stdout: '', stderr: `${INTERNAL_ERROR}\n` };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await runCommunitiesLegacyWriterInventory(
    process.argv.slice(2),
    process.env.COMMUNITIES_LEGACY_FLOW_SHA256_REQUIRED,
    process.env.COMMUNITIES_LEGACY_FUNCTION_ALLOWLIST_SHA256_REQUIRED,
  );
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}
