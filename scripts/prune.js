import { readdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { getConfig } from '../src/config.js';
import { createRepository } from '../src/db.js';
import { recordingStore } from '../src/storage.js';
const config = getConfig(),
  repository = createRepository(config),
  store = recordingStore(config.recordingsDir);
let removed = 0;
try {
  while (true) {
    const rows = await repository.expired(config.retentionDays);
    for (const row of rows) {
      await store.remove(row.id);
      await repository.remove(row.id);
      removed++;
    }
    if (rows.length < 1000) break;
  }
  // Recover files left behind by process termination between filesystem and DB writes.
  const files = await readdir(config.recordingsDir).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  for (const name of files) {
    const match =
      /^([0-9a-f-]{36})(?:\.(?:json|capture)\.gz(?:\.[0-9a-f-]{36}\.tmp)?|\.mp4|\.tmp\.mp4|\.video(?:\.json)?(?:\.tmp)?)$/.exec(
        name,
      );
    if (!match) continue;
    const file = path.join(config.recordingsDir, name);
    if ((await stat(file)).mtimeMs > Date.now() - 86400000) continue;
    if (name.endsWith('.tmp') || name.endsWith('.tmp.mp4') || !(await repository.get(match[1]))) {
      await unlink(file);
      removed++;
    }
  }
  // Unfinalized page checkpoints and interrupted writes are temporary, never public.
  const pendingDirectory = path.join(config.recordingsDir, '.pending');
  const pendingFiles = await readdir(pendingDirectory).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  for (const name of pendingFiles) {
    if (!/^[0-9a-f-]{36}\.(?:json|capture)\.gz(?:\.[0-9a-f-]{36}\.tmp)?$/.test(name)) continue;
    const file = path.join(pendingDirectory, name);
    if ((await stat(file)).mtimeMs < Date.now() - 86400000) {
      await unlink(file);
      removed++;
    }
  }
  console.info(`Removed ${removed} expired or orphaned recordings.`);
} finally {
  await repository.close();
}
