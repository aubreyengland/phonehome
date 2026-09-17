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

import { getZoomConfig, saveZoomConfig } from '../src/db.ts';

describe('saveZoomConfig / getZoomConfig', () => {
  it('returns null when nothing has been saved', async () => {
    expect(await getZoomConfig(env.DB)).toBeNull();
  });

  it('saves and reads back a config record', async () => {
    await saveZoomConfig(env.DB, {
      clientId: 'client-123',
      clientSecretEncrypted: 'ciphertext-abc',
      accountId: 'account-456',
      updatedAt: '2026-09-16T00:00:00.000Z',
    });

    const config = await getZoomConfig(env.DB);
    expect(config).toEqual({
      clientId: 'client-123',
      clientSecretEncrypted: 'ciphertext-abc',
      accountId: 'account-456',
      updatedAt: '2026-09-16T00:00:00.000Z',
    });
  });

  it('overwrites the existing record on a second save (single-row upsert)', async () => {
    await saveZoomConfig(env.DB, {
      clientId: 'client-123',
      clientSecretEncrypted: 'ciphertext-abc',
      accountId: 'account-456',
      updatedAt: '2026-09-16T00:00:00.000Z',
    });
    await saveZoomConfig(env.DB, {
      clientId: 'client-999',
      clientSecretEncrypted: 'ciphertext-xyz',
      accountId: 'account-456',
      updatedAt: '2026-09-16T02:00:00.000Z',
    });

    const config = await getZoomConfig(env.DB);
    expect(config?.clientId).toBe('client-999');

    const count = await env.DB.prepare('SELECT COUNT(*) as n FROM zoom_s2s_config').first<{ n: number }>();
    expect(count?.n).toBe(1);
  });
});
