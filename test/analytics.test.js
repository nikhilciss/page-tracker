import test from 'node:test';
import assert from 'node:assert/strict';
import { visitorCredential, readVisitor, identifiedVisitor } from '../src/analytics.js';
import { fixture } from './helpers.js';

test('visitor credentials cannot cross accounts, origins or accept tampering', () => {
  const id = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
  const token = visitorCredential(id, 'account-a', 'https://one.example', 'secret');
  assert.equal(readVisitor(token, 'account-a', 'https://one.example', 'secret'), id);
  assert.equal(readVisitor(token, 'account-b', 'https://one.example', 'secret'), null);
  assert.equal(readVisitor(token, 'account-a', 'https://two.example', 'secret'), null);
  assert.equal(readVisitor(token + 'x', 'account-a', 'https://one.example', 'secret'), null);
});
test('analytics authorization derives ownership from signed recording context', async (t) => {
  let received;
  const f = await fixture({
    analytics: {
      async start(input) {
        received = input;
        return {
          visitor_id: input.visitor,
          session_id: 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb',
          page_id: 'cccccccc-cccc-4ccc-cccc-cccccccccccc',
        };
      },
      async get(account) {
        assert.equal(account, 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa');
        return null;
      },
    },
  });
  t.after(() => f.close());
  const post = (path, body) =>
    fetch(f.url + path, {
      method: 'POST',
      headers: { Origin: 'https://allowed.example', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  const recording = await (
    await post('/api/track/init', { page_url: 'https://allowed.example/page?secret=abc' })
  ).json();
  assert.equal(
    (await post('/api/track/analytics/start', { token: recording.token, account_id: 'forged' }))
      .status,
    400,
  );
  assert.equal((await post('/api/track/analytics/start', { token: 'invalid' })).status, 401);
  const response = await post('/api/track/analytics/start', { token: recording.token });
  assert.equal(response.status, 200);
  assert.equal(received.account, 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa');
  assert.equal(received.url, 'https://allowed.example/page');
  assert.equal(f.rows.size, 0);
  const url = f.url + '/api/admin/sessions/bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
  assert.equal((await fetch(url)).status, 401);
  assert.equal((await fetch(url, { headers: { Cookie: f.authCookie } })).status, 404);
});

test('different host accounts in one browser receive isolated stable visitor identities', async (t) => {
  const inputs = [];
  const f = await fixture({
    analytics: {
      async start(input) {
        inputs.push(input);
        return { visitor_id: input.visitor, session_id: input.visitor, page_id: input.recording };
      },
    },
  });
  t.after(() => f.close());
  const post = async (path, body) => {
    const response = await fetch(f.url + '/api/track/' + path, {
      method: 'POST',
      headers: { Origin: 'https://allowed.example', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(response.ok, true);
    return response.json();
  };
  async function start(id, visitor_token) {
    const recording = await post('init', {
      page_url: 'https://allowed.example/page',
      ...(id ? { user_id: id } : {}),
    });
    return post('analytics/start', {
      token: recording.token,
      ...(visitor_token ? { visitor_token } : {}),
    });
  }
  const anon = await start();
  const a = await start('user-a', anon.visitor_token);
  const b = await start('user-b', a.visitor_token);
  const again = await start('user-a', b.visitor_token);
  const logout = await start(null, b.visitor_token);
  assert.notEqual(a.visitor_id, b.visitor_id);
  assert.notEqual(a.session_id, b.session_id);
  assert.equal(a.visitor_id, again.visitor_id);
  assert.notEqual(anon.visitor_id, a.visitor_id);
  assert.notEqual(logout.visitor_id, b.visitor_id);
  assert.notEqual(logout.visitor_id, a.visitor_id);
  assert(inputs.every((i) => i.account === 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'));
});

test('host visitor derivation is tenant/origin scoped and ignores invalid identities', () => {
  const a = identifiedVisitor('user-1', 'tenant-a', 'https://one.example', 'secret');
  assert.equal(a, identifiedVisitor(' user-1 ', 'tenant-a', 'https://one.example', 'secret'));
  assert.notEqual(a, identifiedVisitor('user-1', 'tenant-b', 'https://one.example', 'secret'));
  assert.notEqual(a, identifiedVisitor('user-1', 'tenant-a', 'https://two.example', 'secret'));
  for (const value of [null, '', '  ', 42, 'x'.repeat(161)])
    assert.equal(identifiedVisitor(value, 'a', 'b', 'secret'), null);
});
