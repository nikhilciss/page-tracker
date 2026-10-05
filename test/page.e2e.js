import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { fixture } from './helpers.js';

test(
  'script-only page recording across ordinary sites and navigation types',
  { timeout: 90000 },
  async (t) => {
    const f = await fixture();
    const browser = await chromium.launch({
      executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
      chromiumSandbox: true,
    });
    f.authorizeBrowser(browser);
    const host = createServer((req, res) => {
      res.setHeader('Content-Type', 'text/html');
      if (req.url.startsWith('/done.php') || req.url.startsWith('/next.php'))
        return res.end('<html><body>Destination</body></html>');
      res.end(`<!doctype html><html><head><title>Existing project page</title><script src="${f.url}/tracker.js" data-user-id="visitor-7" data-user-name="Visitor Seven" defer></script></head>
      <body><h1>Page recording without form attributes</h1>
      <label>Notes<input name="notes"></label><input name="password" type="password">
      <button id="reload" onclick="location.reload()">Native JS reload</button>
      <button id="ajax" onclick="document.querySelector('h1').textContent='Page updated'">Update page</button>
      <a href="/next.php" id="next">Next page</a><a href="#section" id="hash">Section</a>
      ${req.url.startsWith('/form.php') ? '<form action="/done.php" method="post"><input name="first_name" value="Alex"><input type="hidden" name="handler_count" value="0"><button type="submit" name="intent" value="save" formaction="/done.php?button=1">Submit existing form</button></form><script>document.querySelector("form").addEventListener("submit",event=>{document.querySelector("[name=handler_count]").value=Number(document.querySelector("[name=handler_count]").value)+1;});</script>' : ''}
      </body></html>`);
    });
    await new Promise((resolve) => host.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${host.address().port}`;
    f.config.allowedOrigins.add(origin);
    t.after(async () => {
      await browser.close();
      await new Promise((resolve) => host.close(resolve));
      await f.close();
    });
    const errors = [];
    async function open(path = '/plain.php') {
      const page = await browser.newPage();
      page.setDefaultTimeout(10000);
      page.on('pageerror', (error) => errors.push(error.message));
      const init = page.waitForResponse((res) => res.url().endsWith('/api/track/init'));
      await page.goto(origin + path);
      const session = await (await init).json();
      assert.equal(
        (await page.evaluate(() => UniversalTracker.checkpoint())).status,
        'checkpointed',
      );
      return { page, session };
    }
    async function saved(session) {
      for (let i = 0; i < 100; i++) {
        const row = await f.repository.findSession(session.session_id, 'page');
        if (row) return row;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.fail('Page session was not finalized');
    }
    await t.test('starts with no forms, masks fields, and saves before a normal link', async () => {
      const { page, session } = await open();
      assert.equal(await page.locator('form').count(), 0);
      assert.equal(await f.repository.findSession(session.session_id, 'page'), undefined);
      await page.locator('[name=notes]').fill('Whole page notes');
      await page.locator('[name=password]').fill('do-not-save-password');
      await page.locator('#ajax').click();
      await page.locator('#next').click();
      await page.waitForURL('**/next.php');
      const row = await saved(session),
        recording = await f.store.read(row.id);
      assert.equal(recording.scope, 'page');
      assert.equal(recording.save_reason, 'link');
      assert.equal(recording.user_id, 'visitor-7');
      assert.equal(recording.user_name, 'Visitor Seven');
      assert.ok(JSON.stringify(recording).includes('Whole page notes'));
      assert.ok(!JSON.stringify(recording).includes('do-not-save-password'));
      await page.close();
    });
    for (const interaction of ['none', 'input', 'button', 'cancelled form']) {
      await t.test('browser refresh does not save after ' + interaction, async () => {
        const { page, session } = await open('/form.php');
        const finishes = [];
        page.on('request', (request) => {
          if (request.url().endsWith('/page/finish')) finishes.push(request.url());
        });
        if (interaction === 'input') await page.locator('[name=notes]').fill('Unsaved');
        if (interaction === 'button') await page.locator('#ajax').click();
        if (interaction === 'cancelled form') {
          await page.evaluate(() =>
            document
              .querySelector('form')
              .addEventListener('submit', (event) => event.preventDefault()),
          );
          await page.getByRole('button', { name: 'Submit existing form' }).click();
        }
        await page.reload();
        await page.waitForTimeout(300);
        assert.deepEqual(finishes, []);
        assert.equal(await f.repository.findSession(session.session_id, 'page'), undefined);
        await page.close();
      });
    }
    await t.test(
      'direct JavaScript reload finalizes the latest checkpoint and starts a fresh session',
      async () => {
        const { page, session } = await open();
        await page.locator('[name=notes]').fill('Before direct reload');
        await page.evaluate(() => UniversalTracker.checkpoint());
        const init = page.waitForResponse((res) => res.url().endsWith('/api/track/init'));
        await page.locator('#reload').click();
        await page.waitForLoadState();
        const next = await (await init).json();
        assert.notEqual(next.session_id, session.session_id);
        const recording = await f.store.read((await saved(session)).id);
        assert.equal(recording.save_reason, 'pagehide');
        assert.ok(JSON.stringify(recording).includes('Before direct reload'));
        await page.close();
      },
    );
    await t.test(
      'unmarked native forms preserve the destination, submitter and run host handlers once',
      async () => {
        const { page, session } = await open('/form.php');
        const destination = page.waitForRequest((req) => req.url().includes('/done.php'));
        await page.getByRole('button', { name: 'Submit existing form' }).click();
        await page.waitForURL('**/done.php?button=1');
        const request = await destination;
        assert.equal(request.method(), 'POST');
        assert.match(request.postData(), /intent=save/);
        assert.match(request.postData(), /handler_count=1/);
        assert.match(request.postData(), /first_name=Alex/);
        assert.equal((await f.store.read((await saved(session)).id)).save_reason, 'form');
        await page.close();
      },
    );
    await t.test(
      'cancelled AJAX forms and hash links stay active; explicit save is idempotent',
      async () => {
        const { page, session } = await open('/form.php');
        await page.evaluate(() => {
          document
            .querySelector('form')
            .addEventListener('submit', (event) => event.preventDefault());
        });
        await page.getByRole('button', { name: 'Submit existing form' }).click();
        await page.locator('#hash').click();
        assert.equal(await f.repository.findSession(session.session_id, 'page'), undefined);
        const a = await page.evaluate(() => UniversalTracker.save());
        const b = await page.evaluate(() => UniversalTracker.save());
        assert.equal(a.status, 'saved');
        assert.equal(a.recordingId, b.recordingId);
        assert.equal((await f.store.read((await saved(session)).id)).save_reason, 'manual');
        await page.close();
      },
    );
    await t.test('explicit reload flushes current actions before navigating', async () => {
      const { page, session } = await open();
      await page.locator('[name=notes]').fill('Latest action before reload');
      const navigated = page.waitForNavigation({ waitUntil: 'domcontentloaded' });
      await page.evaluate(() => {
        UniversalTracker.reload();
      });
      await navigated;
      await saved(session);
      const recording = await f.store.read((await saved(session)).id);
      assert.equal(recording.save_reason, 'reload');
      assert.ok(JSON.stringify(recording).includes('Latest action before reload'));
      await page.close();
    });
    await t.test(
      'a failing backend never blocks a normal navigation beyond the save deadline',
      async () => {
        const { page } = await open();
        await page.route('**/api/track/page/checkpoint', (route) =>
          route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }),
        );
        const start = Date.now();
        await page.locator('#next').click();
        await page.waitForURL('**/next.php');
        assert.ok(Date.now() - start < 5000);
        await page.close();
      },
    );
    assert.deepEqual(errors, []);
  },
);
