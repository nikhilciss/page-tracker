import { normalizeVisitorIdentity } from '../shared/visitor-identity.js';
import { BlockList, isIP } from 'node:net';
import geoip from 'geoip-lite';
const privateNetworks = new BlockList();
for (const [ip, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['100.64.0.0', 10],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
])
  privateNetworks.addSubnet(ip, bits, 'ipv4');
for (const [ip, bits] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
])
  privateNetworks.addSubnet(ip, bits, 'ipv6');
export function locationFor(address, lookup = geoip.lookup) {
  const ip = String(address || '').replace(/^::ffff:/i, '');
  const family = isIP(ip);
  if (!family) return { ip: null, geo_status: 'unavailable' };
  if (privateNetworks.check(ip, family === 4 ? 'ipv4' : 'ipv6'))
    return { ip, geo_status: 'private' };
  let result;
  try {
    result = lookup(ip);
  } catch {}
  return result
    ? {
        ip,
        geo_status: 'approximate',
        country: result.country || null,
        region: result.region || null,
        city: result.city || null,
        geo_timezone: result.timezone || null,
      }
    : { ip, geo_status: 'unavailable' };
}
const clean = (v, max = 160) =>
  typeof v === 'string'
    ? v
        .replace(/[\u0000-\u001f\u007f]/g, '')
        .trim()
        .slice(0, max)
    : null;
export function identityContext(body) {
  const identity = normalizeVisitorIdentity({ id: body.user_id, name: body.user_name });
  return {
    user_id: identity.id,
    user_name: identity.name,
    identity_source: identity.id || identity.name ? 'host_provided' : null,
  };
}
export function captureContext(req, body) {
  let referrer_origin = null;
  try {
    const url = new URL(body.referrer || '');
    if (['http:', 'https:'].includes(url.protocol)) referrer_origin = url.origin;
  } catch {}
  return {
    ...locationFor(req.ip),
    user_agent: clean(req.get('User-Agent'), 1024),
    ...identityContext(body),
    language: clean(body.language, 40),
    timezone: clean(body.timezone, 80),
    viewport_width: body.viewport_width || null,
    viewport_height: body.viewport_height || null,
    referrer_origin,
  };
}
export async function migrateContext(c) {
  const id = 'CHAR(36) CHARACTER SET ascii COLLATE ascii_bin';
  await c.query(`CREATE TABLE IF NOT EXISTS recording_contexts (
    account_id ${id} NOT NULL, recording_session_id ${id} NOT NULL,context JSON NOT NULL,
    captured_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY(account_id,recording_session_id),FOREIGN KEY(account_id) REFERENCES accounts(id)
  ) ENGINE=InnoDB`);
}
export function contextRepository(pool) {
  return {
    async save(account, recording, context) {
      await pool.execute(
        'INSERT IGNORE INTO recording_contexts(account_id,recording_session_id,context) VALUES (?,?,?)',
        [account, recording, JSON.stringify(context)],
      );
    },
    async updateIdentity(account, recording, body) {
      const identity = identityContext(body);
      await pool.execute(
        `UPDATE recording_contexts SET context=JSON_SET(context,
          '$.user_id',CAST(? AS JSON),'$.user_name',CAST(? AS JSON),
          '$.identity_source',CAST(? AS JSON),'$.identity_updated_at',?)
         WHERE account_id=? AND recording_session_id=? AND NOT JSON_CONTAINS(context,CAST(? AS JSON))`,
        [
          JSON.stringify(identity.user_id),
          JSON.stringify(identity.user_name),
          JSON.stringify(identity.identity_source),
          new Date().toISOString(),
          account,
          recording,
          JSON.stringify(identity),
        ],
      );
    },
    async get(account, recording) {
      const [[row]] = await pool.execute(
        'SELECT context,captured_at FROM recording_contexts WHERE account_id=? AND recording_session_id=?',
        [account, recording],
      );
      return row ? { ...row.context, captured_at: row.captured_at } : null;
    },
    async session(account, id) {
      const [rows] = await pool.execute(
        'SELECT DISTINCT c.recording_session_id,c.context,c.captured_at FROM recording_contexts c JOIN session_pages p ON p.account_id=c.account_id AND p.recording_session_id=c.recording_session_id WHERE p.account_id=? AND p.tracking_session_id=? ORDER BY c.captured_at,c.recording_session_id',
        [account, id],
      );
      return rows.map((r) => ({
        ...r.context,
        recording_session_id: r.recording_session_id,
        captured_at: r.captured_at,
      }));
    },
  };
}
