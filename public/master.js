import { api, account, date, duration } from './account-api.js';
const $ = (s) => document.querySelector(s);
const company = new URLSearchParams(location.search).get('company');
let offset = 0;
function cell(value, href) {
  const td = document.createElement('td');
  if (href) {
    const link = document.createElement('a');
    link.href = href;
    link.textContent = value;
    td.append(link);
  } else td.textContent = value;
  return td;
}
async function load() {
  $('#refresh').disabled = true;
  try {
    const data = await api(
      '/api/master/companies' +
        (company ? '/' + encodeURIComponent(company) : '') +
        '?offset=' +
        offset,
    );
    const labels = company
      ? ['Session ID', 'Visitor', 'Page', 'Duration', 'Recorded']
      : ['Company domain', 'Account name', 'Email', 'Sessions', 'Registered'];
    const heading = document.createElement('tr');
    labels.forEach((label) => {
      const th = document.createElement('th');
      th.textContent = label;
      heading.append(th);
    });
    $('#head').replaceChildren(heading);
    $('#rows').replaceChildren();
    if (company) {
      $('#back').hidden = false;
      $('#title').textContent = data.company.company_origin;
      $('#description').textContent = data.company.name + ' · ' + data.company.email;
    }
    for (const row of company ? data.recordings : data.companies) {
      const tr = document.createElement('tr');
      if (company)
        tr.append(
          cell(row.session_id, '/session.html?master=1&id=' + encodeURIComponent(row.id)),
          cell(row.user_name || row.user_id || 'Guest'),
          cell(row.page_url),
          cell(duration(row.duration_ms)),
          cell(date(row.created_at)),
        );
      else
        tr.append(
          cell(row.company_origin, '/master/admin?company=' + encodeURIComponent(row.id)),
          cell(row.name),
          cell(row.email),
          cell(row.session_count),
          cell(date(row.created_at)),
        );
      $('#rows').append(tr);
    }
    const total = Number(company ? data.stats.total : data.total);
    $('#empty').hidden = total !== 0;
    $('#previous').disabled = offset === 0;
    $('#next').disabled = offset + 20 >= total;
    $('#page-label').textContent = total
      ? offset + 1 + '–' + Math.min(offset + 20, total) + ' of ' + total
      : '0 results';
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
  if (!user.is_master) location.replace('/');
  else await load();
} catch (error) {
  $('#feedback').textContent = error.message;
}
