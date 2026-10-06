import { identifiedVisitor } from '../src/analytics.js';
import { migrateContext, contextRepository } from '../src/context.js';
import { dashboardRepository } from '../src/dashboard.js';
import { checkSemanticBrowser } from './semantic-browser-check.js';
import { migrateSemantic } from '../src/semantic-migration.js';
import { semanticRepository } from '../src/semantic-repository.js';
import { fixture } from '../test/helpers.js';
import { chromium } from 'playwright';
// Uses an isolated disposable database; never drops or edits the configured application database.
import mysql from 'mysql2/promise';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getConfig } from '../src/config.js';
import { migrateAnalytics } from '../src/analytics-schema.js';
import { analyticsRepository } from '../src/analytics-repository.js';
const { database: ignored, ...config } = getConfig().db;
const name = 'tracker_test_' + randomUUID().replaceAll('-', '');
const admin = await mysql.createConnection(config);
let pool;
try {
  await admin.query('CREATE DATABASE ' + name);
  pool = mysql.createPool({ ...config, database: name });
  await pool.query(
    'CREATE TABLE accounts(id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY, company_origin VARCHAR(255),is_master BOOLEAN DEFAULT FALSE)',
  );
  await pool.query(
    'CREATE TABLE recordings(id CHAR(36) PRIMARY KEY, account_id CHAR(36),session_id CHAR(36),browser VARCHAR(1024),user_name VARCHAR(160),user_id VARCHAR(160),duration_ms INT,created_at DATETIME(3),page_url VARCHAR(2048))',
  );
  const a = randomUUID(),
    b = randomUUID();
  await pool.execute('INSERT INTO accounts(id,company_origin) VALUES (?,?),(?,?)', [
    a,
    'https://a.example',
    b,
    'https://b.example',
  ]);
  await migrateAnalytics(pool);
  await migrateSemantic(pool);
  await migrateContext(pool);
  await migrateAnalytics(pool);
  await migrateSemantic(pool);
  await migrateContext(pool);
  const repo = analyticsRepository(pool),
    visitor = randomUUID(),
    recording = randomUUID();
  const input = {
    account: a,
    origin: 'https://a.example',
    visitor,
    recording,
    url: 'https://a.example/page',
    timeout: 60,
  };
  const first = await repo.start(input);
  const duplicate = await repo.start({ ...input, visitor: randomUUID() });
  assert.equal(first.page_id, duplicate.page_id);
  const [[count]] = await pool.query('SELECT COUNT(*) AS n FROM visitors');
  assert.equal(count.n, 1);
  const parallel = await Promise.all([
    repo.start({ ...input, recording: randomUUID() }),
    repo.start({ ...input, recording: randomUUID() }),
  ]);
  assert.ok(parallel.every((x) => x.session_id === first.session_id));
  assert.equal(await repo.get(b, first.session_id), null);
  assert.equal(await repo.activity(b, recording), false);
  assert.equal(await repo.activity(a, recording), true);
  await pool.execute(
    'UPDATE tracking_sessions SET last_activity_at=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 61 SECOND) WHERE id=?',
    [first.session_id],
  );
  assert.equal(await repo.activity(a, recording), false);
  const next = await repo.start({ ...input, recording: randomUUID() });
  assert.notEqual(next.session_id, first.session_id);
  assert.equal((await repo.get(a, next.session_id)).session.returning_visitor, 1);
  await assert.rejects(
    pool.execute(
      'INSERT INTO session_pages(id,account_id,project_id,tracking_session_id,recording_session_id,page_url,started_at,last_activity_at) SELECT ?,?,project_id,id,?, ?,UTC_TIMESTAMP(),UTC_TIMESTAMP() FROM tracking_sessions WHERE id=?',
      [randomUUID(), b, randomUUID(), 'https://b.example', first.session_id],
    ),
  );
  const semantics = semanticRepository(pool);
  const fresh = await repo.start({ ...input, recording: randomUUID() });
  const [[freshPage]] = await pool.execute(
    'SELECT recording_session_id FROM session_pages WHERE id=?',
    [fresh.page_id],
  );
  const claims = { account_id: a, origin: 'https://a.example', id: freshPage.recording_session_id };
  const event = (sequence, type, metadata = {}) => ({
    id: randomUUID(),
    sequence,
    offset_ms: 0,
    type,
    metadata,
  });
  const batch = [
    event(0, 'page_view', { url: input.url }),
    event(1, 'click', { text: 'password 12345', sensitive: true }),
  ];
  assert.equal((await semantics.ingest(claims, batch)).next_sequence, 2);
  assert.equal((await semantics.ingest(claims, batch)).next_sequence, 2);
  await assert.rejects(semantics.ingest(claims, [{ ...batch[1], metadata: {} }]), /Conflicting/);
  await assert.rejects(semantics.ingest(claims, [event(4, 'click')]), /Sequence gap/);
  await assert.rejects(semantics.ingest({ ...claims, account_id: b }, [event(2, 'click')]));
  const stored = await semantics.events(a, fresh.session_id);
  assert.equal(stored.filter((e) => e.event_type === 'click').length, 1);
  assert.equal(stored.find((e) => e.event_type === 'click').metadata.text, undefined);
  assert.equal(await semantics.events(b, fresh.session_id), null);
  await semantics.ingest(claims, [
    event(2, 'navigation', { url: 'https://a.example/pricing' }),
    event(3, 'page_view', { url: 'https://a.example/pricing' }),
  ]);
  assert.equal(
    (await repo.get(a, fresh.session_id)).pages.filter((x) => x.recording_session_id === claims.id)
      .length,
    2,
  );
  // A 61-second simulated gap rotates the session, not the recording identity.
  await pool.execute(
    'UPDATE semantic_streams SET started_at=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 61 SECOND) WHERE id=?',
    [claims.id],
  );
  await pool.execute(
    'UPDATE tracking_sessions SET last_activity_at=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 61 SECOND) WHERE id=?',
    [fresh.session_id],
  );
  const rotated = await semantics.ingest(claims, [{ ...event(4, 'click'), offset_ms: 61000 }]);
  assert.notEqual(rotated.session_id, fresh.session_id);
  assert.ok(
    (await semantics.events(a, fresh.session_id)).some((e) => e.event_type === 'inferred_timeout'),
  );
  const fixtureAccount = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
  await pool.execute('INSERT INTO accounts(id,company_origin) VALUES (?,?)', [
    fixtureAccount,
    'https://allowed.example',
  ]);
  const f = await fixture({ analytics: repo, semantic: semanticRepository(pool) });
  const browser = await chromium.launch({
    executablePath: '/usr/bin/google-chrome',
    headless: true,
  });
  try {
    const page = await browser.newPage();
    const started = page.waitForResponse(
      (r) => r.url().endsWith('/analytics/start') && r.status() === 200,
    );
    await page.goto(f.url + '/page-demo.html');
    const one = await (await started).json();
    const restarted = page.waitForResponse(
      (r) => r.url().endsWith('/analytics/start') && r.status() === 200,
    );
    await page.reload();
    const two = await (await restarted).json();
    assert.equal(one.visitor_id, two.visitor_id);
    assert.equal(one.session_id, two.session_id);
    assert.notEqual(one.page_id, two.page_id);
    assert.equal(f.rows.size, 0);
    assert.equal((await repo.get(fixtureAccount, one.session_id)).pages.length, 2);
    await checkSemanticBrowser(browser, f, pool, repo, fixtureAccount);
    const reporting = dashboardRepository(pool);
    const from = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const to = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const filters = { from, to, offset: 0 };
    const report = await reporting.overview(fixtureAccount, filters);
    const [[actual]] = await pool.execute(
      'SELECT COUNT(*) total FROM tracking_sessions WHERE account_id=?',
      [fixtureAccount],
    );
    assert.equal(report.totals.sessions, actual.total);
    assert.ok(report.totals.page_views > 0);
    assert.ok(report.events.click > 0);
    assert.ok(report.totals.average_engaged_ms > 0);
    assert.equal(report.breakdown.device.Unknown, actual.total);
    assert.equal(
      (await reporting.overview(b, { ...filters, project: report.projects[0].id })).total,
      0,
    );
    assert.equal(
      (await reporting.overview(fixtureAccount, { ...filters, device: 'Mobile' })).total,
      0,
    );
    assert.equal((await reporting.detail(b, one.session_id)).recordings.length, 0);
    const before = (await reporting.detail(fixtureAccount, one.session_id)).engaged_ms;
    const future = new Date(Date.now() + 3600000);
    for (let i = 0; i < 2; i++)
      await pool.execute(
        `INSERT INTO session_events(id,account_id,project_id,visitor_id,tracking_session_id,page_id,event_type,occurred_at,metadata,page_offset_ms,session_offset_ms,recording_offset_ms)
      SELECT ?,p.account_id,p.project_id,s.visitor_id,s.id,p.id,'engagement',?,JSON_OBJECT('engaged_ms',1000),0,0,0 FROM session_pages p JOIN tracking_sessions s ON s.id=p.tracking_session_id WHERE p.id=?`,
        [randomUUID(), future, one.page_id],
      );
    assert.equal(
      (await reporting.detail(fixtureAccount, one.session_id)).engaged_ms,
      before + 1000,
      'Overlapping engagement is counted once',
    );
    await pool.execute(
      'INSERT INTO recordings(id,account_id,session_id,browser,created_at,page_url) VALUES (?,?,?,?,?,?)',
      [
        randomUUID(),
        fixtureAccount,
        (await repo.get(fixtureAccount, one.session_id)).pages[0].recording_session_id,
        'Mozilla Android Mobile Chrome/120',
        new Date(),
        'https://example.test',
      ],
    );
    assert.equal(
      (
        await reporting.overview(fixtureAccount, {
          ...filters,
          browser: 'Chrome',
          device: 'Mobile',
        })
      ).total,
      1,
    );
    const contexts = contextRepository(pool);
    const documentId = (await repo.get(fixtureAccount, one.session_id)).pages[0]
      .recording_session_id;
    await contexts.save(fixtureAccount, documentId, {
      user_name: 'Fixture Logged-in User',
      user_id: '42',
      user_agent: 'Mozilla Edg/120',
      geo_status: 'private',
      ip: '127.0.0.1',
    });
    assert.equal(
      (await contexts.get(fixtureAccount, documentId)).user_name,
      'Fixture Logged-in User',
    );
    await contexts.updateIdentity(b, documentId, { user_id: 'forged', user_name: 'Wrong Tenant' });
    assert.equal(
      (await contexts.get(fixtureAccount, documentId)).user_name,
      'Fixture Logged-in User',
    );
    await contexts.updateIdentity(fixtureAccount, documentId, {
      user_id: ' late-id ',
      user_name: ' Late Name ',
    });
    let updatedContext = await contexts.get(fixtureAccount, documentId);
    assert.equal(updatedContext.user_name, 'Late Name');
    assert.equal(updatedContext.user_id, 'late-id');
    assert.equal(updatedContext.ip, '127.0.0.1');
    assert.equal(updatedContext.user_agent, 'Mozilla Edg/120');
    await contexts.updateIdentity(fixtureAccount, documentId, { user_id: null, user_name: null });
    updatedContext = await contexts.get(fixtureAccount, documentId);
    assert.equal(updatedContext.user_id, null);
    assert.equal(updatedContext.user_name, null);
    assert.equal(updatedContext.identity_source, null);
    await contexts.updateIdentity(fixtureAccount, documentId, {
      user_id: '42',
      user_name: 'Fixture Logged-in User',
    });
    assert.equal(await contexts.get(b, documentId), null);
    assert.equal((await contexts.session(b, one.session_id)).length, 0);
    assert.ok(
      (await reporting.overview(fixtureAccount, filters)).sessions.some(
        (s) => s.visitor_label === 'Fixture Logged-in User',
      ),
    );
    const oldDocument = randomUUID(),
      oldRecording = randomUUID();
    const [[ownedProject]] = await pool.execute(
      'SELECT id,origin FROM projects WHERE account_id=? LIMIT 1',
      [fixtureAccount],
    );
    for (const rid of [oldRecording, randomUUID()])
      await pool.execute(
        'INSERT INTO recordings(id,account_id,session_id,browser,duration_ms,created_at,page_url) VALUES (?,?,?,?,?,?,?)',
        [
          rid,
          fixtureAccount,
          oldDocument,
          'Mozilla Firefox/120',
          9000,
          new Date(),
          ownedProject.origin + '/old',
        ],
      );
    const historical = await reporting.overview(fixtureAccount, {
      ...filters,
      project: ownedProject.id,
      browser: 'Firefox',
    });
    assert.equal(
      historical.total,
      1,
      'Two form recordings in one document appear as one historical visit',
    );
    assert.equal(historical.coverage.analytics_sessions, 0);
    assert.equal(historical.coverage.historical_visits, 1);
    assert.equal(
      historical.totals.visitors,
      0,
      'Do not invent visitor identity for historical recordings',
    );
    assert.equal(historical.sessions[0].engaged_ms, null);
    assert.equal(historical.sessions[0].source, 'recording');
    assert.equal(
      (await reporting.overview(b, { ...filters, project: ownedProject.id, browser: 'Firefox' }))
        .total,
      0,
    );
    assert.equal(
      (
        await reporting.overview(fixtureAccount, {
          ...filters,
          from: '2000-01-01',
          to: '2000-01-02',
        })
      ).total,
      0,
    );
    const byIP = await reporting.overview(fixtureAccount, { ...filters, ip: '127.0.0.1' });
    assert.ok(byIP.total > 0);
    assert.ok(byIP.sessions.every((s) => s.ip === '127.0.0.1'));
    assert.equal((await reporting.overview(b, { ...filters, ip: '127.0.0.1' })).total, 0);
    const privateVisits = await reporting.overview(fixtureAccount, {
      ...filters,
      country: 'Local/private network',
    });
    assert.ok(privateVisits.total > 0);
    assert.ok(privateVisits.reports.countries.every((r) => r.label === 'Local/private network'));
    const pasted = await reporting.overview(fixtureAccount, { ...filters, input_method: 'paste' });
    assert.ok(pasted.total > 0);
    assert.equal(pasted.reports.input_methods.find((r) => r.label === 'paste').value, pasted.total);
    assert.ok(report.reports.domains.length > 0);
    console.log(
      'Dashboard MySQL queries passed: aggregates, engagement union, missing metadata and tenant-scoped filters.',
    );
  } finally {
    await browser.close();
    await f.close();
  }
  // Verify identity isolation after the baseline aggregate assertions.
  const identityAccount = randomUUID();
  await pool.execute('INSERT INTO accounts(id,company_origin) VALUES (?,?)', [
    identityAccount,
    'https://identity.example',
  ]);
  const identityInput = {
    account: identityAccount,
    origin: 'https://identity.example',
    url: 'https://identity.example/page',
    timeout: 1800,
  };
  const userA = identifiedVisitor('user-a', identityAccount, identityInput.origin, 'test-secret');
  const userB = identifiedVisitor('user-b', identityAccount, identityInput.origin, 'test-secret');
  const visitA = await repo.start({ ...identityInput, visitor: userA, recording: randomUUID() });
  const visitB = await repo.start({ ...identityInput, visitor: userB, recording: randomUUID() });
  const repeatA = await repo.start({ ...identityInput, visitor: userA, recording: randomUUID() });
  assert.notEqual(visitA.session_id, visitB.session_id);
  assert.equal(visitA.session_id, repeatA.session_id);
  const [[identityTotals]] = await pool.execute(
    'SELECT COUNT(*) sessions,COUNT(DISTINCT visitor_id) visitors FROM tracking_sessions WHERE account_id=?',
    [identityAccount],
  );
  assert.equal(identityTotals.sessions, 2);
  assert.equal(identityTotals.visitors, 2);
  console.log(
    'Host identity MySQL checks passed: two users, two sessions; returning user retains its own session.',
  );
  console.log(
    'Analytics MySQL checks passed: idempotent migration, retries, concurrency, expiry, ownership and FK isolation.',
  );
} finally {
  await pool?.end();
  await admin.query('DROP DATABASE ' + name);
  await admin.end();
}
