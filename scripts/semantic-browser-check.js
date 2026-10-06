import { writeFile, mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
export async function checkSemanticBrowser(browser, f, pool, repo, account) {
  const html = `<!doctype html><html><body style="margin:0"><button id="action" data-analytics-label="Get Started">Get Started</button><form id="contact"><input name="email" type="email" required><input name="password" type="password"><input class="private" name="notes"><button type="submit">Send</button></form><div style="height:3000px"></div><script src="/tracker.js" data-analytics-redact-selectors=".private" defer></script></body></html>`;
  for (const mobile of [false, true]) {
    const context = await browser.newContext({
      viewport: mobile ? { width: 375, height: 812 } : { width: 1280, height: 800 },
      isMobile: mobile,
      hasTouch: mobile,
    });
    try {
      await context.route('**/semantic-fixture*', (r) =>
        r.fulfill({ contentType: 'text/html', body: html }),
      );
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      const init = page.waitForResponse(
        (r) => r.url().endsWith('/analytics/start') && r.status() === 200,
      );
      const firstBatch = page.waitForResponse(
        (r) => r.url().endsWith('/analytics/events') && r.status() === 200,
      );
      await page.goto(f.url + '/semantic-fixture');
      const identity = await (await init).json();
      await firstBatch;
      await page.evaluate(() =>
        document.querySelector('form').addEventListener('submit', (e) => e.preventDefault()),
      );
      await page.locator('#action').click();
      await page.locator('button[type=submit]').click(); // Browser validity stops submit, but records invalid attempt.
      await page.locator('[name=email]').fill('private.person@example.com');
      await page.locator('[name=password]').fill('VerySecretPassword');
      await page.locator('[name=notes]').fill('PrivateCompanyInformation');
      await page.evaluate(() => {
        const field = document.querySelector('[name=notes]');
        field.dispatchEvent(
          new InputEvent('input', {
            bubbles: true,
            inputType: 'insertFromPaste',
            data: 'ClipboardSecretValue',
          }),
        );
      });
      await page.locator('button[type=submit]').click();
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await page.waitForTimeout(350);
      await page.evaluate(() =>
        history.pushState({}, '', '/semantic-fixture/products?token=do-not-store'),
      );
      await page.evaluate(() => history.replaceState({}, '', '/semantic-fixture/pricing'));
      await page.evaluate(() => (location.hash = '/contact'));
      await page.waitForTimeout(100);
      await page.goBack();
      await page.waitForTimeout(100);
      await page.goBack();
      await page.waitForTimeout(100);
      await page.evaluate(async () => {
        for (let i = 0; i < 8 && UniversalTracker.analyticsStatus()?.pending; i++)
          await UniversalTracker.analyticsFlush();
      });
      let [events] = await pool.execute(
        'SELECT event_type,metadata FROM session_events WHERE account_id=? AND tracking_session_id=?',
        [account, identity.session_id],
      );
      const types = events.map((x) => x.event_type);
      assert.ok(events.some((e) => e.metadata.input_method === 'paste'));
      assert.ok(!JSON.stringify(events).includes('ClipboardSecretValue'));
      for (const type of [
        'session_start',
        'page_view',
        'navigation',
        'click',
        'scroll_milestone',
        'form_view',
        'form_start',
        'form_field_interaction',
        'form_submit',
        'form_validation_attempt',
        'visibility_change',
      ])
        assert.ok(types.includes(type), 'Missing ' + type);
      assert.equal(types.includes('form_success'), false);
      for (const secret of [
        'private.person@example.com',
        'VerySecretPassword',
        'PrivateCompanyInformation',
        'do-not-store',
      ])
        assert.ok(!JSON.stringify(events).includes(secret));
      assert.ok(
        events
          .filter((e) => e.event_type === 'form_field_interaction')
          .some((e) => e.metadata.sensitive === true),
      );
      assert.ok(
        events.some((e) => e.event_type === 'scroll_milestone' && e.metadata.milestone === 100),
      );
      assert.ok(
        events.some((e) => e.event_type === 'navigation' && e.metadata.navigation === 'pushState'),
      );
      assert.ok(
        events.some(
          (e) => e.event_type === 'navigation' && e.metadata.navigation === 'replaceState',
        ),
      );
      assert.ok(
        events.some((e) => e.event_type === 'navigation' && e.metadata.navigation === 'popstate'),
      );
      assert.ok(
        events.some((e) => e.event_type === 'navigation' && e.metadata.navigation === 'hashchange'),
      );
      assert.ok((await repo.get(account, identity.session_id)).pages.length >= 4);
      await page.evaluate(() =>
        UniversalTracker.confirmFormSuccess(document.querySelector('form')),
      );
      await page.evaluate(async () => {
        for (let i = 0; i < 8 && UniversalTracker.analyticsStatus()?.pending; i++)
          await UniversalTracker.analyticsFlush();
      });
      const [[success]] = await pool.execute(
        "SELECT COUNT(*) n FROM session_events WHERE tracking_session_id=? AND event_type='form_success'",
        [identity.session_id],
      );
      assert.equal(success.n, 1);
      // Offline requests queue their exact IDs; resuming retries rather than double-counting.
      await context.setOffline(true);
      await page.locator('#action').click();
      await page.evaluate(async () => {
        for (let i = 0; i < 8 && UniversalTracker.analyticsStatus()?.pending; i++)
          await UniversalTracker.analyticsFlush();
      });
      assert.ok((await page.evaluate(() => UniversalTracker.analyticsStatus())).pending > 0);
      const recovered = page.waitForResponse(
        (r) => r.url().endsWith('/analytics/events') && r.status() === 200,
      );
      await context.setOffline(false);
      await page.evaluate(async () => {
        for (let i = 0; i < 8 && UniversalTracker.analyticsStatus()?.pending; i++)
          await UniversalTracker.analyticsFlush();
      });
      await recovered;
      assert.equal((await page.evaluate(() => UniversalTracker.analyticsStatus())).partial, false);
      // Hidden intervals do not accumulate engaged time (controlled lifecycle simulation).
      await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', {
          configurable: true,
          get: () => 'hidden',
        });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await page.evaluate(() => UniversalTracker.analyticsFlush());
      const [[beforeHidden]] = await pool.execute(
        'SELECT SUM(engaged_ms) total FROM session_pages WHERE tracking_session_id=?',
        [identity.session_id],
      );
      await page.waitForTimeout(5200);
      await page.evaluate(() => UniversalTracker.analyticsFlush());
      const [[afterHidden]] = await pool.execute(
        'SELECT SUM(engaged_ms) total FROM session_pages WHERE tracking_session_id=?',
        [identity.session_id],
      );
      assert.equal(String(beforeHidden.total), String(afterHidden.total));
      await page.evaluate(() => {
        delete document.visibilityState;
        document.dispatchEvent(new Event('visibilitychange'));
      });
      const second = await context.newPage();
      const next = second.waitForResponse(
        (r) => r.url().endsWith('/analytics/start') && r.status() === 200,
      );
      await second.goto(f.url + '/semantic-fixture');
      const same = await (await next).json();
      assert.equal(same.visitor_id, identity.visitor_id);
      assert.equal(same.session_id, identity.session_id);
      // A failed exit batch survives a document reload in the bounded tab-local outbox.
      let rejectUploads = true;
      await page.route('**/analytics/events', (r) => (rejectUploads ? r.abort() : r.continue()));
      await page.locator('#action').click();
      await page.evaluate(async () => {
        for (let i = 0; i < 6; i++) await UniversalTracker.analyticsFlush();
      });
      const queued = await page.evaluate(() =>
        Object.entries(sessionStorage)
          .filter(([k]) => k.startsWith('page-tracker:pending:'))
          .some(([, v]) => JSON.parse(v).events.length > 0),
      );
      assert.equal(queued, true);
      rejectUploads = false;
      const reloadReady = page.waitForResponse(
        (r) => r.url().endsWith('/analytics/start') && r.status() === 200,
      );
      await page.reload();
      await reloadReady;
      await page.waitForFunction(() => UniversalTracker.analyticsStatus()?.pending === 0);
      const [[duplicates]] = await pool.query(
        'SELECT COUNT(*) n FROM (SELECT stream_id,sequence_number,COUNT(*) c FROM session_events WHERE stream_id IS NOT NULL GROUP BY stream_id,sequence_number HAVING c>1) d',
      );
      assert.equal(duplicates.n, 0);
      if (process.env.WRITE_ANALYTICS_SAMPLES === '1' && !mobile) {
        await mkdir('docs/samples', { recursive: true });
        const detail = await repo.get(account, identity.session_id);
        const [records] = await pool.execute(
          'SELECT id,project_id,visitor_id,tracking_session_id,page_id,event_type,occurred_at,sequence_number,page_offset_ms,session_offset_ms,recording_offset_ms,metadata FROM session_events WHERE account_id=? AND tracking_session_id=? ORDER BY occurred_at,(stream_id IS NOT NULL),stream_id,sequence_number,id LIMIT 30',
          [account, identity.session_id],
        );
        await writeFile(
          'docs/samples/semantic-session.json',
          JSON.stringify(
            { source: 'Isolated automated test, not customer data', ...detail },
            null,
            2,
          ) + '\n',
        );
        await writeFile(
          'docs/samples/semantic-events.json',
          JSON.stringify(
            { source: 'Isolated automated test, first 30 events', events: records },
            null,
            2,
          ) + '\n',
        );
      }
      assert.deepEqual(errors, []);
      assert.equal(f.rows.size, 0);
    } finally {
      await context.close();
    }
  }
}
