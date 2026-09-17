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
  it('reflects the kill switch state', () => {
    expect(renderSettingsPage(true)).toContain('name="servingEnabled" checked');
    expect(renderSettingsPage(false)).toContain('name="servingEnabled">');
    expect(renderSettingsPage(false)).toContain('action="/admin/settings"');
  });
});
