import { startPageTracker } from './page-tracker.js';
import { startFormTracker } from './form-tracker.js';

// MVC views may execute the widget from the body, a module, or a partial loader.
// Some loaders evaluate downloaded code inline, so currentScript has no source URL.
function trackerScript() {
  const current = document.currentScript;
  if (current?.src) return current;
  const candidates = [...document.querySelectorAll('script[src]')].filter((element) => {
    try {
      const url = new URL(element.src, document.baseURI);
      return (
        ['http:', 'https:'].includes(url.protocol) &&
        (element.hasAttribute('data-universal-tracker') || /\/tracker\.js$/.test(url.pathname))
      );
    } catch {
      return false;
    }
  });
  // An explicit marker also supports renamed widget URLs.
  return (
    candidates.find((element) => element.hasAttribute('data-universal-tracker')) ||
    candidates.at(-1)
  );
}
const marker = Symbol.for('universal-tracker.loaded');
const script = trackerScript();
if (script && !window[marker]) {
  if (script.dataset.recordingMode === 'form') startFormTracker(script);
  else {
    window[marker] = true;
    startPageTracker(script);
  }
}
