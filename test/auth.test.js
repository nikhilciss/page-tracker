import test from 'node:test';
import assert from 'node:assert/strict';
import { issueSession, verifySession } from '../src/auth.js';
const config = { secret: 'a'.repeat(64), sessionTtl: 60 };
const context = {
  origin: 'https://example.com',
  page_url: 'https://example.com/form',
  browser: 'Test',
};
test('signed sessions are unique, origin-bound, tamper-resistant and expire', () => {
  const a = issueSession(context, config, 100000),
    b = issueSession(context, config, 100000);
  assert.notEqual(a.session_id, b.session_id);
  assert.equal(verifySession(a.token, context.origin, config, 100000).id, a.session_id);
  assert.throws(() => verifySession(`${a.token}x`, context.origin, config, 100000));
  assert.throws(() => verifySession(a.token, 'https://evil.example', config, 100000));
  assert.throws(() => verifySession(a.token, context.origin, config, 160000));
});
