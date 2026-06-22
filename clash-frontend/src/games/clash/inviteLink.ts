/**
 * Shareable duel session links (issue #24).
 *
 * `buildInviteLink` turns a session id into a copyable URL carrying `?session=<id>`.
 * `readSessionParam` reads that param back on load so the Rejoin Arena field can be
 * pre-filled. Pre-filling is the ONLY thing the param does — joining still runs the
 * on-chain player-membership check in handleLoadSession, so a link can never bypass auth.
 *
 * These are kept dependency-free (only `window.location`) so they are unit-testable.
 */

/** Turn a session id into a shareable invite URL with `?session=<id>`. */
export function buildInviteLink(sid: number): string {
  if (typeof window === 'undefined') return `?session=${sid}`;
  const { origin, pathname } = window.location;
  return `${origin}${pathname}?session=${sid}`;
}

/** Read a `?session=<id>` query param, returning a positive integer or null. */
export function readSessionParam(): number | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = new URLSearchParams(window.location.search).get('session');
    if (!raw) return null;
    const sid = parseInt(raw.trim(), 10);
    return Number.isNaN(sid) || sid <= 0 ? null : sid;
  } catch {
    return null;
  }
}
