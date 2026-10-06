import { authenticatedIdentity, AuthenticationError } from './authenticated-identity.js';
import { verifyDomain } from './domain-access.js';
import {
  randomBytes,
  randomUUID,
  createHash,
  scrypt as derive,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';
import { z } from 'zod';
import { rateLimit } from 'express-rate-limit';
import express from 'express';
const scrypt = promisify(derive);
const email = z
  .string()
  .trim()
  .email()
  .max(254)
  .transform((value) => value.toLowerCase());
const password = z.string().min(12).max(128);
export function normalizeOrigin(value) {
  const url = new URL(value.includes('://') ? value : 'https://' + value);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  )
    throw new Error('Enter a domain or origin without a page path.');
  if (url.origin.length > 255) throw new Error('Domain is too long.');
  return url.origin;
}
export async function hashPassword(value) {
  const salt = randomBytes(16).toString('hex');
  const hash = await scrypt(value, salt, 64);
  return salt + ':' + hash.toString('hex');
}
export async function checkPassword(value, stored) {
  const [salt, hash] = stored.split(':');
  const actual = await scrypt(value, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
const digest = (value) => createHash('sha256').update(value).digest('hex');
const tokenFrom = (req) =>
  (req.get('Cookie') || '')
    .split(';')
    .map((v) => v.trim())
    .find((v) => v.startsWith('tracker_session='))
    ?.slice(16);
const publicUser = (user) => ({
  ...authenticatedIdentity(user),
  email: user.email,
  company_origin: user.company_origin,
  is_master: !!user.is_master,
});
export function accountAuth({ app, config, repository, verifier = verifyDomain }) {
  const cookieOptions = {
    httpOnly: true,
    secure: config.publicOrigin.startsWith('https:'),
    sameSite: 'strict',
    path: '/',
  };
  const csrf = (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    if (req.get('Origin') !== config.publicOrigin || req.get('Sec-Fetch-Site') === 'cross-site')
      return res.status(403).json({ error: 'Request origin is not allowed.' });
    next();
  };
  async function requireLogin(req, res, next) {
    const token = tokenFrom(req);
    if (!token || !/^[a-f0-9]{64}$/.test(token))
      return res.status(401).json({ error: 'Please log in.' });
    const user = await repository.loginSession(digest(token));
    if (!user) return res.status(401).json({ error: 'Session expired. Please log in.' });
    try {
      authenticatedIdentity(user);
    } catch (error) {
      if (error instanceof AuthenticationError)
        return res.status(401).json({ error: error.message });
      throw error;
    }
    req.account = user;
    next();
  }
  async function startSession(req, res, user) {
    let responseUser;
    try {
      responseUser = publicUser(user);
    } catch (error) {
      if (error instanceof AuthenticationError)
        return res.status(401).json({ error: error.message });
      throw error;
    }
    const old = tokenFrom(req);
    if (old) await repository.deleteLoginSession(digest(old));
    const token = randomBytes(32).toString('hex');
    await repository.createLoginSession(
      digest(token),
      user.id,
      new Date(Date.now() + 12 * 3600000),
    );
    res.cookie('tracker_session', token, { ...cookieOptions, maxAge: 12 * 3600000 });
    res.json({ user: responseUser });
  }
  app.use('/api/auth', express.json({ limit: '8kb' }), csrf);
  const limiter = rateLimit({
    windowMs: 15 * 60000,
    limit: 30,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
  });
  app.post('/api/auth/signup', limiter, async (req, res) => {
    const parsed = z
      .object({
        name: z.string().trim().min(1).max(160),
        email,
        password,
        company_domain: z.string().trim().min(1).max(255),
      })
      .strict()
      .safeParse(req.body);
    if (!parsed.success)
      return res.status(400).json({
        error: 'Provide a name, valid email, company domain, and a password of 12–128 characters.',
      });
    let company_origin;
    try {
      company_origin = normalizeOrigin(parsed.data.company_domain);
    } catch {
      return res
        .status(400)
        .json({ error: 'Use a domain or full origin (including port), without a page path.' });
    }
    try {
      if (!(await verifier(company_origin, null, 'http', config.localVerificationOrigins || [])))
        return res.status(400).json({
          error:
            'Signup requires your company website to return HTTP 200. Only same-origin redirects are followed (up to three).',
        });
    } catch {
      return res.status(400).json({
        error:
          'Cannot reach the company website. Check its URL. Local development domains require LOCAL_VERIFICATION_ORIGINS.',
      });
    }
    const user = {
      id: randomUUID(),
      name: parsed.data.name,
      email: parsed.data.email,
      company_origin,
      domain_verified_at: new Date(),
      key_version: 0,
      password_hash: await hashPassword(parsed.data.password),
    };
    try {
      await repository.createAccount(user);
    } catch (error) {
      if (error.code === 'ER_DUP_ENTRY')
        return res
          .status(409)
          .json({ error: 'An account with this email or company origin already exists.' });
      throw error;
    }
    await startSession(req, res, await repository.accountByEmail(user.email));
  });
  // A fixed dummy hash keeps unknown-email logins on the password verification path.
  const dummy = hashPassword(randomBytes(32).toString('hex'));
  app.post(['/api/auth/login', '/api/auth/master/login'], limiter, async (req, res) => {
    const parsed = z
      .object({ email, password: z.string().min(1).max(128) })
      .strict()
      .safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Enter your email and password.' });
    const user = await repository.accountByEmail(parsed.data.email);
    const valid = await checkPassword(parsed.data.password, user?.password_hash || (await dummy));
    if (!user || !valid || !!user.is_master !== (req.path === '/api/auth/master/login'))
      return res.status(401).json({ error: 'Incorrect email or password.' });
    await startSession(req, res, user);
  });
  app.get('/api/auth/me', requireLogin, (req, res) => res.json({ user: publicUser(req.account) }));
  app.post('/api/auth/logout', requireLogin, async (req, res) => {
    await repository.deleteLoginSession(digest(tokenFrom(req)));
    res.clearCookie('tracker_session', cookieOptions);
    res.json({ status: 'logged_out' });
  });
  return { requireLogin, csrf };
}
