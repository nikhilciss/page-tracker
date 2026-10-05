import express from 'express';
import { domainAccess } from './domain-access.js';
import { accountAuth } from './accounts.js';
import cors from 'cors';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import path from 'node:path';
import { root } from './config.js';
import { issueSession, verifySession } from './auth.js';
import {
  initSchema,
  submissionSchema,
  scrubSubmission,
  checkpointSchema,
  finishSchema,
} from './schema.js';
import { createPersister } from './persist.js';
import { createPageSessions } from './page-sessions.js';

export function createApp({ config, repository, store, videos, logger = console, verifier }) {
  const app = express();
  const persist = createPersister({ repository, store, videos, logger });
  const pages = createPageSessions({ directory: config.recordingsDir, repository, persist });
  app.locals.pageSessions = pages;
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', config.trustProxy);
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          'media-src': ["'self'", 'blob:'],
          'upgrade-insecure-requests': process.env.NODE_ENV === 'production' ? [] : null,
        },
      },
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );
  app.get('/tracker.js', (_req, res) => {
    res.set('Cache-Control', 'no-cache');
    res.sendFile(path.join(root, 'public', 'tracker.js'));
  });
  app.get('/health', async (_req, res) => {
    try {
      await repository.ping();
      res.json({ status: 'ok' });
    } catch {
      res.status(503).json({ status: 'unavailable' });
    }
  });
  app.use('/api', (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  const { requireLogin, csrf } = accountAuth({ app, config, repository, verifier });
  domainAccess({ app, repository, config, requireLogin, csrf });
  app.use(
    '/api/track',
    async (req, res, next) => {
      req.originOwner = req.get('Origin')
        ? await repository.ownerByOrigin(req.get('Origin'))
        : null;
      if (!req.originOwner) return res.status(403).json({ error: 'Origin is not allowed' });
      next();
    },
    cors({
      origin: true,
      methods: ['POST', 'OPTIONS'],
      allowedHeaders: ['Content-Type'],
      maxAge: 600,
    }),
    rateLimit({ windowMs: 60000, limit: 120, standardHeaders: 'draft-8', legacyHeaders: false }),
    express.json({ limit: '8mb', type: ['application/json', 'text/plain'] }),
  );

  app.post('/api/track/init', async (req, res) => {
    const parsed = initSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid initialization' });
    const url = new URL(parsed.data.page_url);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== req.get('Origin'))
      return res.status(400).json({ error: 'Page origin mismatch' });
    // Query strings and fragments frequently contain credentials or personal information.
    const page_url = `${url.origin}${url.pathname}`;
    res.status(201).json(
      issueSession(
        {
          origin: url.origin,
          page_url,
          account_id: req.originOwner.id,
          key_version: req.originOwner.key_version,
          browser: (req.get('User-Agent') || '').slice(0, 1024),
        },
        config,
      ),
    );
  });
  app.post('/api/track/submit', async (req, res) => {
    const parsed = submissionSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid recording payload' });
    let claims;
    try {
      claims = verifySession(parsed.data.token, req.get('Origin'), config);
      if (
        claims.account_id !== req.originOwner.id ||
        claims.key_version !== req.originOwner.key_version
      )
        throw new Error('Account mismatch');
    } catch {
      return res.status(401).json({ error: 'Invalid or expired session' });
    }
    let body;
    try {
      body = scrubSubmission(parsed.data);
    } catch {
      return res.status(400).json({ error: 'Invalid page snapshot' });
    }
    const result = await persist(claims, body);
    res.status(result.duplicate ? 200 : 201).json(result);
  });

  for (const [action, schema] of [
    ['checkpoint', checkpointSchema],
    ['finish', finishSchema],
  ]) {
    app.post(`/api/track/page/${action}`, async (req, res) => {
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'Invalid page payload' });
      let claims;
      try {
        claims = verifySession(parsed.data.token, req.get('Origin'), config);
        if (
          claims.account_id !== req.originOwner.id ||
          claims.key_version !== req.originOwner.key_version
        )
          throw new Error('Account mismatch');
      } catch {
        return res.status(401).json({ error: 'Invalid or expired session' });
      }
      try {
        const result = await pages[action](claims, parsed.data);
        res.status(result.pending ? 202 : 200).json(result);
      } catch (error) {
        if (error.status)
          return res.status(error.status).json({
            error: error.message,
            ...(Number.isInteger(error.expectedOffset)
              ? { expected_offset: error.expectedOffset }
              : {}),
          });
        throw error;
      }
    });
  }

  app.use('/api/master', requireLogin, csrf, (req, res, next) => {
    if (!req.account.is_master)
      return res.status(403).json({ error: 'Master administrator access required.' });
    next();
  });
  app.get('/api/master/companies', async (req, res) => {
    const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 20));
    const offset = Math.min(1000000, Math.max(0, Number.parseInt(req.query.offset, 10) || 0));
    res.json(await repository.companies(limit, offset));
  });
  app.get('/api/master/companies/:id', async (req, res) => {
    const company = await repository.accountById(req.params.id);
    if (!company || company.is_master) return res.status(404).json({ error: 'Company not found' });
    const offset = Math.min(1000000, Math.max(0, Number.parseInt(req.query.offset, 10) || 0));
    res.json({ company, ...(await repository.list(20, offset, company.id)) });
  });
  app.get('/master/admin/login', (_req, res) => res.sendFile(path.join(root, 'public/login.html')));
  app.get('/master/admin', (_req, res) => res.sendFile(path.join(root, 'public/master.html')));
  app.use(
    '/api/admin',
    rateLimit({ windowMs: 60000, limit: 90, standardHeaders: 'draft-8', legacyHeaders: false }),
    requireLogin,
    csrf,
    async (req, res, next) => {
      const match = /^\/recordings\/([^/]+)/.exec(req.path);
      if (match) {
        const row = /^[0-9a-f-]{36}$/.test(match[1]) ? await repository.get(match[1]) : null;
        if (!row || (!req.account.is_master && row.account_id !== req.account.id))
          return res.status(404).json({ error: 'Recording not found' });
        req.recording = row;
      }
      next();
    },
  );
  app.get('/api/admin/recordings', async (req, res) => {
    const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 20));
    const offset = Math.min(1000000, Math.max(0, Number.parseInt(req.query.offset, 10) || 0));
    res.json(await repository.list(limit, offset, req.account.id));
  });
  app.get('/api/admin/recordings/:id', async (req, res) => {
    if (!/^[0-9a-f-]{36}$/.test(req.params.id))
      return res.status(404).json({ error: 'Recording not found' });
    const row = await repository.get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Recording not found' });
    const owner =
      row.account_id === req.account.id
        ? req.account
        : await repository.accountById(row.account_id);
    res.json({
      recording: req.recording,
      account_name: owner?.name || 'Unassigned',
      company_origin: owner?.company_origin || new URL(row.page_url).origin,
    });
  });
  app.get('/api/admin/recordings/:id/video/status', async (req, res) => {
    if (!(await repository.get(req.params.id)))
      return res.status(404).json({ error: 'Recording not found' });
    res.json(
      videos
        ? await videos.status(req.params.id)
        : { status: 'unavailable', message: 'Video worker is not enabled.' },
    );
  });
  app.post('/api/admin/recordings/:id/video/retry', async (req, res) => {
    if (!(await repository.get(req.params.id)))
      return res.status(404).json({ error: 'Recording not found' });
    if (!videos) return res.status(503).json({ error: 'Video worker is not enabled' });
    await videos.enqueue(req.params.id, true);
    res.status(202).json(await videos.status(req.params.id));
  });
  app.get('/api/admin/recordings/:id/video', async (req, res) => {
    if (!(await repository.get(req.params.id)))
      return res.status(404).json({ error: 'Recording not found' });
    if (!videos || (await videos.status(req.params.id)).status !== 'ready')
      return res.status(409).json({ error: 'Video is not ready' });
    res.type('video/mp4');
    res.set('Content-Disposition', `inline; filename="${req.params.id}.mp4"`);
    res.sendFile(videos.file(req.params.id));
  });
  // Demo destination intentionally discards the original form values.
  app.post('/demo/complete', (_req, res) => res.redirect(303, '/complete.html'));
  app.use(express.static(path.join(root, 'public'), { index: 'index.html', dotfiles: 'deny' }));
  app.use((_req, res) => res.status(404).json({ error: 'Not found' }));
  app.use((error, _req, res, _next) => {
    if (error.status === 401)
      return res.status(401).json({ error: 'Recording authorization required or revoked.' });
    if (error.type === 'entity.too.large')
      return res.status(413).json({ error: 'Payload too large' });
    if (error.type === 'entity.parse.failed')
      return res.status(400).json({ error: 'Invalid JSON' });
    logger.error('Request failed', { code: error.code || 'INTERNAL_ERROR' });
    res.status(500).json({ error: 'Request could not be completed' });
  });
  return app;
}
