import { record } from 'rrweb';
import { createPageSanitizer, sensitiveElement } from '../shared/page-events.js';

// Encrypted page event buffer; page mode uploads incremental checkpoints.
export function startPageCapture(keyPromise, redactionSelector = '') {
  const sanitize = createPageSanitizer(),
    encoder = new TextEncoder(),
    decoder = new TextDecoder();
  const entries = [];
  let bytes = 0,
    pending = 0,
    truncated = false,
    stopped = false,
    stopRecording;
  const startedAt = Date.now();
  function emit(event) {
    if (stopped || truncated) return;
    try {
      const sanitized = sanitize(event);
      const encoded = encoder.encode(JSON.stringify(sanitized));
      if (entries.length >= 15000 || bytes + encoded.length > 6 * 1024 * 1024 || pending >= 64) {
        truncated = true;
        // Stop the timeline at the first omitted event; later mutations may depend on it.
        queueMicrotask(() => stopRecording?.());
        return;
      }
      bytes += encoded.length;
      if (window.crypto?.subtle && keyPromise) {
        pending++;
        entries.push(
          keyPromise
            .then(async (key) => {
              if (!key) return { raw: sanitized };
              const iv = crypto.getRandomValues(new Uint8Array(12));
              return {
                iv,
                data: await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded),
              };
            })
            .catch(() => {
              truncated = true;
              return null;
            })
            .finally(() => {
              encoded.fill(0);
              pending--;
            }),
        );
      } else {
        entries.push(Promise.resolve({ raw: sanitized }));
      }
    } catch {
      truncated = true;
    }
  }
  try {
    stopRecording = record({
      emit,
      recordAfter: 'DOMContentLoaded',
      inlineStylesheet: true,
      inlineImages: false,
      recordCanvas: false,
      collectFonts: false,
      recordCrossOriginIframes: false,
      slimDOMOptions: 'all',
      blockSelector: '[data-recording-ignore], iframe, object, embed',
      maskTextSelector:
        '[data-recording-mask]' + (redactionSelector ? ',' + redactionSelector : ''),
      maskAllInputs: true,
      maskInputFn: (value, element) =>
        sensitiveElement(element) || (redactionSelector && element.closest(redactionSelector))
          ? '[REDACTED]'
          : value,
      sampling: { mousemove: 100, mousemoveCallback: 100, scroll: 100, input: 'all' },
      errorHandler: () => true,
    });
  } catch {
    truncated = true;
  }
  return {
    async snapshot(from = 0) {
      // Freeze the prefix now: encryption/network waits must not capture post-submit actions.
      const prefix = entries.slice(from),
        endedAt = Date.now(),
        wasTruncated = truncated;
      const key = keyPromise ? await keyPromise : null;
      const events = [];
      for (const promise of prefix) {
        const entry = await promise;
        if (!entry) break;
        if (entry.raw) {
          events.push(entry.raw);
        } else if (key && entry.iv && entry.data) {
          events.push(
            JSON.parse(
              decoder.decode(
                await crypto.subtle.decrypt({ name: 'AES-GCM', iv: entry.iv }, key, entry.data),
              ),
            ),
          );
        }
      }
      if (from === 0 && !events.some((event) => event.type === 2)) return undefined;
      return {
        format: 'rrweb',
        events,
        duration_ms: Math.max(0, endedAt - startedAt),
        truncated: wasTruncated,
      };
    },
    stop() {
      stopped = true;
      stopRecording?.();
      entries.length = 0;
    },
  };
}
