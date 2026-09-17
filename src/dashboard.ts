import type { FleetRow, FleetStatus, ZoomConfigRecord } from './db.ts';

export type FleetFilter = FleetStatus | 'all';

const FILTERS: { value: FleetFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'seen', label: 'Seen' },
  { value: 'not-seen', label: 'Not seen' },
  { value: 'unexpected', label: 'Unexpected' },
];

export function parseFleetFilter(value: string | null): FleetFilter {
  return FILTERS.some((f) => f.value === value) ? (value as FleetFilter) : 'all';
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function cell(value: string | number | null): string {
  return value === null ? '<td class="muted">—</td>' : `<td>${escapeHtml(String(value))}</td>`;
}

function renderRow(row: FleetRow): string {
  return `<tr class="status-${row.status}">
  <td><span class="badge">${escapeHtml(row.status)}</span></td>
  <td class="mono">${escapeHtml(row.macAddress)}</td>
  ${cell(row.expectedName)}
  ${cell(row.expectedExtension)}
  ${cell(row.expectedModel)}
  ${cell(row.manufacturer && row.model ? `${row.manufacturer} ${row.model}` : (row.manufacturer ?? row.model))}
  ${cell(row.firmware)}
  ${cell(row.sourceIp)}
  ${cell(row.lastSeenAt)}
  <td class="num">${row.checkInCount}</td>
</tr>`;
}

export function renderDashboard(rows: FleetRow[], filter: FleetFilter, zoomConfig: ZoomConfigRecord | null): string {
  const counts = {
    expected: rows.filter((r) => r.status !== 'unexpected').length,
    seen: rows.filter((r) => r.status === 'seen').length,
    notSeen: rows.filter((r) => r.status === 'not-seen').length,
    unexpected: rows.filter((r) => r.status === 'unexpected').length,
  };
  const visible = filter === 'all' ? rows : rows.filter((r) => r.status === filter);

  const filterLinks = FILTERS.map(
    (f) => `<a href="/admin?status=${f.value}"${f.value === filter ? ' class="active"' : ''}>${f.label}</a>`,
  ).join(' ');

  const zoomStatus = zoomConfig
    ? `<p>Configured: client ID <code>${escapeHtml(zoomConfig.clientId)}</code>, account ID <code>${escapeHtml(zoomConfig.accountId)}</code>, saved ${escapeHtml(zoomConfig.updatedAt)}. Saving again overwrites.</p>`
    : '<p>Not configured yet.</p>';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Provisioning Inventory</title>
<style>
  body { font: 14px/1.4 system-ui, sans-serif; margin: 1.5rem; color: #1a1a1a; }
  h1, h2 { font-weight: 600; }
  .summary { display: flex; gap: 1.5rem; margin: 1rem 0; }
  .summary div { padding: .5rem .75rem; border: 1px solid #ddd; border-radius: 6px; }
  .summary strong { display: block; font-size: 1.4rem; }
  .filters a { margin-right: .75rem; }
  .filters a.active { font-weight: 700; text-decoration: none; }
  table { border-collapse: collapse; width: 100%; margin-top: 1rem; }
  th, td { text-align: left; padding: .35rem .5rem; border-bottom: 1px solid #e5e5e5; white-space: nowrap; }
  th { background: #f5f5f5; position: sticky; top: 0; }
  .mono { font-family: ui-monospace, monospace; }
  .num { text-align: right; }
  .muted { color: #999; }
  .badge { font-size: .75rem; padding: .1rem .4rem; border-radius: 4px; background: #eee; }
  .status-seen .badge { background: #d8f3dc; }
  .status-not-seen .badge { background: #fff3cd; }
  .status-unexpected .badge { background: #f8d7da; }
  form label { display: block; margin: .5rem 0; }
  form input { width: 24rem; max-width: 100%; }
</style>
</head>
<body>
  <h1>Provisioning Inventory</h1>
  <div class="summary">
    <div>Expected <strong>${counts.expected}</strong></div>
    <div>Seen <strong>${counts.seen}</strong></div>
    <div>Not seen <strong>${counts.notSeen}</strong></div>
    <div>Unexpected <strong>${counts.unexpected}</strong></div>
  </div>
  <div class="filters">${filterLinks}</div>
  <table>
    <thead>
      <tr><th>Status</th><th>MAC</th><th>Name</th><th>Ext</th><th>Expected model</th><th>Seen as</th><th>Firmware</th><th>Last IP</th><th>Last seen</th><th class="num">Check-ins</th></tr>
    </thead>
    <tbody>
${visible.map(renderRow).join('\n')}
    </tbody>
  </table>
  <p class="muted">${visible.length} of ${rows.length} rows shown.</p>

  <h2>Zoom S2S Settings</h2>
  ${zoomStatus}
  <form method="POST" action="/admin/settings">
    <label>Client ID <input name="clientId" required autocomplete="off"></label>
    <label>Client Secret <input name="clientSecret" type="password" required autocomplete="off"></label>
    <label>Account ID <input name="accountId" required autocomplete="off"></label>
    <button type="submit">Save</button>
  </form>
</body>
</html>`;
}
