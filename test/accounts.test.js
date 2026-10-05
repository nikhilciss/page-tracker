import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, payload } from './helpers.js';
import { normalizeOrigin } from '../src/accounts.js';

test('accounts: signup, session cookies, tenant isolation, CSRF, logout and origin ownership', async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const post = (path, body, cookie, origin = f.url) =>
    fetch(f.url + path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: origin,
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: JSON.stringify(
        path === '/api/track/init' ? { ...body, authorization: f.grant(body.page_url) } : body,
      ),
    });
  assert.equal(normalizeOrigin('Company.example'), 'https://company.example');
  assert.throws(() => normalizeOrigin('https://company.example/path'));
  assert.throws(() => normalizeOrigin('https://user:pass@company.example'));
  const signup = {
    name: 'Company Owner',
    email: 'new@example.test',
    password: 'strong-password-123',
    company_domain: 'http://php-project.test:8080',
  };
  assert.equal((await post('/api/auth/signup', { ...signup, password: 'short' })).status, 400);
  const response = await post('/api/auth/signup', signup);
  assert.equal(response.status, 200);
  const cookieHeader = response.headers.get('set-cookie');
  assert.match(cookieHeader, /HttpOnly/i);
  assert.match(cookieHeader, /SameSite=Strict/i);
  const cookie = cookieHeader.split(';')[0];
  const user = (await response.json()).user;
  assert.equal(user.company_origin, signup.company_domain);
  assert.equal(user.password_hash, undefined);
  assert.notEqual(f.accounts.get(user.id).password_hash, signup.password);
  assert.equal(
    (await post('/api/auth/signup', { ...signup, email: 'different@example.test' })).status,
    409,
  );
  assert.equal(
    (await post('/api/auth/login', { email: signup.email, password: 'wrong' })).status,
    401,
  );
  assert.equal(
    (await post('/api/auth/logout', {}, cookie, 'https://attacker.example')).status,
    403,
  );
  Object.assign(f.accounts.get(user.id), {
    domain_verified_at: new Date(),
    api_key_hash: 'test-key',
    key_version: 1,
  });
  const init = await post(
    '/api/track/init',
    { page_url: signup.company_domain + '/form.php' },
    null,
    signup.company_domain,
  );
  assert.equal(init.status, 201);
  const session = await init.json();
  const submitted = await post(
    '/api/track/submit',
    payload(session.token),
    null,
    signup.company_domain,
  );
  assert.equal(submitted.status, 201);
  const id = (await submitted.json()).recording_id;
  const get = (path, sessionCookie) => fetch(f.url + path, { headers: { Cookie: sessionCookie } });
  assert.equal((await get('/api/admin/recordings/' + id, cookie)).status, 200);
  const own = await (await get('/api/admin/recordings', cookie)).json();
  assert.equal(own.recordings.length, 1);
  const other = await (await get('/api/admin/recordings', f.authCookie)).json();
  assert.equal(other.recordings.length, 0);
  for (const suffix of ['', '/video', '/video/status'])
    assert.equal((await get('/api/admin/recordings/' + id + suffix, f.authCookie)).status, 404);
  assert.equal(
    (await post('/api/admin/recordings/' + id + '/video/retry', {}, f.authCookie)).status,
    404,
  );
  assert.equal(
    (
      await fetch(f.url + '/api/admin/recordings', {
        headers: { Authorization: 'Bearer anything' },
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await post(
        '/api/track/init',
        { page_url: 'https://unregistered.test' },
        null,
        'https://unregistered.test',
      )
    ).status,
    403,
  );
  const login = await post(
    '/api/auth/login',
    { email: signup.email, password: signup.password },
    cookie,
  );
  const rotated = login.headers.get('set-cookie').split(';')[0];
  assert.notEqual(rotated, cookie);
  assert.equal((await get('/api/auth/me', cookie)).status, 401);
  assert.equal((await get('/api/auth/me', rotated)).status, 200);
  assert.equal((await post('/api/auth/logout', {}, rotated)).status, 200);
  assert.equal((await get('/api/auth/me', rotated)).status, 401);
});
