import { randomUUID } from 'node:crypto';

export function createPersister({ repository, store, videos, logger = console }) {
  const queue = (id) =>
    videos
      ?.enqueue(id)
      .catch((error) =>
        logger.error('Could not queue video', { id, code: error.code || 'VIDEO_QUEUE_ERROR' }),
      );
  return async (claims, body) => {
    if (!claims.account_id || !Number.isInteger(claims.key_version))
      throw Object.assign(new Error('Recording authorization required'), { status: 401 });
    const access = await repository.integration(claims.account_id);
    if (!access?.domain_verified_at || access.key_version !== claims.key_version)
      throw Object.assign(new Error('Recording authorization revoked'), { status: 401 });
    const existing = await repository.findSession(claims.id, body.form_key);
    if (existing) {
      await queue(existing.id);
      return { recording_id: existing.id, duplicate: true };
    }
    const id = randomUUID();
    const { token: _token, ...recording } = body;
    const data = {
      version: body.scope === 'page' ? 2 : 1,
      id,
      session_id: claims.id,
      page_url: claims.page_url,
      browser: claims.browser,
      submitted_at: new Date().toISOString(),
      ...recording,
      account_id: claims.account_id || null,
    };
    const size = await store.write(id, data);
    try {
      await repository.insert({
        ...data,
        size_bytes: size,
        event_count: body.scope === 'page' ? body.page.events.length : body.events.length,
        field_count: body.fields.length,
      });
    } catch (error) {
      await store.remove(id);
      if (error.code === 'ER_DUP_ENTRY') {
        const duplicate = await repository.findSession(claims.id, body.form_key);
        if (duplicate) {
          await queue(duplicate.id);
          return { recording_id: duplicate.id, duplicate: true };
        }
      }
      throw error;
    }
    await queue(id);
    return { recording_id: id, duplicate: false };
  };
}
