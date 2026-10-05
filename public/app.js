import { api, account, date, duration } from './account-api.js';
const $ = (s) => document.querySelector(s);
let offset = 0;
async function load() {
  $('#refresh').disabled = true;
  try {
    const { recordings, stats } = await api('/api/admin/recordings?limit=20&offset=' + offset);
    $('#count').textContent = 'Recorded sessions';
    $('#stat-total').textContent = Number(stats.total).toLocaleString();
    $('#stat-guests').textContent = Number(stats.guests).toLocaleString();
    $('#stat-duration').textContent = duration(Number(stats.average_duration_ms));
    $('#empty-state').hidden = Number(stats.total) !== 0;
    $('#recordings').replaceChildren();
    for (const row of recordings) {
      const tr = document.createElement('tr');
      const td = document.createElement('td'),
        link = document.createElement('a');
      link.href = '/session.html?id=' + encodeURIComponent(row.id);
      link.textContent = row.session_id;
      td.append(link);
      tr.append(td);
      for (const value of [
        row.user_name || row.user_id || 'Guest',
        row.page_url,
        duration(row.duration_ms),
        date(row.created_at),
      ]) {
        const cell = document.createElement('td');
        cell.textContent = value;
        tr.append(cell);
      }
      $('#recordings').append(tr);
    }
    $('#previous').disabled = offset === 0;
    $('#next').disabled = offset + 20 >= Number(stats.total);
    $('#page-label').textContent = stats.total
      ? offset + 1 + '–' + Math.min(offset + 20, stats.total)
      : '0 sessions';
    $('#feedback').textContent = '';
  } catch (error) {
    $('#feedback').textContent = error.message;
  } finally {
    $('#refresh').disabled = false;
  }
}
$('#refresh').addEventListener('click', load);
$('#previous').addEventListener('click', () => {
  offset = Math.max(0, offset - 20);
  load();
});
$('#next').addEventListener('click', () => {
  offset += 20;
  load();
});
try {
  const user = await account();
  if (user.is_master) location.replace('/master/admin');
  $('#origin').textContent = user.company_origin;
  await load();
} catch (error) {
  $('#feedback').textContent = error.message;
}
