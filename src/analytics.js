import { semanticBatch } from './semantic-schema.js';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { verifySession } from './auth.js';

export function visitorCredential(visitor, account, origin, secret, identified = false) {
  const body = Buffer.from(
    JSON.stringify({ visitor, account, origin, identified, exp: Date.now() + 365 * 86400000 }),
  ).toString('base64url');
  return (
    body +
    '.' +
    createHmac('sha256', secret)
      .update('visitor:' + body)
      .digest('base64url')
  );
}
export function readVisitor(value, account, origin, secret) {
  if (!value) return null;
  try {
    const [body, signature, ...rest] = value.split('.');
    const expected = createHmac('sha256', secret)
      .update('visitor:' + body)
      .digest();
    const actual = Buffer.from(signature, 'base64url');
    if (rest.length || expected.length !== actual.length || !timingSafeEqual(expected, actual))
      return null;
    const claim = JSON.parse(Buffer.from(body, 'base64url'));
    return !claim.identified &&
      claim.account === account &&
      claim.origin === origin &&
      claim.exp > Date.now() &&
      z.uuid().safeParse(claim.visitor).success
      ? claim.visitor
      : null;
  } catch {
    return null;
  }
}
// Stable pseudonymous identity per tenant + project origin + explicit host account ID.
// This labels analytics only; it never grants access or verifies host authentication.
export function identifiedVisitor(userId, account, origin, secret) {
  if (typeof userId !== 'string' || !userId.trim() || userId.length > 160) return null;
  const bytes = createHmac('sha256', secret)
    .update(JSON.stringify(['analytics-host-user', account, origin, userId.trim()]))
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 0x80;
  bytes[8] = (bytes[8] & 63) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export function analyticsRoutes({ app, repository, config, requireLogin }) {
  const schema = z
    .object({ token: z.string().max(12000), visitor_token: z.string().max(2048).optional() })
    .strict();
  app.post('/api/track/analytics/start', async (req, res) => {
    const body = schema.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'Invalid analytics initialization' });
    let claims;
    try {
      claims = verifySession(body.data.token, req.get('Origin'), config);
      if (
        claims.account_id !== req.originOwner.id ||
        claims.key_version !== req.originOwner.key_version
      )
        throw new Error();
    } catch {
      return res.status(401).json({ error: 'Invalid session' });
    }
    const hostVisitor = identifiedVisitor(
      claims.analytics_user_id,
      claims.account_id,
      claims.origin,
      config.secret,
    );
    const visitor =
      hostVisitor ||
      readVisitor(body.data.visitor_token, claims.account_id, claims.origin, config.secret);
    await repository.semantic?.expire(claims.account_id);
    const result = await repository.analytics.start({
      account: claims.account_id,
      origin: claims.origin,
      visitor: visitor || randomUUID(),
      recording: claims.id,
      url: claims.page_url,
      timeout: config.analyticsTimeoutSeconds || 1800,
    });
    res.json({
      ...result,
      visitor_token: visitorCredential(
        result.visitor_id,
        claims.account_id,
        claims.origin,
        config.secret,
        !!hostVisitor,
      ),
    });
  });
  app.post('/api/track/analytics/activity', async (req, res) => {
    const body = z
      .object({ token: z.string().max(12000) })
      .strict()
      .safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'Invalid activity' });
    let claims;
    try {
      claims = verifySession(body.data.token, req.get('Origin'), config);
      if (
        claims.account_id !== req.originOwner.id ||
        claims.key_version !== req.originOwner.key_version
      )
        throw new Error();
    } catch {
      return res.status(401).json({ error: 'Invalid session' });
    }
    const changed = await repository.analytics.activity(claims.account_id, claims.id);
    res.status(changed ? 200 : 409).json({ status: changed ? 'active' : 'expired_or_unknown' });
  });
  app.post('/api/track/analytics/events', async (req, res) => {
    const parsed = semanticBatch.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid semantic batch' });
    let claims;
    try {
      claims = verifySession(parsed.data.token, req.get('Origin'), config);
      if (
        claims.account_id !== req.originOwner.id ||
        claims.key_version !== req.originOwner.key_version
      )
        throw new Error();
    } catch {
      return res.status(401).json({ error: 'Invalid session' });
    }
    try {
      res.json(await repository.semantic.ingest(claims, parsed.data.events));
    } catch (error) {
      if (error.status)
        return res
          .status(error.status)
          .json({ error: error.message, expected_sequence: error.expected_sequence });
      throw error;
    }
  });
  app.get('/api/admin/sessions/:id/events', requireLogin, async (req, res) => {
    if (!z.uuid().safeParse(req.params.id).success)
      return res.status(404).json({ error: 'Session not found' });
    const offset = Math.min(100000, Math.max(0, parseInt(req.query.offset) || 0));
    await repository.semantic.expire(req.account.id);
    const events = await repository.semantic.events(req.account.id, req.params.id, offset);
    if (!events) return res.status(404).json({ error: 'Session not found' });
    res.json({ events, next_offset: events.length === 200 ? offset + 200 : null });
  });
  app.get('/api/admin/sessions/:id', requireLogin, async (req, res) => {
    if (!z.uuid().safeParse(req.params.id).success)
      return res.status(404).json({ error: 'Session not found' });
    // New analytics reads remain tenant-scoped, including master accounts.
    await repository.semantic?.expire(req.account.id);
    const session = await repository.analytics.get(req.account.id, req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    res.json(session);
  });
}
