import { duration } from './account-api.js';
export const $ = (s) => document.querySelector(s);
export const number = (n) => Number(n || 0).toLocaleString();
export function node(tag, text, className) {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (className) e.className = className;
  return e;
}
export function metric(label, value, note) {
  const e = node('div', undefined, 'metric');
  e.append(node('span', label), node('strong', value), node('small', note));
  return e;
}
export function bars(target, rows, format = number) {
  target.replaceChildren();
  if (!rows.length) {
    target.append(node('p', 'No data in this selection.', 'muted'));
    return;
  }
  const max = Math.max(...rows.map((r) => Number(r.value)), 1);
  for (const r of rows) {
    const line = node('div', undefined, 'bar-row'),
      head = node('div', undefined, 'bar-label'),
      track = node('div', undefined, 'bar-track'),
      fill = node('div', undefined, 'bar-fill');
    head.append(node('span', r.label), node('strong', format(r.value)));
    fill.style.width = (Number(r.value) / max) * 100 + '%';
    track.append(fill);
    line.append(head, track);
    target.append(line);
  }
}
export function chart(target, rows, key, label, format = number) {
  target.replaceChildren();
  if (!rows.length) {
    target.append(node('p', 'No activity in this selection.', 'muted'));
    return;
  }
  const max = Math.max(...rows.map((r) => Number(r[key])), 1),
    wrap = node('div', undefined, 'trend-bars');
  if (rows.length > 90) wrap.style.gap = '0';
  wrap.setAttribute('role', 'img');
  wrap.setAttribute(
    'aria-label',
    label + '; ' + rows.map((r) => r.day + ': ' + format(r[key])).join(', '),
  );
  for (const r of rows) {
    const bar = node('div', undefined, 'trend-column');
    bar.style.height = Math.max(0, (Number(r[key]) / max) * 100) + '%';
    bar.title = r.day + ' · ' + format(r[key]);
    wrap.append(bar);
  }
  const axis = node('div', undefined, 'chart-axis');
  axis.append(
    node('span', rows[0].day),
    node('span', format(max) + ' peak'),
    node('span', rows.at(-1).day),
  );
  target.append(wrap, axis);
}
export function details(target, values) {
  target.replaceChildren();
  for (const [key, value] of Object.entries(values))
    target.append(node('dt', key), node('dd', String(value ?? 'Not available')));
}
export { duration };
