import { evidence, who, selectTab } from './session-view.js';
import { api, account, date } from './account-api.js';
import { $, node, metric, details, duration, number } from './analytics-ui.js';
const id = new URLSearchParams(location.search).get('analytics');
const endpoint = '/api/admin/analytics/sessions/' + encodeURIComponent(id),
  eventEndpoint = '/api/admin/sessions/' + encodeURIComponent(id) + '/events';
let data,
  events = [],
  next = 0,
  timer,
  selected,
  version = 0;
const video = $('#session-video');
function renderEvents() {
  $('#timeline').replaceChildren();
  const filter = $('#event-filter').value;
  for (const e of events.filter(
    (e) =>
      !filter || (filter === 'form' ? e.event_type.startsWith('form_') : e.event_type === filter),
  )) {
    const li = node('li'),
      time = node('time', duration(e.session_offset_ms)),
      content = node('div'),
      m = e.metadata || {};
    time.title = date(e.occurred_at);
    content.append(node('strong', e.event_type.replaceAll('_', ' ')));
    const page = data.pages.find((p) => p.id === e.page_id);
    const context = [
      m.text,
      m.form,
      m.field,
      m.action,
      m.input_method ? `Input method: ${m.input_method}` : null,
      m.sensitive ? 'Sensitive field · metadata only' : null,
      m.milestone ? m.milestone + '% depth' : null,
      m.url || page?.page_url,
      m.route,
      m.tag,
      m.navigation,
      Number.isFinite(m.x) && Number.isFinite(m.y) ? `Position ${m.x}, ${m.y}` : null,
    ]
      .filter(Boolean)
      .join(' · ');
    content.append(node('p', context || date(e.occurred_at)));
    if (e.event_type === 'form_submit')
      content.append(node('p', 'Browser submit attempt · server outcome unknown'));
    if (e.event_type === 'form_success')
      content.append(node('p', 'Success explicitly reported by host integration'));
    const recording = data.recordings.find(
      (r) => m.source !== 'server' && r.session_id === page?.recording_session_id,
    );
    if (recording && Number.isFinite(e.recording_offset_ms)) {
      const b = node('button', 'Seek in video', 'secondary');
      b.onclick = () => {
        selectTab('replay');
        choose(recording.id, Number(e.recording_offset_ms) / 1000);
      };
      content.append(b);
    }
    li.append(time, content);
    $('#timeline').append(li);
  }
  if (!$('#timeline').children.length)
    $('#timeline').append(node('li', 'No matching events loaded.'));
}
async function more() {
  $('#more-events').disabled = true;
  $('#timeline-status').textContent = 'Loading activity…';
  try {
    const d = await api(eventEndpoint + '?offset=' + next);
    events.push(...d.events);
    next = d.next_offset;
    renderEvents();
    $('#more-events').hidden = next === null;
    $('#timeline-status').textContent =
      number(events.length) + ' events loaded' + (next !== null ? ' · more available' : '');
  } catch (e) {
    $('#timeline-status').textContent = e.message;
    $('#more-events').hidden = false;
  } finally {
    $('#more-events').disabled = false;
  }
}
async function choose(recordingId, seek) {
  clearTimeout(timer);
  selected = recordingId;
  const current = ++version;
  $('#recording-select').value = recordingId;
  video.pause();
  video.hidden = true;
  video.removeAttribute('src');
  video.load();
  $('#download-video').hidden = true;
  $('#retry-video').hidden = true;
  $('#video-tools').hidden = true;
  const base = '/api/admin/recordings/' + encodeURIComponent(recordingId);
  async function poll() {
    try {
      const state = await api(base + '/video/status');
      if (current !== version) return;
      $('#video-status').textContent = state.message || 'Video ' + state.status;
      $('#retry-video').hidden = state.status !== 'failed';
      if (['queued', 'processing'].includes(state.status)) {
        timer = setTimeout(poll, 2000);
        return;
      }
      if (state.status === 'ready') {
        video.onloadedmetadata = () => {
          video.playbackRate = Number($('#speed').value);
          if (seek !== undefined) {
            const doc = data.recordings.find((r) => r.id === recordingId)?.session_id;
            const offset = state.segments?.find((s) => s.session_id === doc)?.offset_ms || 0;
            seek += offset / 1000;
            if (Number.isFinite(video.duration) && seek <= video.duration) {
              video.currentTime = Math.max(0, seek);
            } else
              $('#video-status').textContent =
                'This event is outside the available video duration.';
          }
        };
        video.src = base + '/video';
        video.hidden = false;
        $('#video-tools').hidden = false;
        $('#download-video').href = base + '/video';
        $('#download-video').download = recordingId + '.' + (state.format || 'mp4');
        $('#download-video').hidden = false;
        $('#download-video').textContent = 'Download ' + (state.format || 'mp4').toUpperCase();
        $('#video-status').textContent =
          (state.format || 'mp4').toUpperCase() +
          ' ready' +
          (state.truncated ? ' · Recording truncated' : '');
      }
    } catch (e) {
      if (current === version) $('#video-status').textContent = e.message;
    }
  }
  await poll();
}
$('#recover-recording').onclick = async () => {
  $('#recover-recording').disabled = true;
  try {
    await api(endpoint + '/recover-recording', { method: 'POST' });
    location.reload();
  } catch (error) {
    $('#pending-capture').textContent = error.message;
    $('#recover-recording').disabled = false;
  }
};
$('#event-filter').onchange = renderEvents;
$('#more-events').onclick = more;
$('#speed').onchange = () => (video.playbackRate = Number($('#speed').value));
$('#recording-select').onchange = () => choose($('#recording-select').value);
$('#retry-video').onclick = async () => {
  try {
    await api('/api/admin/recordings/' + encodeURIComponent(selected) + '/video/retry', {
      method: 'POST',
    });
    await choose(selected);
  } catch (e) {
    $('#video-status').textContent = e.message;
  }
};
window.addEventListener('pagehide', () => {
  version++;
  clearTimeout(timer);
});
try {
  await account();
  $('#feedback').textContent = 'Loading session…';
  data = await api(endpoint);
  const s = data.session,
    recording = data.recordings[0];
  $('#session-metrics').hidden = false;
  $('#session-metrics').replaceChildren(
    metric('Page views', number(data.pages.length), 'Documents and SPA routes'),
    metric(
      'Observed span',
      duration(Math.max(0, new Date(s.last_activity_at) - new Date(s.started_at))),
      'Not exact dwell time',
    ),
    metric('Engagement estimate', duration(data.engaged_ms), 'Overlapping tabs deduplicated'),
  );
  const context = data.contexts?.at(-1);
  evidence({
    'Session details': {
      'Session ID': s.id,
      'Visitor ID': s.visitor_id,
      Project: s.project_id,
      Status: s.status === 'active' ? 'Active' : 'Timed out',
      Recordings: data.recordings.length,
    },
    'When did they visit?': {
      'Visit date': new Date(s.started_at).toLocaleDateString(),
      'Visit time': new Date(s.started_at).toLocaleTimeString(undefined, { timeZoneName: 'short' }),
      'Last activity': date(s.last_activity_at),
      'Observed span': duration(Math.max(0, new Date(s.last_activity_at) - new Date(s.started_at))),
      'Engagement estimate': duration(data.engaged_ms),
    },
    'Where did they visit?': {
      'Landing page': data.pages[0]?.page_url || 'Not captured',
      'Referrer origin': context?.referrer_origin || 'Not captured',
    },
    'Who visited?': who(
      context,
      data.recordings.find((r) => r.session_id === context?.recording_session_id) || recording,
      s.visitor_id,
    ),
  });
  $('#journey-card').hidden = false;
  for (const p of data.pages) {
    const li = node('li', p.page_url);
    li.append(
      node('small', date(p.started_at)),
      node(
        'small',
        'Max scroll ' + Number(p.max_scroll || 0) + '% · Observed ' + duration(p.observed_ms || 0),
      ),
    );
    $('#journey').append(li);
  }
  $('#timeline-card').hidden = false;
  await more();
  if (data.pending_capture?.pages) {
    $('#pending-capture').hidden = false;
    $('#pending-capture').textContent =
      data.pending_capture.pages +
      ' page capture(s) are waiting for a completion signal. You can manually end and recover an inactive capture; this does not confirm submission success.' +
      (data.pending_capture.recoverable
        ? ''
        : ' Close the tracked pages, wait 30 seconds, then refresh to recover.');
    $('#recover-recording').hidden = !data.pending_capture.recoverable;
  }
  if (data.recordings.length) {
    data.recordings.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    $('#recording-summary').textContent =
      data.recordings.length +
      ' saved recording(s). Newest selected first; choose another recording below.';
    $('#recording-label').hidden = false;
    for (const r of data.recordings)
      $('#recording-select').add(new Option(date(r.created_at) + ' · ' + r.page_url, r.id));
    await choose(data.recordings[0].id);
  } else
    $('#video-status').textContent =
      'No finalized recording. The captured activity remains available below.';
  $('#feedback').textContent = '';
} catch (e) {
  $('#feedback').textContent = e.message;
  $('#video-status').textContent = 'Session unavailable.';
}
