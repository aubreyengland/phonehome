import type { BlockedIpRow } from '../blocked.ts';
import { escapeHtml, renderPage } from './layout.ts';

export interface SettingsView {
  servingEnabled: boolean;
  allowedIpsText: string;
  adminAllowedIpsText: string;
  blocked: BlockedIpRow[];
  /** Validation problems from a rejected save; the page re-renders with the submitted text. */
  errors: string[];
}

function renderBlocked(rows: BlockedIpRow[]): string {
  if (rows.length === 0) return '<p class="muted">No blocked requests recorded.</p>';
  const body = rows
    .map(
      (r) => `<tr><td class="mono">${escapeHtml(r.ip)}</td><td class="num">${r.count}</td><td>${escapeHtml(r.firstSeen)}</td><td>${escapeHtml(r.lastSeen)}</td><td class="mono">${escapeHtml(r.lastPath ?? '')}</td></tr>`,
    )
    .join('\n');
  return `<table>
    <thead><tr><th>IP</th><th class="num">Blocked</th><th>First seen</th><th>Last seen</th><th>Last path</th></tr></thead>
    <tbody>
${body}
    </tbody>
  </table>`;
}

export function renderSettingsPage(view: SettingsView): string {
  const errors = view.errors.length
    ? `<div class="warn"><strong>Not saved.</strong><ul>${view.errors.map((e) => `<li>${escapeHtml(e)}</li>`).join('')}</ul></div>`
    : '';
  const body = `  <h1>Settings</h1>
  ${errors}
  <form method="POST" action="/admin/settings">
    <h2>Serving</h2>
    <p>Serving is <span class="badge ${view.servingEnabled ? 'on' : 'off'}">${view.servingEnabled ? 'ON' : 'OFF'}</span>.
    When off, every <code>{mac}.cfg</code> request gets a 404 and no phone is redirected.</p>
    <label><input type="checkbox" name="servingEnabled"${view.servingEnabled ? ' checked' : ''}> Serve Zoom redirect configs to eligible phones</label>

    <h2>Provisioning IP allowlist</h2>
    <p>Public IPs or CIDRs the phones come from, one per line (<code>#</code> comments allowed). Requests from any other IP get a 404,
    are <em>not</em> written to the request log, and are counted below. <strong>Empty = every IP is allowed.</strong></p>
    <label>Allowed IPs<br><textarea name="allowedIps" rows="6" cols="48" spellcheck="false">${escapeHtml(view.allowedIpsText)}</textarea></label>

    <h2>Admin IP allowlist</h2>
    <p>IPs allowed to reach <code>/admin</code> at all (checked before the password). Empty = no restriction.
    The save is refused if your own IP would be locked out. If you do lock yourself out anyway, clear it with
    <code>npx wrangler d1 execute phone_provisioning --remote --command "DELETE FROM settings WHERE key = 'admin_allowed_ips'"</code>.</p>
    <label>Admin IPs<br><textarea name="adminAllowedIps" rows="4" cols="48" spellcheck="false">${escapeHtml(view.adminAllowedIpsText)}</textarea></label>

    <p><button type="submit">Save</button></p>
  </form>

  <h2>Blocked IPs</h2>
  ${renderBlocked(view.blocked)}
  <form method="POST" action="/admin/settings/purge">
    <p><button type="submit">Purge non-allowlisted history</button>
    <span class="muted">Deletes request-log rows from IPs outside the provisioning allowlist and resets the table above. No-op while the allowlist is empty.</span></p>
  </form>`;
  return renderPage('Settings', 'settings', body);
}
