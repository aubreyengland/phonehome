import type { ResponseKind } from './db.ts';
import { renderPage } from './pages/layout.ts';

export interface ConsoleRow {
  id: number;
  receivedAt: string;
  sourceIp: string | null;
  macAddress: string | null;
  manufacturer: string | null;
  model: string | null;
  firmware: string | null;
  httpMethod: string;
  path: string;
  queryString: string;
  userAgent: string | null;
  headersJson: string;
  responseStatus: number | null;
  responseKind: ResponseKind | null;
  responseReason: string | null;
}

const DEFAULT_LIMIT = 200;

export async function listRecentRequests(db: D1Database, opts: { after?: number; limit?: number }): Promise<ConsoleRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? DEFAULT_LIMIT, 1), 1000);
  const after = opts.after ?? 0;
  const result = await db
    .prepare(
      `SELECT id, received_at AS receivedAt, source_ip AS sourceIp, mac_address AS macAddress,
              manufacturer, model, firmware, http_method AS httpMethod, path, query_string AS queryString,
              user_agent AS userAgent, headers_json AS headersJson,
              response_status AS responseStatus, response_kind AS responseKind, response_reason AS responseReason
       FROM provisioning_requests
       WHERE id > ?
       ORDER BY id DESC
       LIMIT ?`,
    )
    .bind(after, limit)
    .all<ConsoleRow>();
  return result.results;
}

/** JSON safe to embed inside a <script> block: `<` can never close the tag. */
function embedJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

const SCRIPT = `
const tbody = document.getElementById('rows');
const filter = document.getElementById('filter');
const pause = document.getElementById('pause');
let paused = false;
let lastId = INITIAL_LAST_ID;

function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }
function dash(s) { return s == null || s === '' ? '<span class="muted">—</span>' : esc(s); }

function rowHtml(r) {
  const seenAs = r.manufacturer && r.model ? r.manufacturer + ' ' + r.model : (r.manufacturer || r.model || '');
  const text = [r.macAddress, r.path, r.userAgent, r.responseReason, r.sourceIp, seenAs].join(' ').toLowerCase();
  return '<tr class="kind-' + esc(r.responseKind) + '" data-text="' + esc(text) + '" data-id="' + r.id + '">' +
    '<td>' + esc(r.receivedAt) + '</td>' +
    '<td><span class="badge">' + esc(r.responseStatus) + ' ' + esc(r.responseKind) + '</span> ' + dash(r.responseReason) + '</td>' +
    '<td class="mono">' + dash(r.macAddress) + '</td>' +
    '<td>' + esc(r.httpMethod) + ' <span class="mono">' + esc(r.path + (r.queryString || '')) + '</span></td>' +
    '<td>' + dash(seenAs) + (r.firmware ? ' ' + esc(r.firmware) : '') + '</td>' +
    '<td>' + dash(r.sourceIp) + '</td>' +
    '</tr>' +
    '<tr class="details" hidden><td colspan="6"><pre>' + esc(r.userAgent || '(no User-Agent)') + '\\n\\n' + esc(JSON.stringify(JSON.parse(r.headersJson), null, 2)) + '</pre></td></tr>';
}

function applyFilter() {
  const q = filter.value.trim().toLowerCase();
  for (const tr of tbody.querySelectorAll('tr[data-text]')) {
    const show = !q || tr.dataset.text.includes(q);
    tr.hidden = !show;
    if (!show) tr.nextElementSibling.hidden = true;
  }
}

function render(rows, prepend) {
  const html = rows.map(rowHtml).join('');
  if (prepend) tbody.insertAdjacentHTML('afterbegin', html); else tbody.innerHTML = html;
  applyFilter();
}

tbody.addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-text]');
  if (tr) tr.nextElementSibling.hidden = !tr.nextElementSibling.hidden;
});
filter.addEventListener('input', applyFilter);
pause.addEventListener('click', () => { paused = !paused; pause.textContent = paused ? 'Resume' : 'Pause'; });

render(INITIAL_ROWS, false);

setInterval(async () => {
  if (paused) return;
  try {
    const res = await fetch('/admin/api/requests?after=' + lastId);
    if (!res.ok) return;
    const { rows } = await res.json();
    if (rows.length) { lastId = rows[0].id; render(rows, true); }
  } catch (_) { /* next tick */ }
}, 2000);
`;

export function renderConsolePage(rows: ConsoleRow[]): string {
  const lastId = rows[0]?.id ?? 0;
  const body = `  <h1>Console</h1>
  <p>Every request the phones make, newest first. Polls every 2 s. Click a row for its User-Agent and raw headers.</p>
  <p><input type="text" id="filter" placeholder="filter: MAC, path, UA, reason, IP" size="48"> <button type="button" id="pause">Pause</button></p>
  <table>
    <thead><tr><th>Received</th><th>Response</th><th>MAC</th><th>Request</th><th>Seen as</th><th>IP</th></tr></thead>
    <tbody id="rows"></tbody>
  </table>
  <script>
const INITIAL_ROWS = ${embedJson(rows)};
const INITIAL_LAST_ID = ${lastId};
${SCRIPT}
  </script>`;
  return renderPage('Console', 'console', body);
}
