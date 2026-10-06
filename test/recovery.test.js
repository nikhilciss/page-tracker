import test from 'node:test';
import assert from 'node:assert/strict';
import { utimes } from 'node:fs/promises';
import { fixture } from './helpers.js';

test('capture recovery requires owner session and CSRF, rejects active capture, then saves manual replay', async (t) => {
  const owner = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
  const analyticsId = '11111111-1111-4111-8111-111111111111';
  let recordingSession;
  const f = await fixture({
    analytics: {
      async get(account, id) {
        return account === owner && id === analyticsId
          ? { session: { id }, pages: [{ recording_session_id: recordingSession }] }
          : null;
      },
    },
  });
  t.after(() => f.close());
  const post = (route, body, headers = {}) =>
    fetch(f.url + route, {
      method: 'POST',
      headers: { Origin: f.url, 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  const init = await (await post('/api/track/init', { page_url: f.url + '/form' })).json();
  recordingSession = init.session_id;
  await post('/api/track/page/checkpoint', {
    token: init.token,
    offset: 0,
    duration_ms: 1000,
    truncated: false,
    fields: [],
    user_id: null,
    page_title: '',
    events: [
      { type: 4, timestamp: 1000, data: { href: f.url, width: 800, height: 600 } },
      {
        type: 2,
        timestamp: 1001,
        data: { node: { type: 0, id: 1, childNodes: [] }, initialOffset: { top: 0, left: 0 } },
      },
    ],
  });
  const route = '/api/admin/analytics/sessions/' + analyticsId + '/recover-recording';
  assert.equal((await post(route, {})).status, 401);
  assert.equal(
    (await post(route, {}, { Cookie: f.authCookie, Origin: 'https://evil.test' })).status,
    403,
  );
  assert.equal(
    (
      await post(
        route.replace(analyticsId, '22222222-2222-4222-8222-222222222222'),
        {},
        { Cookie: f.authCookie },
      )
    ).status,
    404,
  );
  assert.equal((await post(route, {}, { Cookie: f.authCookie })).status, 409);
  const old = new Date(Date.now() - 60000);
  await utimes(f.directory + '/.pending/' + recordingSession + '.capture.gz', old, old);
  const response = await post(route, {}, { Cookie: f.authCookie });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.ok(result.recording_id);
  assert.equal((await f.store.read(result.recording_id)).save_reason, 'manual');
});
