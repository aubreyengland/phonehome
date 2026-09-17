import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { insertRequestLog } from '../src/db.ts';
import { listRecentRequests, renderConsolePage } from '../src/console.ts';

async function log(path: string, receivedAt: string) {
  await insertRequestLog(env.DB, {
    receivedAt,
    sourceIp: '203.0.113.5',
    manufacturer: 'Yealink',
    model: 'SIP-T48S',
    firmware: '66.86.0.15',
    macAddress: '80:5E:C0:AA:BB:CC',
    httpMethod: 'GET',
    path,
    queryString: '',
    userAgent: 'Yealink SIP-T48S 66.86.0.15',
    headersJson: '{"user-agent":"Yealink SIP-T48S 66.86.0.15"}',
    responseStatus: 404,
    responseKind: 'not_found',
    responseReason: 'not-in-zoom',
  });
}

describe('listRecentRequests', () => {
  it('returns newest first with a limit, and only rows after a cursor', async () => {
    await log('/a.cfg', '2026-09-17T00:00:01.000Z');
    await log('/b.cfg', '2026-09-17T00:00:02.000Z');
    await log('/c.cfg', '2026-09-17T00:00:03.000Z');

    const all = await listRecentRequests(env.DB, {});
    expect(all.map((r) => r.path)).toEqual(['/c.cfg', '/b.cfg', '/a.cfg']);
    expect(all[0]).toMatchObject({ macAddress: '80:5E:C0:AA:BB:CC', responseStatus: 404, responseKind: 'not_found', responseReason: 'not-in-zoom' });
    expect(typeof all[0]?.id).toBe('number');

    expect((await listRecentRequests(env.DB, { limit: 2 })).map((r) => r.path)).toEqual(['/c.cfg', '/b.cfg']);
    expect((await listRecentRequests(env.DB, { after: all[2]!.id })).map((r) => r.path)).toEqual(['/c.cfg', '/b.cfg']);
    expect(await listRecentRequests(env.DB, { after: all[0]!.id })).toEqual([]);
  });
});

describe('renderConsolePage', () => {
  it('embeds the initial rows as JSON, escaping </script>, and includes the poller', () => {
    const html = renderConsolePage([
      {
        id: 7,
        receivedAt: 't',
        sourceIp: null,
        macAddress: null,
        manufacturer: null,
        model: null,
        firmware: null,
        httpMethod: 'GET',
        path: '/</script><script>alert(1)</script>',
        queryString: '',
        userAgent: null,
        headersJson: '{}',
        responseStatus: 404,
        responseKind: 'not_found',
        responseReason: 'unknown-file',
      },
    ]);
    expect(html).not.toContain('</script><script>alert(1)');
    expect(html).toContain('\\u003c/script>');
    expect(html).toContain("fetch('/admin/api/requests?after=' + lastId)");
    expect(html).toContain('2000');
    expect(html).toContain('id="pause"');
    expect(html).toContain('id="filter"');
  });

  it('parses headers defensively client-side instead of a raw double JSON.parse', () => {
    const html = renderConsolePage([]);
    expect(html).toContain('prettyHeaders(');
    expect(html).not.toContain('JSON.parse(JSON.parse(');
  });

  it('still embeds a row with unparsable headersJson (the page render never executes the client script)', () => {
    const html = renderConsolePage([
      {
        id: 1,
        receivedAt: 't',
        sourceIp: null,
        macAddress: null,
        manufacturer: null,
        model: null,
        firmware: null,
        httpMethod: 'GET',
        path: '/malformed-headers.cfg',
        queryString: '',
        userAgent: null,
        headersJson: 'not json',
        responseStatus: 404,
        responseKind: 'not_found',
        responseReason: 'unknown-file',
      },
    ]);
    expect(html).toContain('/malformed-headers.cfg');
  });
});
