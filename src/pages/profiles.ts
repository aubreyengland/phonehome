import type { ProfileRow, Vendor } from '../profiles.ts';
import { escapeHtml, renderPage } from './layout.ts';

const VENDOR_OPTIONS: Vendor[] = ['yealink', 'poly', 'other'];

function renderRow(p: ProfileRow): string {
  const m = escapeHtml(p.model);
  const options = VENDOR_OPTIONS.map((v) => `<option value="${v}"${v === p.vendor ? ' selected' : ''}>${v}</option>`).join('');
  return `<tr>
  <td>${m}</td>
  <td class="num">${p.deviceCount}</td>
  <td><select name="vendor:${m}">${options}</select></td>
  <td><input type="url" name="zoom_url:${m}" value="${escapeHtml(p.zoomUrl ?? '')}" placeholder="https://provpp.zoom.us/…"></td>
  <td><input type="checkbox" name="enabled:${m}"${p.enabled ? ' checked' : ''}></td>
</tr>`;
}

export function renderProfilesPage(profiles: ProfileRow[]): string {
  const body = `  <h1>Provisioning profiles</h1>
  <p>One row per model in the expected fleet. A phone is redirected only if its model is <em>enabled</em> and has a Zoom URL.
  Vendor picks the config file format. <code>other</code> is never served.</p>
  <form method="POST" action="/admin/profiles/refresh"><button type="submit">Refresh models from fleet</button></form>
  <form method="POST" action="/admin/profiles">
  <table>
    <thead><tr><th>Model</th><th class="num">Devices</th><th>Vendor</th><th>Zoom provisioning URL</th><th>Enabled</th></tr></thead>
    <tbody>
${profiles.map(renderRow).join('\n')}
    </tbody>
  </table>
  <p><button type="submit">Save all</button></p>
  </form>`;
  return renderPage('Profiles', 'profiles', body);
}
