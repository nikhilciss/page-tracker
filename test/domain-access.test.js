import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fixture } from './helpers.js';
import { verifyDomain, publicIPv4 } from '../src/domain-access.js';

test('signup requires HTTP 200 before creating account; recording needs no API key', async (t) => {
  const f = await fixture({ verifier: verifyDomain });
  let code = 503;
  const host = createServer((req, res) => {
    assert.ok(['/', '/other'].includes(req.url));
    res.writeHead(code, { Location: '/other' });
    res.end('page');
  });
  await new Promise((r) => host.listen(0, '127.0.0.1', r));
  const origin = 'http://127.0.0.1:' + host.address().port;
  f.config.localVerificationOrigins = [origin];
  t.after(async () => {
    await new Promise((r) => host.close(r));
    await f.close();
  });
  const post = (path, body, requestOrigin = f.url) =>
    fetch(f.url + path, {
      method: 'POST',
      headers: { Origin: requestOrigin, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  const body = {
    name: 'Company',
    email: 'signup@example.test',
    password: 'test-password-1234',
    company_domain: origin,
  };
  const before = f.accounts.size;
  for (const status of [503, 302, 404]) {
    code = status;
    const response = await post('/api/auth/signup', body);
    assert.equal(response.status, 400);
    assert.equal(response.headers.get('set-cookie'), null);
    assert.equal(f.accounts.size, before);
  }
  code = 200;
  const response = await post('/api/auth/signup', body);
  assert.equal(response.status, 200);
  const { user } = await response.json();
  assert.ok(f.accounts.get(user.id).domain_verified_at);
  assert.equal(f.accounts.get(user.id).api_key_hash, undefined);
  assert.equal((await post('/api/track/init', { page_url: origin + '/page' }, origin)).status, 201);
  assert.equal(
    (
      await post(
        '/api/track/init',
        { page_url: 'https://unknown.example/page' },
        'https://unknown.example',
      )
    ).status,
    403,
  );
  for (const path of [
    '/api/account/integration/key',
    '/api/account/integration/revoke',
    '/api/server/authorize',
  ])
    assert.equal((await post(path, {})).status, 404);
});

test('availability checks reject private destinations unless explicitly allowed', async () => {
  for (const ip of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '192.168.1.1', '::1'])
    assert.equal(publicIPv4(ip), false);
  await assert.rejects(verifyDomain('http://127.0.0.1', null, 'http'));
});

test('availability follows bounded same-origin redirects and rejects foreign redirects', async () => {
  let mode = 'login';
  const host = createServer((req, res) => {
    if (mode === 'login' && req.url === '/login') return res.end('Login');
    res.writeHead(302, {
      Location: mode === 'foreign' ? 'http://example.test/login' : mode === 'loop' ? '/' : '/login',
    });
    res.end();
  });
  await new Promise((r) => host.listen(0, '127.0.0.1', r));
  const origin = 'http://127.0.0.1:' + host.address().port;
  try {
    assert.equal(await verifyDomain(origin, null, 'http', [origin]), true);
    mode = 'foreign';
    assert.equal(await verifyDomain(origin, null, 'http', [origin]), false);
    mode = 'loop';
    assert.equal(await verifyDomain(origin, null, 'http', [origin]), false);
  } finally {
    await new Promise((r) => host.close(r));
  }
});
