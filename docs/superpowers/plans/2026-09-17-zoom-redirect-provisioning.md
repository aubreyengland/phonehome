# Zoom Redirect Provisioning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the Phase 1 capture-only Worker into a redirect provisioning server that
answers `{mac}.cfg` with a vendor config pointing the phone at Zoom's model-specific
provisioning URL, gated on a read-only Zoom device mirror, with a live debug console and a
kill switch.

**Architecture:** Same single Cloudflare Worker + D1. New modules: `serve.ts` (decision),
`config/yealink.ts` + `config/poly.ts` (generators), `zoom.ts` (S2S token + device list
mirror + hourly cron), `profiles.ts` (model → Zoom URL table), `console.ts` (request feed
page + JSON API), and `pages/` (one renderer per admin page behind one Basic Auth check).

**Tech Stack:** Cloudflare Workers, D1, TypeScript 7, Vitest 4 + `@cloudflare/vitest-pool-workers`
0.22 (plugin API, no per-test storage isolation — `test/apply-migrations.ts` wipes tables in
`beforeEach`), imports use explicit `.ts` extensions.

**Spec:** `docs/superpowers/specs/2026-09-17-zoom-redirect-provisioning-design.md`

## Global Constraints

- Every non-`/admin` request is logged in full before responding, whatever the response. (spec §1)
- `{mac}.cfg` is served only when: MAC in `expected_devices` AND in `zoom_devices` AND its
  model's profile `enabled = 1` with a non-null `zoom_url` AND `settings.serving_enabled = '1'`.
  Anything else → `404` empty. `PUT`/`POST` → `200` empty. (spec §1)
- Every logged row records `response_status`, `response_kind` (`redirect` | `not_found` | `accepted`),
  `response_reason`. (spec §1)
- Vendor for the file format comes from the profile's `vendor`, never the User-Agent. (spec §1)
- Zoom S2S app is read-only: only `POST /oauth/token` and `GET /phone/devices`. Token used
  once per sync, never stored. (spec §4)
- A failed sync leaves the previous `zoom_devices` mirror intact. (spec §4)
- All `/admin*` routes: one Basic Auth check, `Cache-Control: no-store`. (spec §5)
- Console is the only page with JavaScript; it polls every 2 s. (spec §5)
- Free Workers plan only. No new Cloudflare products. (spec Cost)

---

## File Structure

```
migrations/
  0003_phase2.sql             # profiles, zoom_devices, settings, response columns
src/
  db.ts                       # + settings get/set, response columns in RequestLogEntry, fleet columns
  profiles.ts                 # provisioning_profiles queries + vendor guessing
  zoom.ts                     # S2S token, device list fetch, mirror replace/count, syncZoomDevices
  serve.ts                    # classifyRequest, loadServeContext, decideResponse
  config/yealink.ts           # renderYealinkRedirect
  config/poly.ts              # renderPolyMaster, renderPolyDeviceConfig
  console.ts                  # listRecentRequests, renderConsolePage, requestsJson
  pages/layout.ts             # escapeHtml, renderPage (nav + CSS)
  pages/dashboard.ts          # renderDashboard (moved from src/dashboard.ts)
  pages/zoom.ts               # renderZoomPage
  pages/profiles.ts           # renderProfilesPage
  pages/settings.ts           # renderSettingsPage
  index.ts                    # router: admin routes table + provisioning handler + scheduled()
test/
  db.spec.ts, index.spec.ts, dashboard.spec.ts   # updated
  profiles.spec.ts, zoom.spec.ts, serve.spec.ts, config.spec.ts, console.spec.ts, pages.spec.ts
```

Phase 1 put every query in `db.ts`. Phase 2 keeps request-log, settings, Zoom-config and
fleet queries there, and puts each new feature's queries next to its logic (`profiles.ts`,
`zoom.ts`, `console.ts`) so a task's files fit in one screen.

---

### Task 1: Schema, settings, response columns

**Files:**
- Create: `migrations/0003_phase2.sql`
- Modify: `src/db.ts`
- Modify: `src/index.ts`
- Modify: `test/db.spec.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `ResponseKind`, extended `RequestLogEntry` (`responseStatus: number`,
  `responseKind: ResponseKind`, `responseReason: string | null`), `SETTING` key constants,
  `getSetting(db, key): Promise<string | null>`, `setSetting(db, key, value): Promise<void>`,
  `isServingEnabled(db): Promise<boolean>` in `src/db.ts`. Tables `provisioning_profiles`,
  `zoom_devices`, `settings`.

- [x] **Step 1: Create the migration**

```sql
-- migrations/0003_phase2.sql
CREATE TABLE provisioning_profiles (
  model TEXT PRIMARY KEY,
  vendor TEXT NOT NULL,
  zoom_url TEXT,
  enabled INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE zoom_devices (
  mac_address TEXT PRIMARY KEY,
  zoom_device_id TEXT NOT NULL,
  display_name TEXT,
  device_type TEXT,
  assignee TEXT,
  status TEXT,
  raw_json TEXT NOT NULL,
  synced_at TEXT NOT NULL
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

ALTER TABLE provisioning_requests ADD COLUMN response_status INTEGER;
ALTER TABLE provisioning_requests ADD COLUMN response_kind TEXT;
ALTER TABLE provisioning_requests ADD COLUMN response_reason TEXT;
```

- [x] **Step 2: Write the failing tests**

In `test/db.spec.ts`, every object literal passed to `insertRequestLog` (the one in
`persists a full request log row`, the `checkIn` helper, and the `ignores check-ins that
carried no MAC` test) gets three more properties:

```ts
      responseStatus: 200,
      responseKind: 'accepted',
      responseReason: null,
```

Then append:

```ts
// append to test/db.spec.ts
import { SETTING, getSetting, isServingEnabled, setSetting } from '../src/db.ts';

describe('insertRequestLog response columns', () => {
  it('persists status, kind, and reason', async () => {
    await insertRequestLog(env.DB, {
      receivedAt: '2026-09-17T00:00:00.000Z',
      sourceIp: null,
      manufacturer: null,
      model: null,
      firmware: null,
      macAddress: 'AA:BB:CC:DD:EE:FF',
      httpMethod: 'GET',
      path: '/aabbccddeeff.cfg',
      queryString: '',
      userAgent: null,
      headersJson: '{}',
      responseStatus: 404,
      responseKind: 'not_found',
      responseReason: 'not-in-zoom',
    });
    const row = await env.DB.prepare('SELECT response_status, response_kind, response_reason FROM provisioning_requests').first();
    expect(row).toEqual({ response_status: 404, response_kind: 'not_found', response_reason: 'not-in-zoom' });
  });
});

describe('settings', () => {
  it('returns null for an unset key', async () => {
    expect(await getSetting(env.DB, SETTING.servingEnabled)).toBeNull();
  });

  it('sets, reads, and overwrites a key', async () => {
    await setSetting(env.DB, SETTING.lastZoomSyncResult, 'ok: 3 devices');
    await setSetting(env.DB, SETTING.lastZoomSyncResult, 'error: boom');
    expect(await getSetting(env.DB, SETTING.lastZoomSyncResult)).toBe('error: boom');
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM settings').first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it('isServingEnabled is false unless the value is exactly "1"', async () => {
    expect(await isServingEnabled(env.DB)).toBe(false);
    await setSetting(env.DB, SETTING.servingEnabled, '0');
    expect(await isServingEnabled(env.DB)).toBe(false);
    await setSetting(env.DB, SETTING.servingEnabled, '1');
    expect(await isServingEnabled(env.DB)).toBe(true);
  });
});
```

- [x] **Step 3: Run tests to verify they fail**

Run: `npm test -- db.spec.ts`
Expected: FAIL — `getSetting` is not a function; `response_status` column errors.

- [x] **Step 4: Update `src/db.ts`**

Replace the `RequestLogEntry` interface and `insertRequestLog` at the top of the file:

```ts
export type ResponseKind = 'redirect' | 'not_found' | 'accepted';

export interface RequestLogEntry {
  receivedAt: string;
  sourceIp: string | null;
  manufacturer: string | null;
  model: string | null;
  firmware: string | null;
  macAddress: string | null;
  httpMethod: string;
  path: string;
  queryString: string;
  userAgent: string | null;
  headersJson: string;
  responseStatus: number;
  responseKind: ResponseKind;
  responseReason: string | null;
}

export async function insertRequestLog(db: D1Database, entry: RequestLogEntry): Promise<void> {
  await db
    .prepare(
      `INSERT INTO provisioning_requests
        (received_at, source_ip, manufacturer, model, firmware, mac_address,
         http_method, path, query_string, user_agent, headers_json,
         response_status, response_kind, response_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      entry.receivedAt,
      entry.sourceIp,
      entry.manufacturer,
      entry.model,
      entry.firmware,
      entry.macAddress,
      entry.httpMethod,
      entry.path,
      entry.queryString,
      entry.userAgent,
      entry.headersJson,
      entry.responseStatus,
      entry.responseKind,
      entry.responseReason,
    )
    .run();
}
```

Append:

```ts
// append to src/db.ts
export const SETTING = {
  servingEnabled: 'serving_enabled',
  lastZoomSyncAt: 'last_zoom_sync_at',
  lastZoomSyncResult: 'last_zoom_sync_result',
} as const;

export type SettingKey = (typeof SETTING)[keyof typeof SETTING];

export async function getSetting(db: D1Database, key: SettingKey): Promise<string | null> {
  const row = await db.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

export async function setSetting(db: D1Database, key: SettingKey, value: string): Promise<void> {
  await db
    .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .bind(key, value)
    .run();
}

/** The kill switch. Missing or anything but '1' means off. */
export async function isServingEnabled(db: D1Database): Promise<boolean> {
  return (await getSetting(db, SETTING.servingEnabled)) === '1';
}
```

- [x] **Step 5: Update `src/index.ts` to log the new fields**

In `captureProvisioningRequest`, add to the `insertRequestLog` object (Phase 1's inert
behavior is kept until Task 6 replaces this function):

```ts
      responseStatus: 200,
      responseKind: 'accepted',
      responseReason: 'phase1-inert',
```

- [x] **Step 6: Run the full suite and typecheck**

Run: `npm test && npx tsc`
Expected: PASS (tsc catches any `insertRequestLog` call still missing the new fields).

- [x] **Step 7: Commit**

```bash
git add migrations/0003_phase2.sql src/db.ts src/index.ts test/db.spec.ts
git commit -m "feat: phase 2 schema, settings store, and response columns on request log"
```

---

### Task 2: Admin restructure — layout, per-page renderers, Zoom + Settings pages

**Files:**
- Create: `src/pages/layout.ts`, `src/pages/dashboard.ts`, `src/pages/zoom.ts`, `src/pages/settings.ts`
- Create: `src/zoom.ts` (only `countZoomDevices` for now; Task 4 adds the client)
- Delete: `src/dashboard.ts`
- Modify: `src/index.ts`
- Modify: `test/dashboard.spec.ts`, `test/index.spec.ts`
- Create: `test/pages.spec.ts`

**Interfaces:**
- Consumes: `getSetting`, `setSetting`, `isServingEnabled`, `SETTING` (Task 1); `FleetRow`,
  `listFleet`, `getZoomConfig`, `saveZoomConfig`, `ZoomConfigRecord` (Phase 1).
- Produces: `escapeHtml(value: string): string`, `NavKey`, `renderPage(title: string,
  active: NavKey, body: string, extraHead?: string): string` in `src/pages/layout.ts`;
  `renderDashboard(rows: FleetRow[], filter: FleetFilter): string`, `parseFleetFilter`,
  `FleetFilter` in `src/pages/dashboard.ts`; `ZoomPageView`, `renderZoomPage(view):
  string` in `src/pages/zoom.ts`; `renderSettingsPage(servingEnabled: boolean): string` in
  `src/pages/settings.ts`; `countZoomDevices(db): Promise<number>` in `src/zoom.ts`;
  `htmlResponse(body: string, status?: number): Response` and the `ADMIN_ROUTES` pattern
  in `src/index.ts` that later tasks add routes to.

- [x] **Step 1: Write the failing tests**

Replace `test/dashboard.spec.ts` imports and the settings-form test:

```ts
// test/dashboard.spec.ts — change the import line to:
import { renderDashboard } from '../src/pages/dashboard.ts';
// every renderDashboard(rows, filter, null) call drops the third argument -> renderDashboard(rows, filter)
// delete the test 'renders a settings form for Zoom S2S credentials and never echoes the secret'
// add:
  it('links every admin page in the nav', () => {
    const html = renderDashboard([], 'all');
    for (const href of ['/admin', '/admin/console', '/admin/zoom', '/admin/profiles', '/admin/settings']) {
      expect(html).toContain(`href="${href}"`);
    }
  });
```

```ts
// test/pages.spec.ts
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
```

In `test/index.spec.ts`, replace the whole `describe('/admin/settings', …)` block with:

```ts
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
  });
});
```

and add `isServingEnabled` to the existing `import { getZoomConfig } from '../src/db.ts';` line.

- [x] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `src/pages/*` don't exist; `/admin/zoom` falls through to the provisioning handler.

- [x] **Step 3: Create `src/pages/layout.ts`**

```ts
// src/pages/layout.ts
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export type NavKey = 'fleet' | 'console' | 'zoom' | 'profiles' | 'settings';

const NAV: { key: NavKey; href: string; label: string }[] = [
  { key: 'fleet', href: '/admin', label: 'Fleet' },
  { key: 'console', href: '/admin/console', label: 'Console' },
  { key: 'zoom', href: '/admin/zoom', label: 'Zoom' },
  { key: 'profiles', href: '/admin/profiles', label: 'Profiles' },
  { key: 'settings', href: '/admin/settings', label: 'Settings' },
];

const CSS = `
  body { font: 14px/1.4 system-ui, sans-serif; margin: 0; color: #1a1a1a; }
  nav { display: flex; gap: 1rem; padding: .75rem 1.5rem; background: #f5f5f5; border-bottom: 1px solid #ddd; }
  nav a { text-decoration: none; color: #333; }
  nav a.active { font-weight: 700; border-bottom: 2px solid #333; }
  main { padding: 1.5rem; }
  h1, h2 { font-weight: 600; }
  .summary { display: flex; gap: 1.5rem; margin: 1rem 0; flex-wrap: wrap; }
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
  .status-seen .badge, .kind-redirect .badge, .on { background: #d8f3dc; }
  .status-not-seen .badge, .kind-accepted .badge { background: #fff3cd; }
  .status-unexpected .badge, .kind-not_found .badge, .off { background: #f8d7da; }
  form label { display: block; margin: .5rem 0; }
  form input[type=text], form input[type=password], form input[type=url] { width: 28rem; max-width: 100%; }
  button { cursor: pointer; }
  pre { background: #f5f5f5; padding: .5rem; overflow: auto; white-space: pre-wrap; }
`;

export function renderPage(title: string, active: NavKey, body: string, extraHead = ''): string {
  const nav = NAV.map((n) => `<a href="${n.href}"${n.key === active ? ' class="active"' : ''}>${n.label}</a>`).join('\n    ');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${CSS}</style>
${extraHead}
</head>
<body>
  <nav>
    ${nav}
  </nav>
  <main>
${body}
  </main>
</body>
</html>`;
}
```

- [x] **Step 4: Create `src/pages/dashboard.ts` and delete `src/dashboard.ts`**

```ts
// src/pages/dashboard.ts
import type { FleetRow, FleetStatus } from '../db.ts';
import { escapeHtml, renderPage } from './layout.ts';

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

export function renderDashboard(rows: FleetRow[], filter: FleetFilter): string {
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
  <p class="muted">${visible.length} of ${rows.length} rows shown.</p>`;

  return renderPage('Provisioning Inventory', 'fleet', body);
}
```

Then `git rm src/dashboard.ts`.

- [x] **Step 5: Create `src/pages/zoom.ts`, `src/pages/settings.ts`, `src/zoom.ts`**

```ts
// src/pages/zoom.ts
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
```

```ts
// src/pages/settings.ts
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
```

```ts
// src/zoom.ts
export async function countZoomDevices(db: D1Database): Promise<number> {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM zoom_devices').first<{ n: number }>();
  return row?.n ?? 0;
}
```

- [x] **Step 6: Rewrite `src/index.ts` around an admin routes table**

```ts
// src/index.ts
import type { Env } from './types.ts';
import { parseDevice } from './parse.ts';
import { SETTING, getSetting, getZoomConfig, insertRequestLog, isServingEnabled, listFleet, saveZoomConfig, setSetting } from './db.ts';
import { checkBasicAuth, unauthorizedResponse } from './auth.ts';
import { parseFleetFilter, renderDashboard } from './pages/dashboard.ts';
import { renderZoomPage } from './pages/zoom.ts';
import { renderSettingsPage } from './pages/settings.ts';
import { countZoomDevices } from './zoom.ts';
import { encryptSecret } from './crypto.ts';

type Handler = (request: Request, env: Env, url: URL) => Promise<Response>;

export function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function redirect(url: URL, path: string): Response {
  return Response.redirect(`${url.origin}${path}`, 303);
}

function sourceIpOf(request: Request): string | null {
  const cfIp = request.headers.get('CF-Connecting-IP');
  if (cfIp) {
    return cfIp;
  }
  const forwarded = request.headers.get('X-Forwarded-For');
  return forwarded ? (forwarded.split(',')[0]?.trim() ?? null) : null;
}

async function captureProvisioningRequest(request: Request, env: Env, url: URL): Promise<Response> {
  const userAgent = request.headers.get('User-Agent');
  const parsed = parseDevice(url.pathname, url.search, userAgent);

  try {
    await insertRequestLog(env.DB, {
      receivedAt: new Date().toISOString(),
      sourceIp: sourceIpOf(request),
      manufacturer: parsed.manufacturer,
      model: parsed.model,
      firmware: parsed.firmware,
      macAddress: parsed.macAddress,
      httpMethod: request.method,
      path: url.pathname,
      queryString: url.search,
      userAgent,
      headersJson: JSON.stringify(Object.fromEntries(request.headers)),
      responseStatus: 200,
      responseKind: 'accepted',
      responseReason: 'phase1-inert',
    });
  } catch (error) {
    // Never let a logging failure change what the phone sees.
    console.error('failed to log provisioning request', error);
  }

  return new Response('', { status: 200, headers: { 'Content-Type': 'text/plain' } });
}

const dashboard: Handler = async (_request, env, url) => {
  const fleet = await listFleet(env.DB);
  return htmlResponse(renderDashboard(fleet, parseFleetFilter(url.searchParams.get('status'))));
};

const zoomPage: Handler = async (_request, env) => {
  const [config, lastSyncAt, lastSyncResult, deviceCount] = await Promise.all([
    getZoomConfig(env.DB),
    getSetting(env.DB, SETTING.lastZoomSyncAt),
    getSetting(env.DB, SETTING.lastZoomSyncResult),
    countZoomDevices(env.DB),
  ]);
  return htmlResponse(renderZoomPage({ config, lastSyncAt, lastSyncResult, deviceCount }));
};

const saveZoomCredentials: Handler = async (request, env, url) => {
  const form = await request.formData();
  const clientId = String(form.get('clientId') ?? '').trim();
  const clientSecret = String(form.get('clientSecret') ?? '');
  const accountId = String(form.get('accountId') ?? '').trim();
  if (!clientId || !clientSecret || !accountId) {
    return new Response('clientId, clientSecret, and accountId are all required', { status: 400 });
  }
  await saveZoomConfig(env.DB, {
    clientId,
    clientSecretEncrypted: await encryptSecret(clientSecret, env.ENCRYPTION_KEY),
    accountId,
    updatedAt: new Date().toISOString(),
  });
  return redirect(url, '/admin/zoom');
};

const settingsPage: Handler = async (_request, env) => htmlResponse(renderSettingsPage(await isServingEnabled(env.DB)));

const saveSettings: Handler = async (request, env, url) => {
  const form = await request.formData();
  await setSetting(env.DB, SETTING.servingEnabled, form.get('servingEnabled') === 'on' ? '1' : '0');
  return redirect(url, '/admin/settings');
};

/** `"METHOD /path"` -> handler. Every entry is behind Basic Auth. Later tasks add rows here. */
const ADMIN_ROUTES: Record<string, Handler> = {
  'GET /admin': dashboard,
  'GET /admin/zoom': zoomPage,
  'POST /admin/zoom': saveZoomCredentials,
  'GET /admin/settings': settingsPage,
  'POST /admin/settings': saveSettings,
};

function isAdminPath(pathname: string): boolean {
  return pathname === '/admin' || pathname.startsWith('/admin/');
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (isAdminPath(url.pathname)) {
      if (!checkBasicAuth(request, env.ADMIN_USER, env.ADMIN_PASSWORD)) {
        return unauthorizedResponse();
      }
      const handler = ADMIN_ROUTES[`${request.method} ${url.pathname}`];
      return handler ? handler(request, env, url) : new Response('Not Found', { status: 404 });
    }

    return captureProvisioningRequest(request, env, url);
  },
};
```

- [x] **Step 7: Run the full suite and typecheck**

Run: `npm test && npx tsc`
Expected: PASS.

- [x] **Step 8: Commit**

```bash
git add -A src test
git commit -m "feat: split admin into per-page renderers with nav, Zoom page, and kill switch"
```

---

### Task 3: Provisioning profiles (model → vendor → Zoom URL)

**Files:**
- Create: `src/profiles.ts`, `src/pages/profiles.ts`
- Modify: `src/index.ts` (three routes)
- Test: `test/profiles.spec.ts`, `test/index.spec.ts`

**Interfaces:**
- Consumes: `renderPage`, `escapeHtml` (Task 2); `buildSeedSql` (Phase 1, for test seeding).
- Produces: `Vendor`, `ProfileRow`, `guessVendor(model: string): Vendor`,
  `refreshProfiles(db, now: string): Promise<number>`, `listProfiles(db): Promise<ProfileRow[]>`,
  `saveProfile(db, input: ProfileInput, now: string): Promise<void>`, `isValidZoomUrl(value: string): boolean`
  in `src/profiles.ts`. Task 6 reads `provisioning_profiles` by `model`.

- [x] **Step 1: Write the failing tests**

```ts
// test/profiles.spec.ts
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { buildSeedSql } from '../src/fleet.ts';
import { guessVendor, isValidZoomUrl, listProfiles, refreshProfiles, saveProfile } from '../src/profiles.ts';

async function seedFleet() {
  await env.DB.exec(
    buildSeedSql(
      [
        { macAddress: '80:5E:C0:00:00:01', rcDeviceId: '1', name: 'A', extension: null, model: 'Yealink T48S', rcStatus: null },
        { macAddress: '80:5E:C0:00:00:02', rcDeviceId: '2', name: 'B', extension: null, model: 'Yealink T48S', rcStatus: null },
        { macAddress: '64:16:7F:00:00:03', rcDeviceId: '3', name: 'C', extension: null, model: 'Polycom VVX411', rcStatus: null },
        { macAddress: '9C:AD:EF:00:00:04', rcDeviceId: '4', name: 'D', extension: null, model: 'Polycom OBi302', rcStatus: null },
        { macAddress: '9C:AD:EF:00:00:05', rcDeviceId: '5', name: 'E', extension: null, model: null, rcStatus: null },
      ],
      '2026-09-17T00:00:00.000Z',
    ),
  );
}

describe('guessVendor', () => {
  it('maps model strings to vendors', () => {
    expect(guessVendor('Yealink T48S')).toBe('yealink');
    expect(guessVendor('Yealink T48U Ultra-elegant Gigabit IP Phone')).toBe('yealink');
    expect(guessVendor('Polycom VVX411')).toBe('poly');
    expect(guessVendor('Polycom IP 5000 Conference Phone')).toBe('poly');
    expect(guessVendor('Polycom OBi302')).toBe('other');
    expect(guessVendor('Cisco SPA-122 ATA')).toBe('other');
  });
});

describe('isValidZoomUrl', () => {
  it('accepts only https URLs', () => {
    expect(isValidZoomUrl('https://provpp.zoom.us/api/v2/pbx/provisioning/yealink/t48s/')).toBe(true);
    expect(isValidZoomUrl('http://provpp.zoom.us/x')).toBe(false);
    expect(isValidZoomUrl('provpp.zoom.us/x')).toBe(false);
    expect(isValidZoomUrl('')).toBe(false);
  });
});

describe('refreshProfiles / listProfiles / saveProfile', () => {
  it('creates one disabled profile per distinct expected model with a device count', async () => {
    await seedFleet();
    expect(await refreshProfiles(env.DB, '2026-09-17T00:00:00.000Z')).toBe(3);
    expect(await refreshProfiles(env.DB, '2026-09-17T00:00:00.000Z')).toBe(0);

    const profiles = await listProfiles(env.DB);
    expect(profiles.map((p) => [p.model, p.vendor, p.deviceCount, p.enabled, p.zoomUrl])).toEqual([
      ['Polycom OBi302', 'other', 1, false, null],
      ['Polycom VVX411', 'poly', 1, false, null],
      ['Yealink T48S', 'yealink', 2, false, null],
    ]);
  });

  it('saves vendor, url, and enabled for an existing model and keeps the count', async () => {
    await seedFleet();
    await refreshProfiles(env.DB, '2026-09-17T00:00:00.000Z');
    await saveProfile(env.DB, { model: 'Yealink T48S', vendor: 'yealink', zoomUrl: 'https://provpp.zoom.us/y/', enabled: true }, '2026-09-17T01:00:00.000Z');

    const t48s = (await listProfiles(env.DB)).find((p) => p.model === 'Yealink T48S');
    expect(t48s).toEqual({ model: 'Yealink T48S', vendor: 'yealink', zoomUrl: 'https://provpp.zoom.us/y/', enabled: true, deviceCount: 2, updatedAt: '2026-09-17T01:00:00.000Z' });
  });

  it('ignores saves for models that have no profile row', async () => {
    await saveProfile(env.DB, { model: 'Nope', vendor: 'other', zoomUrl: null, enabled: false }, '2026-09-17T01:00:00.000Z');
    expect(await listProfiles(env.DB)).toEqual([]);
  });
});
```

```ts
// append to test/index.spec.ts
import { listProfiles } from '../src/profiles.ts';

describe('/admin/profiles', () => {
  const seed = () =>
    env.DB.exec(
      buildSeedSql(
        [{ macAddress: '80:5E:C0:00:00:01', rcDeviceId: '1', name: 'A', extension: null, model: 'Yealink T48S', rcStatus: null }],
        '2026-09-17T00:00:00.000Z',
      ),
    );
  const post = (path: string, body: string) =>
    SELF.fetch(`https://example.com${path}`, {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      redirect: 'manual',
    });

  it('refreshes models from the expected fleet and renders them', async () => {
    await seed();
    expect((await post('/admin/profiles/refresh', '')).status).toBe(303);
    const html = await (await SELF.fetch('https://example.com/admin/profiles', { headers: AUTH })).text();
    expect(html).toContain('Yealink T48S');
    expect(html).toContain('name="zoom_url:Yealink T48S"');
  });

  it('saves every row of the form', async () => {
    await seed();
    await post('/admin/profiles/refresh', '');
    const body = new URLSearchParams({
      'vendor:Yealink T48S': 'yealink',
      'zoom_url:Yealink T48S': 'https://provpp.zoom.us/y/',
      'enabled:Yealink T48S': 'on',
    }).toString();
    expect((await post('/admin/profiles', body)).status).toBe(303);
    expect((await listProfiles(env.DB))[0]).toMatchObject({ vendor: 'yealink', zoomUrl: 'https://provpp.zoom.us/y/', enabled: true });
  });

  it('rejects a non-https Zoom URL with 400 and saves nothing', async () => {
    await seed();
    await post('/admin/profiles/refresh', '');
    const response = await post('/admin/profiles', new URLSearchParams({ 'vendor:Yealink T48S': 'yealink', 'zoom_url:Yealink T48S': 'http://x' }).toString());
    expect(response.status).toBe(400);
    expect((await listProfiles(env.DB))[0]?.zoomUrl).toBeNull();
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `npm test -- profiles.spec.ts index.spec.ts`
Expected: FAIL — `src/profiles.ts` missing; `/admin/profiles` is 404.

- [x] **Step 3: Create `src/profiles.ts`**

```ts
// src/profiles.ts
export type Vendor = 'yealink' | 'poly' | 'other';

export interface ProfileRow {
  model: string;
  vendor: Vendor;
  zoomUrl: string | null;
  enabled: boolean;
  deviceCount: number;
  updatedAt: string;
}

export interface ProfileInput {
  model: string;
  vendor: Vendor;
  zoomUrl: string | null;
  enabled: boolean;
}

const VENDORS: Vendor[] = ['yealink', 'poly', 'other'];

export function parseVendor(value: string | null): Vendor {
  return VENDORS.includes(value as Vendor) ? (value as Vendor) : 'other';
}

/** Vendor from the RingCentral model string. OBi ATAs are Poly-branded but not VVX/UCS firmware. */
export function guessVendor(model: string): Vendor {
  if (/^yealink/i.test(model)) return 'yealink';
  if (/^polycom\s+(vvx|ip\s*\d)/i.test(model)) return 'poly';
  return 'other';
}

export function isValidZoomUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

/** Inserts a disabled profile for every expected model that has none yet. Returns how many were added. */
export async function refreshProfiles(db: D1Database, now: string): Promise<number> {
  const missing = await db
    .prepare(
      `SELECT DISTINCT e.model AS model FROM expected_devices e
       LEFT JOIN provisioning_profiles p ON p.model = e.model
       WHERE e.model IS NOT NULL AND p.model IS NULL`,
    )
    .all<{ model: string }>();
  if (missing.results.length === 0) return 0;
  await db.batch(
    missing.results.map((m) =>
      db
        .prepare('INSERT INTO provisioning_profiles (model, vendor, zoom_url, enabled, updated_at) VALUES (?, ?, NULL, 0, ?)')
        .bind(m.model, guessVendor(m.model), now),
    ),
  );
  return missing.results.length;
}

export async function listProfiles(db: D1Database): Promise<ProfileRow[]> {
  const result = await db
    .prepare(
      `SELECT p.model AS model, p.vendor AS vendor, p.zoom_url AS zoomUrl, p.enabled AS enabled,
              p.updated_at AS updatedAt,
              (SELECT COUNT(*) FROM expected_devices e WHERE e.model = p.model) AS deviceCount
       FROM provisioning_profiles p
       ORDER BY p.model`,
    )
    .all<Omit<ProfileRow, 'enabled'> & { enabled: number }>();
  return result.results.map((r) => ({ ...r, enabled: r.enabled === 1 }));
}

export async function saveProfile(db: D1Database, input: ProfileInput, now: string): Promise<void> {
  await db
    .prepare('UPDATE provisioning_profiles SET vendor = ?, zoom_url = ?, enabled = ?, updated_at = ? WHERE model = ?')
    .bind(input.vendor, input.zoomUrl, input.enabled ? 1 : 0, now, input.model)
    .run();
}
```

- [x] **Step 4: Create `src/pages/profiles.ts` and wire the routes**

```ts
// src/pages/profiles.ts
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
```

In `src/index.ts` add imports and three handlers, then three rows in `ADMIN_ROUTES`:

```ts
import { isValidZoomUrl, listProfiles, parseVendor, refreshProfiles, saveProfile } from './profiles.ts';
import { renderProfilesPage } from './pages/profiles.ts';

const profilesPage: Handler = async (_request, env) => htmlResponse(renderProfilesPage(await listProfiles(env.DB)));

const refreshProfilesRoute: Handler = async (_request, env, url) => {
  await refreshProfiles(env.DB, new Date().toISOString());
  return redirect(url, '/admin/profiles');
};

const saveProfiles: Handler = async (request, env, url) => {
  const form = await request.formData();
  const now = new Date().toISOString();
  const inputs = (await listProfiles(env.DB)).map((p) => ({
    model: p.model,
    vendor: parseVendor(form.get(`vendor:${p.model}`) as string | null),
    zoomUrl: String(form.get(`zoom_url:${p.model}`) ?? '').trim() || null,
    enabled: form.get(`enabled:${p.model}`) === 'on',
  }));
  const bad = inputs.find((i) => i.zoomUrl !== null && !isValidZoomUrl(i.zoomUrl));
  if (bad) {
    return new Response(`Zoom URL for "${bad.model}" must start with https://`, { status: 400 });
  }
  for (const input of inputs) {
    await saveProfile(env.DB, input, now);
  }
  return redirect(url, '/admin/profiles');
};

// in ADMIN_ROUTES:
  'GET /admin/profiles': profilesPage,
  'POST /admin/profiles': saveProfiles,
  'POST /admin/profiles/refresh': refreshProfilesRoute,
```

- [x] **Step 5: Run the full suite and typecheck**

Run: `npm test && npx tsc`
Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add src/profiles.ts src/pages/profiles.ts src/index.ts test/profiles.spec.ts test/index.spec.ts
git commit -m "feat: provisioning profiles page mapping expected models to Zoom URLs"
```

---

### Task 4: Zoom client — S2S token, device list mirror, sync route, hourly cron

**Files:**
- Modify: `src/zoom.ts`, `src/pages/zoom.ts`, `src/index.ts`, `wrangler.toml`
- Test: `test/zoom.spec.ts`, `test/index.spec.ts`

**Interfaces:**
- Consumes: `getZoomConfig`, `SETTING`, `setSetting` (db); `decryptSecret` (crypto);
  `normalizeMac` (parse).
- Produces: `ZoomDeviceRow`, `fetchS2SToken(fetchImpl, creds): Promise<string>`,
  `fetchZoomDevices(fetchImpl, token): Promise<unknown[]>`, `toZoomDeviceRows(raw, syncedAt):
  ZoomDeviceRow[]`, `replaceZoomDevices(db, rows): Promise<void>`, `syncZoomDevices(env,
  fetchImpl?): Promise<SyncResult>` in `src/zoom.ts`; `POST /admin/zoom/sync`; `scheduled()`
  export. Task 6 reads `zoom_devices` by `mac_address`.

- [x] **Step 1: Write the failing tests**

```ts
// test/zoom.spec.ts
import { env } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { encryptSecret } from '../src/crypto.ts';
import { SETTING, getSetting, saveZoomConfig } from '../src/db.ts';
import { countZoomDevices, fetchS2SToken, fetchZoomDevices, replaceZoomDevices, syncZoomDevices, toZoomDeviceRows } from '../src/zoom.ts';

type FetchImpl = typeof fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** A fetch stub that answers the token call, then device pages keyed by `type` and `next_page_token`. */
function zoomStub(pages: Record<string, { devices: unknown[]; next_page_token?: string }>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.startsWith('https://zoom.us/oauth/token')) {
      return jsonResponse({ access_token: 'tok-123', token_type: 'bearer', expires_in: 3600 });
    }
    const u = new URL(url);
    const key = `${u.searchParams.get('type')}:${u.searchParams.get('next_page_token') ?? ''}`;
    const page = pages[key];
    return page ? jsonResponse({ ...page, next_page_token: page.next_page_token ?? '' }) : jsonResponse({ code: 404 }, 404);
  }) as unknown as FetchImpl;
  return { impl, calls };
}

const creds = { clientId: 'cid', clientSecret: 'shh', accountId: 'acc' };

describe('fetchS2SToken', () => {
  it('posts account_credentials with Basic auth and returns the token', async () => {
    const { impl, calls } = zoomStub({});
    expect(await fetchS2SToken(impl, creds)).toBe('tok-123');
    expect(calls[0]?.url).toBe('https://zoom.us/oauth/token');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(new Headers(calls[0]?.init?.headers).get('Authorization')).toBe(`Basic ${btoa('cid:shh')}`);
    expect(String(calls[0]?.init?.body)).toBe('grant_type=account_credentials&account_id=acc');
  });

  it('throws with the status on a non-200 without leaking the secret', async () => {
    const impl = vi.fn(async () => jsonResponse({ reason: 'Invalid client' }, 401)) as unknown as FetchImpl;
    await expect(fetchS2SToken(impl, creds)).rejects.toThrow(/401/);
    await expect(fetchS2SToken(impl, creds)).rejects.not.toThrow(/shh/);
  });
});

describe('fetchZoomDevices', () => {
  it('walks both device types and every page with a bearer token', async () => {
    const { impl, calls } = zoomStub({
      'assigned:': { devices: [{ id: 'a1' }], next_page_token: 'p2' },
      'assigned:p2': { devices: [{ id: 'a2' }] },
      'unassigned:': { devices: [{ id: 'u1' }] },
    });
    const devices = await fetchZoomDevices(impl, 'tok-123');
    expect(devices.map((d) => (d as { id: string }).id)).toEqual(['a1', 'a2', 'u1']);
    expect(calls.every((c) => new Headers(c.init?.headers).get('Authorization') === 'Bearer tok-123')).toBe(true);
    expect(calls.map((c) => new URL(c.url).searchParams.get('page_size'))).toEqual(['100', '100', '100']);
  });
});

describe('toZoomDeviceRows', () => {
  it('normalizes MACs, flattens the assignee, keeps raw JSON, skips devices without a MAC', () => {
    const rows = toZoomDeviceRows(
      [
        { id: 'a1', mac_address: '64-16-7F-4B-6B-E7', display_name: 'Lobby', device_type: 'Polycom VVX411', status: 'online', assignee: { name: 'Jess', extension_number: 5326 } },
        { id: 'a2', mac_address: '805ec0aabbcc', display_name: 'Desk', device_type: 'Yealink T48S', status: 'offline', assignees: [{ name: 'Sam' }] },
        { id: 'a3', display_name: 'No MAC' },
        { id: 'a4', mac_address: 'not-a-mac' },
      ],
      '2026-09-17T00:00:00.000Z',
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      macAddress: '64:16:7F:4B:6B:E7',
      zoomDeviceId: 'a1',
      displayName: 'Lobby',
      deviceType: 'Polycom VVX411',
      assignee: 'Jess (5326)',
      status: 'online',
      rawJson: JSON.stringify({ id: 'a1', mac_address: '64-16-7F-4B-6B-E7', display_name: 'Lobby', device_type: 'Polycom VVX411', status: 'online', assignee: { name: 'Jess', extension_number: 5326 } }),
      syncedAt: '2026-09-17T00:00:00.000Z',
    });
    expect(rows[1]?.assignee).toBe('Sam');
  });
});

describe('replaceZoomDevices / syncZoomDevices', () => {
  it('replaces the mirror wholesale', async () => {
    const row = { macAddress: '80:5E:C0:00:00:01', zoomDeviceId: 'a1', displayName: null, deviceType: null, assignee: null, status: null, rawJson: '{}', syncedAt: 't' };
    await replaceZoomDevices(env.DB, [row, { ...row, macAddress: '80:5E:C0:00:00:02', zoomDeviceId: 'a2' }]);
    await replaceZoomDevices(env.DB, [{ ...row, macAddress: '80:5E:C0:00:00:03', zoomDeviceId: 'a3' }]);
    expect(await countZoomDevices(env.DB)).toBe(1);
    const only = await env.DB.prepare('SELECT mac_address FROM zoom_devices').first<{ mac_address: string }>();
    expect(only?.mac_address).toBe('80:5E:C0:00:00:03');
  });

  it('syncs end to end and records the result', async () => {
    await saveZoomConfig(env.DB, { clientId: 'cid', clientSecretEncrypted: await encryptSecret('shh', env.ENCRYPTION_KEY), accountId: 'acc', updatedAt: 't' });
    const { impl } = zoomStub({
      'assigned:': { devices: [{ id: 'a1', mac_address: '805ec0000001' }] },
      'unassigned:': { devices: [{ id: 'u1', mac_address: '805ec0000002' }, { id: 'u2' }] },
    });
    const result = await syncZoomDevices(env, impl);
    expect(result).toEqual({ ok: true, message: 'ok: 2 devices mirrored (1 without a MAC skipped)' });
    expect(await countZoomDevices(env.DB)).toBe(2);
    expect(await getSetting(env.DB, SETTING.lastZoomSyncResult)).toBe(result.message);
    expect(await getSetting(env.DB, SETTING.lastZoomSyncAt)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('reports missing credentials without touching the mirror', async () => {
    await replaceZoomDevices(env.DB, [{ macAddress: '80:5E:C0:00:00:09', zoomDeviceId: 'x', displayName: null, deviceType: null, assignee: null, status: null, rawJson: '{}', syncedAt: 't' }]);
    const result = await syncZoomDevices(env, vi.fn() as unknown as FetchImpl);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/not configured/);
    expect(await countZoomDevices(env.DB)).toBe(1);
  });

  it('keeps the previous mirror when Zoom errors mid-way', async () => {
    await saveZoomConfig(env.DB, { clientId: 'cid', clientSecretEncrypted: await encryptSecret('shh', env.ENCRYPTION_KEY), accountId: 'acc', updatedAt: 't' });
    await replaceZoomDevices(env.DB, [{ macAddress: '80:5E:C0:00:00:09', zoomDeviceId: 'x', displayName: null, deviceType: null, assignee: null, status: null, rawJson: '{}', syncedAt: 't' }]);
    const { impl } = zoomStub({ 'assigned:': { devices: [{ id: 'a1', mac_address: '805ec0000001' }] } }); // unassigned page -> 404
    const result = await syncZoomDevices(env, impl);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/^error: /);
    expect(await countZoomDevices(env.DB)).toBe(1);
    expect(await getSetting(env.DB, SETTING.lastZoomSyncResult)).toBe(result.message);
  });
});
```

```ts
// append to test/index.spec.ts
describe('/admin/zoom/sync', () => {
  it('runs a sync and redirects back with the result recorded', async () => {
    const response = await SELF.fetch('https://example.com/admin/zoom/sync', { method: 'POST', headers: AUTH, redirect: 'manual' });
    expect(response.status).toBe(303);
    expect(response.headers.get('Location')).toBe('https://example.com/admin/zoom');
    const html = await (await SELF.fetch('https://example.com/admin/zoom', { headers: AUTH })).text();
    expect(html).toContain('not configured');
    expect(html).toContain('action="/admin/zoom/sync"');
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `npm test -- zoom.spec.ts index.spec.ts`
Expected: FAIL — functions missing; `/admin/zoom/sync` is 404.

- [x] **Step 3: Write `src/zoom.ts`**

```ts
// src/zoom.ts
import type { Env } from './types.ts';
import { SETTING, getZoomConfig, setSetting } from './db.ts';
import { decryptSecret } from './crypto.ts';
import { normalizeMac } from './parse.ts';

type FetchImpl = typeof fetch;

export interface ZoomDeviceRow {
  macAddress: string;
  zoomDeviceId: string;
  displayName: string | null;
  deviceType: string | null;
  assignee: string | null;
  status: string | null;
  rawJson: string;
  syncedAt: string;
}

export interface SyncResult {
  ok: boolean;
  message: string;
}

const TOKEN_URL = 'https://zoom.us/oauth/token';
const DEVICES_URL = 'https://api.zoom.us/v2/phone/devices';
const PAGE_SIZE = 100;

export async function countZoomDevices(db: D1Database): Promise<number> {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM zoom_devices').first<{ n: number }>();
  return row?.n ?? 0;
}

export async function fetchS2SToken(
  fetchImpl: FetchImpl,
  creds: { clientId: string; clientSecret: string; accountId: string },
): Promise<string> {
  const response = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${btoa(`${creds.clientId}:${creds.clientSecret}`)}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ grant_type: 'account_credentials', account_id: creds.accountId }).toString(),
  });
  if (!response.ok) {
    throw new Error(`Zoom token request failed: HTTP ${response.status}`);
  }
  const body = (await response.json()) as { access_token?: string };
  if (!body.access_token) {
    throw new Error('Zoom token response had no access_token');
  }
  return body.access_token;
}

async function fetchDevicePage(fetchImpl: FetchImpl, token: string, type: string, pageToken: string): Promise<{ devices: unknown[]; next: string }> {
  const url = new URL(DEVICES_URL);
  url.searchParams.set('type', type);
  url.searchParams.set('page_size', String(PAGE_SIZE));
  if (pageToken) url.searchParams.set('next_page_token', pageToken);
  const response = await fetchImpl(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) {
    throw new Error(`Zoom device list (${type}) failed: HTTP ${response.status}`);
  }
  const body = (await response.json()) as { devices?: unknown[]; next_page_token?: string };
  return { devices: body.devices ?? [], next: body.next_page_token ?? '' };
}

/** Every device Zoom knows about, assigned and unassigned, all pages. Raw objects as Zoom returns them. */
export async function fetchZoomDevices(fetchImpl: FetchImpl, token: string): Promise<unknown[]> {
  const all: unknown[] = [];
  for (const type of ['assigned', 'unassigned']) {
    let pageToken = '';
    do {
      const page = await fetchDevicePage(fetchImpl, token, type, pageToken);
      all.push(...page.devices);
      pageToken = page.next;
    } while (pageToken);
  }
  return all;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : typeof value === 'number' ? String(value) : null;
}

function assigneeOf(device: Record<string, unknown>): string | null {
  const candidate = device.assignee ?? (Array.isArray(device.assignees) ? device.assignees[0] : undefined);
  if (!candidate || typeof candidate !== 'object') return null;
  const a = candidate as Record<string, unknown>;
  const name = str(a.name) ?? str(a.display_name);
  const ext = str(a.extension_number);
  if (name && ext) return `${name} (${ext})`;
  return name ?? ext ?? null;
}

export function toZoomDeviceRows(raw: unknown[], syncedAt: string): ZoomDeviceRow[] {
  const rows: ZoomDeviceRow[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const device = item as Record<string, unknown>;
    const macAddress = normalizeMac(str(device.mac_address) ?? '');
    const zoomDeviceId = str(device.id);
    if (!macAddress || !zoomDeviceId) continue;
    rows.push({
      macAddress,
      zoomDeviceId,
      displayName: str(device.display_name),
      deviceType: str(device.device_type),
      assignee: assigneeOf(device),
      status: str(device.status),
      rawJson: JSON.stringify(device),
      syncedAt,
    });
  }
  return rows;
}

export async function replaceZoomDevices(db: D1Database, rows: ZoomDeviceRow[]): Promise<void> {
  const insert = db.prepare(
    `INSERT INTO zoom_devices (mac_address, zoom_device_id, display_name, device_type, assignee, status, raw_json, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  await db.batch([
    db.prepare('DELETE FROM zoom_devices'),
    ...rows.map((r) => insert.bind(r.macAddress, r.zoomDeviceId, r.displayName, r.deviceType, r.assignee, r.status, r.rawJson, r.syncedAt)),
  ]);
}

/** Read-only: token exchange + device list, then replace the mirror. Never throws; result is recorded in settings. */
export async function syncZoomDevices(env: Env, fetchImpl: FetchImpl = fetch): Promise<SyncResult> {
  const now = new Date().toISOString();
  let result: SyncResult;
  try {
    const config = await getZoomConfig(env.DB);
    if (!config) {
      throw new Error('Zoom credentials not configured');
    }
    const clientSecret = await decryptSecret(config.clientSecretEncrypted, env.ENCRYPTION_KEY);
    const token = await fetchS2SToken(fetchImpl, { clientId: config.clientId, clientSecret, accountId: config.accountId });
    const raw = await fetchZoomDevices(fetchImpl, token);
    const rows = toZoomDeviceRows(raw, now);
    await replaceZoomDevices(env.DB, rows);
    const skipped = raw.length - rows.length;
    result = { ok: true, message: `ok: ${rows.length} devices mirrored${skipped ? ` (${skipped} without a MAC skipped)` : ''}` };
  } catch (error) {
    result = { ok: false, message: `error: ${error instanceof Error ? error.message : String(error)}` };
  }
  await setSetting(env.DB, SETTING.lastZoomSyncAt, now);
  await setSetting(env.DB, SETTING.lastZoomSyncResult, result.message);
  return result;
}
```

- [x] **Step 4: Add the Sync now form, the route, the cron**

In `src/pages/zoom.ts`, directly after the `<p>… devices mirrored …</p>` line:

```ts
  <form method="POST" action="/admin/zoom/sync"><button type="submit">Sync now</button></form>
```

In `src/index.ts`:

```ts
import { countZoomDevices, syncZoomDevices } from './zoom.ts';   // replaces the existing countZoomDevices import

const syncZoom: Handler = async (_request, env, url) => {
  await syncZoomDevices(env);
  return redirect(url, '/admin/zoom');
};

// in ADMIN_ROUTES:
  'POST /admin/zoom/sync': syncZoom,

// add to the default export, next to fetch():
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(syncZoomDevices(env));
  },
```

In `wrangler.toml`, after the `routes` block:

```toml
[triggers]
crons = ["0 * * * *"]
```

- [x] **Step 5: Run the full suite and typecheck**

Run: `npm test && npx tsc`
Expected: PASS. (The index test's sync hits real `fetch` only if credentials exist; the test DB has none, so it records `error: Zoom credentials not configured`.)

- [x] **Step 6: Commit**

```bash
git add src/zoom.ts src/pages/zoom.ts src/index.ts wrangler.toml test/zoom.spec.ts test/index.spec.ts
git commit -m "feat: read-only Zoom device mirror with manual sync and hourly cron"
```

---

### Task 5: Vendor config generators

**Files:**
- Create: `src/config/yealink.ts`, `src/config/poly.ts`
- Test: `test/config.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `renderYealinkRedirect(zoomUrl: string): string`; `renderPolyMaster(macLower:
  string): string`, `renderPolyDeviceConfig(zoomUrl: string): string`, `polyServerName(zoomUrl:
  string): string`. Content types are decided by Task 6.

- [x] **Step 1: Write the failing tests**

```ts
// test/config.spec.ts
import { describe, expect, it } from 'vitest';
import { renderYealinkRedirect } from '../src/config/yealink.ts';
import { polyServerName, renderPolyDeviceConfig, renderPolyMaster } from '../src/config/poly.ts';

describe('renderYealinkRedirect', () => {
  it('produces the exact redirect file', () => {
    expect(renderYealinkRedirect('https://provpp.zoom.us/api/v2/pbx/provisioning/yealink/t48s/')).toBe(
      `#!version:1.0.0.1
static.auto_provision.server.url = https://provpp.zoom.us/api/v2/pbx/provisioning/yealink/t48s/
static.auto_provision.dhcp_option.enable = 0
static.auto_provision.pnp_enable = 0
`,
    );
  });

  it('refuses a URL with a newline (config injection)', () => {
    expect(() => renderYealinkRedirect('https://x/\nstatic.security.user_password = pwn')).toThrow();
  });
});

describe('poly', () => {
  it('strips the scheme for device.prov.serverName', () => {
    expect(polyServerName('https://provpp.zoom.us/api/v2/pbx/provisioning/poly/vvx411/')).toBe('provpp.zoom.us/api/v2/pbx/provisioning/poly/vvx411/');
  });

  it('produces the master config referencing the per-MAC zoom file', () => {
    expect(renderPolyMaster('64167f4b6be7')).toBe(
      `<?xml version="1.0" standalone="yes"?>
<APPLICATION APP_FILE_PATH="sip.ld" CONFIG_FILES="64167f4b6be7-zoom.cfg" MISC_FILES="" LOG_FILE_DIRECTORY="" OVERRIDES_DIRECTORY="" CONTACTS_DIRECTORY="" LICENSE_DIRECTORY="" USER_PROFILES_DIRECTORY="" CALL_LISTS_DIRECTORY="" COREFILE_DIRECTORY=""/>
`,
    );
  });

  it('produces the device config with XML-escaped server name', () => {
    expect(renderPolyDeviceConfig('https://provpp.zoom.us/p/?a=1&b=2')).toBe(
      `<?xml version="1.0" encoding="utf-8" standalone="yes"?>
<polycomConfig>
  <device device.set="1" device.prov.serverType.set="1" device.prov.serverType="HTTPS" device.prov.serverName.set="1" device.prov.serverName="provpp.zoom.us/p/?a=1&amp;b=2" device.dhcp.bootSrvUseOpt.set="1" device.dhcp.bootSrvUseOpt="Static"/>
</polycomConfig>
`,
    );
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `npm test -- config.spec.ts`
Expected: FAIL — modules missing.

- [x] **Step 3: Write the generators**

```ts
// src/config/yealink.ts
/**
 * Minimal Yealink auto-provision file: point the phone at Zoom and stop it from asking
 * DHCP/PnP again on the next boot (which would bring it straight back here).
 */
export function renderYealinkRedirect(zoomUrl: string): string {
  if (/[\r\n]/.test(zoomUrl)) {
    throw new Error('zoomUrl must be a single line');
  }
  return `#!version:1.0.0.1
static.auto_provision.server.url = ${zoomUrl}
static.auto_provision.dhcp_option.enable = 0
static.auto_provision.pnp_enable = 0
`;
}
```

```ts
// src/config/poly.ts
function escapeXmlAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}

/** Poly wants host + path without the scheme; serverType carries HTTPS separately. */
export function polyServerName(zoomUrl: string): string {
  return zoomUrl.replace(/^https?:\/\//i, '');
}

/** Master config (`{mac}.cfg`): only the per-MAC zoom file, nothing else. `macLower` is 12 hex chars. */
export function renderPolyMaster(macLower: string): string {
  return `<?xml version="1.0" standalone="yes"?>
<APPLICATION APP_FILE_PATH="sip.ld" CONFIG_FILES="${macLower}-zoom.cfg" MISC_FILES="" LOG_FILE_DIRECTORY="" OVERRIDES_DIRECTORY="" CONTACTS_DIRECTORY="" LICENSE_DIRECTORY="" USER_PROFILES_DIRECTORY="" CALL_LISTS_DIRECTORY="" COREFILE_DIRECTORY=""/>
`;
}

/** `{mac}-zoom.cfg`: set the provisioning server to Zoom and stop using the DHCP boot server option. */
export function renderPolyDeviceConfig(zoomUrl: string): string {
  const serverName = escapeXmlAttr(polyServerName(zoomUrl));
  return `<?xml version="1.0" encoding="utf-8" standalone="yes"?>
<polycomConfig>
  <device device.set="1" device.prov.serverType.set="1" device.prov.serverType="HTTPS" device.prov.serverName.set="1" device.prov.serverName="${serverName}" device.dhcp.bootSrvUseOpt.set="1" device.dhcp.bootSrvUseOpt="Static"/>
</polycomConfig>
`;
}
```

- [x] **Step 4: Run tests to verify they pass**

Run: `npm test -- config.spec.ts && npx tsc`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/config test/config.spec.ts
git commit -m "feat: Yealink and Poly redirect config generators"
```

---

### Task 6: Serving decision and the real provisioning endpoint

**Files:**
- Create: `src/serve.ts`
- Modify: `src/index.ts` (replace `captureProvisioningRequest`)
- Test: `test/serve.spec.ts`, `test/index.spec.ts`

**Interfaces:**
- Consumes: generators (Task 5); `isServingEnabled`, `ResponseKind` (Task 1); `Vendor`
  (Task 3); `normalizeMac` (Phase 1).
- Produces: `RequestFile`, `classifyRequest(pathname: string): RequestFile`, `ServeContext`,
  `loadServeContext(db, mac: string): Promise<ServeContext>`, `Decision`,
  `decideResponse(method: string, file: RequestFile, context: ServeContext | null): Decision`
  in `src/serve.ts`.

- [x] **Step 1: Write the failing unit tests**

```ts
// test/serve.spec.ts
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { SETTING, setSetting } from '../src/db.ts';
import { buildSeedSql } from '../src/fleet.ts';
import { refreshProfiles, saveProfile } from '../src/profiles.ts';
import { replaceZoomDevices } from '../src/zoom.ts';
import { classifyRequest, decideResponse, loadServeContext, type ServeContext } from '../src/serve.ts';

describe('classifyRequest', () => {
  it('recognizes the per-MAC files and nothing else', () => {
    expect(classifyRequest('/805ec0aabbcc.cfg')).toEqual({ type: 'mac_cfg', mac: '80:5E:C0:AA:BB:CC', macLower: '805ec0aabbcc' });
    expect(classifyRequest('/805EC0AABBCC.cfg')).toEqual({ type: 'mac_cfg', mac: '80:5E:C0:AA:BB:CC', macLower: '805ec0aabbcc' });
    expect(classifyRequest('/805ec0aabbcc-zoom.cfg')).toEqual({ type: 'poly_device_cfg', mac: '80:5E:C0:AA:BB:CC', macLower: '805ec0aabbcc' });
    for (const p of ['/y000000000065.cfg', '/000000000000.cfg', '/805ec0aabbcc-phone.cfg', '/805ec0aabbcc.boot', '/', '/dir/805ec0aabbcc.cfg']) {
      expect(classifyRequest(p)).toEqual({ type: 'other', mac: null, macLower: null });
    }
  });
});

const ready: ServeContext = {
  servingEnabled: true,
  expectedModel: 'Yealink T48S',
  inZoom: true,
  profile: { vendor: 'yealink', zoomUrl: 'https://provpp.zoom.us/y/', enabled: true },
};
const macCfg = classifyRequest('/805ec0aabbcc.cfg');
const polyCfg = classifyRequest('/64167f4b6be7-zoom.cfg');

describe('decideResponse', () => {
  it('accepts PUT/POST uploads with 200 regardless of anything else', () => {
    expect(decideResponse('PUT', classifyRequest('/64167f4b6be7-phone.cfg'), null)).toMatchObject({ status: 200, kind: 'accepted', reason: 'upload', body: '' });
    expect(decideResponse('POST', macCfg, null)).toMatchObject({ status: 200, kind: 'accepted' });
  });

  it('404s unknown files and unsupported methods', () => {
    expect(decideResponse('GET', classifyRequest('/y000000000065.cfg'), null)).toMatchObject({ status: 404, kind: 'not_found', reason: 'unknown-file' });
    expect(decideResponse('DELETE', macCfg, ready)).toMatchObject({ status: 404, kind: 'not_found', reason: 'unsupported-method' });
  });

  it('serves the Yealink redirect when everything lines up', () => {
    const d = decideResponse('GET', macCfg, ready);
    expect(d).toMatchObject({ status: 200, kind: 'redirect', reason: null, contentType: 'text/plain' });
    expect(d.body).toContain('static.auto_provision.server.url = https://provpp.zoom.us/y/');
  });

  it('serves both Poly files', () => {
    const poly: ServeContext = { ...ready, expectedModel: 'Polycom VVX411', profile: { vendor: 'poly', zoomUrl: 'https://provpp.zoom.us/p/', enabled: true } };
    const master = decideResponse('GET', classifyRequest('/64167f4b6be7.cfg'), poly);
    expect(master).toMatchObject({ status: 200, kind: 'redirect', contentType: 'application/xml' });
    expect(master.body).toContain('CONFIG_FILES="64167f4b6be7-zoom.cfg"');
    const device = decideResponse('GET', polyCfg, poly);
    expect(device.body).toContain('device.prov.serverName="provpp.zoom.us/p/"');
  });

  it('gives each gate its own reason, in order', () => {
    const cases: [Partial<ServeContext> | null, string][] = [
      [{ servingEnabled: false }, 'serving-off'],
      [{ expectedModel: null }, 'not-expected'],
      [{ inZoom: false }, 'not-in-zoom'],
      [{ profile: null }, 'no-profile'],
      [{ profile: { ...ready.profile!, enabled: false } }, 'profile-disabled'],
      [{ profile: { ...ready.profile!, zoomUrl: null } }, 'no-zoom-url'],
      [{ profile: { ...ready.profile!, vendor: 'other' } }, 'vendor-other'],
    ];
    for (const [override, reason] of cases) {
      const d = decideResponse('GET', macCfg, { ...ready, ...override });
      expect(d, reason).toMatchObject({ status: 404, kind: 'not_found', reason, body: '' });
    }
    expect(decideResponse('GET', macCfg, { servingEnabled: true, expectedModel: null, inZoom: false, profile: null })).toMatchObject({ status: 404, reason: 'not-expected' });
  });

  it('does not serve the Poly device file to a Yealink profile', () => {
    expect(decideResponse('GET', polyCfg, ready)).toMatchObject({ status: 404, reason: 'unknown-file' });
  });

  it('answers HEAD like GET but with an empty body', () => {
    expect(decideResponse('HEAD', macCfg, ready)).toMatchObject({ status: 200, kind: 'redirect', body: '' });
  });
});

describe('loadServeContext', () => {
  it('joins the expected device, the Zoom mirror, the profile, and the switch', async () => {
    await env.DB.exec(buildSeedSql([{ macAddress: '80:5E:C0:AA:BB:CC', rcDeviceId: '1', name: 'A', extension: null, model: 'Yealink T48S', rcStatus: null }], 't'));
    await refreshProfiles(env.DB, 't');
    await saveProfile(env.DB, { model: 'Yealink T48S', vendor: 'yealink', zoomUrl: 'https://provpp.zoom.us/y/', enabled: true }, 't');
    await replaceZoomDevices(env.DB, [{ macAddress: '80:5E:C0:AA:BB:CC', zoomDeviceId: 'z', displayName: null, deviceType: null, assignee: null, status: null, rawJson: '{}', syncedAt: 't' }]);
    await setSetting(env.DB, SETTING.servingEnabled, '1');

    expect(await loadServeContext(env.DB, '80:5E:C0:AA:BB:CC')).toEqual(ready);
    expect(await loadServeContext(env.DB, '80:5E:C0:00:00:00')).toEqual({ servingEnabled: true, expectedModel: null, inZoom: false, profile: null });
  });
});
```

```ts
// append to test/index.spec.ts
import { refreshProfiles, saveProfile } from '../src/profiles.ts';
import { replaceZoomDevices } from '../src/zoom.ts';
import { SETTING, setSetting } from '../src/db.ts';

describe('provisioning endpoint (phase 2)', () => {
  async function makeReady() {
    await env.DB.exec(buildSeedSql([{ macAddress: '80:5E:C0:AA:BB:CC', rcDeviceId: '1', name: 'A', extension: null, model: 'Yealink T48S', rcStatus: null }], 't'));
    await refreshProfiles(env.DB, 't');
    await saveProfile(env.DB, { model: 'Yealink T48S', vendor: 'yealink', zoomUrl: 'https://provpp.zoom.us/y/', enabled: true }, 't');
    await replaceZoomDevices(env.DB, [{ macAddress: '80:5E:C0:AA:BB:CC', zoomDeviceId: 'z', displayName: null, deviceType: null, assignee: null, status: null, rawJson: '{}', syncedAt: 't' }]);
    await setSetting(env.DB, SETTING.servingEnabled, '1');
  }
  const lastLog = () =>
    env.DB.prepare('SELECT path, response_status, response_kind, response_reason FROM provisioning_requests ORDER BY id DESC LIMIT 1').first();

  it('serves the redirect and logs it', async () => {
    await makeReady();
    const response = await SELF.fetch('https://example.com/805ec0aabbcc.cfg', { headers: { 'User-Agent': 'Yealink SIP-T48S 66.86.0.15' } });
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/plain');
    expect(await response.text()).toContain('https://provpp.zoom.us/y/');
    expect(await lastLog()).toEqual({ path: '/805ec0aabbcc.cfg', response_status: 200, response_kind: 'redirect', response_reason: null });
  });

  it('404s with the reason when the kill switch is off', async () => {
    await makeReady();
    await setSetting(env.DB, SETTING.servingEnabled, '0');
    const response = await SELF.fetch('https://example.com/805ec0aabbcc.cfg');
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('');
    expect(await lastLog()).toMatchObject({ response_kind: 'not_found', response_reason: 'serving-off' });
  });

  it('404s common files and still logs them', async () => {
    const response = await SELF.fetch('https://example.com/y000000000065.cfg', { headers: { 'User-Agent': 'Yealink SIP-T48S 66.86.0.15 80:5e:c0:aa:bb:cc' } });
    expect(response.status).toBe(404);
    const row = await env.DB.prepare('SELECT mac_address, response_reason FROM provisioning_requests').first();
    expect(row).toEqual({ mac_address: '80:5E:C0:AA:BB:CC', response_reason: 'unknown-file' });
  });

  it('accepts Poly uploads with 200', async () => {
    const response = await SELF.fetch('https://example.com/64167f4b6be7-phone.cfg', { method: 'PUT', body: '<x/>' });
    expect(response.status).toBe(200);
    expect(await lastLog()).toMatchObject({ response_kind: 'accepted', response_reason: 'upload' });
  });
});
```

Also delete the Phase 1 test `logs unparseable requests with null device fields and still returns 200`'s
`expect(response.status).toBe(200)` line and change it to `expect(response.status).toBe(200)` only if
the request is a POST — it is (`method: 'POST'`), so it stays 200 via `accepted`. No change needed;
just re-run it.

- [x] **Step 2: Run tests to verify they fail**

Run: `npm test -- serve.spec.ts index.spec.ts`
Expected: FAIL — `src/serve.ts` missing; endpoint still returns 200 for everything.

- [x] **Step 3: Write `src/serve.ts`**

```ts
// src/serve.ts
import type { ResponseKind } from './db.ts';
import { isServingEnabled } from './db.ts';
import type { Vendor } from './profiles.ts';
import { normalizeMac } from './parse.ts';
import { renderYealinkRedirect } from './config/yealink.ts';
import { renderPolyDeviceConfig, renderPolyMaster } from './config/poly.ts';

export interface RequestFile {
  type: 'mac_cfg' | 'poly_device_cfg' | 'other';
  mac: string | null;
  macLower: string | null;
}

const MAC_CFG_RE = /^\/([0-9a-f]{12})(-zoom)?\.cfg$/i;

/** Only two paths are ever served: `/{mac}.cfg` and `/{mac}-zoom.cfg`, at the root. */
export function classifyRequest(pathname: string): RequestFile {
  const match = pathname.match(MAC_CFG_RE);
  const mac = match ? normalizeMac(match[1]!) : null;
  if (!match || !mac) {
    return { type: 'other', mac: null, macLower: null };
  }
  return { type: match[2] ? 'poly_device_cfg' : 'mac_cfg', mac, macLower: match[1]!.toLowerCase() };
}

export interface ServeContext {
  servingEnabled: boolean;
  expectedModel: string | null;
  inZoom: boolean;
  profile: { vendor: Vendor; zoomUrl: string | null; enabled: boolean } | null;
}

export async function loadServeContext(db: D1Database, mac: string): Promise<ServeContext> {
  const [servingEnabled, row] = await Promise.all([
    isServingEnabled(db),
    db
      .prepare(
        `SELECT e.model AS expectedModel,
                z.mac_address IS NOT NULL AS inZoom,
                p.vendor AS vendor, p.zoom_url AS zoomUrl, p.enabled AS profileEnabled
         FROM expected_devices e
         LEFT JOIN zoom_devices z ON z.mac_address = e.mac_address
         LEFT JOIN provisioning_profiles p ON p.model = e.model
         WHERE e.mac_address = ?`,
      )
      .bind(mac)
      .first<{ expectedModel: string | null; inZoom: number; vendor: Vendor | null; zoomUrl: string | null; profileEnabled: number | null }>(),
  ]);
  if (!row) {
    return { servingEnabled, expectedModel: null, inZoom: false, profile: null };
  }
  return {
    servingEnabled,
    expectedModel: row.expectedModel,
    inZoom: row.inZoom === 1,
    profile: row.vendor === null ? null : { vendor: row.vendor, zoomUrl: row.zoomUrl, enabled: row.profileEnabled === 1 },
  };
}

export interface Decision {
  status: number;
  kind: ResponseKind;
  reason: string | null;
  body: string;
  contentType: string;
}

function notFound(reason: string): Decision {
  return { status: 404, kind: 'not_found', reason, body: '', contentType: 'text/plain' };
}

/** Pure: every row of the spec §1 table, in gate order. `context` is null when the path has no MAC. */
export function decideResponse(method: string, file: RequestFile, context: ServeContext | null): Decision {
  if (method === 'PUT' || method === 'POST') {
    return { status: 200, kind: 'accepted', reason: 'upload', body: '', contentType: 'text/plain' };
  }
  if (method !== 'GET' && method !== 'HEAD') {
    return notFound('unsupported-method');
  }
  if (file.type === 'other' || !file.macLower) {
    return notFound('unknown-file');
  }
  if (!context?.servingEnabled) return notFound('serving-off');
  if (!context.expectedModel) return notFound('not-expected');
  if (!context.inZoom) return notFound('not-in-zoom');
  if (!context.profile) return notFound('no-profile');
  if (!context.profile.enabled) return notFound('profile-disabled');
  if (!context.profile.zoomUrl) return notFound('no-zoom-url');

  let body: string;
  let contentType: string;
  if (context.profile.vendor === 'yealink' && file.type === 'mac_cfg') {
    body = renderYealinkRedirect(context.profile.zoomUrl);
    contentType = 'text/plain';
  } else if (context.profile.vendor === 'poly') {
    body = file.type === 'mac_cfg' ? renderPolyMaster(file.macLower) : renderPolyDeviceConfig(context.profile.zoomUrl);
    contentType = 'application/xml';
  } else if (context.profile.vendor === 'other') {
    return notFound('vendor-other');
  } else {
    return notFound('unknown-file');
  }
  return { status: 200, kind: 'redirect', reason: null, body: method === 'HEAD' ? '' : body, contentType };
}
```

- [x] **Step 4: Replace `captureProvisioningRequest` in `src/index.ts`**

```ts
import { classifyRequest, decideResponse, loadServeContext } from './serve.ts';

async function handleProvisioning(request: Request, env: Env, url: URL): Promise<Response> {
  const userAgent = request.headers.get('User-Agent');
  const parsed = parseDevice(url.pathname, url.search, userAgent);
  const file = classifyRequest(url.pathname);
  const context = file.mac ? await loadServeContext(env.DB, file.mac) : null;
  const decision = decideResponse(request.method, file, context);

  try {
    await insertRequestLog(env.DB, {
      receivedAt: new Date().toISOString(),
      sourceIp: sourceIpOf(request),
      manufacturer: parsed.manufacturer,
      model: parsed.model,
      firmware: parsed.firmware,
      macAddress: parsed.macAddress,
      httpMethod: request.method,
      path: url.pathname,
      queryString: url.search,
      userAgent,
      headersJson: JSON.stringify(Object.fromEntries(request.headers)),
      responseStatus: decision.status,
      responseKind: decision.kind,
      responseReason: decision.reason,
    });
  } catch (error) {
    // Never let a logging failure change what the phone sees.
    console.error('failed to log provisioning request', error);
  }

  return new Response(decision.body, {
    status: decision.status,
    headers: { 'Content-Type': decision.contentType, 'Cache-Control': 'no-store' },
  });
}
```

and in `fetch()` replace `return captureProvisioningRequest(request, env, url);` with
`return handleProvisioning(request, env, url);`. Delete `captureProvisioningRequest`.

Phase 1's smoke test `responds 200 with an empty body for any path` now expects `404`:
change its two assertions to `expect(response.status).toBe(404)` and keep the empty-body
check; rename it `responds 404 with an empty body for an unknown MAC file`.

- [x] **Step 5: Run the full suite and typecheck**

Run: `npm test && npx tsc`
Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add src/serve.ts src/index.ts test/serve.spec.ts test/index.spec.ts
git commit -m "feat: serve Zoom redirect configs per MAC behind fleet, Zoom, profile, and kill-switch gates"
```

---

### Task 7: Debug console

**Files:**
- Create: `src/console.ts`
- Modify: `src/index.ts` (two routes)
- Test: `test/console.spec.ts`, `test/index.spec.ts`

**Interfaces:**
- Consumes: `insertRequestLog` (test seeding), `renderPage`/`escapeHtml` (Task 2), `htmlResponse`.
- Produces: `ConsoleRow`, `listRecentRequests(db, opts: { after?: number; limit?: number }):
  Promise<ConsoleRow[]>`, `renderConsolePage(rows: ConsoleRow[]): string` in `src/console.ts`;
  `GET /admin/console`, `GET /admin/api/requests`.

- [x] **Step 1: Write the failing tests**

```ts
// test/console.spec.ts
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { insertRequestLog } from '../src/db.ts';
import { listRecentRequests, renderConsolePage } from '../src/console.ts';

async function log(path: string, receivedAt: string) {
  await insertRequestLog(env.DB, {
    receivedAt,
    sourceIp: '203.0.113.5',
    manufacturer: 'Yealink',
    model: 'SIP-T48S',
    firmware: '66.86.0.15',
    macAddress: '80:5E:C0:AA:BB:CC',
    httpMethod: 'GET',
    path,
    queryString: '',
    userAgent: 'Yealink SIP-T48S 66.86.0.15',
    headersJson: '{"user-agent":"Yealink SIP-T48S 66.86.0.15"}',
    responseStatus: 404,
    responseKind: 'not_found',
    responseReason: 'not-in-zoom',
  });
}

describe('listRecentRequests', () => {
  it('returns newest first with a limit, and only rows after a cursor', async () => {
    await log('/a.cfg', '2026-09-17T00:00:01.000Z');
    await log('/b.cfg', '2026-09-17T00:00:02.000Z');
    await log('/c.cfg', '2026-09-17T00:00:03.000Z');

    const all = await listRecentRequests(env.DB, {});
    expect(all.map((r) => r.path)).toEqual(['/c.cfg', '/b.cfg', '/a.cfg']);
    expect(all[0]).toMatchObject({ macAddress: '80:5E:C0:AA:BB:CC', responseStatus: 404, responseKind: 'not_found', responseReason: 'not-in-zoom' });
    expect(typeof all[0]?.id).toBe('number');

    expect((await listRecentRequests(env.DB, { limit: 2 })).map((r) => r.path)).toEqual(['/c.cfg', '/b.cfg']);
    expect((await listRecentRequests(env.DB, { after: all[2]!.id })).map((r) => r.path)).toEqual(['/c.cfg', '/b.cfg']);
    expect(await listRecentRequests(env.DB, { after: all[0]!.id })).toEqual([]);
  });
});

describe('renderConsolePage', () => {
  it('embeds the initial rows as JSON, escaping </script>, and includes the poller', () => {
    const html = renderConsolePage([
      {
        id: 7,
        receivedAt: 't',
        sourceIp: null,
        macAddress: null,
        manufacturer: null,
        model: null,
        firmware: null,
        httpMethod: 'GET',
        path: '/</script><script>alert(1)</script>',
        queryString: '',
        userAgent: null,
        headersJson: '{}',
        responseStatus: 404,
        responseKind: 'not_found',
        responseReason: 'unknown-file',
      },
    ]);
    expect(html).not.toContain('</script><script>alert(1)');
    expect(html).toContain('\\u003c/script>');
    expect(html).toContain("fetch('/admin/api/requests?after=' + lastId)");
    expect(html).toContain('2000');
    expect(html).toContain('id="pause"');
    expect(html).toContain('id="filter"');
  });
});
```

```ts
// append to test/index.spec.ts
describe('/admin/console', () => {
  it('renders the page and serves the JSON feed with an after cursor', async () => {
    await SELF.fetch('https://example.com/first.cfg');
    await SELF.fetch('https://example.com/second.cfg');

    const page = await SELF.fetch('https://example.com/admin/console', { headers: AUTH });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('/second.cfg');

    const feed = await SELF.fetch('https://example.com/admin/api/requests', { headers: AUTH });
    expect(feed.headers.get('Content-Type')).toContain('application/json');
    const { rows } = (await feed.json()) as { rows: { id: number; path: string }[] };
    expect(rows.map((r) => r.path)).toEqual(['/second.cfg', '/first.cfg']);

    const newer = await SELF.fetch(`https://example.com/admin/api/requests?after=${rows[1]!.id}`, { headers: AUTH });
    expect(((await newer.json()) as { rows: unknown[] }).rows).toHaveLength(1);
  });

  it('requires auth on the feed', async () => {
    expect((await SELF.fetch('https://example.com/admin/api/requests')).status).toBe(401);
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `npm test -- console.spec.ts index.spec.ts`
Expected: FAIL — `src/console.ts` missing; routes 404.

- [x] **Step 3: Write `src/console.ts`**

```ts
// src/console.ts
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
```

- [x] **Step 4: Wire the routes in `src/index.ts`**

```ts
import { listRecentRequests, renderConsolePage } from './console.ts';

const consolePage: Handler = async (_request, env) => htmlResponse(renderConsolePage(await listRecentRequests(env.DB, {})));

const requestsFeed: Handler = async (_request, env, url) => {
  const after = Number(url.searchParams.get('after') ?? 0);
  const rows = await listRecentRequests(env.DB, { after: Number.isFinite(after) ? after : 0 });
  return new Response(JSON.stringify({ rows }), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
};

// in ADMIN_ROUTES:
  'GET /admin/console': consolePage,
  'GET /admin/api/requests': requestsFeed,
```

- [x] **Step 5: Run the full suite and typecheck**

Run: `npm test && npx tsc`
Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add src/console.ts src/index.ts test/console.spec.ts test/index.spec.ts
git commit -m "feat: debug console with 2s polling request feed"
```

---

### Task 8: Fleet dashboard — In Zoom, Redirected, and header state

**Files:**
- Modify: `src/db.ts` (`listFleet`), `src/pages/dashboard.ts`, `src/index.ts`
- Modify: `test/db.spec.ts`, `test/dashboard.spec.ts`

**Interfaces:**
- Consumes: `zoom_devices` (Task 4), response columns (Task 1), settings.
- Produces: `FleetRow` gains `inZoom: boolean` and `lastRedirectAt: string | null`;
  `DashboardHeader { servingEnabled: boolean; lastZoomSyncAt: string | null; zoomDeviceCount: number }`;
  `renderDashboard(rows, filter, header)`.

- [x] **Step 1: Write the failing tests**

In `test/db.spec.ts` `listFleet` test, add before `const fleet = await listFleet(env.DB);`:

```ts
    await replaceZoomDevices(env.DB, [{ macAddress: '80:5E:C0:00:00:01', zoomDeviceId: 'z1', displayName: null, deviceType: null, assignee: null, status: null, rawJson: '{}', syncedAt: 't' }]);
    await insertRequestLog(env.DB, {
      receivedAt: '2026-09-17T03:00:00.000Z',
      sourceIp: null, manufacturer: null, model: null, firmware: null,
      macAddress: '80:5E:C0:00:00:01',
      httpMethod: 'GET', path: '/805ec0000001.cfg', queryString: '', userAgent: null, headersJson: '{}',
      responseStatus: 200, responseKind: 'redirect', responseReason: null,
    });
```

(import `replaceZoomDevices` from `'../src/zoom.ts'`), and extend the expectations: the seen
row's `toEqual<FleetRow>` object gains `inZoom: true, lastRedirectAt: '2026-09-17T03:00:00.000Z'`
and `checkInCount: 3`, `lastSeenAt: '2026-09-17T03:00:00.000Z'`, `firmware: null`,
`manufacturer: null`, `model: null`, `sourceIp: null` (the redirect row is now the latest);
the not-seen `toMatchObject` gains `inZoom: false, lastRedirectAt: null`; the unexpected one
gains `inZoom: false, lastRedirectAt: null`.

In `test/dashboard.spec.ts`, add `inZoom: true, lastRedirectAt: '2026-09-17T02:00:00.000Z'` to
`seen`, `inZoom: false, lastRedirectAt: null` to `notSeen` and `unexpected`; give every
`renderDashboard(rows, filter)` call a third argument `HEADER` where

```ts
const HEADER = { servingEnabled: true, lastZoomSyncAt: '2026-09-17T01:30:00.000Z', zoomDeviceCount: 5 };
```

and add:

```ts
  it('shows In Zoom and Redirected per row and the serving state in the header', () => {
    const html = renderDashboard(rows, 'all', HEADER);
    expect(html).toContain('<th>In Zoom</th>');
    expect(html).toContain('2026-09-17T02:00:00.000Z');
    expect(html).toContain('Serving <span class="badge on">ON</span>');
    expect(html).toContain('5 devices');
    expect(renderDashboard([], 'all', { ...HEADER, servingEnabled: false, lastZoomSyncAt: null })).toContain('Serving <span class="badge off">OFF</span>');
  });
```

- [x] **Step 2: Run tests to verify they fail**

Run: `npm test -- db.spec.ts dashboard.spec.ts`
Expected: FAIL — `inZoom` undefined; renderDashboard ignores the header.

- [x] **Step 3: Update `listFleet` in `src/db.ts`**

Add to `FleetRow`:

```ts
  inZoom: boolean;
  lastRedirectAt: string | null;
```

Replace the `listFleet` SQL and mapping:

```ts
export async function listFleet(db: D1Database): Promise<FleetRow[]> {
  const result = await db
    .prepare(
      `WITH latest AS (
         SELECT mac_address, manufacturer, model, firmware, source_ip, received_at, check_in_count
         FROM (
           SELECT *,
                  COUNT(*) OVER (PARTITION BY mac_address) AS check_in_count,
                  ROW_NUMBER() OVER (PARTITION BY mac_address ORDER BY received_at DESC, id DESC) AS rn
           FROM provisioning_requests
           WHERE mac_address IS NOT NULL
         )
         WHERE rn = 1
       ),
       redirected AS (
         SELECT mac_address, MAX(received_at) AS last_redirect_at
         FROM provisioning_requests
         WHERE response_kind = 'redirect'
         GROUP BY mac_address
       )
       SELECT * FROM (
         SELECT e.mac_address AS macAddress,
                CASE WHEN l.mac_address IS NULL THEN 'not-seen' ELSE 'seen' END AS status,
                e.name AS expectedName, e.extension AS expectedExtension, e.model AS expectedModel, e.rc_status AS rcStatus,
                l.manufacturer AS manufacturer, l.model AS model, l.firmware AS firmware, l.source_ip AS sourceIp,
                l.received_at AS lastSeenAt, COALESCE(l.check_in_count, 0) AS checkInCount,
                z.mac_address IS NOT NULL AS inZoom, r.last_redirect_at AS lastRedirectAt
         FROM expected_devices e
         LEFT JOIN latest l ON l.mac_address = e.mac_address
         LEFT JOIN zoom_devices z ON z.mac_address = e.mac_address
         LEFT JOIN redirected r ON r.mac_address = e.mac_address
         UNION ALL
         SELECT l.mac_address, 'unexpected', NULL, NULL, NULL, NULL,
                l.manufacturer, l.model, l.firmware, l.source_ip, l.received_at, l.check_in_count,
                z.mac_address IS NOT NULL, r.last_redirect_at
         FROM latest l
         LEFT JOIN expected_devices e ON e.mac_address = l.mac_address
         LEFT JOIN zoom_devices z ON z.mac_address = l.mac_address
         LEFT JOIN redirected r ON r.mac_address = l.mac_address
         WHERE e.mac_address IS NULL
       )
       ORDER BY lastSeenAt DESC NULLS LAST, expectedName`,
    )
    .all<Omit<FleetRow, 'inZoom'> & { inZoom: number }>();
  return result.results.map((r) => ({ ...r, inZoom: r.inZoom === 1 }));
}
```

- [x] **Step 4: Update `src/pages/dashboard.ts` and the route**

```ts
export interface DashboardHeader {
  servingEnabled: boolean;
  lastZoomSyncAt: string | null;
  zoomDeviceCount: number;
}
```

`renderDashboard(rows: FleetRow[], filter: FleetFilter, header: DashboardHeader)`. In
`renderRow`, after the `expectedModel` cell add:

```ts
  <td>${row.inZoom ? '<span class="badge on">yes</span>' : '<span class="muted">no</span>'}</td>
  ${cell(row.lastRedirectAt)}
```

and in the `<thead>` row, after `<th>Expected model</th>` add `<th>In Zoom</th><th>Redirected</th>`.
After the `<h1>` add:

```ts
  <p>Serving <span class="badge ${header.servingEnabled ? 'on' : 'off'}">${header.servingEnabled ? 'ON' : 'OFF'}</span>
  · Zoom mirror: ${header.zoomDeviceCount} devices, synced ${header.lastZoomSyncAt ? escapeHtml(header.lastZoomSyncAt) : 'never'}</p>
```

In `src/index.ts` `dashboard` handler:

```ts
const dashboard: Handler = async (_request, env, url) => {
  const [fleet, servingEnabled, lastZoomSyncAt, zoomDeviceCount] = await Promise.all([
    listFleet(env.DB),
    isServingEnabled(env.DB),
    getSetting(env.DB, SETTING.lastZoomSyncAt),
    countZoomDevices(env.DB),
  ]);
  return htmlResponse(renderDashboard(fleet, parseFleetFilter(url.searchParams.get('status')), { servingEnabled, lastZoomSyncAt, zoomDeviceCount }));
};
```

- [x] **Step 5: Run the full suite and typecheck**

Run: `npm test && npx tsc`
Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add src/db.ts src/pages/dashboard.ts src/index.ts test/db.spec.ts test/dashboard.spec.ts
git commit -m "feat: fleet view shows Zoom presence, last redirect, and serving state"
```

---

### Task 9: Deploy and lab test (manual)

- [x] **Step 1: Migrate production**

```bash
npx wrangler d1 migrations apply phone_provisioning --remote
```

- [x] **Step 2: Deploy** — `npx wrangler deploy`. Confirm the output lists the cron trigger.

- [x] **Step 3: Verify the kill switch is OFF** — `https://phonehome.cincylab.net/admin/settings`
  shows OFF (fresh `settings` table has no row → off). Do not turn it on yet.

- [ ] **Step 4: Zoom** — on `/admin/zoom` confirm credentials are saved, click **Sync now**,
  confirm `ok: N devices mirrored`. If `error: HTTP 400/401`, the S2S app is not activated or
  the account ID is wrong. If the count is 0 with `ok`, the `mac_address` field name differs:
  run `npx wrangler d1 execute phone_provisioning --remote --command "SELECT raw_json FROM zoom_devices LIMIT 1"`
  — empty means no MAC parsed; adjust `toZoomDeviceRows` from a raw object obtained by
  temporarily logging one in `fetchZoomDevices`.

- [ ] **Step 5: Profiles** — `/admin/profiles` → Refresh models. For the one lab model, paste
  the Zoom provisioning URL from Zoom admin (Phone System → Devices → the device → Assisted
  provisioning), set vendor, tick enabled, Save all.

- [ ] **Step 6: Add the lab phone in Zoom admin**, Sync now, confirm it shows **In Zoom** on `/admin`.

- [ ] **Step 7: Dry run with the switch OFF** — `curl -i https://phonehome.cincylab.net/<mac>.cfg`
  → 404; `/admin/console` shows reason `serving-off`. Turn the switch ON, curl again → 200 with
  the redirect body. Console shows `redirect`.

- [ ] **Step 8: The phone** — set DHCP option 66 (Yealink) / 160 (Poly) on the lab scope to
  `https://phonehome.cincylab.net`, reboot the phone, watch the console. Expected sequence:
  common file → 404 `unknown-file`, `{mac}.cfg` → 200 `redirect`, then silence from this MAC
  and the phone registering in Zoom. Anything else: read the open items in the spec, adjust
  the generator, redeploy, repeat.

- [ ] **Step 9: Turn the switch OFF again** until the production DHCP rollout is scheduled.

---

## Self-Review Notes

- **Spec coverage:** §1 endpoint table → Task 6; §2 generators → Task 5; §3 schema → Task 1
  (+ profiles queries Task 3, mirror Task 4); §4 Zoom client + cron → Task 4; §5 pages →
  Tasks 2, 3, 7, 8; §6 operational flow → Task 9; kill switch → Tasks 1, 2, 6.
- **Placeholders:** none; every step has its code or exact edit.
- **Type consistency:** `ResponseKind` (Task 1) used by Tasks 6, 7; `Vendor` (Task 3) by Tasks
  5–6; `ZoomDeviceRow.rawJson` matches `raw_json`; `FleetRow` gains fields in Task 8 only and
  Task 2's dashboard signature is extended in Task 8 with the test files updated in the same task.
- **Test isolation:** every test seeds its own rows; `beforeEach` wipes all app tables
  including `settings`, `zoom_devices`, `provisioning_profiles` (the GLOB filter in
  `test/apply-migrations.ts` already covers new tables).

## Execution Notes (2026-09-17, subagent-driven)

- Tasks 1–8 done and reviewed; final whole-branch review + one fix wave (commit 087bbd9). 117 tests, tsc clean.
- Task 9 steps 1–3 done: migration 0003 applied to production D1, Worker deployed with the hourly cron,
  kill switch confirmed OFF on the live host. Steps 4–9 (Zoom sync, profiles, lab phone, DHCP) are yours.
- Deviations from the plan text, all ruled toward the spec: every `/admin*` response (incl. 401/404/303/400)
  sends `Cache-Control: no-store`; `redirect()` builds the 303 by hand; `classifyRequest` treats the all-zero
  MAC as `other`; `loadServeContext` failure degrades to a logged 404 `context-error`; the console guards
  `JSON.parse` of stored headers; generator throws degrade to 404 `bad-zoom-url`; `isValidZoomUrl` rejects
  whitespace/control chars; `replaceZoomDevices` uses `INSERT OR REPLACE`; admin is 503 when
  `ADMIN_PASSWORD` is unset or < 12 chars; admin POSTs require `Sec-Fetch-Site: same-origin` or a matching
  `Origin` (403 otherwise); `0003` also creates a partial index for the `redirected` CTE.
- Known deferred minors live in git history of the review ledger (summarised in the session's final message).
