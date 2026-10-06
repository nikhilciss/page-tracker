import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { fixture } from './helpers.js';
import { identityContext } from '../src/context.js';

test(
  'explicit host identity: data layer, marked fields, late updates, logout, legacy mode and redaction',
  { timeout: 45000 },
  async (t) => {
    const contexts = new Map();
    const f = await fixture({
      context: {
        async save(account, id, value) {
          contexts.set(id, { account, ...value });
        },
        async updateIdentity(account, id, body) {
          const row = contexts.get(id);
          assert.equal(row.account, account);
          Object.assign(row, identityContext(body));
        },
      },
    });
    const host = createServer((req, res) => {
      res.setHeader('Content-Type', 'text/html');
      res.end(`<!doctype html><html><head><script>window.pageTrackerData={id:'  visitor-1  ',name:'  Visitor One  ',token:'DO-NOT-COPY'};</script><script src="${f.url}/tracker.js" ${req.url === '/legacy' ? 'data-recording-mode="form"' : ''} data-user-id="attribute-id" data-user-name="Attribute User" defer></script></head><body>
      <form data-recording-enabled="true"><input type="hidden" data-page-tracker-user-id value="hidden-id"><input type="hidden" data-page-tracker-user-name value="Hidden User"><input type="hidden" name="csrf_token" value="DO-NOT-COPY"><input name="name" value="Not The Logged In User"><button>Submit</button></form></body></html>`);
    });
    await new Promise((r) => host.listen(0, '127.0.0.1', r));
    const origin = 'http://127.0.0.1:' + host.address().port;
    f.config.allowedOrigins.add(origin);
    const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome' });
    t.after(async () => {
      await browser.close();
      await new Promise((r) => host.close(r));
      await f.close();
    });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const init = page.waitForResponse((r) => r.url().endsWith('/api/track/init'));
    await page.goto(origin + '/page');
    const session = await (await init).json();
    await page.waitForFunction(() => !!window.UniversalTracker);
    assert.equal(contexts.get(session.session_id).user_name, 'Visitor One');
    async function checkpoint() {
      assert.equal(
        (await page.evaluate(() => UniversalTracker.checkpoint())).status,
        'checkpointed',
      );
    }
    await checkpoint();
    assert.equal(contexts.get(session.session_id).user_id, 'visitor-1');
    await page.evaluate(() => delete window.pageTrackerData);
    await checkpoint();
    assert.equal(contexts.get(session.session_id).user_name, 'Hidden User');
    await page.evaluate(() =>
      document
        .querySelectorAll('[data-page-tracker-user-id],[data-page-tracker-user-name]')
        .forEach((e) => e.remove()),
    );
    await checkpoint();
    assert.equal(contexts.get(session.session_id).user_name, 'Attribute User');
    await page.evaluate(() => {
      window.pageTrackerData = { id: 'late-id', name: 'Late User' };
    });
    // Existing periodic checkpoints also pick up unannounced assignments.
    for (let i = 0; i < 40 && contexts.get(session.session_id).user_name !== 'Late User'; i++)
      await page.waitForTimeout(100);
    assert.equal(contexts.get(session.session_id).user_name, 'Late User');
    const changed = page.waitForResponse((r) => r.url().endsWith('/page/checkpoint'));
    await page.evaluate(() => {
      window.pageTrackerData = null;
      document.dispatchEvent(new Event('page-tracker:identity-change'));
    });
    await changed;
    await checkpoint();
    assert.equal(contexts.get(session.session_id).user_name, null);
    assert.equal(contexts.get(session.session_id).user_id, null);
    assert.equal(contexts.get(session.session_id).geo_status, 'private');
    const { recordingStore } = await import('../src/storage.js');
    const draft = await recordingStore(f.directory + '/.pending').read(session.session_id);
    assert.ok(!JSON.stringify(draft).includes('DO-NOT-COPY'));
    assert.ok(
      draft.fields.filter((x) => x.type === 'hidden').every((x) => x.value === '[REDACTED]'),
    );
    const finalized = await page.evaluate(() => UniversalTracker.save());
    assert.equal(finalized.status, 'saved');
    const afterSave = page.waitForResponse((r) => r.url().endsWith('/page/identity'));
    await page.evaluate(() => {
      window.pageTrackerData = { id: 'spa-id', name: 'SPA User' };
      window.dispatchEvent(new Event('page-tracker:identity-change'));
    });
    assert.equal((await afterSave).status(), 200);
    assert.equal(contexts.get(session.session_id).user_name, 'SPA User');
    assert.equal((await f.store.read(finalized.recordingId)).user_name, null);
    const legacyInit = page.waitForResponse((r) => r.url().endsWith('/api/track/init'));
    await page.goto(origin + '/legacy');
    const legacy = await (await legacyInit).json();
    assert.equal(contexts.get(legacy.session_id).user_name, 'Visitor One');
    const late = page.waitForResponse((r) => r.url().endsWith('/page/identity'));
    await page.evaluate(() => {
      window.pageTrackerData = { id: 'legacy-id', name: 'Legacy User' };
      window.dispatchEvent(new Event('page-tracker:identity-change'));
    });
    assert.equal((await late).status(), 200);
    assert.equal(contexts.get(legacy.session_id).user_name, 'Legacy User');
    const submit = page.waitForResponse((r) => r.url().endsWith('/api/track/submit'));
    await page.locator('button').click();
    assert.equal((await submit).status(), 201);
    const saved = [...f.rows.values()].find((row) => row.session_id === legacy.session_id);
    assert.equal((await f.store.read(saved.id)).user_id, 'legacy-id');
    assert.deepEqual(errors, []);
  },
);
