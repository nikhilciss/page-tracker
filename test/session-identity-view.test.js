import test from 'node:test';
import assert from 'node:assert/strict';
globalThis.window = { addEventListener() {} };
const { who } = await import('../public/session-view.js');
delete globalThis.window;

test('anonymous session shows persisted visitor ID without claiming authenticated identity', () => {
  const view = who(null, {}, 'visitor-123');
  assert.equal(view['Anonymous visitor ID'], 'visitor-123');
  assert.equal(view['Visitor display name'], 'Anonymous visitor');
  assert.match(view['Authentication status'], /not verified/);
});

test('legacy host labels remain explicitly unverified and missing IDs are not invented', () => {
  const view = who({ user_name: 'Alice', user_id: 'host-1' });
  assert.equal(view['Visitor display name'], 'Alice');
  assert.equal(view['Host account ID'], 'host-1');
  assert.match(view['Identity source'], /not independently verified/);
  assert.equal(view['Anonymous visitor ID'], 'Not captured for this recording');
});

test('explicit context logout never restores identity from an older recording', () => {
  const view = who(
    { user_id: null, user_name: null, identity_updated_at: '2026-10-06' },
    { user_name: 'Old User', user_id: 'old-id' },
  );
  assert.equal(view['Visitor display name'], 'Anonymous visitor');
  assert.equal(view['Host account ID'], 'Unavailable without host integration');
});
