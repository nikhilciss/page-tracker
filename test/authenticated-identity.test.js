import test from 'node:test';
import assert from 'node:assert/strict';
import { authenticatedIdentity, AuthenticationError } from '../src/authenticated-identity.js';

test('authenticated identity trims a valid database name and exposes only id/name', () => {
  const account = {
    id: 'account-1',
    name: '  Alice  ',
    password_hash: 'private',
    token: 'private',
  };
  assert.deepEqual(authenticatedIdentity(account), { id: 'account-1', name: 'Alice' });
  assert.equal(account.name, '  Alice  ');
});
for (const [label, account] of [
  ['missing username', { id: 1 }],
  ['empty username', { id: 1, name: '' }],
  ['whitespace-only username', { id: 1, name: ' \t\n ' }],
  ['non-string username', { id: 1, name: 42 }],
  ['missing authenticated session', null],
  ['oversized username', { id: 1, name: 'a'.repeat(161) }],
  ['missing account identifier', { name: 'Alice' }],
  ['request identity fields', { body: { id: 1, name: 'Forged' }, headers: { name: 'Forged' } }],
]) {
  test('rejects ' + label, () => {
    assert.throws(
      () => authenticatedIdentity(account),
      (error) =>
        error instanceof AuthenticationError &&
        error.status === 401 &&
        error.code === 'AUTHENTICATION_REQUIRED',
    );
  });
}
test('accepts the username length boundary', () => {
  assert.equal(authenticatedIdentity({ id: 1, name: 'a'.repeat(160) }).name.length, 160);
});
