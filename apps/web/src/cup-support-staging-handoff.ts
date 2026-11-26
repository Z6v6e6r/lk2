const LK2_ORIGIN = 'https://lk2.padlhub.su';
const CUP_SUPPORT_INTAKE = 'https://stg-support.tsup.space/intake';
const DRAFT_QUERY = 'cupSupportIntake';
const DRAFT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function readCupSupportHandoffDraft(
  location: Pick<Location, 'origin' | 'pathname' | 'search'>,
): string | undefined {
  if (location.origin !== LK2_ORIGIN || location.pathname !== '/') return undefined;
  const query = new URLSearchParams(location.search);
  const draft = query.get(DRAFT_QUERY);
  return query.size === 1 && draft && DRAFT_ID.test(draft) ? draft : undefined;
}

export function cupSupportHandoffContinuation(path: string): boolean {
  if (!path.startsWith('/?')) return false;
  return Boolean(readCupSupportHandoffDraft(new URL(path, LK2_ORIGIN)));
}

export function cupSupportHandoffDestination(proof: string): string {
  if (typeof proof !== 'string' || proof.length > 1024 || !/^[\w-]+\.[\w-]+\.[\w-]+$/.test(proof)) {
    throw new Error('Invalid CUP Support handoff proof');
  }
  const destination = new URL(CUP_SUPPORT_INTAKE);
  destination.hash = new URLSearchParams({ cupProof: proof }).toString();
  return destination.href;
}
