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

import { listFleet, type FleetRow } from '../src/db.ts';
import { buildSeedSql } from '../src/fleet.ts';

function checkIn(macAddress: string, receivedAt: string, firmware: string, sourceIp = '203.0.113.5') {
  return insertRequestLog(env.DB, {
    receivedAt,
    sourceIp,
    manufacturer: 'Yealink',
    model: 'SIP-T48S',
    firmware,
    macAddress,
    httpMethod: 'GET',
    path: `/${macAddress.replace(/:/g, '').toLowerCase()}.cfg`,
    queryString: '',
    userAgent: `Yealink SIP-T48S ${firmware}`,
    headersJson: '{}',
  });
}

describe('listFleet', () => {
  it('joins expected devices with latest check-ins and flags unexpected MACs', async () => {
    await env.DB.exec(
      buildSeedSql(
        [
          { macAddress: '80:5E:C0:00:00:01', rcDeviceId: '1', name: 'Seen Phone', extension: '2001', model: 'Yealink T48S', rcStatus: 'Online' },
          { macAddress: '80:5E:C0:00:00:02', rcDeviceId: '2', name: 'Quiet Phone', extension: null, model: 'Polycom VVX411', rcStatus: 'Offline' },
        ],
        '2026-09-17T00:00:00.000Z',
      ),
    );
    await checkIn('80:5E:C0:00:00:01', '2026-09-17T01:00:00.000Z', '66.86.0.14');
    await checkIn('80:5E:C0:00:00:01', '2026-09-17T02:00:00.000Z', '66.86.0.15', '203.0.113.9');
    await checkIn('AA:AA:AA:00:00:03', '2026-09-17T01:30:00.000Z', '1.0.0.0');

    const fleet = await listFleet(env.DB);
    const byMac = Object.fromEntries(fleet.map((r) => [r.macAddress, r]));

    expect(fleet.map((r) => r.status)).toEqual(['seen', 'unexpected', 'not-seen']);

    expect(byMac['80:5E:C0:00:00:01']).toEqual<FleetRow>({
      macAddress: '80:5E:C0:00:00:01',
      status: 'seen',
      expectedName: 'Seen Phone',
      expectedExtension: '2001',
      expectedModel: 'Yealink T48S',
      rcStatus: 'Online',
      manufacturer: 'Yealink',
      model: 'SIP-T48S',
      firmware: '66.86.0.15',
      sourceIp: '203.0.113.9',
      lastSeenAt: '2026-09-17T02:00:00.000Z',
      checkInCount: 2,
    });

    expect(byMac['80:5E:C0:00:00:02']).toMatchObject({
      status: 'not-seen',
      expectedName: 'Quiet Phone',
      expectedExtension: null,
      firmware: null,
      lastSeenAt: null,
      checkInCount: 0,
    });

    expect(byMac['AA:AA:AA:00:00:03']).toMatchObject({
      status: 'unexpected',
      expectedName: null,
      firmware: '1.0.0.0',
      checkInCount: 1,
    });
  });

  it('ignores check-ins that carried no MAC', async () => {
    await insertRequestLog(env.DB, {
      receivedAt: '2026-09-17T01:00:00.000Z',
      sourceIp: null,
      manufacturer: null,
      model: null,
      firmware: null,
      macAddress: null,
      httpMethod: 'GET',
      path: '/y000000000028.cfg',
      queryString: '',
      userAgent: null,
      headersJson: '{}',
    });
    expect(await listFleet(env.DB)).toEqual([]);
  });
});
