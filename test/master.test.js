import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { hashPassword } from '../src/accounts.js';
import { fixture, payload } from './helpers.js';
test('master access requires the database role; company isolation remains enforced', async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const master = {
    id: randomUUID(),
    name: 'Master Admin',
    email: 'admin@admin.com',
    password_hash: await hashPassword('admin@123'),
    company_origin: null,
    is_master: true,
  };
  f.accounts.set(master.id, master);
  const post = (url, body, cookie, origin = f.url) =>
    fetch(f.url + url, {
      method: 'POST',
      headers: {
        Origin: origin,
        'Content-Type': 'application/json',
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: JSON.stringify(
        url === '/api/track/init' ? { ...body, authorization: f.grant(body.page_url) } : body,
      ),
    });
  const get = (url, cookie) => fetch(f.url + url, { headers: cookie ? { Cookie: cookie } : {} });
  assert.equal((await get('/master/admin/login')).status, 200);
  assert.equal((await get('/api/master/companies')).status, 401);
  assert.equal((await get('/api/master/companies', f.authCookie)).status, 403);
  assert.equal(
    (
      await post('/api/auth/master/login', {
        email: 'owner@example.test',
        password: 'test-password-1234',
      })
    ).status,
    401,
  );
  assert.equal(
    (await post('/api/auth/login', { email: master.email, password: 'admin@123' })).status,
    401,
  );
  assert.equal(
    (await post('/api/auth/master/login', { email: master.email, password: 'wrong' })).status,
    401,
  );
  const login = await post('/api/auth/master/login', {
    email: master.email,
    password: 'admin@123',
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const registered = await post('/api/auth/signup', {
    name: 'Other Company',
    email: 'other@example.test',
    password: 'test-password-1234',
    company_domain: 'https://other.example',
  });
  const user = (await registered.json()).user;
  Object.assign(f.accounts.get(user.id), {
    domain_verified_at: new Date(),
    api_key_hash: 'test-key',
    key_version: 1,
  });
  const init = await post(
    '/api/track/init',
    { page_url: 'https://other.example/page' },
    null,
    'https://other.example',
  );
  const { token } = await init.json();
  const result = await post('/api/track/submit', payload(token), null, 'https://other.example');
  const id = (await result.json()).recording_id;
  const companies = await (await get('/api/master/companies', cookie)).json();
  assert.equal(companies.total, 2);
  assert.ok(!JSON.stringify(companies).includes('password_hash'));
  const sessions = await (await get('/api/master/companies/' + user.id, cookie)).json();
  assert.equal(sessions.recordings[0].id, id);
  const detail = await (await get('/api/admin/recordings/' + id, cookie)).json();
  assert.equal(detail.account_name, 'Other Company');
  assert.equal((await get('/api/admin/recordings/' + id + '/video/status', cookie)).status, 200);
  assert.equal((await get('/api/admin/recordings/' + id + '/video', cookie)).status, 409);
  assert.equal((await get('/api/admin/recordings/' + id, f.authCookie)).status, 404);
  assert.equal((await get('/api/master/companies/' + user.id, f.authCookie)).status, 403);
  assert.equal(
    (
      await post('/api/auth/signup', {
        name: 'Escalate',
        email: 'escalate@example.test',
        password: 'test-password-1234',
        company_domain: 'https://escalate.example',
        is_master: true,
      })
    ).status,
    400,
  );
  assert.equal((await post('/api/auth/logout', {}, cookie)).status, 200);
  assert.equal((await get('/api/master/companies', cookie)).status, 401);
});
