import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { fixture, sampleField } from './helpers.js';

test('page checkpoint and finish protocol is private, ordered and idempotent', async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const post = (path, body, type = 'application/json', origin = f.url) =>
    fetch(f.url + '/api/track/' + path, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': type },
      body: JSON.stringify(
        path === 'init' ? { ...body, authorization: f.grant(body.page_url) } : body,
      ),
    });
  const session = await (await post('init', { page_url: f.url + '/existing.php' })).json();
  const events = [
    { type: 4, timestamp: 1000, data: { href: f.url + '/existing.php', width: 1000, height: 800 } },
    {
      type: 2,
      timestamp: 1001,
      data: { node: { type: 0, id: 1, childNodes: [] }, initialOffset: { top: 0, left: 0 } },
    },
  ];
  const checkpoint = {
    token: session.token,
    offset: 0,
    events,
    duration_ms: 100,
    truncated: false,
    page_title: 'Existing page',
    user_id: null,
    fields: [sampleField],
  };
  assert.equal(
    (await post('page/checkpoint', checkpoint, 'application/json', 'https://evil.example')).status,
    403,
  );
  assert.equal(
    (await post('page/checkpoint', { ...checkpoint, token: session.token + 'x' })).status,
    401,
  );
  assert.equal((await post('page/checkpoint', checkpoint)).status, 200);
  assert.equal(f.rows.size, 0);
  assert.ok(
    (await readdir(f.directory + '/.pending')).includes(session.session_id + '.capture.gz'),
  );
  const wrong = await post('page/checkpoint', { ...checkpoint, offset: 5 });
  assert.equal(wrong.status, 409);
  assert.equal((await wrong.json()).expected_offset, 2);
  const repeated = await post('page/checkpoint', checkpoint);
  assert.equal((await repeated.json()).next_offset, 2);
  // Finish can arrive before the last checkpoint. Wait for its acknowledged sequence.
  const finish = { token: session.token, reason: 'pagehide', expected_count: 3 };
  assert.equal((await post('page/finish', finish, 'text/plain;charset=UTF-8')).status, 202);
  assert.equal(f.rows.size, 0);
  const tail = {
    ...checkpoint,
    offset: 2,
    events: [{ type: 3, timestamp: 1100, data: { source: 3, id: 1, x: 0, y: 200 } }],
  };
  const done = await (await post('page/checkpoint', tail)).json();
  assert.ok(done.recording_id);
  const retries = await Promise.all([post('page/finish', finish), post('page/finish', finish)]);
  for (const response of retries)
    assert.equal((await response.json()).recording_id, done.recording_id);
  assert.equal(f.rows.size, 1);
  const recording = await f.store.read(done.recording_id);
  assert.equal(recording.scope, 'page');
  assert.equal(recording.page.events.length, 3);
  assert.equal(recording.form_key, 'page');
  assert.deepEqual(await readdir(f.directory + '/.pending'), []);
  assert.equal(
    (await fetch(f.url + '/uploads/recordings/.pending/' + session.session_id + '.capture.gz'))
      .status,
    404,
  );
});

test('combined recordings reject invalid continuation and retry idempotently', async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const post = (route, body) =>
    fetch(f.url + '/api/track/' + route, {
      method: 'POST',
      headers: { Origin: f.url, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  const a = await (await post('init', { page_url: f.url + '/form' })).json();
  const b = await (await post('init', { page_url: f.url + '/success' })).json();
  const checkpoint = (session) => ({
    token: session.token,
    offset: 0,
    duration_ms: 500,
    truncated: false,
    page_title: '',
    user_id: null,
    fields: [],
    events: [
      { type: 4, timestamp: 1000, data: { href: f.url + '/form', width: 800, height: 600 } },
      {
        type: 2,
        timestamp: 1001,
        data: { node: { type: 0, id: 1, childNodes: [] }, initialOffset: { top: 0, left: 0 } },
      },
    ],
  });
  await post('page/checkpoint', checkpoint(b));
  const body = {
    token: b.token,
    reason: 'success',
    expected_count: 2,
    previous: [{ token: a.token, expected_count: 2 }],
  };
  assert.equal(
    (
      await post('page/finish', {
        ...body,
        previous: [{ token: a.token + 'bad', expected_count: 2 }],
      })
    ).status,
    401,
  );
  assert.equal(
    (await post('page/finish', { ...body, previous: [{ token: b.token, expected_count: 2 }] }))
      .status,
    401,
  );
  assert.equal((await post('page/finish', body)).status, 409);
  assert.equal(f.rows.size, 0);
  await post('page/checkpoint', checkpoint(a));
  const done = await (await post('page/finish', body)).json();
  assert.ok(done.recording_id);
  assert.equal((await (await post('page/finish', body)).json()).recording_id, done.recording_id);
  assert.equal(f.rows.size, 1);
  const saved = await f.store.read(done.recording_id);
  assert.equal(saved.recording_segments.length, 2);
  assert.equal(saved.page.events.filter((e) => e.type === 2).length, 2);
});
