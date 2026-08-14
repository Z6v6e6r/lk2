const COMMUNITY_INVITE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43,128}$/;

export function consumeCommunityInviteToken(
  location: Pick<Location, 'pathname' | 'search' | 'hash'>,
  history: Pick<History, 'replaceState' | 'state'>,
): string | null {
  if (location.pathname.replace(/\/+$/, '') !== '/community-invite') return null;
  const candidate = location.hash.startsWith('#') ? location.hash.slice(1) : '';
  if (location.hash) {
    history.replaceState(history.state, '', `${location.pathname}${location.search}`);
  }
  return COMMUNITY_INVITE_TOKEN_PATTERN.test(candidate) ? candidate : null;
}
