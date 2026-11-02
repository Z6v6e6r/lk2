export type ClosedPackageFamily = 'HISTORICAL108' | 'R1_PACKAGE119';
export const CLOSED_R1_OPERATION_SCHEMAS: Readonly<
  Record<'game_start_0103' | 'subject_link_0104', string>
>;
export const CLOSED_R1_ARGUMENTS: Readonly<Record<string, 'game_start_0103' | 'subject_link_0104'>>;
export function closedApplicationPackageFamily(operation: unknown): ClosedPackageFamily;
export function closedApplicationPackageDescriptor(operation: unknown): {
  schema: string;
  packagedCount: number;
  packagedLedgerSha256: string;
  profiles: Record<
    string,
    { filename: string; checksum: string; preCount: number; postCount: number }
  >;
  checkpoints: Record<string, { ledgerSha256: string }>;
};
export function closedApplicationDescriptorPath(operation: unknown): string;
export function closedApplicationPackageArgument(operation: unknown): string;
export function assertClosedR1Descriptor(): unknown;
export function assertClosedR1PackagedCatalog(
  packaged: readonly { filename: string; checksum: string }[],
): void;
