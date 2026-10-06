// Privacy-first semantic collector: no input values or raw keyboard characters.
export function semanticCapture(script, { emit, flush, onClose }) {
  let route = location.origin + location.pathname,
    routeStarted = performance.now(),
    lastInput = performance.now(),
    sampleAt = performance.now(),
    closed = false,
    visible = document.visibilityState === 'visible';
  let milestones = new Set(),
    maxDepth = 0;
  let formStates = new WeakMap(),
    fieldStates = new WeakMap();
  let forms = 0,
    fields = 0;
  const selector = script.dataset.analyticsRedactSelectors;
  const privateElement = (el) => {
    if (!el) return true;
    try {
      if (selector && el.closest(selector)) return true;
    } catch {
      return true;
    }
    return (
      !!el.closest('[data-recording-mask],[data-recording-ignore]') ||
      /password|hidden|file/i.test(el.type || '') ||
      /pass|secret|token|card|cvv|cvc|otp|email|phone|ssn|auth/i.test(
        (el.id || '') + ' ' + (el.name || '') + ' ' + (el.autocomplete || ''),
      )
    );
  };
  const token = (value) =>
    /^[a-zA-Z][a-zA-Z_-]{0,39}$/.test(value || '') &&
    !/secret|token|email|phone|password/i.test(value)
      ? value
      : undefined;
  const safeUrl = (value) => {
    try {
      const u = new URL(value, location.href);
      return ['http:', 'https:'].includes(u.protocol) ? u.origin + u.pathname : undefined;
    } catch {
      return undefined;
    }
  };
  function form(el) {
    const f = el?.form || el?.closest?.('form');
    if (!f) return null;
    if (!formStates.has(f))
      formStates.set(f, { id: 'form-' + ++forms, started: false, viewed: false });
    return formStates.get(f);
  }
  function context(el) {
    if (!(el instanceof Element)) return {};
    const sensitive = privateElement(el),
      data = { tag: el.tagName.toLowerCase().slice(0, 24), sensitive };
    if (sensitive) return data;
    data.id = token(el.id);
    data.role = token(el.getAttribute('role'));
    data.classes = [...el.classList].map(token).filter(Boolean).slice(0, 4);
    const label = el.closest('[data-analytics-label]')?.getAttribute('data-analytics-label');
    if (label && !/@|\d{4}|https?:|bearer|password|secret|token/i.test(label))
      data.text = label.slice(0, 100);
    const anchor = el.closest('a[href]');
    if (anchor) data.url = safeUrl(anchor.href);
    const f = form(el);
    if (f) data.form = f.id;
    return data;
  }
  function field(el) {
    if (!(el instanceof Element) || !el.matches('input,textarea,select')) return null;
    if (el.closest('[data-recording-ignore]')) return null;
    if (!fieldStates.has(el))
      fieldStates.set(el, { id: 'field-' + ++fields, started: false, pending: false });
    const state = fieldStates.get(el),
      f = form(el);
    return {
      state,
      f,
      metadata: {
        field: state.id,
        field_type: token(el.type) || 'other',
        form: f?.id,
        sensitive: privateElement(el),
      },
    };
  }
  const listeners = [];
  const listen = (target, type, fn, opts) => {
    target.addEventListener(type, fn, opts);
    listeners.push(() => target.removeEventListener(type, fn, opts));
  };
  function engagement() {
    const now = performance.now();
    const ms = visible ? Math.max(0, Math.min(now, lastInput + 15000) - sampleAt) : 0;
    if (ms >= 250)
      emit('engagement', {
        engaged_ms: Math.round(Math.min(15000, ms)),
        depth: maxDepth,
        elapsed_ms: Math.round(now - routeStarted),
      });
    sampleAt = now;
  }
  const touch = () => {
    engagement();
    lastInput = performance.now();
  };
  for (const type of ['pointerdown', 'keydown', 'scroll', 'input'])
    listen(document, type, touch, { passive: true, capture: true });
  listen(
    document,
    'click',
    (e) => {
      const el =
        e.target instanceof Element
          ? e.target.closest('button,a,input,[role=button]') || e.target
          : null;
      if (!el || el.closest('[data-recording-ignore]')) return;
      emit('click', { ...context(el), x: Math.round(e.clientX), y: Math.round(e.clientY) });
      if (el.matches('button[type=submit],input[type=submit],button:not([type])') && form(el))
        emit('form_validation_attempt', { form: form(el).id, action: 'submit_button' });
    },
    true,
  );
  for (const [name, action] of [
    ['focusin', 'focus'],
    ['focusout', 'blur'],
    ['input', 'input_started'],
    ['change', 'input_completed'],
  ])
    listen(
      document,
      name,
      (e) => {
        const info = field(e.target);
        if (!info) return;
        if (info.f && !info.f.started) {
          info.f.started = true;
          emit('form_start', { form: info.f.id });
        }
        let input_method;
        if (name === 'input') {
          input_method =
            e.inputType === 'insertFromPaste'
              ? 'paste'
              : e.inputType === 'insertFromDrop'
                ? 'drop'
                : e.inputType === 'insertReplacementText'
                  ? 'replacement'
                  : /^(insertText|insertCompositionText|delete)/.test(e.inputType || '')
                    ? 'typing'
                    : 'unknown';
          info.state.methods ||= new Set();
          if (info.state.pending && info.state.methods.has(input_method)) return;
          info.state.methods.add(input_method);
          info.state.pending = true;
        }
        if (name === 'change' && e.target.matches('select,input[type=checkbox],input[type=radio]'))
          input_method = 'selection';
        if (name === 'change' || name === 'focusout') info.state.pending = false;
        emit('form_field_interaction', {
          ...info.metadata,
          action,
          ...(input_method ? { input_method } : {}),
        });
      },
      true,
    );
  const invalidAt = new WeakMap();
  listen(
    document,
    'invalid',
    (e) => {
      const info = field(e.target);
      if (!info) return;
      const now = performance.now();
      if (now - (invalidAt.get(e.target) || -10000) < 1000) return;
      invalidAt.set(e.target, now);
      emit('form_validation_attempt', { ...info.metadata, action: 'invalid' });
    },
    true,
  );
  listen(
    document,
    'submit',
    (e) => {
      const f = form(e.target);
      if (f) emit('form_submit', { form: f.id });
      flush();
    },
    true,
  );
  let scrollTimer;
  function scroll() {
    const h = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0);
    const depth = Math.min(100, Math.max(0, ((scrollY + innerHeight) / Math.max(h, 1)) * 100));
    maxDepth = Math.max(maxDepth, depth);
    for (const m of [25, 50, 75, 90, 100])
      if (depth >= m && !milestones.has(m)) {
        milestones.add(m);
        emit('scroll_milestone', { milestone: m, depth: Math.round(depth) });
      }
  }
  listen(
    window,
    'scroll',
    () => {
      if (!scrollTimer)
        scrollTimer = setTimeout(() => {
          scrollTimer = null;
          scroll();
        }, 250);
    },
    { passive: true },
  );
  const observer =
    typeof IntersectionObserver !== 'undefined'
      ? new IntersectionObserver((entries) => {
          for (const entry of entries)
            if (entry.isIntersecting) {
              const f = form(entry.target);
              if (f && !f.viewed) {
                f.viewed = true;
                emit('form_view', { form: f.id });
              }
              observer.unobserve(entry.target);
            }
        })
      : null;
  function scan() {
    for (const f of document.forms) {
      if (f.closest('[data-recording-ignore]')) continue;
      const state = form(f);
      if (!state.viewed) observer?.observe(f);
    }
  }
  scan();
  let mutationTimer;
  const mutations = new MutationObserver(() => {
    if (!mutationTimer)
      mutationTimer = setTimeout(() => {
        mutationTimer = null;
        scan();
      }, 500);
  });
  mutations.observe(document.documentElement, { childList: true, subtree: true });
  function navigate(kind) {
    const next = location.origin + location.pathname;
    const hash = location.hash;
    const key =
      next +
      (script.dataset.analyticsHashRoutes !== 'false' && /^#!?\//.test(hash)
        ? hash.split('?')[0]
        : '');
    if (key === route) return;
    if (kind === 'popstate' && next === route.split('#')[0]) kind = 'hashchange';
    engagement();
    route = key;
    emit('navigation', { navigation: kind, url: safeUrl(location.href) });
    emit('page_view', {
      url: safeUrl(location.href),
      navigation: kind,
      route: /^#!?\/[a-zA-Z_/-]{0,160}$/.test(hash) ? hash : undefined,
    });
    routeStarted = performance.now();
    formStates = new WeakMap();
    fieldStates = new WeakMap();
    milestones = new Set();
    maxDepth = 0;
    scroll();
    scan();
  }
  const originals = {};
  for (const method of ['pushState', 'replaceState']) {
    const original = history[method];
    const wrapper = function (...args) {
      const result = original.apply(this, args);
      try {
        navigate(method);
      } catch {
        /* Never change host navigation behavior. */
      }
      return result;
    };
    originals[method] = { original, wrapper };
    try {
      history[method] = wrapper;
    } catch {
      /* Read-only host history methods remain untouched. */
    }
  }
  listen(window, 'popstate', () => navigate('popstate'));
  listen(window, 'hashchange', () => navigate('hashchange'));
  listen(document, 'visibilitychange', () => {
    engagement();
    sampleAt = performance.now();
    visible = document.visibilityState === 'visible';
    emit('visibility_change', {
      visibility: document.visibilityState === 'visible' ? 'visible' : 'hidden',
    });
    flush(document.visibilityState === 'hidden');
  });
  listen(window, 'pagehide', () => {
    engagement();
    emit('page_exit', { partial: true });
    flush(true);
    stop();
    onClose?.();
  });
  const timer = setInterval(engagement, 5000);
  function stop() {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    clearTimeout(scrollTimer);
    clearTimeout(mutationTimer);
    observer?.disconnect();
    mutations.disconnect();
    listeners.forEach((fn) => fn());
    for (const [method, { original, wrapper }] of Object.entries(originals))
      if (history[method] === wrapper) history[method] = original;
  }
  emit('page_view', { url: safeUrl(location.href), navigation: 'initial' });
  emit('visibility_change', {
    visibility: document.visibilityState === 'visible' ? 'visible' : 'hidden',
  });
  scroll();
  return {
    stop,
    confirmForm(formElement) {
      const f = form(formElement);
      if (f) emit('form_success', { form: f.id, action: 'host_confirmed' });
    },
  };
}
