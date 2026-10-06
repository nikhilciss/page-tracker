import { readVisitorIdentity, identityPayload } from './visitor-identity.js';
import { recordingJourney } from './recording-journey.js';
import { startSemantic } from './semantic-transport.js';
import { analyticsIdentity } from './analytics-identity.js';
import { startPageCapture } from './page-capture.js';
import { sensitiveElement } from '../shared/page-events.js';

export function startPageTracker(script) {
  const endpoint = new URL('./api/track/', script.src);
  const journey = recordingJourney(endpoint);
  const originalPage = () => location.origin + location.pathname;
  const keys = new WeakMap(),
    imageClicks = new WeakMap();
  let redactionSelector = script.dataset.analyticsRedactSelectors || '';
  try {
    if (redactionSelector) document.querySelector(redactionSelector);
  } catch {
    redactionSelector = 'input,textarea,select';
  }
  let fieldNumber = 0,
    epoch = 0,
    current;
  const clip = (value, length = 160) => String(value || '').slice(0, length);
  function fields() {
    return [...document.querySelectorAll('input,select,textarea')]
      .filter((element) => !element.closest('[data-recording-ignore]'))
      .slice(0, 100)
      .map((element) => {
        if (!keys.has(element)) keys.set(element, 'field-' + ++fieldNumber);
        const masked =
          sensitiveElement(element) || !!(redactionSelector && element.closest(redactionSelector));
        let value = masked ? '[REDACTED]' : clip(element.value, 2000);
        if (!masked && ['checkbox', 'radio'].includes(element.type))
          value = element.checked ? value : false;
        if (!masked && element.tagName === 'SELECT' && element.multiple)
          value = [...element.selectedOptions]
            .slice(0, 100)
            .map((option) => clip(option.value, 2000));
        return {
          key: keys.get(element),
          name: clip(element.name || element.id),
          type: clip(element.type || element.tagName.toLowerCase(), 40),
          masked,
          value,
        };
      });
  }
  async function post(route, data, signal, keepalive = false) {
    const response = await fetch(new URL(route, endpoint), {
      method: 'POST',
      keepalive,
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
      signal,
    });
    const result = await response.json();
    if (!response.ok) {
      const error = new Error('Recording request failed');
      error.expectedOffset = result.expected_offset;
      throw error;
    }
    return result;
  }
  const startAnalytics = analyticsIdentity(script, post);
  function initialize(state) {
    if (!state.sessionPromise) {
      state.sessionPromise = post(
        'init',
        {
          page_url: state.url,
          ...identityPayload(readVisitorIdentity(script)),
          language: clip(navigator.language, 40),
          timezone: clip(Intl.DateTimeFormat().resolvedOptions().timeZone, 80),
          referrer: (() => {
            try {
              return new URL(document.referrer).origin;
            } catch {
              return '';
            }
          })(),
          viewport_width: Math.min(innerWidth, 20000),
          viewport_height: Math.min(innerHeight, 20000),
        },
        AbortSignal.timeout(3000),
      )
        .then((session) => {
          state.session = session;
          journey.configure(session.recording_policy);
          state.successArmed = journey.resumed || !journey.matches(false);
          return session;
        })
        .catch(() => {
          state.sessionPromise = null;
          return null;
        });
    }
    return state.sessionPromise;
  }
  async function checkpoint(state = current, signal) {
    if (!state || state.closed || state.saved) return;
    if (state.upload) return state.upload;
    state.lastUpload = performance.now();
    state.upload = (async () => {
      const session = await initialize(state);
      if (!session || state.closed) throw new Error('Session unavailable');
      const snapshot = await state.capture.snapshot(state.offset);
      if (!snapshot || state.closed) throw new Error('Page not ready');
      try {
        const payload = {
          token: session.token,
          offset: state.offset,
          events: snapshot.events,
          duration_ms: snapshot.duration_ms,
          truncated: snapshot.truncated,
          page_title: clip(document.title, 300),
          ...identityPayload(readVisitorIdentity(script)),
          fields: fields(),
        };
        const keepalive = new Blob([JSON.stringify(payload)]).size <= 48000;
        state.exitOffset = keepalive ? state.offset + snapshot.events.length : state.offset;
        const result = await post(
          'page/checkpoint',
          payload,
          signal || AbortSignal.timeout(5000),
          keepalive,
        );
        state.offset = result.next_offset;
        journey.remember(session, state.offset);
        if (result.recording_id) {
          state.saved = { status: 'saved', recordingId: result.recording_id };
          journey.clear();
        }
        return result;
      } catch (error) {
        if (Number.isInteger(error.expectedOffset)) state.offset = error.expectedOffset;
        throw error;
      }
    })().finally(() => {
      state.upload = null;
      state.exitOffset = state.offset;
    });
    return state.upload;
  }
  function notify(detail) {
    document.dispatchEvent(new CustomEvent('recording:complete', { bubbles: true, detail }));
  }
  async function save(reason = 'manual') {
    const state = current;
    if (!state || state.closed) return { status: 'error' };
    if (state.saved) return state.saved;
    await initialize(state);
    if (reason === 'form') journey.attempt();
    if (journey.enabled && reason !== 'success') {
      try {
        await state.upload;
        await checkpoint(state, AbortSignal.timeout(3000));
        return { status: 'checkpointed' };
      } catch {
        return { status: 'error' };
      }
    }
    if (state.saving) return state.saving;
    state.saving = (async () => {
      const controller = new AbortController();
      let timer;
      try {
        const timeout = new Promise((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error('Save timed out'));
          }, 3500);
        });
        const result = await Promise.race([
          timeout,
          (async () => {
            // Finish an earlier upload, then capture any events produced while it was pending.
            await state.upload;
            await checkpoint(state, controller.signal);
            if (controller.signal.aborted || state.closed) throw new Error('Page exited');
            return post(
              'page/finish',
              {
                token: state.session.token,
                reason,
                expected_count: state.offset,
                ...(journey.enabled ? { previous: journey.previous(state.session) } : {}),
              },
              controller.signal,
            );
          })(),
        ]);
        if (!result.recording_id) throw new Error('Checkpoint incomplete');
        state.saved = { status: 'saved', recordingId: result.recording_id };
        journey.clear();
        state.capture.stop();
        clearTimeout(state.timer);
        notify(state.saved);
        return state.saved;
      } catch {
        const detail = { status: 'error' };
        notify(detail);
        return detail;
      } finally {
        clearTimeout(timer);
        state.saving = null;
      }
    })();
    return state.saving;
  }
  function finishOnExit(state) {
    if (journey.enabled || !state?.session || state.saved) return;
    // Keep this well below the browser's 64 KiB keepalive budget. The video is already checkpointed.
    fetch(new URL('page/finish', endpoint), {
      method: 'POST',
      credentials: 'omit',
      keepalive: true,
      referrerPolicy: 'no-referrer',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify({
        token: state.session.token,
        reason: 'pagehide',
        expected_count: Math.max(state.offset, state.exitOffset || 0),
      }),
    }).catch(() => {});
  }
  async function tick(state) {
    if (state.closed || state.saved) return;
    try {
      await checkpoint(state);
    } catch {
      /* Retried while this page remains alive. */
    }
    if (!journey.matches(false)) state.successArmed = true;
    if (state.successArmed && journey.matches() && !state.closed && !state.saved)
      await save('success');
    if (!state.closed && !state.saved) state.timer = setTimeout(() => tick(state), 2000);
  }
  function begin() {
    const key = window.crypto?.subtle?.generateKey
      ? crypto.subtle
          .generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
          .catch(() => null)
      : Promise.resolve(null);
    const state = { epoch: ++epoch, url: originalPage(), offset: 0, closed: false, saved: null };
    state.startedAt = performance.now();
    current = state;
    state.capture = startPageCapture(key, redactionSelector);
    initialize(state);
    try {
      state.analytics = startSemantic(
        script,
        () => initialize(state),
        startAnalytics,
        state.startedAt,
      );
    } catch {
      /* Analytics never interrupts the recording lifecycle. */
    }
    tick(state);
  }
  let identityTimer;
  window.addEventListener(
    'page-tracker:identity-change',
    () => {
      clearTimeout(identityTimer);
      identityTimer = setTimeout(async () => {
        const state = current;
        if (!state || state.closed) return;
        try {
          if (state.saved) {
            const session = await initialize(state);
            if (session)
              await post(
                'page/identity',
                {
                  token: session.token,
                  ...identityPayload(readVisitorIdentity(script)),
                },
                AbortSignal.timeout(3000),
              );
          } else {
            await state.upload;
            await checkpoint(state);
          }
        } catch {
          /* Periodic retry remains active. */
        }
      }, 250);
    },
    true,
  );
  document.addEventListener('submit', () => journey.attempt(), true);
  // Native handlers run first. Cancelled AJAX submissions stay part of the current page session.
  window.addEventListener('submit', async (event) => {
    const form = event.target;
    if (
      !(form instanceof HTMLFormElement) ||
      event.defaultPrevented ||
      form.method === 'dialog' ||
      !current ||
      current.closed
    )
      return;
    const target =
      event.submitter?.getAttribute('formtarget') ??
      form.getAttribute('target') ??
      document.querySelector('base[target]')?.getAttribute('target') ??
      '_self';
    if (target && target !== '_self') return;
    event.preventDefault();
    const state = current,
      submitter = event.submitter;
    const result = await save('form');
    if (current !== state || state.closed || !form.isConnected) return;
    if (
      !['saved', 'checkpointed'].includes(result.status) &&
      (script.dataset.recordingFailClosed === 'true' || form.dataset.recordingFailClosed === 'true')
    )
      return;
    // Submit once without re-running host event handlers; retain clicked-button overrides and value.
    const originals = new Map(),
      hidden = [];
    try {
      if (submitter?.form === form) {
        for (const name of ['action', 'method', 'enctype', 'target']) {
          if (submitter.hasAttribute('form' + name)) {
            originals.set(name, form.getAttribute(name));
            form.setAttribute(name, submitter.getAttribute('form' + name));
          }
        }
        if ((submitter.name || submitter.type === 'image') && !submitter.disabled) {
          const add = (name, value) => {
            const input = document.createElement('input');
            input.type = 'hidden';
            input.name = name;
            input.value = value;
            form.append(input);
            hidden.push(input);
          };
          if (submitter.type === 'image') {
            const point = imageClicks.get(submitter) || { x: 0, y: 0 };
            add((submitter.name ? submitter.name + '.' : '') + 'x', String(point.x));
            add((submitter.name ? submitter.name + '.' : '') + 'y', String(point.y));
          } else add(submitter.name, submitter.value);
        }
      }
      HTMLFormElement.prototype.submit.call(form);
    } finally {
      hidden.forEach((input) => input.remove());
      for (const [name, value] of originals)
        value === null ? form.removeAttribute(name) : form.setAttribute(name, value);
    }
  });
  window.addEventListener('click', async (event) => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    const link =
      event.target instanceof Element ? event.target.closest('a[href],area[href]') : null;
    if (!link || link.hasAttribute('download')) return;
    const target =
      link.getAttribute('target') ??
      document.querySelector('base[target]')?.getAttribute('target') ??
      '_self';
    if (target && target !== '_self') return;
    const url = new URL(link.href, location.href);
    if (!['http:', 'https:'].includes(url.protocol)) return;
    if (
      url.origin === location.origin &&
      url.pathname === location.pathname &&
      url.search === location.search &&
      link.getAttribute('href').includes('#')
    )
      return;
    const state = current;
    if (!state || state.closed) return;
    event.preventDefault();
    const result = await save('link');
    if (state !== current || state.closed) return;
    if (
      !['saved', 'checkpointed'].includes(result.status) &&
      script.dataset.recordingFailClosed === 'true'
    )
      return;
    location.assign(url.href);
  });
  // Limit implicit save intent to the current button event task, not a later browser refresh.
  document.addEventListener(
    'click',
    (event) => {
      if (event.target instanceof HTMLInputElement && event.target.type === 'image')
        imageClicks.set(event.target, {
          x: Math.max(0, Math.floor(event.offsetX)),
          y: Math.max(0, Math.floor(event.offsetY)),
        });
      if (
        event.target instanceof Element &&
        event.target.closest(
          'button,[role="button"],input[type="button"],input[type="submit"],input[type="image"]',
        )
      ) {
        const state = current;
        if (!state || state.closed) return;
        state.actionIntent = true;
        clearTimeout(state.actionTimer);
        state.actionTimer = setTimeout(() => {
          state.actionIntent = false;
        }, 0);
        checkpoint().catch(() => {});
      }
    },
    true,
  );
  for (const type of ['input', 'change'])
    document.addEventListener(
      type,
      () => {
        const state = current;
        if (!state || state.closed || state.saved) return;
        clearTimeout(state.poke);
        state.poke = setTimeout(
          async () => {
            try {
              await state.upload;
              await checkpoint(state);
            } catch {
              /* Periodic checkpoint retries. */
            }
          },
          Math.max(150, 1000 - (performance.now() - (state.lastUpload || 0))),
        );
      },
      { passive: true },
    );
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') checkpoint().catch(() => {});
  });
  // Observe only: never cancel unloading or display a confirmation prompt.
  // Direct location.reload/assign calls dispatch beforeunload during the action handler.
  window.addEventListener('beforeunload', () => {
    if (current) current.actionExit = current.actionIntent === true;
  });
  window.addEventListener('pagehide', () => {
    const state = current;
    if (state?.actionExit) finishOnExit(state);
    if (state) {
      state.closed = true;
      clearTimeout(state.timer);
      clearTimeout(state.poke);
      clearTimeout(state.actionTimer);
      state.capture.stop();
    }
  });
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) begin();
  });
  window.UniversalTracker = Object.freeze({
    save: () => save('manual'),
    confirmFormSuccess: (form) => {
      current?.analytics?.confirmForm(form);
      return journey.enabled ? save('success') : undefined;
    },
    analyticsFlush: () => current?.analytics?.flush(),
    analyticsStatus: () => current?.analytics?.status(),
    checkpoint: () =>
      checkpoint()
        .then(() => ({ status: 'checkpointed' }))
        .catch(() => ({ status: 'error' })),
    async navigate(url) {
      const destination = new URL(url, location.href);
      if (!['http:', 'https:'].includes(destination.protocol))
        throw new Error('Unsupported navigation');
      const result = await save('link');
      if (
        ['saved', 'checkpointed'].includes(result.status) ||
        script.dataset.recordingFailClosed !== 'true'
      )
        location.assign(destination.href);
      return result;
    },
    async reload() {
      const result = await save('reload');
      if (
        ['saved', 'checkpointed'].includes(result.status) ||
        script.dataset.recordingFailClosed !== 'true'
      )
        location.reload();
      return result;
    },
  });
  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', begin, { once: true });
  else begin();
}
