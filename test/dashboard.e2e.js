import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { fixture } from './helpers.js';
import { summarize, technical } from '../src/dashboard.js';
test(
  'analytics dashboard filters, drilldown, empty/error states and responsive layouts',
  { timeout: 45000 },
  async (t) => {
    const id = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb',
      pageId = 'cccccccc-cccc-4ccc-cccc-cccccccccccc',
      visitor = 'dddddddd-dddd-4ddd-bddd-dddddddddddd';
    const now = new Date().toISOString();
    let withRecording = false,
      historyOnly = false;
    let fail = false,
      lastFilters;
    const session = {
      id,
      visitor_id: visitor,
      project_id: pageId,
      first_seen_at: now,
      started_at: now,
      last_activity_at: now,
      status: 'active',
      ...technical(),
    };
    const pageRow = {
      id: pageId,
      recording_session_id: visitor,
      page_url: 'https://example.test/<script>alert(1)</script>',
      tracking_session_id: id,
      started_at: now,
      max_scroll: 75,
      observed_ms: 1000,
    };
    const f = await fixture({
      dashboard: {
        async overview(account, filters) {
          lastFilters = filters;
          if (fail)
            throw Object.assign(new Error('Reporting temporarily unavailable'), { status: 503 });
          if (historyOnly)
            return {
              ...summarize([], [], [], [], filters.from),
              totals: { ...summarize([], [], [], [], filters.from).totals, sessions: 1 },
              coverage: { analytics_sessions: 0, historical_visits: 1 },
              sessions: [
                {
                  id,
                  recording_id: visitor,
                  source: 'recording',
                  visitor_id: null,
                  visitor_label: 'Unknown visitor',
                  pages: 1,
                  observed_ms: 9000,
                  engaged_ms: null,
                  device: 'Desktop',
                  browser: 'Firefox',
                  started_at: now,
                  status: 'recorded',
                },
              ],
              total: 1,
              projects: [{ id: pageId, origin: 'https://example.test' }],
              options: { browser: ['Firefox'], device: ['Desktop'] },
            };
          const sessions = filters.device ? [] : [{ ...session }];
          return {
            ...summarize(
              sessions,
              sessions.length
                ? [
                    {
                      ...pageRow,
                      views: 1,
                      depth_sum: 75,
                      reach_25: 1,
                      reach_50: 1,
                      reach_75: 1,
                      reach_90: 0,
                      reach_100: 0,
                    },
                  ]
                : [],
              [],
              [],
              filters.from,
            ),
            reports: {
              countries: [{ label: 'Unknown', value: sessions.length }],
              ips: [{ label: 'Unknown', value: sessions.length }],
              domains: [{ label: 'example.test', value: sessions.length }],
              referrers: [{ label: 'Unknown', value: sessions.length }],
              duration: [],
              submit_timing: [],
              input_methods: [],
              input_method_unknown: sessions.length,
              sensitive_activity: [],
              saved_recordings: 0,
              recent_recordings: [],
              video_status: null,
            },
            sessions,
            total: sessions.length,
            projects: [{ id: pageId, origin: 'https://example.test' }],
            options: { browser: ['Unknown'], device: ['Unknown', 'Mobile'] },
          };
        },
        async detail() {
          return {
            recordings: withRecording
              ? [
                  {
                    id: visitor,
                    session_id: visitor,
                    created_at: now,
                    page_url: pageRow.page_url,
                    browser: 'Test browser',
                    technical: technical(),
                  },
                  {
                    id: pageId,
                    session_id: pageId,
                    created_at: new Date(new Date(now).getTime() + 1000).toISOString(),
                    page_url: pageRow.page_url,
                  },
                ]
              : [],
            engaged_ms: 0,
            events: {},
          };
        },
      },
      analytics: {
        async get() {
          return { session, pages: [pageRow] };
        },
      },
      semantic: {
        async expire() {},
        async events() {
          return [
            {
              id: visitor,
              page_id: pageId,
              session_offset_ms: 1000,
              recording_offset_ms: 1000,
              event_type: 'form_submit',
              occurred_at: now,
              metadata: { form: 'form-1' },
            },
          ];
        },
      },
    });
    const browser = await chromium.launch({
      executablePath: '/usr/bin/google-chrome',
      headless: true,
    });
    t.after(async () => {
      await browser.close();
      await f.close();
    });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const [name, value] = f.authCookie.split('=');
    await context.addCookies([{ name, value, url: f.url }]);
    const page = await context.newPage(),
      errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(f.url + '/');
    await page.waitForFunction(() => document.querySelector('#stat-total').textContent === '1');
    assert.match(await page.locator('#pages-chart').textContent(), /<script>/);
    assert.match(await page.locator('#country-report').textContent(), /Unknown/);
    assert.match(await page.locator('#recording-summary').textContent(), /Saved recordings/);
    await page.locator('#country').selectOption('');
    assert.equal(await page.locator('#pages-chart script').count(), 0);
    await page.screenshot({ path: '/tmp/tracker-dashboard-desktop.png', fullPage: true });
    await page.locator('#device').selectOption('Mobile');
    await page.getByRole('button', { name: 'Apply filters' }).click();
    await page.locator('#empty-state').waitFor({ state: 'visible' });
    assert.equal(lastFilters.device, 'Mobile');
    await page.locator('#device').selectOption('');
    await page.getByRole('button', { name: 'Apply filters' }).click();
    await page.locator('#sessions a').click();
    await page.waitForFunction(() =>
      document.querySelector('#video-status').textContent.includes('No finalized recording'),
    );
    assert.match(await page.locator('#timeline').textContent(), /server outcome unknown/);
    assert.match(await page.locator('#details').textContent(), /Unknown/);
    await page.screenshot({ path: '/tmp/tracker-session-desktop.png', fullPage: true });
    withRecording = true;
    await page.route('**/api/admin/recordings/*/video/status', (route) =>
      route.fulfill({ json: { status: 'failed', message: 'Fixture video failure' } }),
    );
    await page.reload();
    await page.waitForFunction((expected) => document.querySelector('#recording-select').value === expected, pageId);
    assert.match(await page.locator('#recording-summary').textContent(), /2 saved recording/);
    await page.getByRole('tab', { name: 'Event log' }).click();
    await page.getByRole('button', { name: 'Seek in video' }).click();
    await page.waitForFunction(
      () => document.querySelector('#video-status').textContent === 'Fixture video failure',
    );
    assert.equal(await page.locator('#retry-video').isVisible(), true);
    await page.setViewportSize({ width: 375, height: 812 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    await page.screenshot({ path: '/tmp/tracker-session-mobile.png', fullPage: true });
    await page.goto(f.url + '/');
    await page.waitForFunction(() => document.querySelector('#stat-total').textContent === '1');
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    await page.screenshot({ path: '/tmp/tracker-dashboard-mobile.png', fullPage: true });
    fail = true;
    await page.getByRole('button', { name: 'Refresh data' }).click();
    await page.waitForFunction(() =>
      document.querySelector('#feedback').textContent.includes('Reporting temporarily unavailable'),
    );
    assert.equal(await page.locator('#dashboard').isHidden(), true);
    fail = false;
    await page.getByRole('button', { name: 'Refresh data' }).click();
    await page.locator('#dashboard').waitFor({ state: 'visible' });
    historyOnly = true;
    await page.getByRole('button', { name: 'Refresh data' }).click();
    await page.waitForFunction(() =>
      document.querySelector('#coverage').textContent.includes('1 historical recorded visits'),
    );
    assert.match(await page.locator('#sessions').textContent(), /Historical recording/);
    assert.match(await page.locator('#sessions a').getAttribute('href'), /\?id=/);
    assert.match(await page.locator('#forms-chart').textContent(), /Not captured/);
    assert.match(await page.locator('#metrics').textContent(), /—/);
    assert.deepEqual(errors, []);
  },
);
