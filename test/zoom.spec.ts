import { env } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { encryptSecret } from '../src/crypto.ts';
import { SETTING, getSetting, saveZoomConfig } from '../src/db.ts';
import { countZoomDevices, fetchS2SToken, fetchZoomDevices, replaceZoomDevices, syncZoomDevices, toZoomDeviceRows } from '../src/zoom.ts';

type FetchImpl = typeof fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** A fetch stub that answers the token call, then device pages keyed by `type` and `next_page_token`. */
function zoomStub(pages: Record<string, { devices: unknown[]; next_page_token?: string }>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.startsWith('https://zoom.us/oauth/token')) {
      return jsonResponse({ access_token: 'tok-123', token_type: 'bearer', expires_in: 3600 });
    }
    const u = new URL(url);
    const key = `${u.searchParams.get('type')}:${u.searchParams.get('next_page_token') ?? ''}`;
    const page = pages[key];
    return page ? jsonResponse({ ...page, next_page_token: page.next_page_token ?? '' }) : jsonResponse({ code: 404 }, 404);
  }) as unknown as FetchImpl;
  return { impl, calls };
}

const creds = { clientId: 'cid', clientSecret: 'shh', accountId: 'acc' };

describe('fetchS2SToken', () => {
  it('posts account_credentials with Basic auth and returns the token', async () => {
    const { impl, calls } = zoomStub({});
    expect(await fetchS2SToken(impl, creds)).toBe('tok-123');
    expect(calls[0]?.url).toBe('https://zoom.us/oauth/token');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(new Headers(calls[0]?.init?.headers).get('Authorization')).toBe(`Basic ${btoa('cid:shh')}`);
    expect(String(calls[0]?.init?.body)).toBe('grant_type=account_credentials&account_id=acc');
  });

  it('throws with the status on a non-200 without leaking the secret', async () => {
    const impl = vi.fn(async () => jsonResponse({ reason: 'Invalid client' }, 401)) as unknown as FetchImpl;
    await expect(fetchS2SToken(impl, creds)).rejects.toThrow(/401/);
    await expect(fetchS2SToken(impl, creds)).rejects.not.toThrow(/shh/);
  });
});

describe('fetchZoomDevices', () => {
  it('walks both device types and every page with a bearer token', async () => {
    const { impl, calls } = zoomStub({
      'assigned:': { devices: [{ id: 'a1' }], next_page_token: 'p2' },
      'assigned:p2': { devices: [{ id: 'a2' }] },
      'unassigned:': { devices: [{ id: 'u1' }] },
    });
    const devices = await fetchZoomDevices(impl, 'tok-123');
    expect(devices.map((d) => (d as { id: string }).id)).toEqual(['a1', 'a2', 'u1']);
    expect(calls.every((c) => new Headers(c.init?.headers).get('Authorization') === 'Bearer tok-123')).toBe(true);
    expect(calls.map((c) => new URL(c.url).searchParams.get('page_size'))).toEqual(['100', '100', '100']);
  });
});

describe('toZoomDeviceRows', () => {
  it('normalizes MACs, flattens the assignee, keeps raw JSON, skips devices without a MAC', () => {
    const rows = toZoomDeviceRows(
      [
        { id: 'a1', mac_address: '64-16-7F-4B-6B-E7', display_name: 'Lobby', device_type: 'Polycom VVX411', status: 'online', assignee: { name: 'Jess', extension_number: 5326 } },
        { id: 'a2', mac_address: '805ec0aabbcc', display_name: 'Desk', device_type: 'Yealink T48S', status: 'offline', assignees: [{ name: 'Sam' }] },
        { id: 'a3', display_name: 'No MAC' },
        { id: 'a4', mac_address: 'not-a-mac' },
      ],
      '2026-09-17T00:00:00.000Z',
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      macAddress: '64:16:7F:4B:6B:E7',
      zoomDeviceId: 'a1',
      displayName: 'Lobby',
      deviceType: 'Polycom VVX411',
      assignee: 'Jess (5326)',
      status: 'online',
      rawJson: JSON.stringify({ id: 'a1', mac_address: '64-16-7F-4B-6B-E7', display_name: 'Lobby', device_type: 'Polycom VVX411', status: 'online', assignee: { name: 'Jess', extension_number: 5326 } }),
      syncedAt: '2026-09-17T00:00:00.000Z',
    });
    expect(rows[1]?.assignee).toBe('Sam');
  });
});

describe('replaceZoomDevices / syncZoomDevices', () => {
  it('replaces the mirror wholesale', async () => {
    const row = { macAddress: '80:5E:C0:00:00:01', zoomDeviceId: 'a1', displayName: null, deviceType: null, assignee: null, status: null, rawJson: '{}', syncedAt: 't' };
    await replaceZoomDevices(env.DB, [row, { ...row, macAddress: '80:5E:C0:00:00:02', zoomDeviceId: 'a2' }]);
    await replaceZoomDevices(env.DB, [{ ...row, macAddress: '80:5E:C0:00:00:03', zoomDeviceId: 'a3' }]);
    expect(await countZoomDevices(env.DB)).toBe(1);
    const only = await env.DB.prepare('SELECT mac_address FROM zoom_devices').first<{ mac_address: string }>();
    expect(only?.mac_address).toBe('80:5E:C0:00:00:03');
  });

  it('survives Zoom returning the same MAC twice in one page (duplicate assigned + unassigned entries)', async () => {
    const row = { macAddress: '80:5E:C0:00:00:07', zoomDeviceId: 'first', displayName: null, deviceType: null, assignee: null, status: null, rawJson: '{}', syncedAt: 't' };
    await replaceZoomDevices(env.DB, [row, { ...row, zoomDeviceId: 'second' }]);
    expect(await countZoomDevices(env.DB)).toBe(1);
    const only = await env.DB.prepare('SELECT zoom_device_id FROM zoom_devices').first<{ zoom_device_id: string }>();
    expect(only?.zoom_device_id).toBe('second');
  });

  it('syncs end to end and records the result', async () => {
    await saveZoomConfig(env.DB, { clientId: 'cid', clientSecretEncrypted: await encryptSecret('shh', env.ENCRYPTION_KEY), accountId: 'acc', updatedAt: 't' });
    const { impl } = zoomStub({
      'assigned:': { devices: [{ id: 'a1', mac_address: '805ec0000001' }] },
      'unassigned:': { devices: [{ id: 'u1', mac_address: '805ec0000002' }, { id: 'u2' }] },
    });
    const result = await syncZoomDevices(env, impl);
    expect(result).toEqual({ ok: true, message: 'ok: 2 devices mirrored (1 without a MAC skipped)' });
    expect(await countZoomDevices(env.DB)).toBe(2);
    expect(await getSetting(env.DB, SETTING.lastZoomSyncResult)).toBe(result.message);
    expect(await getSetting(env.DB, SETTING.lastZoomSyncAt)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('reports missing credentials without touching the mirror', async () => {
    await replaceZoomDevices(env.DB, [{ macAddress: '80:5E:C0:00:00:09', zoomDeviceId: 'x', displayName: null, deviceType: null, assignee: null, status: null, rawJson: '{}', syncedAt: 't' }]);
    const result = await syncZoomDevices(env, vi.fn() as unknown as FetchImpl);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/not configured/);
    expect(await countZoomDevices(env.DB)).toBe(1);
  });

  it('never throws even if recording the sync result itself fails', async () => {
    await env.DB.exec('DROP TABLE settings');
    try {
      const result = await syncZoomDevices(env, vi.fn() as unknown as FetchImpl);
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/not configured/);
    } finally {
      await env.DB.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    }
  });

  it('keeps the previous mirror when Zoom errors mid-way', async () => {
    await saveZoomConfig(env.DB, { clientId: 'cid', clientSecretEncrypted: await encryptSecret('shh', env.ENCRYPTION_KEY), accountId: 'acc', updatedAt: 't' });
    await replaceZoomDevices(env.DB, [{ macAddress: '80:5E:C0:00:00:09', zoomDeviceId: 'x', displayName: null, deviceType: null, assignee: null, status: null, rawJson: '{}', syncedAt: 't' }]);
    const { impl } = zoomStub({ 'assigned:': { devices: [{ id: 'a1', mac_address: '805ec0000001' }] } }); // unassigned page -> 404
    const result = await syncZoomDevices(env, impl);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/^error: /);
    expect(await countZoomDevices(env.DB)).toBe(1);
    expect(await getSetting(env.DB, SETTING.lastZoomSyncResult)).toBe(result.message);
  });
});
