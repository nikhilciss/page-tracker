// Shared capture/ingestion sanitization. Replay never needs executable page content.
const sensitive =
  /pass(word|code)?|secret|token|csrf|api.?key|authorization|credit|card|cvv|cvc|ssn|social.?security|iban|routing|account.?number|one.?time|otp/i;
const allowed =
  /^(id|class|name|type|value|placeholder|style|width|height|checked|selected|disabled|readonly|multiple|role|aria-label|colspan|rowspan|_cssText|rr_width|rr_height|rr_scrollLeft|rr_scrollTop)$/;
export function sensitiveElement(element) {
  return (
    !!element.closest('[data-recording-mask]') ||
    ['password', 'hidden', 'file'].includes(element.type) ||
    sensitive.test(`${element.name || ''} ${element.id || ''}`) ||
    /^(cc-|one-time-code|current-password|new-password)/i.test(element.autocomplete || '')
  );
}
export function createPageSanitizer() {
  const privateIds = new Set(),
    nodes = new Map();
  function attributes(attrs, masked) {
    const result = {};
    for (const [name, value] of Object.entries(attrs || {})) {
      if (allowed.test(name)) result[name] = name === 'value' && masked ? '[REDACTED]' : value;
      // Embedded raster images can replay offline. Never fetch captured URLs.
      if (
        name === 'src' &&
        typeof value === 'string' &&
        /^data:image\/(png|jpeg|jpg|gif|webp);base64,/i.test(value)
      )
        result.src = value;
    }
    return result;
  }
  function visit(node, inherited = false, depth = 0) {
    if (!node || typeof node !== 'object' || depth > 100 || nodes.size > 50000)
      throw new Error('Invalid page snapshot');
    if (typeof node.tagName === 'string') node.tagName = node.tagName.toLowerCase();
    const a = node.attributes || {};
    const masked =
      inherited ||
      Object.hasOwn(a, 'data-recording-mask') ||
      ['password', 'hidden', 'file'].includes(a.type) ||
      sensitive.test(`${a.name || ''} ${a.id || ''}`) ||
      /^(cc-|one-time-code|current-password|new-password)/i.test(a.autocomplete || '');
    if (masked) privateIds.add(node.id);
    nodes.set(node.id, { masked, attrs: { name: a.name, id: a.id, type: a.type } });
    if (
      ['script', 'noscript', 'iframe', 'object', 'embed', 'base', 'meta'].includes(node.tagName) ||
      Object.hasOwn(a, 'data-recording-ignore')
    ) {
      node.tagName = 'span';
      node.attributes = {};
      node.childNodes = [];
      return node;
    }
    if (node.attributes) node.attributes = attributes(a, masked);
    if (node.textContent && masked) node.textContent = '[REDACTED]';
    if (Array.isArray(node.childNodes))
      node.childNodes.forEach((child) => visit(child, masked, depth + 1));
    return node;
  }
  return (event) => {
    if (event.type === 2) visit(event.data.node);
    if (event.type === 4) {
      const url = new URL(event.data.href || 'https://invalid.local');
      event.data.href = url.origin + url.pathname;
      event.data.width = Math.max(320, Math.min(3840, Number(event.data.width) || 1280));
      event.data.height = Math.max(200, Math.min(2160, Number(event.data.height) || 720));
    }
    if (event.type === 3) {
      const data = event.data;
      if (data.source === 0) {
        for (const added of data.adds || []) visit(added.node, privateIds.has(added.parentId));
        for (const text of data.texts || []) if (privateIds.has(text.id)) text.value = '[REDACTED]';
        for (const item of data.attributes || []) {
          const old = nodes.get(item.id);
          const attrs = { ...old?.attrs, ...item.attributes };
          const masked =
            old?.masked ||
            sensitive.test(`${attrs.name || ''} ${attrs.id || ''}`) ||
            ['password', 'hidden', 'file'].includes(attrs.type);
          if (masked) privateIds.add(item.id);
          nodes.set(item.id, {
            masked,
            attrs: { name: attrs.name, id: attrs.id, type: attrs.type },
          });
          item.attributes = attributes(item.attributes, masked);
        }
      }
      if (data.source === 5 && privateIds.has(data.id)) data.text = '[REDACTED]';
    }
    return event;
  };
}
export function sanitizePageEvents(events) {
  const sanitize = createPageSanitizer();
  return events.map(sanitize);
}
