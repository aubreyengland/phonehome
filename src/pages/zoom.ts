import type { ZoomConfigRecord } from '../db.ts';
import { escapeHtml, renderPage } from './layout.ts';

export interface ZoomPageView {
  config: ZoomConfigRecord | null;
  lastSyncAt: string | null;
  lastSyncResult: string | null;
  deviceCount: number;
}

export function renderZoomPage(view: ZoomPageView): string {
  const status = view.config
    ? `<p>Configured: client ID <code>${escapeHtml(view.config.clientId)}</code>, account ID <code>${escapeHtml(view.config.accountId)}</code>, saved ${escapeHtml(view.config.updatedAt)}. Saving again overwrites.</p>`
    : '<p>Not configured yet.</p>';

  const body = `  <h1>Zoom</h1>
  <h2>Device mirror</h2>
  <p>${view.deviceCount} devices mirrored. Last sync: ${view.lastSyncAt ? escapeHtml(view.lastSyncAt) : 'never'}${view.lastSyncResult ? ` — ${escapeHtml(view.lastSyncResult)}` : ''}.</p>
  <form method="POST" action="/admin/zoom/sync"><button type="submit">Sync now</button></form>
  <h2>Server-to-Server OAuth credentials</h2>
  ${status}
  <form method="POST" action="/admin/zoom">
    <label>Client ID <input type="text" name="clientId" required autocomplete="off"></label>
    <label>Client Secret <input type="password" name="clientSecret" required autocomplete="off"></label>
    <label>Account ID <input type="text" name="accountId" required autocomplete="off"></label>
    <button type="submit">Save</button>
  </form>`;
  return renderPage('Zoom', 'zoom', body);
}
