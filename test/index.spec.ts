import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('provisioning capture endpoint', () => {
  it('responds 200 with an empty body for any path', async () => {
    const response = await SELF.fetch('https://example.com/aabbccddeeff.cfg');
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('');
    expect(response.headers.get('Content-Type')).toBe('text/plain');
  });
});

import { env } from 'cloudflare:test';

describe('provisioning capture logging', () => {
  it('logs a parsed Yealink check-in to D1', async () => {
    await SELF.fetch('https://example.com/aabbccddeeff.cfg', {
      headers: {
        'User-Agent': 'Yealink SIP-T48U 66.85.0.15',
        'CF-Connecting-IP': '203.0.113.9',
      },
    });

    const row = await env.DB.prepare('SELECT * FROM provisioning_requests WHERE mac_address = ?')
      .bind('AA:BB:CC:DD:EE:FF')
      .first();

    expect(row?.manufacturer).toBe('Yealink');
    expect(row?.model).toBe('SIP-T48U');
    expect(row?.firmware).toBe('66.85.0.15');
    expect(row?.source_ip).toBe('203.0.113.9');
    expect(row?.path).toBe('/aabbccddeeff.cfg');
    expect(row?.http_method).toBe('GET');
    expect(JSON.parse(String(row?.headers_json))['user-agent']).toBe('Yealink SIP-T48U 66.85.0.15');
  });

  it('logs unparseable requests with null device fields and still returns 200', async () => {
    const response = await SELF.fetch('https://example.com/whatever?x=1', {
      method: 'POST',
      headers: { 'User-Agent': 'curl/8.0', 'X-Forwarded-For': '198.51.100.7, 10.0.0.1' },
    });
    expect(response.status).toBe(200);

    const row = await env.DB.prepare('SELECT * FROM provisioning_requests WHERE path = ?')
      .bind('/whatever')
      .first();
    expect(row?.mac_address).toBeNull();
    expect(row?.manufacturer).toBeNull();
    expect(row?.query_string).toBe('?x=1');
    expect(row?.http_method).toBe('POST');
    expect(row?.source_ip).toBe('198.51.100.7');
  });
});
