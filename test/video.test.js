import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile, readdir, unlink } from 'node:fs/promises';
import { fixture } from './helpers.js';
import { createVideoService } from '../src/video.js';
import { sanitizePageEvents } from '../shared/page-events.js';

test('page sanitization removes executable content, URL secrets and private field mutations', () => {
  const events = [
    {
      type: 4,
      timestamp: 1,
      data: { href: 'https://example.test/form?token=secret#fragment', width: 1000, height: 800 },
    },
    {
      type: 2,
      timestamp: 2,
      data: {
        node: {
          type: 0,
          id: 1,
          childNodes: [
            {
              type: 2,
              tagName: 'SCRIPT',
              id: 2,
              attributes: { src: 'http://internal/private', onload: 'danger()' },
              childNodes: [{ type: 3, id: 3, textContent: 'danger()' }],
            },
            {
              type: 2,
              tagName: 'input',
              id: 4,
              attributes: {
                name: 'password',
                type: 'password',
                value: 'top-secret',
                'data-secret': 'hidden-secret',
              },
              childNodes: [],
            },
            {
              type: 2,
              tagName: 'img',
              id: 5,
              attributes: { src: 'http://169.254.169.254/latest/meta-data' },
              childNodes: [],
            },
          ],
        },
      },
    },
    { type: 3, timestamp: 3, data: { source: 5, id: 4, text: 'top-secret', isChecked: false } },
    {
      type: 3,
      timestamp: 4,
      data: {
        source: 0,
        texts: [],
        adds: [],
        removes: [],
        attributes: [{ id: 4, attributes: { value: 'top-secret', onclick: 'danger()' } }],
      },
    },
  ];
  const clean = sanitizePageEvents(events),
    text = JSON.stringify(clean);
  assert.equal(clean[0].data.href, 'https://example.test/form');
  assert.ok(!text.includes('top-secret'));
  assert.ok(!text.includes('hidden-secret'));
  assert.ok(!text.includes('danger()'));
  assert.ok(!text.includes('169.254'));
  assert.equal(clean[2].data.text, '[REDACTED]');
});

test('video jobs recover, deduplicate, retry after failure, and delete with recording retention', async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const id = randomUUID();
  await f.store.write(id, { page: { events: [{ type: 2 }] } });
  await f.repository.insert({ id, session_id: id, form_key: 'one' });

  await writeFile(f.directory + '/' + id + '.video.json', JSON.stringify({ status: 'processing' }));
  let calls = 0;
  const videos = createVideoService({
    config: f.config,
    repository: f.repository,
    store: f.store,
    logger: { error() {} },
    renderer: async (_recording, file) => {
      calls++;
      if (calls === 1) throw new Error('Synthetic renderer failure');
      await writeFile(file, 'test video');
      return { duration_ms: 1000, width: 640, height: 480, fps: 10, truncated: false };
    },
  });
  t.after(() => videos.close());
  const awaitStatus = async (expected) => {
    for (let n = 0; n < 100; n++) {
      if ((await videos.status(id)).status === expected) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail('Job did not reach ' + expected);
  };
  await videos.recover();
  await awaitStatus('failed');
  assert.ok((await f.store.read(id)).page);
  await videos.enqueue(id);
  assert.equal(calls, 1);
  await Promise.all([videos.enqueue(id, true), videos.enqueue(id, true)]);
  await awaitStatus('ready');
  assert.equal(calls, 2);
  await assert.rejects(f.store.read(id), { code: 'ENOENT' });
  assert.deepEqual((await readdir(f.directory)).sort(), [id + '.mp4', id + '.video'].sort());
  // Simulate a crash after atomic MP4 publication and capture removal.
  await unlink(f.directory + '/' + id + '.video');
  await videos.recover();
  assert.equal((await videos.status(id)).status, 'ready');
  await videos.enqueue(id, true);
  assert.equal(calls, 2);
  await f.store.remove(id);
  assert.deepEqual(await readdir(f.directory), []);
});
