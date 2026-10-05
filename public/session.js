import { api, account, date, duration } from './account-api.js';
const $ = (s) => document.querySelector(s),
  id = new URLSearchParams(location.search).get('id');
let timer;
const endpoint = '/api/admin/recordings/' + encodeURIComponent(id || '');
async function poll() {
  try {
    const state = await api(endpoint + '/video/status');
    $('#video-status').textContent = state.message || 'Video ' + state.status;
    $('#retry-video').hidden = state.status !== 'failed';
    if (['queued', 'processing'].includes(state.status)) {
      timer = setTimeout(poll, 2000);
      return;
    }
    if (state.status === 'ready') {
      $('#session-video').src = endpoint + '/video';
      $('#session-video').hidden = false;
      $('#download-video').href = endpoint + '/video';
      $('#download-video').download = id + '.mp4';
      $('#download-video').hidden = false;
      $('#video-status').textContent =
        'MP4 ready' + (state.truncated ? ' · Capture or video duration limit reached' : '');
    }
  } catch (error) {
    $('#video-status').textContent = error.message;
  }
}
$('#retry-video').addEventListener('click', async () => {
  $('#retry-video').disabled = true;
  try {
    await api(endpoint + '/video/retry', { method: 'POST' });
    await poll();
  } catch (error) {
    $('#video-status').textContent = error.message;
  } finally {
    $('#retry-video').disabled = false;
  }
});
window.addEventListener('pagehide', () => clearTimeout(timer));
try {
  const user = await account();
  if (user.is_master) {
    const link = document.querySelector('header a');
    link.href = '/master/admin';
    link.textContent = '← Companies';
  }
  const { recording: row, account_name, company_origin } = await api(endpoint);
  if (user.is_master && row.account_id) {
    document.querySelector('header a').href =
      '/master/admin?company=' + encodeURIComponent(row.account_id);
    document.querySelector('header a').textContent = '← Company sessions';
  }
  const values = {
    'Session ID': row.session_id,
    'Recording ID': row.id,
    Account: account_name,
    'Company origin': company_origin,
    'Visitor name': row.user_name || 'Not provided',
    'Visitor ID': row.user_id || 'Guest',
    'Page domain': new URL(row.page_url).origin,
    'Page URL': row.page_url,
    'Page title': row.page_title || 'Not provided',
    'Browser / user agent': row.browser,
    'Recorded at': date(row.created_at),
    Duration: duration(row.duration_ms),
    Events: row.event_count,
    Fields: row.field_count,
    'Save trigger': row.save_reason || 'Form submission',
    'Capture truncated': row.truncated ? 'Yes' : 'No',
  };
  for (const [label, value] of Object.entries(values)) {
    const dt = document.createElement('dt'),
      dd = document.createElement('dd');
    dt.textContent = label;
    dd.textContent = String(value);
    $('#details').append(dt, dd);
  }
  await poll();
} catch (error) {
  $('#feedback').textContent = error.message;
  $('#video-status').textContent = 'Session unavailable.';
}
