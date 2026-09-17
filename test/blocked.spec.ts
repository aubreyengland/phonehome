import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { clearBlockedIps, deleteRequestsFromIps, listBlockedIps, listRequestSourceIps, recordBlockedIp } from '../src/blocked.ts';
import { insertRequestLog } from '../src/db.ts';

function logFrom(ip: string, path = '/x.cfg') {
  return insertRequestLog(env.DB, {
    receivedAt: '2026-09-17T00:00:00.000Z',
    sourceIp: ip,
    manufacturer: null, model: null, firmware: null, macAddress: null,
    httpMethod: 'GET', path, queryString: '', userAgent: null, headersJson: '{}',
    responseStatus: 404, responseKind: 'not_found', responseReason: 'unknown-file',
  });
}

describe('blocked_ips', () => {
  it('counts repeat offenders and keeps first/last seen and last path', async () => {
    await recordBlockedIp(env.DB, '130.12.180.117', '/.env', '2026-09-17T18:00:00.000Z');
    await recordBlockedIp(env.DB, '130.12.180.117', '/.git/config', '2026-09-17T19:00:00.000Z');
    await recordBlockedIp(env.DB, '157.245.204.205', '/', '2026-09-17T18:30:00.000Z');
    expect(await listBlockedIps(env.DB)).toEqual([
      { ip: '130.12.180.117', count: 2, firstSeen: '2026-09-17T18:00:00.000Z', lastSeen: '2026-09-17T19:00:00.000Z', lastPath: '/.git/config' },
      { ip: '157.245.204.205', count: 1, firstSeen: '2026-09-17T18:30:00.000Z', lastSeen: '2026-09-17T18:30:00.000Z', lastPath: '/' },
    ]);
    await clearBlockedIps(env.DB);
    expect(await listBlockedIps(env.DB)).toEqual([]);
  });

  it('lists distinct source IPs and deletes request rows by IP', async () => {
    await logFrom('203.0.113.9');
    await logFrom('203.0.113.9', '/y.cfg');
    await logFrom('130.12.180.117');
    expect((await listRequestSourceIps(env.DB)).sort()).toEqual(['130.12.180.117', '203.0.113.9']);
    expect(await deleteRequestsFromIps(env.DB, ['130.12.180.117', '1.1.1.1'])).toBe(1);
    expect(await deleteRequestsFromIps(env.DB, [])).toBe(0);
    const left = await env.DB.prepare('SELECT COUNT(*) AS n FROM provisioning_requests').first<{ n: number }>();
    expect(left?.n).toBe(2);
  });
});
