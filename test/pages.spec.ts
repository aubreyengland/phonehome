import { describe, expect, it } from 'vitest';
import { escapeHtml, renderPage } from '../src/pages/layout.ts';
import { renderZoomPage } from '../src/pages/zoom.ts';
import { renderSettingsPage } from '../src/pages/settings.ts';

describe('layout', () => {
  it('escapes the five HTML metacharacters', () => {
    expect(escapeHtml(`<a href="x">&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
  });

  it('marks the active nav item', () => {
    const html = renderPage('T', 'zoom', '<p>body</p>');
    expect(html).toContain('<a href="/admin/zoom" class="active">');
    expect(html).not.toContain('<a href="/admin" class="active">');
    expect(html).toContain('<p>body</p>');
    expect(html).toContain('<title>T</title>');
  });
});

describe('renderZoomPage', () => {
  it('renders the credentials form, never the secret, and the sync status', () => {
    const html = renderZoomPage({
      config: { clientId: 'client-123', clientSecretEncrypted: 'CIPHERTEXT', accountId: 'account-456', updatedAt: '2026-09-17T00:00:00.000Z' },
      lastSyncAt: '2026-09-17T01:00:00.000Z',
      lastSyncResult: 'ok: 12 devices',
      deviceCount: 12,
    });
    expect(html).toContain('action="/admin/zoom"');
    expect(html).toContain('name="clientId"');
    expect(html).toContain('name="clientSecret"');
    expect(html).toContain('name="accountId"');
    expect(html).toContain('client-123');
    expect(html).not.toContain('CIPHERTEXT');
    expect(html).toContain('ok: 12 devices');
    expect(html).toContain('2026-09-17T01:00:00.000Z');
  });

  it('says never synced when there is no sync yet', () => {
    const html = renderZoomPage({ config: null, lastSyncAt: null, lastSyncResult: null, deviceCount: 0 });
    expect(html).toContain('Not configured yet');
    expect(html).toContain('never');
  });
});

describe('renderSettingsPage', () => {
  const base = { servingEnabled: false, allowedIpsText: '', adminAllowedIpsText: '', blocked: [], errors: [] };

  it('reflects the kill switch state', () => {
    expect(renderSettingsPage({ ...base, servingEnabled: true })).toContain('name="servingEnabled" checked');
    expect(renderSettingsPage(base)).toContain('name="servingEnabled">');
    expect(renderSettingsPage(base)).toContain('action="/admin/settings"');
  });

  it('renders both allowlists, escaped, and the purge form', () => {
    const html = renderSettingsPage({ ...base, allowedIpsText: '203.0.113.0/24 # <office>', adminAllowedIpsText: '198.51.100.7' });
    expect(html).toContain('name="allowedIps"');
    expect(html).toContain('203.0.113.0/24 # &lt;office&gt;');
    expect(html).toContain('name="adminAllowedIps"');
    expect(html).toContain('198.51.100.7');
    expect(html).toContain('action="/admin/settings/purge"');
  });

  it('lists blocked IPs with counts and shows validation errors', () => {
    const html = renderSettingsPage({
      ...base,
      blocked: [{ ip: '130.12.180.117', count: 132, firstSeen: 't1', lastSeen: 't2', lastPath: '/.env' }],
      errors: ['Allowed IPs line 2: "nope" — not an IP address or CIDR'],
    });
    expect(html).toContain('130.12.180.117');
    expect(html).toContain('<td class="num">132</td>');
    expect(html).toContain('/.env');
    expect(html).toContain('Not saved.');
    expect(html).toContain('line 2: &quot;nope&quot;');
  });
});
