import test from 'node:test';
import assert from 'node:assert/strict';
import { technical, summarize } from '../src/dashboard.js';
import { fixture } from './helpers.js';
test('dashboard counts separate session IDs as visitors even for the same identity', () => {
  const sessions = [
    {
      id: 's1',
      visitor_id: 'v',
      first_seen_at: '2026-01-01',
      started_at: '2026-02-01',
      last_activity_at: '2026-02-01T00:01:00Z',
      ...technical(),
    },
    {
      id: 's2',
      visitor_id: 'v',
      first_seen_at: '2026-01-01',
      started_at: '2026-02-02',
      last_activity_at: '2026-02-02',
      ...technical(),
    },
  ];
  const result = summarize(
    sessions,
    [
      {
        tracking_session_id: 's1',
        page_url: '/a',
        views: 2,
        depth_sum: 125,
        reach_25: 2,
        reach_50: 1,
        reach_75: 1,
        reach_90: 1,
        reach_100: 1,
      },
    ],
    [
      { tracking_session_id: 's1', event_type: 'click', total: 3 },
      { tracking_session_id: 's1', event_type: 'engagement', total: 20 },
    ],
    [{ tracking_session_id: 's1', engaged_ms: 5000 }],
    '2026-02-01',
  );
  assert.equal(result.totals.visitors, 2);
  assert.equal(result.totals.unique_identities, 1);
  assert.equal(result.totals.returning_visitors, 2);
  assert.equal(result.totals.new_visitors, 0);
  assert.equal(result.totals.average_observed_ms, 30000);
  assert.equal(result.totals.average_engaged_ms, 2500);
  assert.equal(result.totals.interactions, 3);
  assert.equal(result.totals.page_views, 2);
  assert.equal(result.top_pages[0].average_depth, 62.5);
  assert.equal(technical().device, 'Unknown');
  assert.equal(technical('Mozilla Android Mobile Chrome/110').device, 'Mobile');
  assert.equal(technical('Mozilla Chrome/110 Edg/110').browser, 'Edge');
});
test('dashboard endpoints authenticate, validate filters and keep account ownership server-side', async (t) => {
  let seen;
  const f = await fixture({
    dashboard: {
      async overview(account, filters) {
        seen = { account, filters };
        return { total: 0 };
      },
      async detail() {
        throw new Error('Must not read foreign details');
      },
    },
    analytics: {
      async get() {
        return null;
      },
    },
  });
  t.after(() => f.close());
  const url = f.url + '/api/admin/analytics?from=2026-01-01&to=2026-02-01';
  assert.equal((await fetch(url)).status, 401);
  const headers = { Cookie: f.authCookie };
  assert.equal((await fetch(url + '&account=forged', { headers })).status, 200);
  assert.equal(seen.account, 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa');
  assert.equal((await fetch(url + '&project=invalid', { headers })).status, 400);
  assert.equal((await fetch(url + '&offset=-1', { headers })).status, 400);
  assert.equal(
    (
      await fetch(f.url + '/api/admin/analytics/sessions/bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb', {
        headers,
      })
    ).status,
    404,
  );
});
