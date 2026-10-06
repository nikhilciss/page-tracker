import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { semanticBatch, safeSemanticMetadata } from '../src/semantic-schema.js';
import { fixture } from './helpers.js';
test('semantic schema rejects values, ownership injection, oversized batches and unsafe metadata', () => {
  const event = {
    id: randomUUID(),
    sequence: 0,
    offset_ms: 0,
    type: 'click',
    metadata: { tag: 'button' },
  };
  assert.equal(semanticBatch.safeParse({ token: 'x', events: [event] }).success, true);
  for (const metadata of [
    { value: 'password' },
    { ...event.metadata, account_id: randomUUID() },
    { text: 'x'.repeat(101) },
  ])
    assert.equal(
      semanticBatch.safeParse({ token: 'x', events: [{ ...event, metadata }] }).success,
      false,
    );
  assert.equal(
    semanticBatch.safeParse({ token: 'x', events: Array(51).fill(event) }).success,
    false,
  );
  const clean = safeSemanticMetadata(
    {
      text: 'secret token 123456',
      url: 'https://example.test/path?token=abc#secret',
      id: 'password',
      sensitive: true,
    },
    'https://example.test',
  );
  assert.equal(clean.text, undefined);
  assert.equal(clean.url, undefined);
  assert.equal(clean.id, undefined);
  assert.equal(
    safeSemanticMetadata(
      { url: 'https://example.test/path?token=abc#secret' },
      'https://example.test',
    ).url,
    'https://example.test/path',
  );
});
test('semantic API enforces token ownership and compressed body limits', async (t) => {
  let calls = 0;
  const f = await fixture({
    semantic: {
      async ingest(claims, events) {
        calls++;
        assert.equal(claims.account_id, 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa');
        return { next_sequence: events.length };
      },
    },
  });
  t.after(() => f.close());
  const request = (url, body, zip = false) =>
    fetch(f.url + url, {
      method: 'POST',
      headers: {
        Origin: 'https://allowed.example',
        'Content-Type': 'application/json',
        ...(zip ? { 'Content-Encoding': 'gzip' } : {}),
      },
      body: zip ? gzipSync(JSON.stringify(body)) : JSON.stringify(body),
    });
  const init = await (
    await request('/api/track/init', { page_url: 'https://allowed.example/page' })
  ).json();
  const body = {
    token: init.token,
    events: [{ id: randomUUID(), sequence: 0, offset_ms: 0, type: 'click', metadata: {} }],
  };
  assert.equal((await request('/api/track/analytics/events', body, true)).status, 200);
  assert.equal(
    (await request('/api/track/analytics/events', { ...body, token: 'invalid' })).status,
    401,
  );
  assert.equal(
    (await request('/api/track/analytics/events', { ...body, project_id: randomUUID() })).status,
    400,
  );
  assert.equal(
    (await request('/api/track/analytics/events', { large: 'x'.repeat(70000) }, true)).status,
    413,
  );
  assert.equal(calls, 1);
});
