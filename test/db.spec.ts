import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { insertRequestLog } from '../src/db.ts';

describe('insertRequestLog', () => {
  it('persists a full request log row', async () => {
    await insertRequestLog(env.DB, {
      receivedAt: '2026-09-16T00:00:00.000Z',
      sourceIp: '203.0.113.5',
      manufacturer: 'Yealink',
      model: 'SIP-T48U',
      firmware: '66.85.0.15',
      macAddress: 'AA:BB:CC:DD:EE:FF',
      httpMethod: 'GET',
      path: '/aabbccddeeff.cfg',
      queryString: '',
      userAgent: 'Yealink SIP-T48U 66.85.0.15',
      headersJson: '{"user-agent":"Yealink SIP-T48U 66.85.0.15"}',
    });

    const row = await env.DB.prepare('SELECT * FROM provisioning_requests').first();
    expect(row?.mac_address).toBe('AA:BB:CC:DD:EE:FF');
    expect(row?.manufacturer).toBe('Yealink');
    expect(row?.headers_json).toContain('user-agent');
  });
});
