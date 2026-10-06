// Analytics does not depend on MP4 finalization. No field values are sent here.
export function analyticsIdentity(script, post) {
  const storageKey = 'page-tracker:visitor:' + new URL(script.src).origin;
  let token = null;
  if (script.dataset.analyticsStorage !== 'none') {
    try {
      token = localStorage.getItem(storageKey);
    } catch {
      /* Ephemeral identity fallback. */
    }
  }
  async function start(session) {
    if (script.dataset.analyticsStorage !== 'none') {
      try {
        token = localStorage.getItem(storageKey) || token;
      } catch {}
    }
    const result = await post(
      'analytics/start',
      {
        token: session.token,
        ...(token ? { visitor_token: token } : {}),
      },
      AbortSignal.timeout(5000),
    );
    token = result.visitor_token;
    if (script.dataset.analyticsStorage !== 'none') {
      try {
        localStorage.setItem(storageKey, token);
      } catch {
        /* Storage unavailable. */
      }
    }
    return result;
  }
  return (session) =>
    navigator.locks?.request
      ? navigator.locks.request(storageKey, () => start(session))
      : start(session);
}
