import path from 'node:path';
import { readdir } from 'node:fs/promises';
import { recordingStore } from './storage.js';
import { pageSchema, scrubField } from './schema.js';
import { sanitizePageEvents } from '../shared/page-events.js';

export function createPageSessions({ directory, repository, persist }) {
  const pending = recordingStore(path.join(directory, '.pending')),
    locks = new Map(),
    timers = new Map();
  function locked(id, operation) {
    const previous = locks.get(id) || Promise.resolve();
    const result = previous.catch(() => {}).then(operation);
    locks.set(id, result);
    result
      .finally(() => {
        if (locks.get(id) === result) locks.delete(id);
      })
      .catch(() => {});
    return result;
  }
  async function load(claims) {
    try {
      return await pending.read(claims.id);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return {
        claims,
        events: [],
        fields: [],
        user_id: null,
        page_title: '',
        duration_ms: 0,
        truncated: false,
        finish: null,
      };
    }
  }
  async function commit(draft) {
    if (
      !draft.finish ||
      draft.events.length < draft.finish.expected_count ||
      !draft.events.some((event) => event.type === 2)
    )
      return null;
    const page = pageSchema.parse({
      format: 'rrweb',
      duration_ms: draft.duration_ms,
      truncated: draft.truncated,
      events: draft.events,
    });
    const result = await persist(draft.claims, {
      scope: 'page',
      form_key: 'page',
      form_id: '',
      user_id: draft.user_id,
      user_name: draft.user_name || null,
      page_title: draft.page_title,
      save_reason: draft.finish.reason,
      duration_ms: draft.duration_ms,
      truncated: draft.truncated,
      fields: draft.fields,
      events: [],
      page,
    });
    clearTimeout(timers.get(draft.claims.id));
    timers.delete(draft.claims.id);
    await pending.remove(draft.claims.id);
    return result;
  }
  function exitFallback(claims) {
    if (timers.has(claims.id)) return;
    const timer = setTimeout(() => {
      timers.delete(claims.id);
      locked(claims.id, async () => {
        if (await repository.findSession(claims.id, 'page')) return;
        const draft = await load(claims);
        if (!draft.finish || !draft.events.some((event) => event.type === 2)) return;
        if (draft.events.length < draft.finish.expected_count) {
          draft.truncated = true;
          draft.finish.expected_count = draft.events.length;
          await pending.write(claims.id, draft);
        }
        await commit(draft);
      }).catch(() => {});
    }, 6000);
    timer.unref();
    timers.set(claims.id, timer);
  }
  return {
    checkpoint(claims, body) {
      return locked(claims.id, async () => {
        const existing = await repository.findSession(claims.id, 'page');
        if (existing)
          return { recording_id: existing.id, next_offset: body.offset + body.events.length };
        const draft = await load(claims);
        if (
          body.offset > draft.events.length ||
          (body.offset < draft.events.length &&
            body.offset + body.events.length > draft.events.length)
        ) {
          const error = new Error('Checkpoint offset mismatch');
          error.status = 409;
          error.expectedOffset = draft.events.length;
          throw error;
        }
        if (body.offset === draft.events.length) {
          const events = [...draft.events, ...body.events];
          if (
            events.length > 15000 ||
            Buffer.byteLength(JSON.stringify(events)) > 7 * 1024 * 1024
          ) {
            const error = new Error('Page capture limit reached');
            error.status = 413;
            throw error;
          }
          const page = pageSchema.safeParse({
            format: 'rrweb',
            events,
            duration_ms: body.duration_ms,
            truncated: body.truncated,
          });
          if (!page.success) {
            const error = new Error('Invalid page checkpoint');
            error.status = 400;
            throw error;
          }
          try {
            draft.events = sanitizePageEvents(events);
          } catch {
            const error = new Error('Invalid page snapshot');
            error.status = 400;
            throw error;
          }
          draft.duration_ms = Math.max(draft.duration_ms, body.duration_ms);
          draft.truncated ||= body.truncated;
          draft.fields = body.fields.map(scrubField);
          draft.user_id = body.user_id;
          draft.user_name = body.user_name || null;
          draft.page_title = body.page_title;
        }
        await pending.write(claims.id, draft);
        const result = await commit(draft);
        return { next_offset: draft.events.length, ...result };
      });
    },
    finish(claims, body) {
      return locked(claims.id, async () => {
        const existing = await repository.findSession(claims.id, 'page');
        if (existing) {
          await pending.remove(claims.id);
          return { recording_id: existing.id, duplicate: true };
        }
        const draft = await load(claims);
        draft.finish = { reason: body.reason, expected_count: body.expected_count };
        await pending.write(claims.id, draft);
        const result = await commit(draft);
        if (!result && body.reason === 'pagehide') exitFallback(claims);
        return result || { pending: true };
      });
    },
    async close() {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      await Promise.allSettled([...locks.values()]);
    },
    async recover() {
      const files = await readdir(path.join(directory, '.pending')).catch((error) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      });
      for (const file of files) {
        if (!/^[0-9a-f-]{36}\.(?:json|capture)\.gz$/.test(file)) continue;
        const id = file.split('.')[0],
          draft = await pending.read(id);
        if (draft.finish)
          await locked(id, async () => {
            if (await repository.findSession(id, 'page')) await pending.remove(id);
            else {
              let result;
              try {
                result = await commit(draft);
              } catch (error) {
                if (error.status === 401) {
                  await pending.remove(id);
                  return;
                }
                throw error;
              }
              if (!result && draft.finish.reason === 'pagehide') exitFallback(draft.claims);
            }
          });
      }
    },
  };
}
