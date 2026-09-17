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

import { decryptSecret } from '../src/crypto.ts';
import { getZoomConfig, isServingEnabled } from '../src/db.ts';
import { buildSeedSql } from '../src/fleet.ts';

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
