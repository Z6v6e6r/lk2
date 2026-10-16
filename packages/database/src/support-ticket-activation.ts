import {
  SUPPORT_TICKET_RUNTIME_PRIVILEGES,
  assertSupportTicketAclBoundary,
  type SupportTicketAclSnapshot,
} from './support-ticket-acl.js';
export * from './support-ticket-acl.js';

export * from './support-ticket-prerequisites.js';

/** Accept only owner-only or an incomplete subset of the exact intended grants. No drift repair. */
export function assertSupportTicketAclProvisioningBoundary(
  snapshot: SupportTicketAclSnapshot,
  expected: { readonly runtimeRoleName: string; readonly migratorRoleName: string },
): void {
  const acceptable = (
    grants: SupportTicketAclSnapshot['schema']['grants'],
    allowed: readonly string[],
  ) =>
    grants.every(
      (grant) =>
        grant.grantee === expected.migratorRoleName ||
        (grant.grantee === expected.runtimeRoleName &&
          !grant.grantable &&
          allowed.includes(grant.privilege)),
    );
  if (
    !acceptable(snapshot.schema.grants, ['USAGE']) ||
    snapshot.relations.some((relation) => {
      const allowed = SUPPORT_TICKET_RUNTIME_PRIVILEGES[
        relation.name as keyof typeof SUPPORT_TICKET_RUNTIME_PRIVILEGES
      ] as readonly string[] | undefined;
      return (
        !allowed ||
        !acceptable(relation.grants, allowed) ||
        relation.runtimePrivileges.some((privilege) => !allowed.includes(privilege))
      );
    })
  )
    throw new Error('SUPPORT_ACL_PREIMAGE_DRIFT');
  // Virtual completion validates all structural, ownership, RLS and retention invariants before DCL.
  assertSupportTicketAclBoundary(
    {
      ...snapshot,
      schema: {
        ...snapshot.schema,
        grants: [
          ...snapshot.schema.grants,
          { grantee: expected.runtimeRoleName, privilege: 'USAGE', grantable: false },
        ],
      },
      relations: snapshot.relations.map((relation) => ({
        ...relation,
        runtimePrivileges:
          SUPPORT_TICKET_RUNTIME_PRIVILEGES[
            relation.name as keyof typeof SUPPORT_TICKET_RUNTIME_PRIVILEGES
          ],
      })),
    },
    expected,
  );
}

export {
  openSupportTicketRuntimePool,
  assertSupportDatabaseConnection,
} from './support-ticket-runtime.js';
