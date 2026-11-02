import { createHash } from 'node:crypto';
import { z } from 'zod';

export const organizerLookupType = 'phub-tournament-organizer-lookup+jwt';
export const organizerLookupScope = 'tournaments.organizer-profile.read';
export const organizerUuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
export const organizerLookupBody = z
  .object({
    contractVersion: z.literal(1),
    requestId: organizerUuid,
    assignmentOperationId: organizerUuid,
    tournamentId: organizerUuid,
    selectedUserId: organizerUuid,
    expectedAssignmentRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
export type OrganizerLookupBody = z.infer<typeof organizerLookupBody>;
export function organizerLookupBytes(body: OrganizerLookupBody): string {
  return JSON.stringify({
    contractVersion: 1,
    requestId: body.requestId,
    assignmentOperationId: body.assignmentOperationId,
    tournamentId: body.tournamentId,
    selectedUserId: body.selectedUserId,
    expectedAssignmentRevision: body.expectedAssignmentRevision,
  });
}
export function organizerLookupHash(body: OrganizerLookupBody): string {
  return createHash('sha256').update(organizerLookupBytes(body)).digest('hex');
}
export const organizerLookupPath = (tenantKey: string): string =>
  `/internal/api/v1/${tenantKey}/tournament-organizer-profile-lookups`;
