import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
await mkdir('public/vendor', { recursive: true });
await Promise.all([
  build({
    entryPoints: ['client/tracker.js'],
    outfile: 'public/tracker.js',
    bundle: true,
    minify: true,
    format: 'iife',
    target: 'es2020',
    legalComments: 'eof',
  }),
  build({
    entryPoints: ['client/video-replay.js'],
    outfile: 'public/vendor/video-replay.js',
    bundle: true,
    minify: true,
    format: 'iife',
    target: 'es2020',
    legalComments: 'eof',
  }),
  copyFile('node_modules/rrweb/dist/style.css', 'public/vendor/rrweb.css'),
]);
console.info('Built tracker and offline video renderer.');
