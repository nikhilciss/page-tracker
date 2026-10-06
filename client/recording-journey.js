// Only signed recording references/counts are stored, never page contents or form values.
export function recordingJourney(endpoint) {
  const key = 'page-tracker:journey:' + endpoint.origin + endpoint.pathname;
  let policy,
    parts = [],
    attempted = false,
    readable = false;
  try {
    const saved = JSON.parse(sessionStorage.getItem(key) || 'null');
    if (saved?.expires > Date.now() && Array.isArray(saved.parts) && saved.parts.length <= 20) {
      parts = saved.parts.filter(
        (p) => typeof p.token === 'string' && Number.isInteger(p.expected_count),
      );
      attempted = saved.attempted === true;
      readable = true;
    }
  } catch {}
  function write() {
    try {
      sessionStorage.setItem(
        key,
        JSON.stringify({
          parts,
          attempted,
          expires: Math.min(Date.now() + 30 * 60000, ...parts.map((p) => p.expires_at)),
        }),
      );
    } catch {
      /* Same-page recording still works when storage is unavailable. */
    }
  }
  return {
    configure(value) {
      policy = value;
    },
    get enabled() {
      return !!policy;
    },
    get attempted() {
      return attempted;
    },
    get resumed() {
      return readable && attempted;
    },
    attempt() {
      if (policy) {
        attempted = true;
        write();
      }
    },
    remember(session, count) {
      if (!policy) return;
      const part = { token: session.token, expected_count: count, expires_at: session.expires_at };
      const index = parts.findIndex((p) => p.token === session.token);
      if (index >= 0) parts[index] = part;
      else {
        if (parts.length >= 20) throw new Error('Recording journey page limit reached');
        parts.push(part);
      }
      write();
    },
    previous(session) {
      return parts
        .filter((p) => p.token !== session.token)
        .map(({ token, expected_count }) => ({ token, expected_count }));
    },
    matches(requireAttempt = true) {
      if (!policy || (requireAttempt && !attempted)) return false;
      if (policy.path && location.pathname !== policy.path) return false;
      if (policy.selector) {
        try {
          const el = document.querySelector(policy.selector);
          if (!el || !el.getClientRects().length || getComputedStyle(el).visibility === 'hidden')
            return false;
        } catch {
          return false;
        }
      }
      return true;
    },
    clear() {
      parts = [];
      attempted = false;
      try {
        sessionStorage.removeItem(key);
      } catch {}
    },
  };
}
