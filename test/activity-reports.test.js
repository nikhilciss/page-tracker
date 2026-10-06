import test from 'node:test';
import assert from 'node:assert/strict';
import { distribution, reportSummary, addVideoStatus } from '../src/activity-reports.js';
import { semanticBatch } from '../src/semantic-schema.js';
const visit = (id, extra = {}) => ({
  id,
  country: 'Unknown',
  ip: 'Unknown',
  referrer: 'Unknown',
  domains: new Set(['example.test']),
  input_methods: new Set(),
  field_activity: false,
  sensitive_activity: false,
  observed_ms: 10000,
  submit_times: [],
  ...extra,
});
test('report distributions keep missing context and historical measurements distinct', () => {
  const report = reportSummary(
    [
      visit('1', {
        country: 'IN',
        ip: '1.2.3.4',
        input_methods: new Set(['typing', 'paste']),
        field_activity: true,
        sensitive_activity: true,
        submit_times: [10000],
      }),
      visit('2', { source: 'recording', observed_ms: 60000 }),
    ],
    [{ id: 'r', created_at: '2026-10-05' }],
  );
  assert.equal(report.saved_recordings, 1);
  assert.equal(
    report.duration.reduce((n, r) => n + r.value, 0),
    1,
  );
  assert.equal(report.submit_timing[1].value, 1);
  assert.equal(report.input_method_unknown, 1);
  assert.equal(report.input_methods.length, 2);
  assert.equal(report.domains[0].value, 2);
  assert.equal(report.countries.find((r) => r.label === 'Unknown').value, 1);
  assert.equal(report.sensitive_activity[2].value, 1);
  assert.deepEqual(
    distribution([0, 9999, 10000, 30000, 60000, 300000, 900000, -1, NaN]).map((r) => r.value),
    [2, 1, 1, 1, 1, 1],
  );
});
test('video reporting distinguishes worker states and missing status without exposing internal IDs', async () => {
  const report = { _recording_ids: ['a', 'b', 'c', 'd'], recent_recordings: [] };
  await addVideoStatus(report, {
    async status(id) {
      return { status: { a: 'ready', b: 'queued', c: 'failed', d: 'legacy' }[id] };
    },
  });
  assert.deepEqual(report.video_status, { ready: 1, processing: 1, failed: 1, unavailable: 1 });
  assert.equal(report._recording_ids, undefined);
  const absent = { _recording_ids: ['x'], recent_recordings: [] };
  await addVideoStatus(absent, {
    async status() {
      return { status: 'ready' };
    },
    file() {
      return '/tmp/tracker-nonexistent-ready-file';
    },
  });
  assert.equal(absent.video_status.ready, 0);
  assert.equal(absent.video_status.unavailable, 1);
  const missing = { _recording_ids: ['a'], recent_recordings: [], video_status: null };
  await addVideoStatus(missing);
  assert.equal(missing.video_status, null);
  assert.equal(missing._recording_ids, undefined);
});
test('input-method metadata is bounded and never accepts clipboard values', () => {
  const batch = {
    token: 'x',
    events: [
      {
        id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
        sequence: 0,
        offset_ms: 1,
        type: 'form_field_interaction',
        metadata: { input_method: 'paste', sensitive: true },
      },
    ],
  };
  assert.equal(semanticBatch.safeParse(batch).success, true);
  batch.events[0].metadata.value = 'secret';
  assert.equal(semanticBatch.safeParse(batch).success, false);
  delete batch.events[0].metadata.value;
  batch.events[0].metadata.input_method = 'verified_autofill';
  assert.equal(semanticBatch.safeParse(batch).success, false);
});
