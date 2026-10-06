import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeVisitorIdentity } from '../shared/visitor-identity.js';
import { identityContext } from '../src/context.js';
test('host identity accepts only bounded strings and returns an allowlisted object', () => {
  assert.deepEqual(normalizeVisitorIdentity({ id: ' 123 ', name: ' Alice ', token: 'secret' }), {
    id: '123',
    name: 'Alice',
  });
  for (const value of [
    undefined,
    null,
    123,
    {},
    { id: 1, name: false },
    { id: ' ', name: '\t\n' },
    { id: 'a'.repeat(161), name: 'a'.repeat(161) },
  ])
    assert.deepEqual(normalizeVisitorIdentity(value), { id: null, name: null });
  assert.deepEqual(identityContext({ user_id: null, user_name: null }), {
    user_id: null,
    user_name: null,
    identity_source: null,
  });
});
