import { serialize, deserialize } from 'node:v8';
import { chromium } from 'playwright';
import ffmpegPath from 'ffmpeg-static';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { readFile, writeFile, rename, chmod, unlink, readdir } from 'node:fs/promises';
import path from 'node:path';
import { root } from './config.js';

const validId = (id) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id);
export async function renderVideo(recording, destination, options = {}) {
  const events = recording.page?.events;
  if (!events?.some((event) => event.type === 2))
    throw new Error('This recording has no page capture');
  const meta = events.find((event) => event.type === 4)?.data || {};
  const width = Math.max(320, Math.min(1920, Math.ceil((Number(meta.width) || 1280) / 2) * 2));
  const height = Math.max(200, Math.min(1080, Math.ceil((Number(meta.height) || 720) / 2) * 2));
  const fps = options.fps || 10;
  const maxDuration = (options.maxSeconds || 600) * 1000;
  const capturedDuration = events.at(-1).timestamp - events[0].timestamp;
  const recordedDuration = recording.page.truncated
    ? capturedDuration
    : Math.max(recording.page.duration_ms, capturedDuration);
  const duration = Math.min(maxDuration, Math.max(1000, recordedDuration + 500));
  const frames = Math.ceil((duration / 1000) * fps);
  const executablePath =
    options.chromePath ||
    (existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined);
  let browser,
    encoder,
    encoderResult,
    failed = false;
  const format = destination.endsWith('.webm') ? 'webm' : 'mp4';
  const temporary = destination + '.tmp.' + format;
  const watchdog = setTimeout(
    () => {
      failed = true;
      encoder?.kill('SIGKILL');
      browser?.close().catch(() => {});
    },
    20 * 60 * 1000,
  );
  watchdog.unref();
  try {
    browser = await chromium.launch({ executablePath, chromiumSandbox: options.sandbox !== false });
    const context = await browser.newContext({
      viewport: { width, height },
      deviceScaleFactor: 1,
      serviceWorkers: 'block',
      offline: true,
    });
    // Captured CSS/URLs are untrusted. Never contact the recorded website or any network.
    await context.route('**/*', (route) => route.abort());
    const page = await context.newPage();
    page.setDefaultTimeout(30000);
    await page.clock.install({ time: new Date('2025-01-01T00:00:00Z') });
    await page.setContent(
      `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; frame-src 'self'"><style>html,body{margin:0;background:white;overflow:hidden}.replayer-wrapper{transform-origin:top left}.replayer-mouse{z-index:999999!important}</style></head><body></body></html>`,
    );
    await page.addStyleTag({
      content: await readFile(path.join(root, 'public/vendor/rrweb.css'), 'utf8'),
    });
    await page.addScriptTag({
      content: await readFile(path.join(root, 'public/vendor/video-replay.js'), 'utf8'),
    });
    await page.evaluate((events) => window.startVideoReplay(events), events);
    // Keep the recorded viewport proportions when rendering large displays.
    await page.evaluate(
      ({ width, height, originalWidth, originalHeight }) => {
        const wrapper = document.querySelector('.replayer-wrapper');
        if (wrapper)
          wrapper.style.transform = `scale(${Math.min(width / originalWidth, height / originalHeight)})`;
      },
      { width, height, originalWidth: meta.width || width, originalHeight: meta.height || height },
    );
    encoder = spawn(
      options.ffmpegPath || ffmpegPath,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-f',
        'image2pipe',
        '-vcodec',
        'mjpeg',
        '-framerate',
        String(fps),
        '-i',
        'pipe:0',
        '-an',
        ...(format === 'webm'
          ? [
              '-c:v',
              'libvpx-vp9',
              '-crf',
              '36',
              '-b:v',
              '0',
              '-deadline',
              'good',
              '-cpu-used',
              '4',
              '-row-mt',
              '1',
              '-threads',
              '2',
              '-pix_fmt',
              'yuv420p',
            ]
          : [
              '-c:v',
              'libx264',
              '-preset',
              'veryfast',
              '-threads',
              '2',
              '-crf',
              '23',
              '-pix_fmt',
              'yuv420p',
              '-movflags',
              '+faststart',
            ]),
        temporary,
      ],
      { stdio: ['pipe', 'ignore', 'pipe'] },
    );
    let stderr = '';
    encoder.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-2000);
    });
    encoder.stdin.on('error', () => {
      failed = true;
    });
    encoderResult = new Promise((resolve, reject) => {
      encoder.once('error', reject);
      encoder.once('close', (code) =>
        code === 0 ? resolve() : reject(new Error('Video encoding failed: ' + stderr)),
      );
    });
    encoderResult.catch(() => {
      failed = true;
    });
    for (let index = 0; index < frames; index++) {
      if (failed) throw new Error('Video render interrupted');
      await page.clock.runFor(1000 / fps);
      const image = await page.screenshot({ type: 'jpeg', quality: 80 });
      if (!encoder.stdin.write(image))
        await Promise.race([
          once(encoder.stdin, 'drain'),
          encoderResult.then(() => {
            throw new Error('Encoder stopped');
          }),
        ]);
    }
    encoder.stdin.end();
    await encoderResult;
    await chmod(temporary, 0o600);
    await rename(temporary, destination);
    return {
      format,
      segments: recording.recording_segments || [],
      duration_ms: Math.round((frames * 1000) / fps),
      width,
      height,
      fps,
      truncated: !!recording.page.truncated || recordedDuration + 500 > maxDuration,
    };
  } finally {
    clearTimeout(watchdog);
    encoder?.kill('SIGTERM');
    await browser?.close().catch(() => {});
    await unlink(temporary).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

export function createVideoService({
  config,
  repository,
  store,
  renderer = renderVideo,
  logger = console,
}) {
  const queue = [],
    scheduled = new Set();
  let running = false,
    stopped = false,
    currentTask = Promise.resolve();
  const filename = (id, suffix) => {
    if (!validId(id)) throw new Error('Invalid recording ID');
    return path.join(config.recordingsDir, id + suffix);
  };
  const outputFormat = config.videoFormat === 'mp4' ? 'mp4' : 'webm';
  const existingFile = (id) =>
    ['.webm', '.mp4'].map((suffix) => filename(id, suffix)).find((file) => existsSync(file));
  const videoFile = (id) => existingFile(id) || filename(id, '.' + outputFormat);
  async function saveStatus(id, data) {
    const target = filename(id, '.video');
    await writeFile(target + '.tmp', serialize({ ...data, updated_at: new Date().toISOString() }), {
      mode: 0o600,
    });
    await rename(target + '.tmp', target);
  }
  async function status(id) {
    try {
      const state = deserialize(await readFile(filename(id, '.video')));
      return {
        ...state,
        format: existingFile(id)?.endsWith('.webm') ? 'webm' : state.format || 'mp4',
      };
    } catch (error) {
      if (error.code === 'ENOENT') {
        try {
          const legacy = JSON.parse(await readFile(filename(id, '.video.json'), 'utf8'));
          await saveStatus(id, legacy);
          await unlink(filename(id, '.video.json')).catch((error) => {
            if (error.code !== 'ENOENT') throw error;
          });
          return legacy;
        } catch (legacyError) {
          if (legacyError.code !== 'ENOENT') throw legacyError;
        }
        return {
          status: 'legacy',
          message:
            'This recording has no page capture (older widget or capture limit). Record a fresh page session with the current widget to generate a video.',
        };
      }
      throw error;
    }
  }
  function pump() {
    if (running || stopped || !queue.length) return;
    running = true;
    const id = queue.shift();
    currentTask = (async () => {
      try {
        if (!(await repository.get(id))) return;
        await saveStatus(id, { status: 'processing' });
        if (!!existingFile(id)) {
          await store.removeCapture(id);
          await saveStatus(id, {
            status: 'ready',
            format: videoFile(id).endsWith('.webm') ? 'webm' : 'mp4',
          });
          return;
        }
        const recording = await store.read(id);
        const details = await renderer(recording, videoFile(id), {
          chromePath: config.chromePath,
          maxSeconds: config.videoMaxSeconds || 600,
          sandbox: config.videoSandbox !== false,
          fps: config.videoFps || 10,
        });
        // Retention may have removed the recording during a long render.
        if (!(await repository.get(id))) {
          await unlink(videoFile(id)).catch(() => {});
          return;
        }
        await store.removeCapture(id);
        await saveStatus(id, { status: 'ready', format: outputFormat, ...details });
      } catch (error) {
        logger.error('Video generation failed', { id, message: error.message });
        if (await repository.get(id).catch(() => null))
          await saveStatus(id, {
            status: 'failed',
            message:
              'Video generation failed. Check server logs and Chromium/FFmpeg installation, then retry.',
          }).catch(() => {});
      } finally {
        scheduled.delete(id);
        running = false;
        pump();
      }
    })();
  }
  return {
    status,
    file: (id) => videoFile(id),
    async enqueue(id, retry = false) {
      if (stopped || scheduled.has(id)) return;
      const current = await status(id);
      if (current.status === 'ready' && !!existingFile(id)) {
        await store.removeCapture(id);
        return;
      }
      if (current.status === 'failed' && !retry) return;
      if (!!existingFile(id)) {
        await store.removeCapture(id);
        await saveStatus(id, {
          status: 'ready',
          format: videoFile(id).endsWith('.webm') ? 'webm' : 'mp4',
        });
        return;
      }
      const recording = await store.read(id);
      if (!recording.page?.events?.some((event) => event.type === 2)) return;
      // A second request may have scheduled this job while the files were read.
      if (scheduled.has(id)) return;
      scheduled.add(id);
      try {
        await saveStatus(id, { status: 'queued' });
      } catch (error) {
        scheduled.delete(id);
        throw error;
      }
      queue.push(id);
      pump();
    },
    async recover() {
      const files = await readdir(config.recordingsDir).catch((error) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      });
      for (const file of files)
        if (/\.(?:(?:json|capture)\.gz|mp4|webm|video(?:\.json)?)$/.test(file)) {
          const id = file.split('.')[0];
          if (validId(id) && (await repository.get(id))) await this.enqueue(id);
        }
    },
    async close() {
      stopped = true;
      await currentTask;
    },
  };
}
