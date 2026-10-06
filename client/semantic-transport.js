import { semanticCapture } from './semantic-capture.js';
// Bounded, sequential batches. Retries reuse exact event IDs and sequence numbers.
export function startSemantic(
  script,
  getSession,
  startAnalytics,
  captureStarted = performance.now(),
) {
  const endpoint = new URL('./api/track/analytics/events', script.src),
    storagePrefix = 'page-tracker:pending:' + endpoint.origin + ':',
    storageBase = storagePrefix;
  let storageKey;
  const persist = script.dataset.analyticsStorage !== 'none';
  let sequence = 0,
    queue = [],
    ready = false,
    flight = null,
    retries = 0,
    timer,
    stopped = false,
    partial = false,
    paused = false;
  let session;
  const started = captureStarted,
    epoch = Date.now() - (performance.now() - started);
  const uuid = () =>
    crypto.randomUUID?.() ||
    'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const n = (Math.random() * 16) | 0;
      return (c === 'x' ? n : (n & 3) | 8).toString(16);
    });
  function savePending() {
    if (!persist || !session?.token) return;
    try {
      const keys = Object.keys(sessionStorage).filter((k) => k.startsWith(storagePrefix));
      if (keys.length >= 4 && !keys.includes(storageKey)) return;
      const data = JSON.stringify({
        saved: Date.now(),
        token: session.token,
        events: queue.slice(0, 200),
      });
      if (new TextEncoder().encode(data).byteLength < 120000)
        sessionStorage.setItem(storageKey, data);
    } catch {
      /* Bounded in-memory fallback. */
    }
  }
  async function send(token, events, exit = false) {
    let body = JSON.stringify({ token, events }),
      headers = { 'Content-Type': 'application/json' };
    if (!exit && body.length > 4096 && typeof CompressionStream !== 'undefined') {
      body = await new Response(
        new Blob([body]).stream().pipeThrough(new CompressionStream('gzip')),
      ).blob();
      headers['Content-Encoding'] = 'gzip';
    }
    const response = await fetch(endpoint, {
      method: 'POST',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      headers,
      body,
      keepalive: exit,
      signal: AbortSignal.timeout(5000),
    });
    const data = await response.json();
    if (!response.ok)
      throw Object.assign(new Error('Analytics upload failed'), {
        status: response.status,
        expected: data.expected_sequence,
      });
    return data;
  }
  async function recover() {
    if (!persist) return;
    let keys;
    try {
      keys = Object.keys(sessionStorage)
        .filter((k) => k.startsWith(storagePrefix) && k !== storageKey)
        .slice(0, 4);
    } catch {
      return;
    }
    for (const key of keys) {
      try {
        const old = JSON.parse(sessionStorage.getItem(key));
        if (!old || Date.now() - old.saved > 3600000) {
          sessionStorage.removeItem(key);
          continue;
        }
        await startAnalytics({ token: old.token });
        while (old.events?.length) {
          await send(old.token, old.events.slice(0, 30));
          old.events.splice(0, 30);
          sessionStorage.setItem(key, JSON.stringify(old));
        }
        sessionStorage.removeItem(key);
      } catch (error) {
        if ([400, 401, 403, 409, 413].includes(error.status)) {
          try {
            sessionStorage.removeItem(key);
          } catch {}
        }
      }
    }
  }
  function schedule() {
    clearTimeout(timer);
    if (!stopped && !paused)
      timer = setTimeout(() => flush(), Math.min(30000, 2000 * 2 ** retries) + Math.random() * 300);
  }
  async function flush(exit = false) {
    if (exit) savePending();
    if (paused && !exit) return;
    if (flight) return flight;
    if (!ready || !queue.length) {
      if (exit) savePending();
      schedule();
      return;
    }
    const batch = [];
    let size = 0;
    for (const event of queue) {
      const bytes = new TextEncoder().encode(JSON.stringify(event)).byteLength;
      if (batch.length === 30 || size + bytes > 30000) break;
      batch.push(event);
      size += bytes;
    }
    if (exit) savePending();
    flight = (async () => {
      try {
        const ack = await send(session.token, batch, exit);
        if (ack.next_sequence < batch.at(-1).sequence + 1)
          throw new Error('Incomplete acknowledgment');
        queue.splice(0, batch.length);
        retries = 0;
        if (persist) savePending();
      } catch (error) {
        retries++;
        if ([400, 401, 403, 409, 413].includes(error.status)) {
          stopped = true;
          partial = true;
          capture.stop();
          savePending();
        } else if (retries >= 6) {
          paused = true;
          savePending();
        }
      } finally {
        flight = null;
        schedule();
      }
    })();
    return flight;
  }
  function emit(type, metadata) {
    if (stopped) return;
    if (queue.length >= 200) {
      partial = true;
      stopped = true;
      capture?.stop();
      savePending();
      return;
    }
    queue.push({
      id: uuid(),
      sequence: sequence++,
      offset_ms: Math.round(performance.now() - started),
      timestamp_ms: Math.round(epoch + performance.now() - started),
      type,
      metadata,
    });
  }
  let capture = semanticCapture(script, {
    emit,
    flush,
    onClose: () => {
      stopped = true;
      clearTimeout(timer);
    },
  });
  const init = async () => {
    try {
      session = await getSession();
      if (!session) throw new Error('Session unavailable');
      storageKey = storageBase + session.session_id;
      await startAnalytics(session);
      recover();
      ready = true;
      retries = 0;
      flush();
    } catch {
      if (++retries < 6 && !stopped) timer = setTimeout(init, Math.min(30000, 1000 * 2 ** retries));
      else {
        partial = true;
        savePending();
      }
    }
  };
  init();
  const online = () => {
    if (!stopped) {
      retries = 0;
      paused = false;
      recover();
      ready ? flush() : init();
    }
  };
  window.addEventListener('online', online);
  return {
    flush,
    confirmForm: (element) => capture.confirmForm(element),
    status: () => ({ partial, paused, pending: queue.length }),
    stop() {
      stopped = true;
      clearTimeout(timer);
      capture.stop();
      window.removeEventListener('online', online);
      savePending();
    },
  };
}
