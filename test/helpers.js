import { summarize } from '../src/dashboard.js';
import { signGrant } from '../src/auth.js';
import { hashPassword } from '../src/accounts.js';
import { createVideoService } from '../src/video.js';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { recordingStore } from '../src/storage.js';

export async function fixture(options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'universal-tracker-test-'));
  const rows = new Map(),
    accounts = new Map(),
    loginSessions = new Map();
  const defaultAccount = {
    id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
    name: 'Test Owner',
    domain_verified_at: new Date(),
    api_key_hash: 'fixture-key',
    key_version: 1,
    email: 'owner@example.test',
    company_origin: 'https://allowed.example',
    password_hash: await hashPassword('test-password-1234'),
  };
  accounts.set(defaultAccount.id, defaultAccount);
  const consumedGrants = new Set();
  const repository = {
    async integration(id) {
      return accounts.get(id);
    },
    async ensureChallenge(id, token) {
      accounts.get(id).verification_token ||= token;
    },
    async verifyDomain(id) {
      const a = accounts.get(id);
      a.domain_verified_at = new Date();
    },
    async rotateKey(id, hash, encrypted) {
      const a = accounts.get(id);
      if (!a.domain_verified_at) return 0;
      a.api_key_hash = hash;
      a.api_key_encrypted = encrypted;
      a.key_version = (a.key_version || 0) + 1;
      return 1;
    },
    async revokeKey(id) {
      const a = accounts.get(id);
      a.api_key_hash = null;
      a.api_key_encrypted = null;
      a.key_version = (a.key_version || 0) + 1;
    },
    async ownerByKey(hash) {
      return [...accounts.values()].find(
        (a) => a.api_key_hash === hash && a.domain_verified_at && !a.is_master,
      );
    },
    async consumeGrant(id) {
      if (consumedGrants.has(id)) return false;
      consumedGrants.add(id);
      return true;
    },

    async createAccount(user) {
      if (
        [...accounts.values()].some(
          (a) => a.email === user.email || a.company_origin === user.company_origin,
        )
      )
        throw Object.assign(new Error('Duplicate account'), { code: 'ER_DUP_ENTRY' });
      accounts.set(user.id, user);
    },
    async accountById(id) {
      return accounts.get(id);
    },
    async companies(limit, offset) {
      const values = [...accounts.values()].filter((a) => !a.is_master);
      return {
        total: values.length,
        companies: values.slice(offset, offset + limit).map((a) => ({
          id: a.id,
          name: a.name,
          email: a.email,
          company_origin: a.company_origin,
          created_at: new Date().toISOString(),
          session_count: [...rows.values()].filter((row) => row.account_id === a.id).length,
        })),
      };
    },
    async accountByEmail(email) {
      return [...accounts.values()].find((a) => a.email === email);
    },
    async ownerByOrigin(origin) {
      const owner =
        [...accounts.values()].find((a) => a.company_origin === origin) ||
        (config.allowedOrigins.has(origin) ? defaultAccount : undefined);
      return owner?.domain_verified_at ? owner : undefined;
    },
    async createLoginSession(hash, accountId, expiry) {
      loginSessions.set(hash, { accountId, expiry });
    },
    async loginSession(hash) {
      const session = loginSessions.get(hash);
      return session && session.expiry > new Date() ? accounts.get(session.accountId) : undefined;
    },
    async deleteLoginSession(hash) {
      loginSessions.delete(hash);
    },
    async ping() {},
    async insert(row) {
      if (
        [...rows.values()].some(
          (r) => r.session_id === row.session_id && r.form_key === row.form_key,
        )
      ) {
        const error = new Error('Duplicate');
        error.code = 'ER_DUP_ENTRY';
        throw error;
      }
      rows.set(row.id, { ...row, created_at: new Date().toISOString() });
    },
    async findSession(session, form) {
      return [...rows.values()].find((r) => r.session_id === session && r.form_key === form);
    },
    async get(id) {
      return rows.get(id);
    },
    async list(limit, offset, accountId) {
      const values = [...rows.values()].filter((row) => row.account_id === accountId).reverse();
      return {
        recordings: values.slice(offset, offset + limit),
        stats: {
          total: values.length,
          guests: values.filter((row) => !row.user_id).length,
          average_duration_ms:
            values.reduce((sum, row) => sum + row.duration_ms, 0) / (rows.size || 1),
          storage_bytes: values.reduce((sum, row) => sum + row.size_bytes, 0),
        },
      };
    },
  };
  repository.dashboard = options.dashboard || {
    async overview() {
      return {
        ...summarize([], [], [], [], new Date()),
        projects: [],
        options: { browser: [], device: [] },
        sessions: [],
        total: 0,
      };
    },
  };
  if (options.context) repository.context = options.context;
  if (options.semantic) repository.semantic = options.semantic;
  if (options.analytics) repository.analytics = options.analytics;
  const config = {
    publicOrigin: 'http://127.0.0.1',
    secret: 'session-test-secret'.repeat(4),
    adminToken: 'admin-test-secret'.repeat(4),
    recordingsDir: directory,
    videoFormat: options.videoFormat || 'mp4',
    videoMaxSeconds: 10,
    videoFps: 5,
    sessionTtl: 14400,
    allowedOrigins: new Set(['https://allowed.example']),
    trustProxy: 0,
  };
  const store = recordingStore(directory);
  const videos = options.video ? createVideoService({ config, repository, store }) : undefined;
  const app = createApp({
    config,
    repository,
    store,
    videos,
    logger: { error() {} },
    verifier: options.verifier || (async () => true),
  });
  const server = await new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  config.allowedOrigins.add(url);
  config.publicOrigin = url;
  const login = await fetch(url + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: url },
    body: JSON.stringify({ email: defaultAccount.email, password: 'test-password-1234' }),
  });
  const authCookie = login.headers.get('set-cookie').split(';')[0];
  const grant = (pageUrl) => {
    const page = new URL(pageUrl);
    const owner =
      [...accounts.values()].find((a) => a.company_origin === page.origin) || defaultAccount;
    return signGrant(
      {
        account_id: owner.id,
        origin: page.origin,
        page_url: page.origin + page.pathname,
        key_version: owner.key_version,
      },
      config,
    );
  };
  const authorizeBrowser = (browser) => {
    const original = browser.newPage.bind(browser);
    browser.newPage = async (...args) => {
      const page = await original(...args);
      await page.route('**/page-tracker/token', (route) =>
        route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({ token: grant(route.request().postDataJSON().page_url) }),
        }),
      );
      return page;
    };
  };
  return {
    grant,
    authorizeBrowser,
    config,
    authCookie,
    accounts,
    loginSessions,
    repository,
    store,
    videos,
    rows,
    url,
    directory,
    async close() {
      await app.locals.pageSessions.close();
      await videos?.close();
      await new Promise((resolve) => server.close(resolve));
      await rm(directory, { recursive: true, force: true });
    },
  };
}
export const sampleField = {
  key: 'field-1',
  name: 'first_name',
  type: 'text',
  value: 'Alex',
  masked: false,
};
export const sampleRect = { x: 20, y: 20, width: 400, height: 300 };
export function payload(token, overrides = {}) {
  return {
    token,
    form_key: 'form-1',
    form_id: 'contact',
    user_id: null,
    duration_ms: 1000,
    truncated: false,
    fields: [sampleField],
    events: [
      {
        t: 0,
        type: 'snapshot',
        rect: sampleRect,
        controls: [{ ...sampleField, label: 'First name', rect: sampleRect }],
      },
      { t: 500, type: 'input', field: sampleField },
      { t: 1000, type: 'submit' },
    ],
    ...overrides,
  };
}
