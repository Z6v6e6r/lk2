export class OciProvenanceExtractionError extends Error {
  readonly reason: string;
}

export function extractTimewebOciProvenance(layoutPath: string): {
  readonly runtimeDigest: string;
  readonly statement: unknown;
};
