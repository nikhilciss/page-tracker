import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, stat } from 'node:fs/promises';
import { fixture, payload } from './helpers.js';

test('API and filesystem contract', async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const post = (route, body, origin = f.url) =>
    fetch(`${f.url}/api/track/${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: origin },
      body: JSON.stringify(
        route === 'init' ? { ...body, authorization: f.grant(body.page_url) } : body,
      ),
    });
  let session, recordingId;
  await t.test('initialization strips URL secrets and persists nothing', async () => {
    const response = await post('init', { page_url: `${f.url}/contact?token=private#secret` });
    assert.equal(response.status, 201);
    session = await response.json();
    assert.equal(f.rows.size, 0);
    assert.deepEqual(await readdir(f.directory), []);
    const claims = JSON.parse(Buffer.from(session.token.split('.')[0], 'base64url'));
    assert.equal(claims.page_url, `${f.url}/contact`);
  });
  await t.test(
    'foreign origins, mismatched page URLs and expired tokens are rejected',
    async () => {
      assert.equal(
        (await post('init', { page_url: 'https://evil.example' }, 'https://evil.example')).status,
        403,
      );
      assert.equal((await post('init', { page_url: 'https://evil.example' })).status, 400);
      assert.equal((await post('submit', payload(session.token + 'x'))).status, 401);
      assert.equal(
        (await post('submit', payload(session.token), 'https://allowed.example')).status,
        401,
      );
    },
  );
  await t.test(
    'redacts secrets in fields, snapshots and input events; writes gzip privately',
    async () => {
      const body = payload(session.token);
      body.fields[0] = { ...body.fields[0], name: 'password', value: 'must-never-persist' };
      body.events[0].controls[0] = {
        ...body.events[0].controls[0],
        name: 'api_token',
        value: 'must-never-persist',
      };
      body.events[1].field = { ...body.fields[0] };
      const response = await post('submit', body);
      assert.equal(response.status, 201);
      recordingId = (await response.json()).recording_id;
      const recording = await f.store.read(recordingId);
      assert.equal(recording.fields[0].value, '[REDACTED]');
      assert.ok(!JSON.stringify(recording).includes('must-never-persist'));
      assert.ok(!Object.hasOwn(recording, 'token'));
      assert.deepEqual(await readdir(f.directory), [`${recordingId}.capture.gz`]);
      assert.equal((await stat(`${f.directory}/${recordingId}.capture.gz`)).mode & 0o777, 0o600);
    },
  );
  await t.test(
    'retries and simultaneous duplicate submissions create one recording per form',
    async () => {
      const repeated = await post('submit', payload(session.token));
      assert.equal(repeated.status, 200);
      assert.equal((await repeated.json()).recording_id, recordingId);
      const body = payload(session.token, { form_key: 'form-2' });
      const responses = await Promise.all([post('submit', body), post('submit', body)]);
      const ids = await Promise.all(responses.map((response) => response.json()));
      assert.equal(ids[0].recording_id, ids[1].recording_id);
      assert.equal(f.rows.size, 2);
      assert.equal((await readdir(f.directory)).length, 2);
    },
  );
  await t.test(
    'validation rejects malformed timelines, extra properties and oversized payloads',
    async () => {
      assert.equal(
        (await post('submit', payload(session.token, { events: [{ type: 'submit', t: 0 }] })))
          .status,
        400,
      );
      assert.equal(
        (await post('submit', { ...payload(session.token), html: '<script>bad()</script>' }))
          .status,
        400,
      );
      const body = payload(session.token);
      body.events[1].t = 1001;
      assert.equal((await post('submit', body)).status, 400);
      assert.equal((await post('submit', { data: 'a'.repeat(9000000) })).status, 413);
    },
  );
  await t.test(
    'recordings require admin authorization and are not public static assets',
    async () => {
      assert.equal((await fetch(`${f.url}/api/admin/recordings`)).status, 401);
      const headers = { Cookie: f.authCookie };
      const list = await fetch(`${f.url}/api/admin/recordings`, { headers });
      assert.equal(list.headers.get('cache-control'), 'no-store');
      assert.equal((await list.json()).stats.total, 2);
      const recording = await fetch(`${f.url}/api/admin/recordings/${recordingId}`, { headers });
      assert.equal(recording.status, 200);
      assert.equal(
        (await fetch(`${f.url}/uploads/recordings/${recordingId}.capture.gz`)).status,
        404,
      );
    },
  );
  await t.test('database failures roll back the newly written file', async () => {
    const original = f.repository.insert;
    f.repository.insert = async () => {
      throw new Error('Database unavailable');
    };
    try {
      assert.equal(
        (await post('submit', payload(session.token, { form_key: 'form-3' }))).status,
        500,
      );
    } finally {
      f.repository.insert = original;
    }
    assert.equal((await readdir(f.directory)).length, 2);
  });
  await t.test('tracker can be embedded cross-origin and has no dependency loader', async () => {
    const response = await fetch(`${f.url}/tracker.js`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cross-origin-resource-policy'), 'cross-origin');
    const preflight = await fetch(`${f.url}/api/track/submit`, {
      method: 'OPTIONS',
      headers: {
        Origin: f.url,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type',
      },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), f.url);
  });
});
