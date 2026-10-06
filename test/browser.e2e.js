import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { fixture } from './helpers.js';

test('legacy opt-in form integration', { timeout: 90000 }, async (t) => {
  const f = await fixture();
  const executablePath =
    process.env.CHROME_PATH ||
    (existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined);
  const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
  f.authorizeBrowser(browser);
  t.after(async () => {
    await browser.close();
    await f.close();
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(8000);
  await page.route('**/demo.html', async (route) => {
    const response = await route.fetch();
    const body = (await response.text())
      .replace('src="/tracker.js"', 'src="/tracker.js" data-recording-mode="form"')
      .replace('id="contact-demo"', 'id="contact-demo" data-recording-enabled="true"');
    await route.fulfill({ response, body });
  });
  const addLegacyTracker = () =>
    page.evaluate(
      (url) =>
        new Promise((resolve) => {
          const script = document.createElement('script');
          script.src = url;
          script.dataset.recordingMode = 'form';
          script.onload = resolve;
          document.head.append(script);
        }),
      `${f.url}/tracker.js`,
    );
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const requests = [];
  page.on('request', (req) => {
    if (req.url().includes('/api/track/submit')) requests.push(JSON.parse(req.postData()));
  });
  const fill = async () => {
    await page.locator('[name=first_name]').fill('Alex');
    await page.locator('[name=last_name]').fill('Morgan');
    await page.locator('[name=email]').fill('alex@example.com');
    await page.locator('[name=project_type]').selectOption('Product research');
  };
  await t.test('abandonment uploads nothing; reload creates a fresh session', async () => {
    const first = page.waitForResponse((res) => res.url().endsWith('/api/track/init'));
    await page.goto(`${f.url}/demo.html`);
    const a = await (await first).json();
    await fill();
    const second = page.waitForResponse((res) => res.url().endsWith('/api/track/init'));
    await page.reload();
    const b = await (await second).json();
    assert.notEqual(a.session_id, b.session_id);
    assert.equal(f.rows.size, 0);
    assert.equal(requests.length, 0);
  });
  await t.test(
    'submission saves redacted events then preserves action, values and submitter',
    async () => {
      await fill();
      await page.locator('[name=private_reference]').fill('never-save-this');
      await page.evaluate(() => {
        const form = document.querySelector('form');
        form.dataset.userId = 'user-42';
        const password = document.createElement('input');
        password.type = 'password';
        password.name = 'password';
        password.value = 'never-save-this';
        form.append(password);
      });
      const destination = page.waitForRequest((req) => req.url().endsWith('/demo/complete'));
      await page.getByRole('button', { name: 'Send inquiry' }).click();
      await page.waitForURL('**/complete.html');
      const native = await destination;
      assert.equal(native.method(), 'POST');
      assert.ok(native.postData().includes('intent=contact'));
      assert.ok(native.postData().includes('first_name=Alex'));
      assert.equal(f.rows.size, 1);
      assert.equal(requests.length, 1);
      assert.ok(!JSON.stringify(requests[0]).includes('never-save-this'));
      assert.equal(requests[0].user_id, 'user-42');
      const stored = await f.store.read([...f.rows.keys()][0]);
      assert.ok(stored.events.some((event) => event.type === 'input'));
      assert.equal(stored.events.at(-1).type, 'submit');
    },
  );
  await t.test('admin library offers video playback only', async () => {
    await page.goto(f.url);
    await page.getByLabel('Email', { exact: true }).fill('owner@example.test');
    await page.getByLabel('Password', { exact: true }).fill('test-password-1234');
    await page.getByRole('button', { name: 'Log in', exact: true }).click();
    await page.locator('#legacy summary').click();
    await page.locator('#recordings a').first().waitFor();
    assert.equal(await page.getByRole('button', { name: 'Play ↗' }).count(), 0);
  });
  await t.test(
    'dynamic forms, ignored fields, duplicate scripts and AJAX submit handlers work',
    async () => {
      await page.goto(`${f.url}/complete.html`);
      await addLegacyTracker();
      await addLegacyTracker();
      await page.evaluate(() => {
        const form = document.createElement('form');
        form.id = 'dynamic';
        form.dataset.recordingEnabled = 'true';
        form.innerHTML =
          '<input name="submit" value="safe"><input name="ignored" data-recording-ignore value="never-record"><button name="save" value="yes">Save dynamic</button>';
        window.hostSubmits = 0;
        form.addEventListener('submit', (event) => {
          event.preventDefault();
          window.hostSubmits++;
          window.hostSubmitter = event.submitter?.value;
        });
        document.body.append(form);
      });
      const saved = page.waitForResponse((res) => res.url().endsWith('/api/track/submit'));
      await page.getByRole('button', { name: 'Save dynamic' }).click();
      assert.equal((await saved).status(), 201);
      await page.waitForFunction(() => window.hostSubmits === 1);
      assert.equal(await page.evaluate(() => window.hostSubmitter), 'yes');
      assert.ok(!JSON.stringify(requests.at(-1)).includes('never-record'));
      assert.equal(f.rows.size, 2);
      await page.getByRole('button', { name: 'Save dynamic' }).click();
      assert.equal(await page.evaluate(() => window.hostSubmits), 2);
      assert.equal(f.rows.size, 2);
    },
  );
  await t.test(
    'tracker failure remains silent and allows the host submit handler once',
    async () => {
      await page.goto(`${f.url}/demo.html`);
      await fill();
      await page.evaluate(() => {
        window.hostSubmits = 0;
        document.querySelector('form').addEventListener('submit', (event) => {
          event.preventDefault();
          window.hostSubmits++;
        });
      });
      await page.route('**/api/track/submit', (route) =>
        route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }),
      );
      await page.getByRole('button', { name: 'Send inquiry' }).click();
      await page.waitForFunction(() => window.hostSubmits === 1);
      assert.equal(f.rows.size, 2);
      await page.unroute('**/api/track/submit');
    },
  );
  await t.test('unmarked forms remain untouched', async () => {
    await page.goto(`${f.url}/demo.html`);
    await fill();
    const count = requests.length;
    await page.evaluate(() => {
      document.querySelector('form').removeAttribute('data-recording-enabled');
    });
    await page.getByRole('button', { name: 'Send inquiry' }).click();
    await page.waitForURL('**/complete.html');
    assert.equal(requests.length, count);
  });
  await t.test(
    'a script tag works on a separate host origin with two independent forms',
    async () => {
      const host = createServer((_req, res) => {
        res.setHeader('Content-Type', 'text/html');
        res.end(`<!doctype html><html><head><script src="${f.url}/tracker.js" data-recording-mode="form" defer></script></head><body>
        <form id="external-one" data-recording-enabled="true"><input name="name" value="Visitor"><button>First</button></form>
        <form id="external-two" data-recording-enabled="true"><input name="message" value="Hello"><button>Second</button></form>
        <script>document.addEventListener('submit', event => event.preventDefault());</script>
      </body></html>`);
      });
      await new Promise((resolve) => host.listen(0, '127.0.0.1', resolve));
      const origin = `http://127.0.0.1:${host.address().port}`;
      f.config.allowedOrigins.add(origin);
      try {
        await page.goto(origin);
        for (const name of ['First', 'Second']) {
          const saved = page.waitForResponse((res) => res.url().endsWith('/api/track/submit'));
          await page.getByRole('button', { name, exact: true }).click();
          assert.equal((await saved).status(), 201);
        }
        const rows = [...f.rows.values()].filter((row) => row.page_url.startsWith(origin));
        assert.equal(rows.length, 2);
        assert.equal(rows[0].session_id, rows[1].session_id);
        assert.notEqual(rows[0].form_key, rows[1].form_key);
        assert.equal(rows[0].user_id, null);
      } finally {
        await new Promise((resolve) => host.close(resolve));
      }
    },
  );
  await t.test('a stalled upload obeys the deadline and fail-closed can be retried', async () => {
    await page.goto(`${f.url}/demo.html`);
    await fill();
    await page.evaluate(() => {
      window.hostSubmits = 0;
      document.querySelector('form').dataset.recordingFailClosed = 'true';
      document.querySelector('form').addEventListener('submit', (event) => {
        event.preventDefault();
        window.hostSubmits++;
      });
      document.querySelector('form').addEventListener('recording:complete', (event) => {
        window.recordingStatus = event.detail.status;
      });
    });
    await page.route('**/api/track/submit', () => {});
    const start = Date.now();
    await page.getByRole('button', { name: 'Send inquiry' }).click();
    await page.waitForFunction(() => window.recordingStatus === 'error');
    assert.ok(Date.now() - start < 5000);
    assert.equal(await page.evaluate(() => window.hostSubmits), 0);
    await page.unroute('**/api/track/submit');
    await page.getByRole('button', { name: 'Send inquiry' }).click();
    await page.waitForFunction(
      () => window.hostSubmits === 1 && window.recordingStatus === 'saved',
    );
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(f.url);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: '/tmp/universal-tracker-mobile.png', fullPage: true });
  assert.deepEqual(errors, []);
});
