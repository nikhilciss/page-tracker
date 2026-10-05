import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { fixture } from './helpers.js';

test('MVC body, footer, late partial, module and evaluated script integration', async (t) => {
  const f = await fixture();
  const browser = await chromium.launch({
    executablePath: '/usr/bin/google-chrome',
    chromiumSandbox: true,
  });
  f.authorizeBrowser(browser);
  t.after(async () => {
    await browser.close();
    await f.close();
  });
  for (const placement of ['body', 'footer', 'late', 'module', 'evaluated']) {
    await t.test(placement, async () => {
      const page = await browser.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      const tag = `<script data-universal-tracker src="${f.url}/tracker.js" ${placement === 'module' ? 'type="module"' : ''}></script>`;
      await page.route('**/mvc-view', (route) =>
        route.fulfill({
          contentType: 'text/html',
          body: `<!doctype html><html><head><title>MVC view</title></head><body>${placement === 'body' ? tag : ''}<main><form action="/complete.html"><input name="name" value="MVC visitor"><button>Save</button></form></main>${['footer', 'module'].includes(placement) ? tag : ''}</body></html>`,
        }),
      );
      await page.goto(f.url + '/mvc-view');
      if (placement === 'late')
        await page.evaluate((src) => {
          const partial = document.createElement('section');
          partial.innerHTML = '<p>Late rendered partial</p>';
          document.body.append(partial);
          const script = document.createElement('script');
          script.src = src;
          script.dataset.universalTracker = '';
          partial.append(script);
        }, f.url + '/tracker.js');
      if (placement === 'evaluated')
        await page.evaluate(async (src) => {
          const partial = document.createElement('section');
          partial.innerHTML = '<script data-universal-tracker src="' + src + '"><\/script>';
          document.body.append(partial);
          // Model a partial loader that executes the fetched script without currentScript.
          (0, eval)(await (await fetch(src)).text());
        }, f.url + '/tracker.js');
      await page.waitForFunction(() => !!window.UniversalTracker);
      const before = f.rows.size;
      await page.evaluate(() => UniversalTracker.checkpoint());
      // Repeated partial inclusions must not create a second session.
      await page.addScriptTag({ url: f.url + '/tracker.js' });
      await page.locator('button').click();
      await page.waitForURL((url) => url.pathname === '/complete.html');
      assert.equal(f.rows.size, before + 1);
      const row = [...f.rows.values()].at(-1);
      const capture = await f.store.read(row.id);
      assert.equal(capture.page_url, f.url + '/mvc-view');
      assert.ok(capture.page.events.some((event) => event.type === 2));
      assert.equal(capture.save_reason, 'form');
      assert.deepEqual(errors, []);
      await page.close();
    });
  }
});
