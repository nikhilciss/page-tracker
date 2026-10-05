import { mkdir, writeFile, rename, unlink, readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { gzip, gunzip } from 'node:zlib';
import { serialize, deserialize } from 'node:v8';
import { randomUUID } from 'node:crypto';
const compress = promisify(gzip),
  decompress = promisify(gunzip);
export function recordingStore(directory) {
  const filename = (id) => {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id))
      throw new Error('Invalid recording ID');
    return path.join(directory, `${id}.capture.gz`);
  };
  return {
    async write(id, data) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const final = filename(id),
        temp = `${final}.${randomUUID()}.tmp`;
      const buffer = await compress(serialize(data));
      try {
        await writeFile(temp, buffer, { flag: 'wx', mode: 0o600 });
        await rename(temp, final);
      } finally {
        await unlink(temp).catch((error) => {
          if (error.code !== 'ENOENT') throw error;
        });
      }
      return buffer.length;
    },
    async read(id) {
      try {
        return deserialize(
          await decompress(await readFile(filename(id)), { maxOutputLength: 16 * 1024 * 1024 }),
        );
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        // Read-only compatibility for captures created before video-only storage.
        return JSON.parse(
          (
            await decompress(await readFile(filename(id).replace('.capture.gz', '.json.gz')), {
              maxOutputLength: 16 * 1024 * 1024,
            })
          ).toString(),
        );
      }
    },
    async removeCapture(id) {
      await Promise.all(
        [filename(id), filename(id).replace('.capture.gz', '.json.gz')].map((file) =>
          unlink(file).catch((error) => {
            if (error.code !== 'ENOENT') throw error;
          }),
        ),
      );
    },
    async remove(id) {
      const base = filename(id).replace(/\.capture\.gz$/, '');
      await Promise.all(
        [
          '.capture.gz',
          '.json.gz',
          '.mp4',
          '.mp4.tmp.mp4',
          '.tmp.mp4',
          '.video',
          '.video.tmp',
          '.video.json',
          '.video.json.tmp',
        ].map((suffix) =>
          unlink(base + suffix).catch((error) => {
            if (error.code !== 'ENOENT') throw error;
          }),
        ),
      );
    },
  };
}
