import type { LifecycleRule } from '@aws-sdk/client-s3';

export function policyAllowsAnonymousAccess(policy: string): boolean {
  const document = JSON.parse(policy) as { readonly Statement?: unknown };
  const statements = Array.isArray(document.Statement)
    ? document.Statement
    : document.Statement
      ? [document.Statement]
      : [];
  return statements.some((value) => {
    if (!value || typeof value !== 'object') return false;
    const statement = value as Record<string, unknown>;
    if (statement.Effect !== 'Allow') return false;
    const principal = statement.Principal;
    const anonymous =
      principal === '*' ||
      (principal !== null &&
        typeof principal === 'object' &&
        Object.values(principal).some((entry) => entry === '*'));
    const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
    return (
      anonymous &&
      actions.some((action) =>
        typeof action === 'string' ? action === '*' || action.startsWith('s3:') : false,
      )
    );
  });
}

function lifecyclePrefix(rule: LifecycleRule): string {
  if (rule.Filter?.Prefix !== undefined) return rule.Filter.Prefix;
  if (rule.Filter?.And?.Prefix !== undefined) return rule.Filter.And.Prefix;
  return rule.Prefix ?? '';
}

export function lifecycleCanDeleteReady(rule: LifecycleRule): boolean {
  if (rule.Status !== 'Enabled') return false;
  const prefix = lifecyclePrefix(rule);
  const appliesToReady =
    prefix === '' ||
    'community-media/ready/'.startsWith(prefix) ||
    prefix.startsWith('community-media/ready/');
  return Boolean(
    appliesToReady &&
    (rule.Expiration ||
      rule.NoncurrentVersionExpiration ||
      (rule.NoncurrentVersionTransitions?.length ?? 0) > 0),
  );
}
