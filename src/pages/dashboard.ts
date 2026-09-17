import type { FleetRow, FleetStatus } from '../db.ts';
import { escapeHtml, renderPage } from './layout.ts';

export type FleetFilter = FleetStatus | 'all';

export interface DashboardHeader {
  servingEnabled: boolean;
  lastZoomSyncAt: string | null;
  zoomDeviceCount: number;
  /** True when no provisioning IP allowlist is configured, i.e. the endpoint answers every IP. */
  allowlistEmpty: boolean;
}

const FILTERS: { value: FleetFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'seen', label: 'Seen' },
  { value: 'not-seen', label: 'Not seen' },
  { value: 'unexpected', label: 'Unexpected' },
];

export function parseFleetFilter(value: string | null): FleetFilter {
  return FILTERS.some((f) => f.value === value) ? (value as FleetFilter) : 'all';
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
  <td>${row.inZoom ? '<span class="badge on">yes</span>' : '<span class="muted">no</span>'}</td>
  ${cell(row.lastRedirectAt)}
  ${cell(row.manufacturer && row.model ? `${row.manufacturer} ${row.model}` : (row.manufacturer ?? row.model))}
  ${cell(row.firmware)}
  ${cell(row.sourceIp)}
  ${cell(row.lastSeenAt)}
  <td class="num">${row.checkInCount}</td>
</tr>`;
}

export function renderDashboard(rows: FleetRow[], filter: FleetFilter, header: DashboardHeader): string {
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

  const body = `  <h1>Provisioning Inventory</h1>
  ${header.allowlistEmpty ? '<div class="warn"><strong>No IP allowlist.</strong> The provisioning endpoint answers every IP on the internet. Set one under <a href="/admin/settings">Settings</a>.</div>' : ''}
  <p>Serving <span class="badge ${header.servingEnabled ? 'on' : 'off'}">${header.servingEnabled ? 'ON' : 'OFF'}</span>
  · Zoom mirror: ${header.zoomDeviceCount} devices, synced ${header.lastZoomSyncAt ? escapeHtml(header.lastZoomSyncAt) : 'never'}</p>
  <div class="summary">
    <div>Expected <strong>${counts.expected}</strong></div>
    <div>Seen <strong>${counts.seen}</strong></div>
    <div>Not seen <strong>${counts.notSeen}</strong></div>
    <div>Unexpected <strong>${counts.unexpected}</strong></div>
  </div>
  <div class="filters">${filterLinks}</div>
  <table>
    <thead>
      <tr><th>Status</th><th>MAC</th><th>Name</th><th>Ext</th><th>Expected model</th><th>In Zoom</th><th>Redirected</th><th>Seen as</th><th>Firmware</th><th>Last IP</th><th>Last seen</th><th class="num">Check-ins</th></tr>
    </thead>
    <tbody>
${visible.map(renderRow).join('\n')}
    </tbody>
  </table>
  <p class="muted">${visible.length} of ${rows.length} rows shown.</p>`;

  return renderPage('Provisioning Inventory', 'fleet', body);
}
