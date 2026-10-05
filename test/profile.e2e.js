import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { verifyDomain } from '../src/domain-access.js';
import { fixture } from './helpers.js';

test(
  'signup availability, script-only profile and mobile navigation',
  { timeout: 45000 },
  async (t) => {
    const f = await fixture({ verifier: verifyDomain });
    const host = createServer((_req, res) => res.end('OK'));
    await new Promise((r) => host.listen(0, '127.0.0.1', r));
    const origin = 'http://127.0.0.1:' + host.address().port;
    f.config.localVerificationOrigins = [origin];
    const browser = await chromium.launch({
      executablePath: '/usr/bin/google-chrome',
      headless: true,
    });
    t.after(async () => {
      await browser.close();
      await new Promise((r) => host.close(r));
      await f.close();
    });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(f.url + '/login.html?signup=1');
    await page.locator('#name').fill('Profile Company');
    await page.locator('#domain').fill(origin);
    await page.locator('#email').fill('profile@example.test');
    await page.locator('#password').fill('test-password-1234');
    await page.locator('#submit').click();
    await page.waitForURL(f.url + '/');
    await page.goto(f.url + '/profile.html');
    await page.waitForFunction(() =>
      document.querySelector('#connection-status').textContent.includes('Ready to record'),
    );
    assert.equal(await page.locator('#api-key').count(), 0);
    assert.ok((await page.locator('#script-snippet').textContent()).includes('/tracker.js'));
    await page.screenshot({ path: '/tmp/tracker-profile-desktop.png', fullPage: true });
    await page.setViewportSize({ width: 375, height: 812 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    await page.getByRole('button', { name: 'Toggle navigation' }).click();
    assert.equal(
      await page.locator('body').evaluate((el) => el.classList.contains('nav-open')),
      true,
    );
    await page
      .getByRole('button', { name: 'Close navigation' })
      .click({ position: { x: 350, y: 400 } });
    await page.waitForFunction(
      () => document.querySelector('.sidebar').getBoundingClientRect().right <= 0,
    );
    await page.screenshot({ path: '/tmp/tracker-profile-mobile.png', fullPage: true });
    await page.goto(f.url + '/');
    await page.waitForFunction(() => document.querySelector('#stat-total').textContent === '0');
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    assert.deepEqual(errors, []);
  },
);
