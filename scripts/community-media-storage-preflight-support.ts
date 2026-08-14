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
    const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
    const affectsS3 = actions.some((action) =>
      typeof action === 'string' ? action === '*' || action.startsWith('s3:') : true,
    );
    if (!affectsS3) return false;
    if ('NotPrincipal' in statement) return true;
    return !isScopedPrincipal(statement.Principal);
  });
}

function isScopedPrincipal(value: unknown): boolean {
  if (typeof value === 'string') return value.length > 0 && value !== '*';
  if (Array.isArray(value)) return value.length > 0 && value.every(isScopedPrincipal);
  if (!value || typeof value !== 'object') return false;
  const entries = Object.values(value);
  return entries.length > 0 && entries.every(isScopedPrincipal);
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

export function lifecycleCleansQuarantineVersions(
  rule: LifecycleRule,
  maximumNoncurrentDays = 7,
): boolean {
  if (rule.Status !== 'Enabled') return false;
  if (!hasOnlyPrefixFilter(rule)) return false;
  const prefix = lifecyclePrefix(rule);
  const appliesToQuarantine = prefix === '' || 'community-media/quarantine/'.startsWith(prefix);
  const noncurrentDays = rule.NoncurrentVersionExpiration?.NoncurrentDays;
  return Boolean(
    appliesToQuarantine &&
    typeof noncurrentDays === 'number' &&
    noncurrentDays >= 1 &&
    noncurrentDays <= maximumNoncurrentDays,
  );
}

function hasOnlyPrefixFilter(rule: LifecycleRule): boolean {
  if (rule.Filter?.And) return Object.keys(rule.Filter.And).every((key) => key === 'Prefix');
  if (rule.Filter) return Object.keys(rule.Filter).every((key) => key === 'Prefix');
  return rule.Prefix !== undefined;
}
