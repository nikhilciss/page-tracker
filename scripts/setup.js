import { readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { root } from '../src/config.js';
const example = await readFile(`${root}/.env.example`, 'utf8');
const content = example.replace(
  'SESSION_SECRET=\n',
  `SESSION_SECRET=${randomBytes(32).toString('hex')}\n`,
);
try {
  await writeFile(`${root}/.env`, content, { flag: 'wx', mode: 0o600 });
  console.info('Created .env with random secrets. Run npm run db:init, then npm start.');
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  console.info('.env already exists; left unchanged.');
}
