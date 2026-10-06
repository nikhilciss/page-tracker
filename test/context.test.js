import test from 'node:test';
import assert from 'node:assert/strict';
import { locationFor, captureContext } from '../src/context.js';
import { fixture } from './helpers.js';
test('location distinguishes private/invalid addresses and bounded approximate public metadata', () => {
  for (const ip of ['127.0.0.1', '::1', '::ffff:192.168.1.1', '10.2.3.4', 'fc00::1', 'fe80::1'])
    assert.equal(
      locationFor(ip, () => {
        throw Error('must not look up private IP');
      }).geo_status,
      'private',
    );
  assert.equal(locationFor('bad').geo_status, 'unavailable');
  assert.deepEqual(
    locationFor('8.8.8.8', () => ({
      country: 'US',
      city: 'Test City',
      region: 'CA',
      timezone: 'America/Los_Angeles',
    })),
    {
      ip: '8.8.8.8',
      geo_status: 'approximate',
      country: 'US',
      city: 'Test City',
      region: 'CA',
      geo_timezone: 'America/Los_Angeles',
    },
  );
  const c = captureContext(
    { ip: '127.0.0.1', get: () => 'Test browser' },
    {
      user_name: 'Test User',
      referrer: 'https://example.test/path?token=secret',
      language: 'en',
      timezone: 'Asia/Kolkata',
    },
  );
  assert.equal(c.referrer_origin, 'https://example.test');
  assert.equal(c.user_name, 'Test User');
  assert.equal(c.geo_status, 'private');
  assert.ok(!JSON.stringify(c).includes('secret'));
});
test('context capture derives tenant and IP server-side and accepts explicit host identity only', async (t) => {
  let received;
  const f = await fixture({
    context: {
      async save(account, id, context) {
        received = { account, id, context };
      },
    },
  });
  t.after(() => f.close());
  const post = (body) =>
    fetch(f.url + '/api/track/init', {
      method: 'POST',
      headers: {
        Origin: 'https://allowed.example',
        'Content-Type': 'application/json',
        'X-Forwarded-For': '8.8.8.8',
      },
      body: JSON.stringify(body),
    });
  const res = await post({
    page_url: 'https://allowed.example/page',
    user_name: 'Logged-in User',
    user_id: 'u123',
    referrer: 'https://example.test/?token=secret',
  });
  assert.equal(res.status, 201);
  assert.equal(received.account, 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa');
  assert.equal(received.context.geo_status, 'private');
  assert.equal(received.context.user_name, 'Logged-in User');
  assert.equal(received.id, (await res.json()).session_id);
  assert.equal((await post({ page_url: 'https://allowed.example', ip: '8.8.8.8' })).status, 400);
});

test('identity updates require an origin-bound token and reject non-identity properties', async (t) => {
  let updated;
  const f = await fixture({
    context: {
      async save() {},
      async updateIdentity(account, id, body) {
        updated = { account, id, body };
      },
    },
  });
  t.after(() => f.close());
  const post = (route, body) =>
    fetch(f.url + '/api/track/' + route, {
      method: 'POST',
      headers: { Origin: 'https://allowed.example', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  const session = await (await post('init', { page_url: 'https://allowed.example/page' })).json();
  const body = { token: session.token, user_id: 'id', user_name: 'Name' };
  assert.equal((await post('page/identity', { ...body, token: session.token + 'x' })).status, 401);
  assert.equal(updated, undefined);
  for (const extra of [{ account_id: 'forged' }, { ip: '8.8.8.8' }, { password: 'secret' }])
    assert.equal((await post('page/identity', { ...body, ...extra })).status, 400);
  assert.equal((await post('page/identity', body)).status, 200);
  assert.equal(updated.account, 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa');
  assert.equal(updated.id, session.session_id);
  assert.equal(
    (await post('page/identity', { ...body, user_id: null, user_name: null })).status,
    200,
  );
  assert.equal(updated.body.user_name, null);
});
