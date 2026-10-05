import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';

export function secureEqual(a, b) {
  const left = Buffer.from(a || ''),
    right = Buffer.from(b || '');
  return left.length === right.length && timingSafeEqual(left, right);
}
export function issueSession(context, config, now = Date.now()) {
  const claims = {
    v: 1,
    account_id: context.account_id,
    key_version: context.key_version,
    id: randomUUID(),
    origin: context.origin,
    page_url: context.page_url,
    browser: context.browser,
    exp: Math.floor(now / 1000) + config.sessionTtl,
  };
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = createHmac('sha256', config.secret).update(body).digest('base64url');
  return { token: `${body}.${signature}`, session_id: claims.id, expires_at: claims.exp * 1000 };
}
export function verifySession(token, origin, config, now = Date.now()) {
  if (typeof token !== 'string' || token.length > 12000) throw new Error('Invalid token');
  const parts = token.split('.');
  if (parts.length !== 2) throw new Error('Invalid token');
  const signature = createHmac('sha256', config.secret).update(parts[0]).digest('base64url');
  if (!secureEqual(signature, parts[1])) throw new Error('Invalid token');
  const claims = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
  if (claims.v !== 1 || claims.origin !== origin || claims.exp <= Math.floor(now / 1000))
    throw new Error('Expired or mismatched token');
  return claims;
}

export function signGrant(context, config, now = Date.now()) {
  const claims = {
    ...context,
    purpose: 'bootstrap',
    id: randomUUID(),
    exp: Math.floor(now / 1000) + 60,
  };
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return body + '.' + createHmac('sha256', config.secret).update(body).digest('base64url');
}
export function verifyGrant(token, config, now = Date.now()) {
  if (typeof token !== 'string' || token.length > 12000) throw new Error('Invalid grant');
  const [body, signature, ...rest] = token.split('.');
  if (
    rest.length ||
    !secureEqual(
      signature,
      createHmac('sha256', config.secret)
        .update(body || '')
        .digest('base64url'),
    )
  )
    throw new Error('Invalid grant');
  const claims = JSON.parse(Buffer.from(body, 'base64url'));
  if (
    claims.purpose !== 'bootstrap' ||
    claims.exp <= Math.floor(now / 1000) ||
    !/^[0-9a-f-]{36}$/.test(claims.id)
  )
    throw new Error('Expired grant');
  return claims;
}
