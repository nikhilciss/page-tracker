import { lookup } from 'node:dns/promises';
import https from 'node:https';
import http from 'node:http';
export function publicIPv4(ip) {
  const p = ip.split('.').map(Number);
  return (
    p.length === 4 &&
    p.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) &&
    ![0, 10, 127].includes(p[0]) &&
    p[0] < 224 &&
    !(p[0] === 169 && p[1] === 254) &&
    !(p[0] === 172 && p[1] >= 16 && p[1] <= 31) &&
    !(p[0] === 192 && [0, 168].includes(p[1])) &&
    !(p[0] === 100 && p[1] >= 64 && p[1] <= 127) &&
    !(p[0] === 198 && [18, 19, 51].includes(p[1])) &&
    !(p[0] === 203 && p[1] === 0)
  );
}
async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('DNS timeout')), 5000);
        timer.unref();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
export async function verifyDomain(origin, token, method, localOrigins = []) {
  const url = new URL(origin);
  const local = localOrigins.includes(url.origin);
  if (!['http:', 'https:'].includes(url.protocol) || (!local && url.port))
    throw new Error('Use a standard HTTP or HTTPS port.');
  const addresses = await bounded(lookup(url.hostname, { family: 4, all: true }));
  if (!addresses.length || (!local && addresses.some((a) => !publicIPv4(a.address))))
    throw new Error('Private network verification is blocked.');
  url.pathname = '/';
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? https : http).get(
      url,
      {
        lookup: (_host, options, callback) =>
          callback(
            null,
            options.all ? [{ address: addresses[0].address, family: 4 }] : addresses[0].address,
            4,
          ),
        agent: false,
        headers: { Accept: 'text/plain' },
      },
      (response) => {
        const available = response.statusCode === 200;
        response.destroy();
        resolve(available);
      },
    );
    const timer = setTimeout(() => request.destroy(new Error('Verification timeout')), 5000);
    request.on('close', () => clearTimeout(timer));
    request.on('error', reject);
  });
}
export function domainAccess({ app, repository, requireLogin, csrf }) {
  app.get('/api/account/integration', requireLogin, csrf, async (req, res) => {
    if (req.account.is_master) return res.status(403).json({ error: 'Use a company account.' });
    const access = await repository.integration(req.account.id);
    res.json({ origin: req.account.company_origin, verified: !!access?.domain_verified_at });
  });
}
