import { node, details } from './analytics-ui.js';
export function selectTab(name) {
  for (const key of ['details', 'replay', 'events']) {
    const button = document.querySelector('#tab-' + key),
      active = key === name;
    button.setAttribute('aria-selected', String(active));
    button.tabIndex = active ? 0 : -1;
    document.querySelector('#panel-' + key).hidden = !active;
  }
  if (name !== 'replay') document.querySelector('#session-video').pause();
}
export function setupTabs() {
  const buttons = [...document.querySelectorAll('[role=tab]')];
  buttons.forEach((b, i) => {
    b.onclick = () => selectTab(b.id.slice(4));
    b.onkeydown = (e) => {
      if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(e.key)) return;
      e.preventDefault();
      const target =
        e.key === 'Home' ? 0 : e.key === 'End' ? 2 : (i + (e.key === 'ArrowRight' ? 1 : 2)) % 3;
      buttons[target].click();
      buttons[target].focus();
    };
  });
}
export function evidence(groups) {
  const target = document.querySelector('#details');
  target.replaceChildren();
  for (const [title, values] of Object.entries(groups)) {
    const section = node('section'),
      list = node('dl');
    section.append(node('h3', title), list);
    details(list, values);
    target.append(section);
  }
}
export function locationLabel(c) {
  if (!c) return 'Not captured';
  if (c.geo_status === 'private') return 'Local/private network — location unavailable';
  if (c.geo_status !== 'approximate') return 'Unavailable';
  let country = c.country;
  try {
    country = new Intl.DisplayNames(['en'], { type: 'region' }).of(c.country);
  } catch {}
  return [c.city, c.region, country].filter(Boolean).join(', ') + ' (approximate)';
}
export function browserInfo(ua = '') {
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Firefox\//.test(ua)
      ? 'Firefox'
      : /(Chrome|CriOS)\//.test(ua)
        ? 'Chrome'
        : /Safari\//.test(ua)
          ? 'Safari'
          : 'Unknown';
  const version = (ua.match(/(?:Edg|Firefox|Chrome|CriOS|Version)\/([\d.]+)/g) || [])
    .at(-1)
    ?.split('/')[1];
  return {
    browser: browser + (version ? ' ' + version : ''),
    os: /Android/.test(ua)
      ? 'Android'
      : /iPhone|iPad/.test(ua)
        ? 'iOS'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Mac OS/.test(ua)
            ? 'macOS'
            : /Linux/.test(ua)
              ? 'Linux'
              : 'Unknown',
    device: /iPad|Tablet/.test(ua)
      ? 'Tablet'
      : /Mobile|iPhone|Android/.test(ua)
        ? 'Mobile'
        : ua
          ? 'Desktop'
          : 'Unknown',
  };
}
export function who(context, fallback = {}, visitorId = null) {
  const c = context || {},
    tech = browserInfo(c.user_agent || fallback.browser || ''),
    identity =
      context &&
      ['user_name', 'user_id', 'identity_updated_at'].some((key) => Object.hasOwn(context, key))
        ? context
        : fallback;
  return {
    'Visitor display name': identity.user_name || 'Anonymous visitor',
    'Anonymous visitor ID': visitorId || 'Not captured for this recording',
    'Host account ID': identity.user_id || 'Unavailable without host integration',
    'Identity source':
      identity.user_name || identity.user_id
        ? 'Host-provided (not independently verified)'
        : 'Anonymous browser identity (not a logged-in account)',
    'Authentication status': 'Host login not verified by CIS SessionLens',
    'Remote IP address': c.ip || 'Not captured',
    'Geographic location': locationLabel(context),
    Browser: tech.browser,
    'Operating system': tech.os,
    Device: tech.device,
    'Browser timezone': c.timezone || 'Not captured',
    Language: c.language || 'Not captured',
    Viewport:
      c.viewport_width && c.viewport_height
        ? `${c.viewport_width} × ${c.viewport_height}`
        : 'Not captured',
    'Browser / user agent': c.user_agent || fallback.browser || 'Not captured',
  };
}
