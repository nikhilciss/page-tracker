import { access } from 'node:fs/promises';
// Reporting facts are account-scoped and never read raw rrweb payloads.
const buckets = [10000, 30000, 60000, 300000, 900000, Infinity];
const labels = ['Under 10 sec', '10–30 sec', '30–60 sec', '1–5 min', '5–15 min', '15+ min'];
export function distribution(values) {
  const result = labels.map((label) => ({ label, value: 0 }));
  for (const value of values) {
    if (!Number.isFinite(value) || value < 0) continue;
    result[buckets.findIndex((limit) => value < limit)].value++;
  }
  return result;
}
const rows = (map) =>
  [...map]
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
const add = (map, key) => map.set(key, (map.get(key) || 0) + 1);
function domain(url) {
  try {
    return new URL(url).host;
  } catch {
    return 'Unknown';
  }
}
export async function attachReportFacts(pool, account, visits) {
  const ids = visits.filter((s) => s.source !== 'recording').map((s) => s.id);
  let pages = [],
    methods = [],
    submissions = [];
  if (ids.length) {
    const marks = ids.map(() => '?').join(','),
      args = [account, ...ids];
    [pages] = await pool.execute(
      `SELECT p.tracking_session_id,p.recording_session_id,p.page_url,p.started_at,c.context
      FROM session_pages p LEFT JOIN recording_contexts c ON c.account_id=p.account_id AND c.recording_session_id=p.recording_session_id
      WHERE p.account_id=? AND p.tracking_session_id IN (${marks}) ORDER BY p.started_at,p.id`,
      args,
    );
    [methods] = await pool.execute(
      `SELECT tracking_session_id,JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.input_method')) input_method,
      MAX(JSON_EXTRACT(metadata,'$.sensitive')=true) has_sensitive
      FROM session_events WHERE account_id=? AND tracking_session_id IN (${marks}) AND event_type='form_field_interaction'
      GROUP BY tracking_session_id,input_method`,
      args,
    );
    [submissions] = await pool.execute(
      `SELECT tracking_session_id,page_id,MIN(page_offset_ms) elapsed_ms FROM session_events
      WHERE account_id=? AND tracking_session_id IN (${marks}) AND event_type='form_submit' GROUP BY tracking_session_id,page_id`,
      args,
    );
  }
  const historicalIds = visits.filter((s) => s.source === 'recording').map((s) => s.id);
  let oldContexts = [];
  if (historicalIds.length)
    [oldContexts] = await pool.execute(
      `SELECT recording_session_id,context FROM recording_contexts WHERE account_id=? AND recording_session_id IN (${historicalIds.map(() => '?').join(',')})`,
      [account, ...historicalIds],
    );
  const oldMap = new Map(oldContexts.map((c) => [c.recording_session_id, c.context]));
  const map = new Map(visits.map((s) => [s.id, s]));
  for (const s of visits) {
    s.documents = new Set();
    s.domains = new Set(s.urls ? [...s.urls].map(domain) : []);
    s.input_methods = new Set();
    s.sensitive_activity = false;
    s.field_activity = false;
    s.submit_times = [];
    s.context = null;
    if (s.source === 'recording') {
      s.documents.add(s.id);
      s.context = oldMap.get(s.id) || null;
    }
  }
  for (const p of pages) {
    const s = map.get(p.tracking_session_id);
    s.documents.add(p.recording_session_id);
    s.domains.add(domain(p.page_url));
    s.context ||= p.context || null;
  }
  for (const m of methods) {
    const s = map.get(m.tracking_session_id);
    s.field_activity = true;
    s.sensitive_activity ||= !!Number(m.has_sensitive);
    if (['typing', 'paste', 'drop', 'replacement', 'selection'].includes(m.input_method))
      s.input_methods.add(m.input_method);
  }
  for (const item of submissions)
    map.get(item.tracking_session_id).submit_times.push(Number(item.elapsed_ms));
  for (const s of visits) {
    s.country =
      s.context?.geo_status === 'private'
        ? 'Local/private network'
        : s.context?.country || 'Unknown';
    s.ip = s.context?.ip || 'Unknown';
    s.referrer = s.context?.referrer_origin || 'Unknown';
  }
}
export function reportSummary(visits, recordings) {
  const country = new Map(),
    ip = new Map(),
    domains = new Map(),
    referrers = new Map(),
    methods = new Map();
  let sensitive = 0,
    withoutSensitive = 0,
    unobserved = 0,
    methodUnknown = 0;
  for (const s of visits) {
    add(country, s.country);
    add(ip, s.ip);
    add(referrers, s.referrer);
    for (const d of s.domains) add(domains, d);
    for (const m of s.input_methods) add(methods, m);
    if (!s.input_methods.size) methodUnknown++;
    if (s.sensitive_activity) sensitive++;
    else if (s.field_activity) withoutSensitive++;
    else unobserved++;
  }
  return {
    countries: rows(country),
    ips: rows(ip).slice(0, 10),
    domains: rows(domains).slice(0, 10),
    referrers: rows(referrers).slice(0, 10),
    input_methods: rows(methods),
    input_method_unknown: methodUnknown,
    sensitive_activity: [
      { label: 'Sensitive-field interaction observed', value: sensitive },
      { label: 'Other field interactions only', value: withoutSensitive },
      { label: 'No field interaction data', value: unobserved },
    ],
    duration: distribution(
      visits.filter((s) => s.source !== 'recording').map((s) => s.observed_ms),
    ),
    submit_timing: distribution(visits.flatMap((s) => s.submit_times)),
    saved_recordings: recordings.length,
    recent_recordings: recordings.slice(0, 10),
    video_status: null,
    _recording_ids: recordings.map((r) => r.id),
  };
}
export async function recordingsForVisits(pool, account, visits) {
  const ids = [...new Set(visits.flatMap((s) => [...s.documents]))];
  if (!ids.length) return [];
  const [records] = await pool.execute(
    `SELECT id,session_id,page_url,created_at,duration_ms FROM recordings WHERE account_id=? AND session_id IN (${ids.map(() => '?').join(',')}) ORDER BY created_at DESC,id DESC LIMIT 10001`,
    [account, ...ids],
  );
  if (records.length > 10000)
    throw Object.assign(new Error('Too many recordings. Narrow the date range or project.'), {
      status: 422,
    });
  return records;
}
export async function addVideoStatus(report, videos) {
  if (!report) return;
  const ids = report._recording_ids || [];
  delete report._recording_ids;
  if (!videos) return;
  const counts = { ready: 0, processing: 0, failed: 0, unavailable: 0 };
  let index = 0;
  await Promise.all(
    Array.from({ length: Math.min(8, ids.length) }, async () => {
      while (index < ids.length) {
        const id = ids[index++];
        let state;
        try {
          state = await videos.status(id);
          if (state?.status === 'ready' && typeof videos.file === 'function') {
            try {
              await access(videos.file(id));
            } catch {
              state = null;
            }
          }
        } catch {}
        const key =
          state?.status === 'ready'
            ? 'ready'
            : ['queued', 'processing'].includes(state?.status)
              ? 'processing'
              : state?.status === 'failed'
                ? 'failed'
                : 'unavailable';
        counts[key]++;
        const row = report.recent_recordings.find((r) => r.id === id);
        if (row) row.video_status = key;
      }
    }),
  );
  report.video_status = counts;
}
