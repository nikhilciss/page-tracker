import { createVideoService } from './video.js';
import { getConfig } from './config.js';
import { createRepository } from './db.js';
import { recordingStore } from './storage.js';
import { createApp } from './app.js';

const config = getConfig();
const repository = createRepository(config);
await repository.ping();
const store = recordingStore(config.recordingsDir);
const videos = createVideoService({ config, repository, store });
await videos.recover();
const app = createApp({ config, repository, store, videos });
await app.locals.pageSessions.recover();
const server = app.listen(config.port, config.host, () => {
  console.info(`Universal Tracker listening at ${config.publicOrigin}`);
});
server.requestTimeout = 15000;
server.headersTimeout = 10000;
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    server.close(async () => {
      await app.locals.pageSessions.close();
      await videos.close();
      await repository.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000).unref();
  });
