import { normalizeVisitorIdentity } from '../shared/visitor-identity.js';
const secretField =
  /pass(word|code)?|secret|token|csrf|api.?key|authorization|credit|card|cvv|cvc|ssn|social.?security|iban|routing|account.?number|one.?time|otp/i;
export function readVisitorIdentity(script, form) {
  try {
    // Presence is authoritative, including null on logout. Never mix two sources.
    if (Object.hasOwn(window, 'pageTrackerData'))
      return normalizeVisitorIdentity(window.pageTrackerData);
    const hidden = document.querySelectorAll(
      'input[type="hidden"][data-page-tracker-user-id],input[type="hidden"][data-page-tracker-user-name]',
    );
    if (hidden.length) {
      const value = {};
      for (const el of hidden) {
        if (
          el.closest('[data-recording-ignore],[data-recording-mask]') ||
          secretField.test(el.name + ' ' + el.id)
        )
          continue;
        const key = el.hasAttribute('data-page-tracker-user-id') ? 'id' : 'name';
        if (Object.hasOwn(value, key)) return { id: null, name: null }; // Ambiguous host markup.
        value[key] = el.value;
      }
      return normalizeVisitorIdentity(value);
    }
    for (const el of [form, script, document.documentElement, document.body]) {
      if (el?.hasAttribute('data-user-id') || el?.hasAttribute('data-user-name'))
        return normalizeVisitorIdentity({ id: el.dataset.userId, name: el.dataset.userName });
    }
  } catch {
    /* A host object/getter must not break the page or tracking. */
  }
  return { id: null, name: null };
}
export function identityPayload(identity) {
  return { user_id: identity.id, user_name: identity.name };
}
