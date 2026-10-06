import { renderActivityReports } from './activity-reports.js';
import { api, account, date } from './account-api.js';
import { $, node, number, metric, bars, chart, duration } from './analytics-ui.js';
let offset = 0,
  request = 0,
  legacyOffset = 0;
const today = new Date();
$('#to').value = today.toISOString().slice(0, 10);
today.setUTCDate(today.getUTCDate() - 29);
$('#from').value = today.toISOString().slice(0, 10);
$('#period').onchange = () => {
  const preset = $('#period').value;
  if (preset === 'custom') return;
  const end = new Date(),
    start = new Date();
  if (preset === 'month') start.setUTCDate(1);
  else if (preset === 'previous') {
    end.setUTCDate(0);
    start.setUTCDate(1);
    start.setUTCMonth(start.getUTCMonth() - 1);
  } else start.setUTCDate(start.getUTCDate() - (Number(preset) - 1));
  $('#from').value = start.toISOString().slice(0, 10);
  $('#to').value = end.toISOString().slice(0, 10);
};
for (const id of ['from', 'to']) $('#' + id).onchange = () => ($('#period').value = 'custom');
function options(id, rows, label) {
  const select = $(id),
    value = select.value;
  select.replaceChildren(new Option(label, ''));
  for (const row of rows) select.add(new Option(row.label, row.value));
  if (value && ![...select.options].some((o) => o.value === value))
    select.add(new Option(value + ' (no sessions)', value));
  select.value = value;
}
async function load() {
  const serial = ++request;
  $('#dashboard').setAttribute('aria-busy', 'true');
  $('#feedback').textContent = 'Loading analytics…';
  $('#refresh').disabled = true;
  try {
    const end = new Date($('#to').value + 'T00:00:00Z');
    end.setUTCDate(end.getUTCDate() + 1);
    const query = new URLSearchParams({
      from: $('#from').value,
      to: end.toISOString().slice(0, 10),
      project: $('#project').value,
      device: $('#device').value,
      browser: $('#browser').value,
      country: $('#country').value,
      ip: $('#ip').value.trim(),
      referrer: $('#referrer').value,
      input_method: $('#input_method').value,
      offset,
    });
    const d = await api('/api/admin/analytics?' + query);
    if (serial !== request) return;
    options(
      '#project',
      d.projects.map((p) => ({ value: p.id, label: p.origin })),
      'All projects',
    );
    for (const key of ['browser', 'device'])
      options(
        '#' + key,
        d.options[key].map((value) => ({ value, label: value })),
        'All ' + key + 's',
      );
    for (const key of ['country', 'referrer'])
      options(
        '#' + key,
        (d.options[key] || []).map((value) => ({ value, label: value })),
        key === 'country' ? 'All countries' : 'All referrers',
      );
    renderActivityReports(d.reports);
    const t = d.totals;
    const coverage = d.coverage || { analytics_sessions: d.total, historical_visits: 0 };
    const measured = coverage.analytics_sessions > 0;
    const analyticNumber = (value) => (measured ? number(value) : '—');
    $('#coverage').textContent = coverage.historical_visits
      ? `${number(coverage.historical_visits)} historical recorded visits + ${number(coverage.analytics_sessions)} analytics sessions. Historical visits have no visitor identity or semantic measurements; those metrics cover analytics sessions only.`
      : 'Each analytics session ID counts as a separate visitor here, including repeat visits by the same person.';
    if (offset && offset >= d.total) {
      offset = 0;
      return load();
    }
    $('#metrics').replaceChildren(
      metric('Total visitors', analyticNumber(t.visitors), 'One per analytics session ID'),
      metric('Sessions', number(t.sessions), 'Analytics sessions + historical visits'),
      metric('Page views', analyticNumber(t.page_views), 'Measured document + SPA views'),
      metric(
        'Avg. observed span',
        measured ? duration(t.average_observed_ms) : '—',
        'Not exact time on site',
      ),
      metric(
        'Avg. engagement',
        measured ? duration(t.average_engaged_ms) : '—',
        'Visible activity estimate',
      ),
      metric('Interactions', analyticNumber(t.interactions), 'Measured clicks and form actions'),
    );
    $('#stat-total').textContent = number(d.total);
    $('#empty-state').hidden = !!d.total;
    const days = [];
    for (
      let day = new Date(query.get('from') + 'T00:00:00Z');
      day < end;
      day.setUTCDate(day.getUTCDate() + 1)
    ) {
      const key = day.toISOString().slice(0, 10);
      days.push(d.trends.find((r) => r.day === key) || { day: key, sessions: 0, engaged_ms: 0 });
    }
    chart($('#session-chart'), d.total ? days : [], 'sessions', 'Daily sessions');
    chart(
      $('#engagement-chart'),
      d.total ? days : [],
      'engaged_ms',
      'Estimated engagement',
      duration,
    );
    bars($('#visitors-chart'), [
      { label: 'Sessions from new identities', value: t.new_visitors },
      { label: 'Sessions from returning identities', value: t.returning_visitors },
    ]);
    bars(
      $('#forms-chart'),
      [
        ['form_view', 'Form views'],
        ['form_start', 'Form starts'],
        ['form_submit', 'Browser submit attempts'],
        ['form_validation_attempt', 'Validation attempts'],
        ['form_success', 'Host-reported success'],
      ].map(([key, label]) => ({ label, value: d.events[key] || 0 })),
    );
    bars(
      $('#pages-chart'),
      d.top_pages.map((p) => ({ label: p.url, value: p.views })),
    );
    bars(
      $('#scroll-chart'),
      d.milestones.map((m) => ({ label: m.depth + '% depth', value: m.pages })),
    );
    bars(
      $('#activity-chart'),
      [
        ['click', 'Clicks'],
        ['form_field_interaction', 'Field interactions'],
        ['navigation', 'SPA / history navigation'],
      ].map(([key, label]) => ({ label, value: d.events[key] || 0 })),
    );
    for (const key of ['browser', 'device', 'os'])
      bars(
        $('#' + key + '-chart'),
        Object.entries(d.breakdown[key]).map(([label, value]) => ({ label, value })),
      );
    if (!measured) {
      for (const key of [
        'engagement-chart',
        'visitors-chart',
        'forms-chart',
        'pages-chart',
        'scroll-chart',
        'activity-chart',
      ])
        $('#' + key).replaceChildren(
          node(
            'p',
            d.total
              ? 'Not captured for historical recordings.'
              : 'No analytics sessions in this selection.',
            'muted',
          ),
        );
    }
    $('#sessions').replaceChildren();
    for (const s of d.sessions) {
      const tr = node('tr'),
        cell = node('td'),
        link = node('a', s.visitor_label || 'Visitor ' + s.visitor_id.slice(0, 8));
      link.href =
        s.source === 'recording'
          ? '/session.html?id=' + encodeURIComponent(s.recording_id)
          : '/session.html?analytics=' + encodeURIComponent(s.id);
      cell.append(link, node('small', s.id.slice(0, 8), 'cell-note'));
      tr.append(cell);
      for (const value of [
        s.pages,
        duration(s.observed_ms) + (s.source === 'recording' ? ' recorded' : ''),
        s.engaged_ms === null ? 'Not captured' : duration(s.engaged_ms),
        s.device + ' / ' + s.browser,
        (s.country || 'Unknown') + ' / ' + (s.ip || 'Unknown'),
        date(s.started_at),
        s.source === 'recording'
          ? 'Historical recording'
          : s.status === 'active'
            ? 'Active'
            : 'Timed out',
      ])
        tr.append(node('td', String(value)));
      $('#sessions').append(tr);
    }
    $('#previous').disabled = offset === 0;
    $('#next').disabled = offset + 20 >= d.total;
    $('#page-label').textContent = d.total
      ? `${offset + 1}–${Math.min(offset + 20, d.total)} of ${number(d.total)}`
      : '0 sessions';
    $('#feedback').textContent = 'Updated ' + new Date().toLocaleTimeString();
    $('#dashboard').hidden = false;
  } catch (e) {
    if (serial === request) {
      $('#feedback').textContent = e.message + ' Use Refresh data to retry.';
      $('#dashboard').hidden = true;
    }
  } finally {
    if (serial === request) {
      $('#dashboard').setAttribute('aria-busy', 'false');
      $('#refresh').disabled = false;
    }
  }
}
$('#filters').onsubmit = (e) => {
  e.preventDefault();
  offset = 0;
  load();
};
$('#refresh').onclick = () => {
  offset = 0;
  load();
};
$('#reset-filters').onclick = () => {
  for (const key of ['project', 'device', 'browser', 'country', 'referrer', 'input_method', 'ip'])
    $('#' + key).value = '';
  offset = 0;
  load();
};
$('#previous').onclick = () => {
  offset = Math.max(0, offset - 20);
  load();
};
$('#next').onclick = () => {
  offset += 20;
  load();
};
async function legacy() {
  try {
    const d = await api('/api/admin/recordings?limit=20&offset=' + legacyOffset);
    $('#recordings').replaceChildren();
    for (const r of d.recordings) {
      const a = node(
        'a',
        `${date(r.created_at)} · ${r.user_name || r.user_id || 'Guest'} · ${r.page_url}`,
      );
      a.href = '/session.html?id=' + encodeURIComponent(r.id);
      $('#recordings').append(a);
    }
    $('#legacy-status').textContent = d.stats.total
      ? `${legacyOffset + 1}–${Math.min(legacyOffset + 20, d.stats.total)} of ${number(d.stats.total)} recordings`
      : 'No recordings yet.';
    $('#legacy-prev').disabled = !legacyOffset;
    $('#legacy-next').disabled = legacyOffset + 20 >= d.stats.total;
  } catch (e) {
    $('#legacy-status').textContent = e.message;
  }
}
$('#legacy').ontoggle = () => {
  if ($('#legacy').open) legacy();
};
$('#legacy-prev').onclick = () => {
  legacyOffset = Math.max(0, legacyOffset - 20);
  legacy();
};
$('#legacy-next').onclick = () => {
  legacyOffset += 20;
  legacy();
};
try {
  const user = await account();
  if (user.is_master) location.replace('/master/admin');
  else await load();
} catch (e) {
  $('#feedback').textContent = e.message;
}
