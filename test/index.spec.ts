import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('provisioning capture endpoint', () => {
  it('responds 404 with an empty body for an unknown MAC file', async () => {
    const response = await SELF.fetch('https://example.com/aabbccddeeff.cfg');
    expect(response.status).toBe(404);
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

import { decryptSecret } from '../src/crypto.ts';
import { getZoomConfig, isServingEnabled, SETTING, setSetting } from '../src/db.ts';
import { buildSeedSql } from '../src/fleet.ts';
import { listProfiles, refreshProfiles, saveProfile } from '../src/profiles.ts';
import { replaceZoomDevices } from '../src/zoom.ts';

const AUTH = { Authorization: `Basic ${btoa('admin:secret')}` };

describe('/admin', () => {
  it('rejects requests without valid Basic Auth', async () => {
    const response = await SELF.fetch('https://example.com/admin');
    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toContain('Basic');
  });

  it('does not log admin requests as provisioning check-ins', async () => {
    await SELF.fetch('https://example.com/admin');
    await SELF.fetch('https://example.com/admin', { headers: AUTH });
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM provisioning_requests').first<{ n: number }>();
    expect(count?.n).toBe(0);
  });

  it('renders the fleet dashboard for authenticated requests', async () => {
    await env.DB.exec(
      buildSeedSql(
        [{ macAddress: '80:5E:C0:00:00:02', rcDeviceId: '2', name: 'Quiet Phone', extension: null, model: 'Polycom VVX411', rcStatus: 'Offline' }],
        '2026-09-17T00:00:00.000Z',
      ),
    );
    await SELF.fetch('https://example.com/aabbccddeeff.cfg', { headers: { 'User-Agent': 'Yealink SIP-T48U 66.85.0.15' } });

    const response = await SELF.fetch('https://example.com/admin', { headers: AUTH });
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('text/html');
    const html = await response.text();
    expect(html).toContain('Provisioning Inventory');
    expect(html).toContain('Quiet Phone');
    expect(html).toContain('AA:BB:CC:DD:EE:FF');
  });

  it('applies the ?status= filter', async () => {
    await env.DB.exec(
      buildSeedSql(
        [{ macAddress: '80:5E:C0:00:00:02', rcDeviceId: '2', name: 'Quiet Phone', extension: null, model: 'Polycom VVX411', rcStatus: 'Offline' }],
        '2026-09-17T00:00:00.000Z',
      ),
    );
    await SELF.fetch('https://example.com/aabbccddeeff.cfg', { headers: { 'User-Agent': 'Yealink SIP-T48U 66.85.0.15' } });

    const html = await (await SELF.fetch('https://example.com/admin?status=unexpected', { headers: AUTH })).text();
    expect(html).toContain('AA:BB:CC:DD:EE:FF');
    expect(html).not.toContain('Quiet Phone');
  });
});

describe('/admin/zoom', () => {
  it('rejects unauthenticated POSTs', async () => {
    const response = await SELF.fetch('https://example.com/admin/zoom', { method: 'POST' });
    expect(response.status).toBe(401);
  });

  it('renders the credentials page', async () => {
    const response = await SELF.fetch('https://example.com/admin/zoom', { headers: AUTH });
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.text()).toContain('name="clientSecret"');
  });

  it('saves the encrypted client secret and redirects back to /admin/zoom', async () => {
    const form = new URLSearchParams({ clientId: 'client-123', clientSecret: 'super-secret-value', accountId: 'account-456' });
    const response = await SELF.fetch('https://example.com/admin/zoom', {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      redirect: 'manual',
    });
    expect(response.status).toBe(303);
    expect(response.headers.get('Location')).toBe('https://example.com/admin/zoom');
    expect(response.headers.get('Cache-Control')).toBe('no-store');

    const config = await getZoomConfig(env.DB);
    expect(config?.clientId).toBe('client-123');
    expect(config?.clientSecretEncrypted).not.toContain('super-secret-value');
    expect(await decryptSecret(config!.clientSecretEncrypted, env.ENCRYPTION_KEY)).toBe('super-secret-value');
  });

  it('rejects a submission with a missing field', async () => {
    const response = await SELF.fetch('https://example.com/admin/zoom', {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ clientId: 'x', accountId: 'y' }).toString(),
    });
    expect(response.status).toBe(400);
    expect(await getZoomConfig(env.DB)).toBeNull();
  });
});

describe('/admin/settings', () => {
  it('shows the kill switch and toggles it', async () => {
    let html = await (await SELF.fetch('https://example.com/admin/settings', { headers: AUTH })).text();
    expect(html).toContain('name="servingEnabled">');

    const on = await SELF.fetch('https://example.com/admin/settings', {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'servingEnabled=on',
      redirect: 'manual',
    });
    expect(on.status).toBe(303);
    expect(await isServingEnabled(env.DB)).toBe(true);

    html = await (await SELF.fetch('https://example.com/admin/settings', { headers: AUTH })).text();
    expect(html).toContain('name="servingEnabled" checked');

    await SELF.fetch('https://example.com/admin/settings', {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: '',
      redirect: 'manual',
    });
    expect(await isServingEnabled(env.DB)).toBe(false);
  });

  it('returns 404 for unknown admin paths', async () => {
    const response = await SELF.fetch('https://example.com/admin/nope', { headers: AUTH });
    expect(response.status).toBe(404);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });
});

describe('/admin/profiles', () => {
  const seed = () =>
    env.DB.exec(
      buildSeedSql(
        [{ macAddress: '80:5E:C0:00:00:01', rcDeviceId: '1', name: 'A', extension: null, model: 'Yealink T48S', rcStatus: null }],
        '2026-09-17T00:00:00.000Z',
      ),
    );
  const post = (path: string, body: string) =>
    SELF.fetch(`https://example.com${path}`, {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      redirect: 'manual',
    });

  it('refreshes models from the expected fleet and renders them', async () => {
    await seed();
    expect((await post('/admin/profiles/refresh', '')).status).toBe(303);
    const html = await (await SELF.fetch('https://example.com/admin/profiles', { headers: AUTH })).text();
    expect(html).toContain('Yealink T48S');
    expect(html).toContain('name="zoom_url:Yealink T48S"');
  });

  it('saves every row of the form', async () => {
    await seed();
    await post('/admin/profiles/refresh', '');
    const body = new URLSearchParams({
      'vendor:Yealink T48S': 'yealink',
      'zoom_url:Yealink T48S': 'https://provpp.zoom.us/y/',
      'enabled:Yealink T48S': 'on',
    }).toString();
    expect((await post('/admin/profiles', body)).status).toBe(303);
    expect((await listProfiles(env.DB))[0]).toMatchObject({ vendor: 'yealink', zoomUrl: 'https://provpp.zoom.us/y/', enabled: true });
  });

  it('rejects a non-https Zoom URL with 400 and saves nothing', async () => {
    await seed();
    await post('/admin/profiles/refresh', '');
    const response = await post('/admin/profiles', new URLSearchParams({ 'vendor:Yealink T48S': 'yealink', 'zoom_url:Yealink T48S': 'http://x' }).toString());
    expect(response.status).toBe(400);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect((await listProfiles(env.DB))[0]?.zoomUrl).toBeNull();
  });
});

describe('/admin/zoom/sync', () => {
  it('runs a sync and redirects back with the result recorded', async () => {
    const response = await SELF.fetch('https://example.com/admin/zoom/sync', { method: 'POST', headers: AUTH, redirect: 'manual' });
    expect(response.status).toBe(303);
    expect(response.headers.get('Location')).toBe('https://example.com/admin/zoom');
    const html = await (await SELF.fetch('https://example.com/admin/zoom', { headers: AUTH })).text();
    expect(html).toContain('not configured');
    expect(html).toContain('action="/admin/zoom/sync"');
  });
});

describe('provisioning endpoint (phase 2)', () => {
  async function makeReady() {
    await env.DB.exec(buildSeedSql([{ macAddress: '80:5E:C0:AA:BB:CC', rcDeviceId: '1', name: 'A', extension: null, model: 'Yealink T48S', rcStatus: null }], 't'));
    await refreshProfiles(env.DB, 't');
    await saveProfile(env.DB, { model: 'Yealink T48S', vendor: 'yealink', zoomUrl: 'https://provpp.zoom.us/y/', enabled: true }, 't');
    await replaceZoomDevices(env.DB, [{ macAddress: '80:5E:C0:AA:BB:CC', zoomDeviceId: 'z', displayName: null, deviceType: null, assignee: null, status: null, rawJson: '{}', syncedAt: 't' }]);
    await setSetting(env.DB, SETTING.servingEnabled, '1');
  }
  const lastLog = () =>
    env.DB.prepare('SELECT path, response_status, response_kind, response_reason FROM provisioning_requests ORDER BY id DESC LIMIT 1').first();

  it('serves the redirect and logs it', async () => {
    await makeReady();
    const response = await SELF.fetch('https://example.com/805ec0aabbcc.cfg', { headers: { 'User-Agent': 'Yealink SIP-T48S 66.86.0.15' } });
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/plain');
    expect(await response.text()).toContain('https://provpp.zoom.us/y/');
    expect(await lastLog()).toEqual({ path: '/805ec0aabbcc.cfg', response_status: 200, response_kind: 'redirect', response_reason: null });
  });

  it('404s with the reason when the kill switch is off', async () => {
    await makeReady();
    await setSetting(env.DB, SETTING.servingEnabled, '0');
    const response = await SELF.fetch('https://example.com/805ec0aabbcc.cfg');
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('');
    expect(await lastLog()).toMatchObject({ response_kind: 'not_found', response_reason: 'serving-off' });
  });

  it('404s common files and still logs them', async () => {
    const response = await SELF.fetch('https://example.com/y000000000065.cfg', { headers: { 'User-Agent': 'Yealink SIP-T48S 66.86.0.15 80:5e:c0:aa:bb:cc' } });
    expect(response.status).toBe(404);
    const row = await env.DB.prepare('SELECT mac_address, response_reason FROM provisioning_requests').first();
    expect(row).toEqual({ mac_address: '80:5E:C0:AA:BB:CC', response_reason: 'unknown-file' });
  });

  it('accepts Poly uploads with 200', async () => {
    const response = await SELF.fetch('https://example.com/64167f4b6be7-phone.cfg', { method: 'PUT', body: '<x/>' });
    expect(response.status).toBe(200);
    expect(await lastLog()).toMatchObject({ response_kind: 'accepted', response_reason: 'upload' });
  });

  it('degrades to a logged 404 when loading the serve context throws', async () => {
    await makeReady();
    await env.DB.exec('DROP TABLE provisioning_profiles');
    try {
      const response = await SELF.fetch('https://example.com/805ec0aabbcc.cfg');
      expect(response.status).toBe(404);
      expect(await response.text()).toBe('');
      expect(await lastLog()).toMatchObject({ response_kind: 'not_found', response_reason: 'context-error' });
    } finally {
      await env.DB.exec(
        'CREATE TABLE provisioning_profiles (model TEXT PRIMARY KEY, vendor TEXT NOT NULL, zoom_url TEXT, enabled INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL)',
      );
    }
  });
});
