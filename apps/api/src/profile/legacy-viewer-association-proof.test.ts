import { describe, expect, it, vi } from 'vitest';

import {
  LegacyViewerAssociationProof,
  type LegacyViewerAssociationProofOutcome,
  type LegacyViewerAssociationProofSource,
} from './legacy-viewer-association-proof.js';

const TENANT = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
const USER = '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca';
const TENANT_KEY = 'local-padel';
const ASSOCIATION = 'a'.repeat(64);

function proofWith(options: {
  readonly readByViewerPhone: LegacyViewerAssociationProofSource['readByViewerPhone'];
  readonly pending?: boolean;
  readonly delivered?: number;
  readonly legacyTenantKey?: string | undefined;
  readonly onOutcome?: (
    outcome: LegacyViewerAssociationProofOutcome,
    context: { readonly tenantId: string; readonly userId: string; readonly delivered: number },
  ) => void;
}) {
  const hasPendingDeferredRequests = vi.fn().mockResolvedValue(options.pending ?? true);
  const deliverDeferredFriendRequestsForPlayerKeys = vi.fn().mockResolvedValue({
    delivered: options.delivered ?? 1,
    pending: 0,
  });
  const proof = new LegacyViewerAssociationProof({
    source: { readByViewerPhone: options.readByViewerPhone },
    delivery: { hasPendingDeferredRequests, deliverDeferredFriendRequestsForPlayerKeys },
    legacyTenantKey: 'legacyTenantKey' in options ? options.legacyTenantKey : TENANT_KEY,
    ...(options.onOutcome ? { onOutcome: options.onOutcome } : {}),
  });
  return { proof, hasPendingDeferredRequests, deliverDeferredFriendRequestsForPlayerKeys };
}

describe('legacy viewer association proof', () => {
  it('delivers the saved requests of the player keys the provider phone proves', async () => {
    const readByViewerPhone = vi
      .fn()
      .mockResolvedValue([
        { viewerParticipantExternalId: ASSOCIATION },
        { viewerParticipantExternalId: ASSOCIATION },
      ]);
    const { proof, deliverDeferredFriendRequestsForPlayerKeys } = proofWith({ readByViewerPhone });

    await expect(
      proof.prove({
        tenantKey: TENANT_KEY,
        tenantId: TENANT,
        userId: USER,
        phoneE164: '+79104303190',
        correlationId: 'proof-correlation-0001',
      }),
    ).resolves.toBe('delivered');

    expect(readByViewerPhone).toHaveBeenCalledWith({ phoneE164: '+79104303190', limit: 20 });
    expect(deliverDeferredFriendRequestsForPlayerKeys).toHaveBeenCalledWith({
      tenantId: TENANT,
      deliveryUserId: USER,
      sourcePlayerAssociationIds: [ASSOCIATION],
      limit: 20,
      correlationId: 'proof-correlation-0001',
    });
  });

  it('never reads the legacy mirror while no saved request is waiting', async () => {
    const readByViewerPhone = vi.fn();
    const { proof, deliverDeferredFriendRequestsForPlayerKeys } = proofWith({
      readByViewerPhone,
      pending: false,
    });

    await expect(
      proof.prove({
        tenantKey: TENANT_KEY,
        tenantId: TENANT,
        userId: USER,
        phoneE164: '+79104303190',
        correlationId: 'proof-correlation-0002',
      }),
    ).resolves.toBe('no_pending');

    expect(readByViewerPhone).not.toHaveBeenCalled();
    expect(deliverDeferredFriendRequestsForPlayerKeys).not.toHaveBeenCalled();
  });

  it('never claims the legacy mirror for another tenant', async () => {
    const readByViewerPhone = vi.fn();
    const { proof, hasPendingDeferredRequests } = proofWith({ readByViewerPhone });

    await expect(
      proof.prove({
        tenantKey: 'other-tenant',
        tenantId: TENANT,
        userId: USER,
        phoneE164: '+79104303190',
        correlationId: 'proof-correlation-0003',
      }),
    ).resolves.toBe('tenant_mismatch');

    expect(hasPendingDeferredRequests).not.toHaveBeenCalled();
    expect(readByViewerPhone).not.toHaveBeenCalled();
  });

  it('reports a proof that found nothing, could not settle, or was unavailable', async () => {
    const empty = proofWith({ readByViewerPhone: vi.fn().mockResolvedValue([]) });
    await expect(
      empty.proof.prove({
        tenantKey: TENANT_KEY,
        tenantId: TENANT,
        userId: USER,
        phoneE164: '+79104303190',
        correlationId: 'proof-correlation-0004',
      }),
    ).resolves.toBe('no_match');
    expect(empty.deliverDeferredFriendRequestsForPlayerKeys).not.toHaveBeenCalled();

    const unsettled = proofWith({
      readByViewerPhone: vi.fn().mockResolvedValue([{ viewerParticipantExternalId: ASSOCIATION }]),
      delivered: 0,
    });
    await expect(
      unsettled.proof.prove({
        tenantKey: TENANT_KEY,
        tenantId: TENANT,
        userId: USER,
        phoneE164: '+79104303190',
        correlationId: 'proof-correlation-0005',
      }),
    ).resolves.toBe('not_deliverable');

    const unavailable = proofWith({
      readByViewerPhone: vi
        .fn()
        .mockRejectedValue(new Error('LEGACY_GAMES_PUBLIC_SOURCE_UNAVAILABLE')),
    });
    await expect(
      unavailable.proof.prove({
        tenantKey: TENANT_KEY,
        tenantId: TENANT,
        userId: USER,
        phoneE164: '+79104303190',
        correlationId: 'proof-correlation-0006',
      }),
    ).resolves.toBe('unavailable');
    expect(unavailable.deliverDeferredFriendRequestsForPlayerKeys).not.toHaveBeenCalled();
  });

  it('reports its outcome and never calls the legacy source without a usable phone', async () => {
    const onOutcome = vi.fn();
    const readByViewerPhone = vi.fn();
    const { proof } = proofWith({ readByViewerPhone, onOutcome });

    await expect(
      proof.prove({
        tenantKey: TENANT_KEY,
        tenantId: TENANT,
        userId: USER,
        phoneE164: undefined,
        correlationId: 'proof-correlation-0007',
      }),
    ).resolves.toBe('absent');
    expect(readByViewerPhone).not.toHaveBeenCalled();
    expect(onOutcome).toHaveBeenCalledWith('absent', {
      tenantId: TENANT,
      userId: USER,
      delivered: 0,
    });
  });

  it('stays inert while the configured legacy tenant key is missing', async () => {
    const readByViewerPhone = vi.fn();
    const { proof } = proofWith({ readByViewerPhone, legacyTenantKey: undefined });

    await expect(
      proof.prove({
        tenantKey: TENANT_KEY,
        tenantId: TENANT,
        userId: USER,
        phoneE164: '+79104303190',
        correlationId: 'proof-correlation-0008',
      }),
    ).resolves.toBe('tenant_mismatch');
    expect(readByViewerPhone).not.toHaveBeenCalled();
  });
});
