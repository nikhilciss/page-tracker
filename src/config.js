import { parseRecordingPolicies } from './recording-policy.js';
import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function integer(name, fallback, min, max) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}`);
  return value;
}
export function getConfig() {
  const port = integer('PORT', 3000, 1, 65535);
  const publicOrigin = new URL(process.env.PUBLIC_ORIGIN || `http://localhost:${port}`).origin;
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) throw new Error('Configure SESSION_SECRET (32+ characters).');
  if (process.env.NODE_ENV === 'production' && !publicOrigin.startsWith('https://'))
    throw new Error('Production PUBLIC_ORIGIN must use HTTPS.');
  const database = process.env.DB_NAME || 'universal_tracker';
  if (!/^[a-zA-Z0-9_]+$/.test(database)) throw new Error('Invalid DB_NAME');
  return {
    localVerificationOrigins:
      process.env.NODE_ENV === 'production'
        ? []
        : (process.env.LOCAL_VERIFICATION_ORIGINS || '')
            .split(',')
            .filter(Boolean)
            .map((value) => new URL(value.trim()).origin),
    recordingPolicies: parseRecordingPolicies(process.env.RECORDING_SUCCESS_RULES),
    port,
    publicOrigin,
    secret,
    host: process.env.HOST || '127.0.0.1',
    analyticsTimeoutSeconds: integer('ANALYTICS_SESSION_TIMEOUT_SECONDS', 1800, 60, 86400),
    sessionTtl: integer('SESSION_TTL_SECONDS', 14400, 60, 86400),
    retentionDays: integer('RETENTION_DAYS', 30, 1, 3650),
    trustProxy: integer('TRUST_PROXY_HOPS', 0, 0, 10),
    recordingsDir: path.join(root, 'uploads', 'recordings'),
    chromePath: process.env.CHROME_PATH || undefined,
    videoSandbox: process.env.VIDEO_CHROMIUM_SANDBOX !== 'false',
    videoMaxSeconds: integer('VIDEO_MAX_SECONDS', 600, 1, 3600),
    videoFormat: process.env.VIDEO_FORMAT === 'mp4' ? 'mp4' : 'webm',
    videoFps: integer('VIDEO_FPS', 10, 1, 30),
    db: {
      host: process.env.DB_HOST || 'localhost',
      port: integer('DB_PORT', 3306, 1, 65535),
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASSWORD ?? 'root',
      database,
      timezone: 'Z',
      connectionLimit: 10,
      enableKeepAlive: true,
      charset: 'utf8mb4',
    },
  };
}
