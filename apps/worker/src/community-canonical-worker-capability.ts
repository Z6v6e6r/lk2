export type CommunitiesReadMode = 'mock' | 'legacy' | 'local';

export function isCanonicalCommunityWorkerEnabled(readMode: CommunitiesReadMode): boolean {
  return readMode === 'local';
}
