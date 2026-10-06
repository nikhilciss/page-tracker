import { $, node, number, metric, bars, duration } from './analytics-ui.js';
import { date } from './account-api.js';
const countryName = (code) => {
  try {
    return /^[A-Z]{2}$/.test(code)
      ? new Intl.DisplayNames(['en'], { type: 'region' }).of(code)
      : code;
  } catch {
    return code;
  }
};
const methodNames = {
  typing: 'Typing / editing',
  paste: 'Paste',
  drop: 'Drag and drop',
  replacement: 'Text replacement',
  selection: 'Selection',
};
function donut(target, rows) {
  target.replaceChildren();
  const total = rows.reduce((n, r) => n + r.value, 0);
  if (!total) {
    target.append(node('p', 'No country observations in this selection.', 'muted'));
    return;
  }
  const shown = rows.slice(0, 6);
  if (rows.length > 6)
    shown.push({ label: 'Other countries', value: rows.slice(6).reduce((n, r) => n + r.value, 0) });
  const colors = ['#af110e', '#c85d58', '#e5a29b', '#374f59', '#79919a', '#969da1', '#d9dfe1'];
  let start = 0;
  const slices = [];
  const layout = node('div', undefined, 'donut-layout'),
    ring = node('div', undefined, 'report-donut'),
    legend = node('div', undefined, 'donut-legend');
  shown.forEach((r, i) => {
    const end = start + (r.value / total) * 100;
    slices.push(`${colors[i]} ${start}% ${end}%`);
    start = end;
    const item = node('div', undefined, 'donut-key'),
      dot = node('span', undefined, 'donut-dot');
    dot.style.background = colors[i];
    item.append(
      dot,
      node('span', countryName(r.label)),
      node('strong', `${number(r.value)} · ${((r.value / total) * 100).toFixed(1)}%`),
    );
    legend.append(item);
  });
  ring.style.background = `conic-gradient(${slices.join(',')})`;
  ring.setAttribute('role', 'img');
  ring.setAttribute(
    'aria-label',
    rows.map((r) => `${countryName(r.label)}: ${r.value}`).join(', '),
  );
  const center = node('div');
  center.append(node('strong', number(total)), node('small', 'visits'));
  ring.append(center);
  layout.append(ring, legend);
  target.append(layout);
}
export function renderActivityReports(report) {
  $('#extended-reports').hidden = !report;
  $('#recording-summary').hidden = !report;
  if (!report) return;
  const status = report.video_status;
  $('#recording-summary').replaceChildren(
    metric('Saved recordings', number(report.saved_recordings), 'Unique recording records'),
    metric('Playable videos', status ? number(status.ready) : '—', 'Ready WebM / MP4 files'),
    metric(
      'Queued / processing',
      status ? number(status.processing) : '—',
      'Generation in progress',
    ),
    metric(
      'Failed generation',
      status ? number(status.failed) : '—',
      status ? `${number(status.unavailable)} legacy or unavailable` : 'Video status unavailable',
    ),
  );
  donut($('#country-report'), report.countries);
  for (const [id, key] of [
    ['ip-report', 'ips'],
    ['domain-report', 'domains'],
    ['referrer-report', 'referrers'],
    ['duration-report', 'duration'],
    ['submit-timing-report', 'submit_timing'],
    ['sensitive-report', 'sensitive_activity'],
  ])
    bars($('#' + id), report[key].some((r) => r.value) ? report[key] : []);
  bars(
    $('#input-method-report'),
    report.input_methods.map((r) => ({ ...r, label: methodNames[r.label] || r.label })),
  );
  $('#method-coverage').textContent =
    `${number(report.input_method_unknown)} visits have no captured input method. Methods are collected only by the updated widget; no field values are stored.`;
  $('#recent-recording-rows').replaceChildren();
  for (const r of report.recent_recordings) {
    const tr = node('tr');
    tr.append(node('td', date(r.created_at)), node('td', r.page_url));
    const cell = node('td'),
      a = node('a', r.id.slice(0, 12) + '…');
    a.href = '/session.html?id=' + encodeURIComponent(r.id);
    a.title = r.id;
    cell.append(a);
    tr.append(
      cell,
      node('td', duration(r.duration_ms)),
      node('td', r.video_status || 'Unavailable'),
    );
    $('#recent-recording-rows').append(tr);
  }
  $('#recording-report-empty').textContent = report.saved_recordings
    ? ''
    : 'No saved recordings linked to this selection.';
}
