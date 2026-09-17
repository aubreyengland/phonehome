import { renderPage } from './layout.ts';

export function renderSettingsPage(servingEnabled: boolean): string {
  const body = `  <h1>Settings</h1>
  <p>Serving is <span class="badge ${servingEnabled ? 'on' : 'off'}">${servingEnabled ? 'ON' : 'OFF'}</span>.
  When off, every <code>{mac}.cfg</code> request gets a 404 and no phone is redirected.</p>
  <form method="POST" action="/admin/settings">
    <label><input type="checkbox" name="servingEnabled"${servingEnabled ? ' checked' : ''}> Serve Zoom redirect configs to eligible phones</label>
    <button type="submit">Save</button>
  </form>`;
  return renderPage('Settings', 'settings', body);
}
