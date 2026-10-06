import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRecordingPolicies } from '../src/recording-policy.js';
test('recording success rules are explicit and origin scoped', () => {
  assert.deepEqual(parseRecordingPolicies(), {});
  assert.deepEqual(
    parseRecordingPolicies('{"https://example.test":{"path":"/done","selector":".success"}}')[
      'https://example.test'
    ],
    { path: '/done', selector: '.success' },
  );
  for (const input of [
    'null',
    '[]',
    '{"https://example.test/path":{"path":"/done"}}',
    '{"https://example.test":{"status":200}}',
    '{"https://example.test":{"path":"/done?token=secret"}}',
  ])
    assert.throws(() => parseRecordingPolicies(input));
});
