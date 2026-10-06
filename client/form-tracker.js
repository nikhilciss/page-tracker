import { readVisitorIdentity, identityPayload } from './visitor-identity.js';
import { startPageCapture } from './page-capture.js';
/* Universal Tracker v2. Bundled page recorder; no cookies, persistent browser storage, or unload uploads. */
export function startFormTracker(script) {
  'use strict';
  const marker = Symbol.for('universal-tracker.loaded');
  if (!script || window[marker]) return;
  window[marker] = true;
  const endpoint = new URL('./api/track/', script.src);
  const selector = 'form[data-recording-enabled="true"]';
  const sensitive =
    /pass(word|code)?|secret|token|csrf|api.?key|authorization|credit|card|cvv|cvc|ssn|social.?security|iban|routing|account.?number|one.?time|otp/i;
  const encoder = new TextEncoder(),
    decoder = new TextDecoder();
  const nativeRequestSubmit = HTMLFormElement.prototype.requestSubmit;
  const states = new Map(),
    keys = new WeakMap(),
    bypass = new WeakSet();
  let sequence = 0,
    formSequence = 0,
    generation = 0,
    started = performance.now(),
    active = true;
  let sessionPromise,
    keyPromise,
    observer,
    snapshotTimer,
    pageCapture,
    lastMove = 0,
    lastScroll = 0;
  const clip = (value, limit = 160) => String(value || '').slice(0, limit);
  const time = () => Math.min(86400000, Math.round(performance.now() - started));
  const ignored = (element) => !!element.closest('[data-recording-ignore]');
  const eligible = (form) => form.isConnected && form.matches(selector) && !ignored(form);
  const fieldKey = (element) => {
    if (!keys.has(element)) keys.set(element, `field-${++sequence}`);
    return keys.get(element);
  };
  function field(element) {
    const type = (element.type || element.tagName).toLowerCase();
    const name = clip(element.name || element.id);
    const masked =
      !!element.closest('[data-recording-mask]') ||
      ['password', 'hidden', 'file'].includes(type) ||
      sensitive.test(`${element.name} ${element.id}`) ||
      /^(cc-|one-time-code|current-password|new-password)/i.test(element.autocomplete || '');
    let value = '[REDACTED]';
    if (!masked) {
      if (type === 'checkbox' || type === 'radio')
        value = element.checked ? clip(element.value, 2000) : false;
      else if (element.tagName === 'SELECT' && element.multiple)
        value = [...element.selectedOptions]
          .slice(0, 100)
          .map((option) => clip(option.value, 2000));
      else value = clip(element.value, 2000);
    }
    return { key: fieldKey(element), name, type, value, masked };
  }
  function controls(form) {
    return [...form.elements].filter(
      (element) => element.matches('input, select, textarea, button') && !ignored(element),
    );
  }
  function rectangle(element) {
    const r = element.getBoundingClientRect();
    const bound = (n) => Math.round(Math.max(-100000, Math.min(100000, n)));
    return {
      x: bound(r.x + scrollX),
      y: bound(r.y + scrollY),
      width: Math.max(0, bound(r.width)),
      height: Math.max(0, bound(r.height)),
    };
  }
  function captureSnapshot(state) {
    const elements = controls(state.form);
    if (elements.length > 100) state.truncated = true;
    add(state, {
      type: 'snapshot',
      rect: rectangle(state.form),
      controls: elements.slice(0, 100).map((element) => ({
        ...field(element),
        rect: rectangle(element),
        label: clip(
          element.labels?.[0]?.textContent ||
            element.getAttribute('aria-label') ||
            element.name ||
            element.id ||
            element.type,
        ),
      })),
    });
  }
  function add(state, data) {
    if (!active || state.busy || state.completed || !eligible(state.form)) return;
    const event = { ...data, t: time() };
    const encoded = encoder.encode(JSON.stringify(event));
    if (
      state.entries.length >= 2000 ||
      state.bytes + encoded.length > 700000 ||
      state.pending >= 24
    ) {
      state.truncated = true;
      return;
    }
    state.bytes += encoded.length;
    const thisKey = keyPromise;
    if (window.crypto?.subtle && thisKey) {
      state.pending++;
      const encrypted = thisKey
        .then(async (key) => {
          if (!key) return { raw: event };
          const iv = crypto.getRandomValues(new Uint8Array(12));
          const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);
          return { iv, data };
        })
        .catch(() => {
          state.failed = true;
          return null;
        })
        .finally(() => {
          encoded.fill(0);
          state.pending--;
        });
      state.entries.push(encrypted);
    } else {
      state.entries.push(Promise.resolve({ raw: event }));
    }
  }
  async function request(path, body, signal) {
    const response = await fetch(new URL(path, endpoint), {
      method: 'POST',
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) throw new Error('Tracking request failed');
    return response.json();
  }
  function initialize() {
    if (!sessionPromise) {
      const version = generation;
      sessionPromise = request(
        'init',
        {
          page_url: location.origin + location.pathname,
          ...identityPayload(readVisitorIdentity(script)),
        },
        AbortSignal.timeout(3000),
      ).catch(() => {
        if (generation === version) sessionPromise = null;
        return null;
      });
    }
    return sessionPromise;
  }
  let identityTimer;
  window.addEventListener(
    'page-tracker:identity-change',
    () => {
      clearTimeout(identityTimer);
      identityTimer = setTimeout(async () => {
        if (!active) return;
        try {
          const session = await initialize();
          if (session)
            await request(
              'page/identity',
              {
                token: session.token,
                ...identityPayload(readVisitorIdentity(script)),
              },
              AbortSignal.timeout(3000),
            );
        } catch {
          /* Host identity reporting must not interrupt the application. */
        }
      }, 250);
    },
    true,
  );
  function scan() {
    if (!active) return;
    for (const [form, state] of states) {
      if (!eligible(form)) {
        state.entries = [];
        states.delete(form);
      }
    }
    for (const form of document.querySelectorAll(selector)) {
      if (states.size >= 10) break;
      if (states.has(form) || ignored(form)) continue;
      const state = {
        form,
        formKey: `form-${++formSequence}`,
        entries: [],
        bytes: 0,
        pending: 0,
        truncated: false,
        busy: false,
        completed: false,
        failed: false,
      };
      states.set(form, state);
      initialize();
      if (!pageCapture) pageCapture = startPageCapture(keyPromise);
      captureSnapshot(state);
    }
  }
  function each(data) {
    for (const state of states.values()) add(state, data);
  }
  function snapshotSoon() {
    if (snapshotTimer || !active) return;
    snapshotTimer = setTimeout(() => {
      snapshotTimer = null;
      scan();
      for (const state of states.values()) captureSnapshot(state);
    }, 350);
  }
  function begin() {
    active = true;
    started = performance.now();
    keyPromise = window.crypto?.subtle?.generateKey
      ? crypto.subtle
          .generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
          .catch(() => null)
      : Promise.resolve(null);
    scan();
    observer = new MutationObserver(snapshotSoon);
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: [
        'data-recording-enabled',
        'data-recording-ignore',
        'data-recording-mask',
        'type',
        'name',
        'class',
        'style',
        'hidden',
        'disabled',
      ],
    });
  }
  document.addEventListener(
    'input',
    (event) => {
      const element = event.target;
      const state = states.get(element.form);
      if (state && !ignored(element)) add(state, { type: 'input', field: field(element) });
    },
    true,
  );
  document.addEventListener(
    'change',
    (event) => {
      const element = event.target;
      const state = states.get(element.form);
      if (state && !ignored(element)) add(state, { type: 'input', field: field(element) });
    },
    true,
  );
  document.addEventListener(
    'pointermove',
    (event) => {
      if (performance.now() - lastMove < 120) return;
      lastMove = performance.now();
      each({ type: 'move', x: Math.round(event.pageX), y: Math.round(event.pageY) });
    },
    { passive: true },
  );
  document.addEventListener(
    'click',
    (event) => {
      if (!ignored(event.target))
        each({ type: 'click', x: Math.round(event.pageX), y: Math.round(event.pageY) });
    },
    { passive: true },
  );
  window.addEventListener(
    'scroll',
    () => {
      if (performance.now() - lastScroll < 120) return;
      lastScroll = performance.now();
      each({ type: 'scroll', x: Math.round(scrollX), y: Math.round(scrollY) });
    },
    { passive: true },
  );
  window.addEventListener(
    'resize',
    () => {
      each({ type: 'resize', width: innerWidth, height: innerHeight });
      snapshotSoon();
    },
    { passive: true },
  );
  document.addEventListener(
    'submit',
    async (event) => {
      const form = event.target;
      if (!(form instanceof HTMLFormElement) || bypass.has(form) || !eligible(form)) return;
      scan();
      const state = states.get(form);
      if (!state || state.completed) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (state.busy) return;
      captureSnapshot(state);
      state.busy = true;
      const version = generation,
        submitter = event.submitter,
        submittedAt = time(),
        thisKey = keyPromise;
      const pageSnapshot = pageCapture?.snapshot().catch(() => undefined);
      const fields = controls(form).slice(0, 100).map(field);
      const metadata = {
        form_key: state.formKey,
        form_id: clip(form.id),
        ...identityPayload(readVisitorIdentity(script, form)),
      };
      const controller = new AbortController();
      let timer,
        status = 'error',
        recordingId;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error('Timeout'));
        }, 3500);
      });
      try {
        const result = await Promise.race([
          timeout,
          (async () => {
            const session = await initialize();
            if (!session || state.failed || generation !== version || !active)
              throw new Error('Unavailable');
            const key = thisKey ? await thisKey : null;
            const events = await Promise.all(
              state.entries.map(async (promise) => {
                const entry = await promise;
                if (!entry) throw new Error('Encryption failed');
                if (entry.raw) return entry.raw;
                return JSON.parse(
                  decoder.decode(
                    await crypto.subtle.decrypt({ name: 'AES-GCM', iv: entry.iv }, key, entry.data),
                  ),
                );
              }),
            );
            const page = await pageSnapshot;
            events.push({ type: 'submit', t: submittedAt });
            if (generation !== version || !active || controller.signal.aborted)
              throw new Error('Page exited');
            return request(
              'submit',
              {
                token: session.token,
                ...metadata,
                duration_ms: submittedAt,
                truncated: state.truncated,
                fields,
                events,
                ...(page ? { page } : {}),
              },
              controller.signal,
            );
          })(),
        ]);
        status = 'saved';
        recordingId = result.recording_id;
        state.completed = true;
        state.entries = [];
      } catch {
        /* Host form must remain usable when the recorder is unavailable. */
      } finally {
        clearTimeout(timer);
        state.busy = false;
      }
      if (generation !== version || !active || !form.isConnected) return;
      form.dispatchEvent(
        new CustomEvent('recording:complete', { bubbles: true, detail: { status, recordingId } }),
      );
      if (status !== 'saved' && form.dataset.recordingFailClosed === 'true') return;
      bypass.add(form);
      try {
        nativeRequestSubmit.call(form, submitter?.form === form ? submitter : undefined);
      } finally {
        bypass.delete(form);
      }
    },
    true,
  );
  window.addEventListener('pagehide', () => {
    active = false;
    generation++;
    observer?.disconnect();
    pageCapture?.stop();
    pageCapture = null;
    clearTimeout(snapshotTimer);
    snapshotTimer = null;
    for (const state of states.values()) state.entries = [];
    states.clear();
    sessionPromise = null;
    keyPromise = null;
  });
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) begin();
  });
  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', begin, { once: true });
  else begin();
}
