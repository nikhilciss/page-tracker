import { evidence, who } from './session-view.js';
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
      $('#download-video').download = id + '.' + (state.format || 'mp4');
      $('#download-video').hidden = false;
      $('#download-video').textContent = 'Download ' + (state.format || 'mp4').toUpperCase();
      $('#video-tools').hidden = false;
      $('#speed').onchange = () => ($('#session-video').playbackRate = Number($('#speed').value));
      $('#video-status').textContent =
        (state.format || 'mp4').toUpperCase() +
        ' ready' +
        (state.truncated ? ' · Capture or video duration limit reached' : '');
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
  const { recording: row, account_name, company_origin, context } = await api(endpoint);
  if (user.is_master && row.account_id) {
    document.querySelector('header a').href =
      '/master/admin?company=' + encodeURIComponent(row.account_id);
    document.querySelector('header a').textContent = '← Company sessions';
  }
  evidence({
    'Session details': {
      'Session ID': row.session_id,
      'Recording ID': row.id,
      Account: account_name,
      'Company origin': company_origin,
    },
    'When did they visit?': {
      'Visit date': new Date(row.created_at).toLocaleDateString(),
      'Saved at': date(row.created_at),
      'Recording duration': duration(row.duration_ms),
      'Capture truncated': row.truncated ? 'Yes' : 'No',
    },
    'Where did they visit?': {
      'Page URL': row.page_url,
      'Page title': row.page_title || 'Not provided',
      'Referrer origin': context?.referrer_origin || 'Not captured',
    },
    'Who visited?': who(context, row),
  });
  document.querySelector('#timeline-status').textContent =
    'Semantic event log is unavailable for this historical recording.';
  document.querySelector('#timeline-card').hidden = false;
  await poll();
} catch (error) {
  $('#feedback').textContent = error.message;
  $('#video-status').textContent = 'Session unavailable.';
}
