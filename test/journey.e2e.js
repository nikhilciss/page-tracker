import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { readdir } from 'node:fs/promises';
import { renderVideo } from '../src/video.js';
import { fixture } from './helpers.js';

test(
  'validation error, reload and correction stay pending until configured success; one playable video',
  { timeout: 60000 },
  async (t) => {
    const f = await fixture();
    const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome' });
    const host = createServer((req, res) => {
      res.setHeader('Content-Type', 'text/html');
      if (req.url === '/ajax')
        return res.end(
          `<!doctype html><html><head><script src="${f.url}/tracker.js" defer></script></head><body><div class="success">Old success</div><form onsubmit="event.preventDefault()"><button>Submit</button></form></body></html>`,
        );
      if (req.method === 'POST') {
        req.resume();
        res.writeHead(303, { Location: req.url === '/first' ? '/error' : '/done' });
        return res.end();
      }
      res.end(`<!doctype html><html><head><script src="${f.url}/tracker.js" defer></script></head><body>
      <h1>${req.url === '/done' ? 'Success proof' : req.url === '/error' ? 'Validation error proof' : 'Initial form proof'}</h1>
      ${req.url === '/done' ? '<div class="success">Saved successfully</div>' : `<form action="${['/error', '/normal'].includes(req.url) ? '/second' : '/first'}" method="post"><input name="password" type="password"><button>Submit</button></form>`}
      </body></html>`);
    });
    await new Promise((resolve) => host.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + host.address().port;
    f.config.allowedOrigins.add(origin);
    f.config.recordingPolicies = { [origin]: { path: '/done', selector: '.success' } };
    t.after(async () => {
      await browser.close();
      await new Promise((r) => host.close(r));
      await f.close();
    });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(origin + '/form');
    await page.waitForFunction(() => !!window.UniversalTracker);
    await page.evaluate(() => UniversalTracker.checkpoint());
    await page.locator('input').fill('secret-password');
    await page.locator('button').click();
    await page.waitForURL(origin + '/error');
    await page.waitForTimeout(2400);
    assert.equal(f.rows.size, 0, 'HTTP 200 validation error must not finalize');
    await page.reload();
    await page.waitForFunction(() => !!window.UniversalTracker);
    await page.evaluate(() => UniversalTracker.checkpoint());
    assert.equal(f.rows.size, 0, 'refresh does not finalize');
    await page.locator('input').fill('corrected-secret');
    await page.locator('button').click();
    await page.waitForURL(origin + '/done');
    for (let i = 0; i < 80 && !f.rows.size; i++) await page.waitForTimeout(100);
    assert.equal(f.rows.size, 1);
    const row = [...f.rows.values()][0],
      capture = await f.store.read(row.id);
    assert.equal(capture.save_reason, 'success');
    assert.equal(capture.recording_segments.length, 4);
    const json = JSON.stringify(capture.page.events);
    for (const text of ['Initial form proof', 'Validation error proof', 'Success proof'])
      assert.ok(json.includes(text));
    assert.ok(!json.includes('secret-password') && !json.includes('corrected-secret'));
    assert.deepEqual(await readdir(f.directory + '/.pending'), []);
    const details = await renderVideo(capture, f.directory + '/combined.webm', {
      fps: 3,
      maxSeconds: 30,
    });
    assert.equal(details.segments.length, 4);
    assert.equal(details.truncated, false);
    await page.goto(f.url + '/login.html');
    const bytes = await import('node:fs/promises').then((fs) =>
      fs.readFile(f.directory + '/combined.webm'),
    );
    await page.evaluate((data) => {
      const v = document.createElement('video');
      v.id = 'proof';
      v.src = URL.createObjectURL(
        new Blob([Uint8Array.from(atob(data), (c) => c.charCodeAt(0))], { type: 'video/webm' }),
      );
      document.body.append(v);
    }, bytes.toString('base64'));
    await page.waitForFunction(() => document.querySelector('#proof').readyState >= 2);
    // A second completed operation in the same tab must start a separate video.
    await page.goto(origin + '/normal');
    await page.waitForFunction(() => !!window.UniversalTracker);
    await page.evaluate(() => UniversalTracker.checkpoint());
    await page.locator('button').click();
    await page.waitForURL(origin + '/done');
    for (let i = 0; i < 80 && f.rows.size === 1; i++) await page.waitForTimeout(100);
    assert.equal(f.rows.size, 2, 'separate successful operations must not merge');
    const second = [...f.rows.values()].find((r) => r.id !== row.id);
    const secondCapture = await f.store.read(second.id);
    assert.equal(secondCapture.recording_segments.length, 2);
    assert.ok(!JSON.stringify(secondCapture.page.events).includes('Validation error proof'));
    const firstIds = new Set(capture.recording_segments.map((s) => s.session_id));
    assert.ok(secondCapture.recording_segments.every((s) => !firstIds.has(s.session_id)));
    f.config.recordingPolicies[origin] = { selector: '.success' };
    const ajax = await browser.newPage();
    await ajax.goto(origin + '/ajax');
    await ajax.waitForFunction(() => !!window.UniversalTracker);
    await ajax.evaluate(() => UniversalTracker.checkpoint());
    await ajax.locator('button').click();
    await ajax.waitForTimeout(2300);
    assert.equal(f.rows.size, 2, 'pre-existing success banner is not a new success');
    await ajax.locator('.success').evaluate((el) => (el.hidden = true));
    await ajax.waitForTimeout(2300);
    await ajax.locator('.success').evaluate((el) => {
      el.textContent = 'New success';
      el.hidden = false;
    });
    for (let i = 0; i < 50 && f.rows.size === 2; i++) await ajax.waitForTimeout(100);
    assert.equal(f.rows.size, 3, 'new AJAX success finalizes without framework-specific hooks');
    await ajax.close();
    assert.deepEqual(errors, []);
  },
);
