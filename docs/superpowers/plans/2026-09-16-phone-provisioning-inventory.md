# Phone Provisioning Inventory Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a Cloudflare Worker that captures every provisioning check-in from a
lab test group of Yealink/Poly desk phones, identifies the device (MAC, model, firmware,
manufacturer, source IP), and shows it on an admin dashboard — plus a settings form to
accept and store (encrypted, unused for now) Zoom Server-to-Server OAuth credentials.

**Architecture:** Single Cloudflare Worker (TypeScript) with a catch-all `fetch` handler.
Non-`/admin` requests are treated as phone provisioning check-ins: parsed, logged to D1,
answered with an inert `200` empty body. `/admin` routes are Basic-Auth-protected and
render a device inventory table plus a Zoom credential intake form.

**Tech Stack:** Cloudflare Workers, D1 (SQLite-compatible), TypeScript, Vitest +
`@cloudflare/vitest-pool-workers` for tests that run against the real Workers runtime
(Miniflare) with a real D1 binding — no mocking of `D1Database` or `Request`/`Response`.

**Spec:** `docs/superpowers/specs/2026-09-16-phone-provisioning-inventory-design.md`

## Global Constraints

- Stay on the free Workers plan — no Containers, no paid tier. (spec: Cost)
- Every non-admin request gets `200`, empty body, `Content-Type: text/plain` — never
  serve real phone config, never error, even when parsing fails. (spec: Non-goals,
  Provisioning capture endpoint)
- `/admin` and `/admin/settings` require HTTP Basic Auth; the catch-all provisioning
  route must stay unauthenticated. (spec: Admin dashboard)
- Zoom client secret is stored encrypted at rest (AES-GCM via Web Crypto), key from a
  Worker secret, never committed to source. (spec: Zoom S2S credential intake)
- Raw request data (headers, path, query, User-Agent) is always persisted in full,
  regardless of whether manufacturer/model/firmware/MAC parsing succeeds — parsing logic
  must be improvable later without re-capturing from physical devices. (spec: Open items)
- No Zoom API calls in this plan — credential storage only. (spec: Non-goals)

---

## File Structure

```
package.json
tsconfig.json
wrangler.toml
vitest.config.ts
migrations/
  0001_init.sql
  0002_expected_devices.sql
scripts/
  build-seed.ts             # node script: Migrate.xlsx -> seed/expected_devices.sql (gitignored)
test/
  apply-migrations.ts       # global setup: applies migrations/ to the test D1 instance
  parse.spec.ts
  db.spec.ts
  crypto.spec.ts
  auth.spec.ts
  dashboard.spec.ts
  fleet.spec.ts
  index.spec.ts
src/
  types.ts                  # Env interface, ParsedDevice type
  parse.ts                  # extractMacAddress, parseUserAgent, parseDevice
  db.ts                      # all D1 queries: request log, fleet view, zoom config
  fleet.ts                   # xlsx -> ExpectedDevice[] parser + seed SQL builder (pure, no node:)
  crypto.ts                  # AES-GCM encrypt/decrypt for the Zoom client secret
  auth.ts                    # Basic Auth check + 401 response helper
  dashboard.ts               # HTML rendering for the admin page
  index.ts                   # fetch handler: routes to capture / admin / settings
```

Each `src/*.ts` file has exactly one job (parsing, persistence, crypto, auth, rendering);
`index.ts` only wires them together by route. This keeps every file small enough to hold
in context and test in isolation.

---

### Task 1: Project scaffold, D1 schema, minimal Worker

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `wrangler.toml`
- Create: `vitest.config.ts`
- Create: `migrations/0001_init.sql`
- Create: `test/apply-migrations.ts`
- Create: `src/types.ts`
- Create: `src/index.ts`
- Test: `test/index.spec.ts`

**Interfaces:**
- Produces: `Env` interface (`DB: D1Database`, `ADMIN_USER: string`,
  `ADMIN_PASSWORD: string`, `ENCRYPTION_KEY: string`) in `src/types.ts`, used by every
  later task.
- Produces: default-exported Worker object with `fetch(request, env)` in `src/index.ts`.

- [x] **Step 1: Create `package.json`**

```json
{
  "name": "phone-provisioning-inventory",
  "private": true,
  "scripts": {
    "test": "vitest run",
    "dev": "wrangler dev",
    "deploy": "wrangler deploy"
  },
  "devDependencies": {
    "@cloudflare/vitest-pool-workers": "^0.5.0",
    "@cloudflare/workers-types": "^4.20240909.0",
    "typescript": "^5.5.0",
    "vitest": "^1.5.0",
    "wrangler": "^3.78.0"
  }
}
```

- [x] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2021",
    "lib": ["ES2021"],
    "module": "ES2022",
    "moduleResolution": "Bundler",
    "types": ["@cloudflare/workers-types", "vitest/globals"],
    "strict": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "noEmit": true
  },
  "include": ["src", "test"]
}
```

- [x] **Step 3: Create `wrangler.toml`**

```toml
name = "phone-provisioning-inventory"
main = "src/index.ts"
compatibility_date = "2024-09-01"

[[d1_databases]]
binding = "DB"
database_name = "phone_provisioning"
database_id = "REPLACE_WITH_D1_DATABASE_ID"
```

`database_id` is a placeholder — Task 13 replaces it with the real ID after running
`wrangler d1 create phone_provisioning`. Tests don't need a real ID; `vitest-pool-workers`
runs its own ephemeral D1 instance from this config.

- [x] **Step 4: Create `migrations/0001_init.sql`**

```sql
CREATE TABLE provisioning_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at TEXT NOT NULL,
  source_ip TEXT,
  manufacturer TEXT,
  model TEXT,
  firmware TEXT,
  mac_address TEXT,
  http_method TEXT NOT NULL,
  path TEXT NOT NULL,
  query_string TEXT,
  user_agent TEXT,
  headers_json TEXT NOT NULL
);

CREATE INDEX idx_provisioning_requests_mac ON provisioning_requests(mac_address);

CREATE TABLE zoom_s2s_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  client_id TEXT NOT NULL,
  client_secret_encrypted TEXT NOT NULL,
  account_id TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

The `CHECK (id = 1)` constraint keeps `zoom_s2s_config` a single-row table — there's only
ever one Zoom app configured, so save/load is a plain upsert against `id = 1`.

- [x] **Step 5: Create `vitest.config.ts`**

```ts
import { defineWorkersConfig, readD1Migrations } from '@cloudflare/vitest-pool-workers/config';
import path from 'node:path';

export default defineWorkersConfig(async () => {
  const migrationsPath = path.join(__dirname, 'migrations');
  const migrations = await readD1Migrations(migrationsPath);
  return {
    test: {
      setupFiles: ['./test/apply-migrations.ts'],
      poolOptions: {
        workers: {
          singleWorker: true,
          wrangler: { configPath: './wrangler.toml' },
          miniflare: {
            bindings: { TEST_MIGRATIONS: migrations },
          },
        },
      },
    },
  };
});
```

- [x] **Step 6: Create `test/apply-migrations.ts`**

```ts
import { applyD1Migrations, env } from 'cloudflare:test';

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
```

This applies `migrations/0001_init.sql` to the ephemeral test D1 instance before any test
runs — `migrations/0001_init.sql` stays the single source of truth for schema, used both
by real deploys (`wrangler d1 migrations apply`) and by tests.

- [x] **Step 7: Create `src/types.ts`**

```ts
export interface Env {
  DB: D1Database;
  ADMIN_USER: string;
  ADMIN_PASSWORD: string;
  ENCRYPTION_KEY: string;
}

export interface ParsedDevice {
  manufacturer: string | null;
  model: string | null;
  firmware: string | null;
  macAddress: string | null;
}
```

- [x] **Step 8: Write the failing smoke test**

```ts
// test/index.spec.ts
import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('provisioning capture endpoint', () => {
  it('responds 200 with an empty body for any path', async () => {
    const response = await SELF.fetch('https://example.com/aabbccddeeff.cfg');
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('');
    expect(response.headers.get('Content-Type')).toBe('text/plain');
  });
});
```

- [x] **Step 9: Run test to verify it fails**

Run: `npm install && npm test`
Expected: FAIL — `src/index.ts` doesn't exist yet, or has no default export.

- [x] **Step 10: Write minimal `src/index.ts`**

```ts
import type { Env } from './types';

export default {
  async fetch(_request: Request, _env: Env): Promise<Response> {
    return new Response('', { status: 200, headers: { 'Content-Type': 'text/plain' } });
  },
};
```

- [x] **Step 11: Run test to verify it passes**

Run: `npm test`
Expected: PASS

- [x] **Step 12: Commit**

```bash
git add package.json tsconfig.json wrangler.toml vitest.config.ts migrations test/apply-migrations.ts test/index.spec.ts src/types.ts src/index.ts
git commit -m "chore: scaffold Cloudflare Worker with D1 schema and smoke test"
```

---

### Task 2: MAC address extraction

**Files:**
- Create: `src/parse.ts`
- Test: `test/parse.spec.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `extractMacAddress(path: string, query: string): string | null` in
  `src/parse.ts`, used by Task 3's `parseDevice` and Task 5's route wiring.

- [x] **Step 1: Write the failing tests**

```ts
// test/parse.spec.ts
import { describe, expect, it } from 'vitest';
import { extractMacAddress } from '../src/parse';

describe('extractMacAddress', () => {
  it('extracts a MAC from a filename that is exactly 12 hex chars', () => {
    expect(extractMacAddress('/aabbccddeeff.cfg', '')).toBe('AA:BB:CC:DD:EE:FF');
  });

  it('extracts a MAC from a mac= query parameter', () => {
    expect(extractMacAddress('/boot.cfg', '?mac=aabbccddeeff')).toBe('AA:BB:CC:DD:EE:FF');
  });

  it('does not false-positive on a common boot filename that happens to be all digits', () => {
    // Yealink's shared boot file is named like y000000000028.cfg — 13 chars including
    // the leading "y", not a MAC, and must not be misidentified as one.
    expect(extractMacAddress('/y000000000028.cfg', '')).toBeNull();
  });

  it('returns null when no MAC is present anywhere', () => {
    expect(extractMacAddress('/unknown.cfg', '')).toBeNull();
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `npm test -- parse.spec.ts`
Expected: FAIL — `src/parse.ts` doesn't exist yet.

- [x] **Step 3: Write the implementation**

```ts
// src/parse.ts
const MAC_HEX_RE = /^[0-9a-fA-F]{12}$/;

function normalizeMac(raw: string): string {
  return raw
    .toUpperCase()
    .match(/.{1,2}/g)!
    .join(':');
}

export function extractMacAddress(path: string, query: string): string | null {
  const queryMac = new URLSearchParams(query).get('mac');
  if (queryMac && MAC_HEX_RE.test(queryMac)) {
    return normalizeMac(queryMac);
  }

  const filename = path.split('/').pop() ?? '';
  const basename = filename.replace(/\.[^.]+$/, '');
  if (MAC_HEX_RE.test(basename)) {
    return normalizeMac(basename);
  }

  return null;
}
```

- [x] **Step 4: Run tests to verify they pass**

Run: `npm test -- parse.spec.ts`
Expected: PASS (all 4 cases)

- [x] **Step 5: Commit**

```bash
git add src/parse.ts test/parse.spec.ts
git commit -m "feat: extract MAC address from provisioning request path/query"
```

---

### Task 3: User-Agent parsing (manufacturer/model/firmware)

**Files:**
- Modify: `src/parse.ts`
- Modify: `test/parse.spec.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `parseUserAgent(userAgent: string | null): { manufacturer: string | null;
  model: string | null; firmware: string | null }` and `parseDevice(path: string, query:
  string, userAgent: string | null): ParsedDevice` in `src/parse.ts`, used by Task 5's
  route wiring.

**Note on format uncertainty:** the spec flags Yealink/Poly User-Agent format as
unconfirmed against real devices. `"Yealink SIP-T48U 66.85.0.15"` matches Yealink's
documented provisioning User-Agent shape. The Poly pattern below is a best-effort
placeholder pending Task 13's lab capture — it's written to be easy to adjust in one
place (the two `match()` calls) once real Poly VVX request data exists, without touching
callers.

- [x] **Step 1: Write the failing tests**

```ts
// append to test/parse.spec.ts
import { parseDevice, parseUserAgent } from '../src/parse';

describe('parseUserAgent', () => {
  it('parses a Yealink User-Agent', () => {
    expect(parseUserAgent('Yealink SIP-T48U 66.85.0.15')).toEqual({
      manufacturer: 'Yealink',
      model: 'SIP-T48U',
      firmware: '66.85.0.15',
    });
  });

  it('parses a Yealink T48S User-Agent', () => {
    expect(parseUserAgent('Yealink SIP-T48S 108.85.0.20')).toEqual({
      manufacturer: 'Yealink',
      model: 'SIP-T48S',
      firmware: '108.85.0.20',
    });
  });

  it('parses a Poly VVX User-Agent', () => {
    expect(parseUserAgent('PolycomSoundPointIPPhone/VVX_411-UA/6.4.7.1181')).toEqual({
      manufacturer: 'Poly',
      model: 'VVX 411',
      firmware: '6.4.7.1181',
    });
  });

  it('returns all nulls for an unrecognized or missing User-Agent', () => {
    expect(parseUserAgent('Mozilla/5.0 unknown device')).toEqual({
      manufacturer: null,
      model: null,
      firmware: null,
    });
    expect(parseUserAgent(null)).toEqual({ manufacturer: null, model: null, firmware: null });
  });
});

describe('parseDevice', () => {
  it('combines MAC extraction and User-Agent parsing', () => {
    expect(parseDevice('/aabbccddeeff.cfg', '', 'Yealink SIP-T48U 66.85.0.15')).toEqual({
      manufacturer: 'Yealink',
      model: 'SIP-T48U',
      firmware: '66.85.0.15',
      macAddress: 'AA:BB:CC:DD:EE:FF',
    });
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `npm test -- parse.spec.ts`
Expected: FAIL — `parseUserAgent` and `parseDevice` don't exist yet.

- [x] **Step 3: Add the implementation**

```ts
// append to src/parse.ts
import type { ParsedDevice } from './types';

export function parseUserAgent(
  userAgent: string | null,
): { manufacturer: string | null; model: string | null; firmware: string | null } {
  if (!userAgent) {
    return { manufacturer: null, model: null, firmware: null };
  }

  if (/yealink/i.test(userAgent)) {
    const modelMatch = userAgent.match(/Yealink\s+([A-Za-z0-9-]+)/i);
    const firmwareMatch = userAgent.match(/(\d+\.\d+\.\d+\.\d+)/);
    return {
      manufacturer: 'Yealink',
      model: modelMatch ? modelMatch[1] : null,
      firmware: firmwareMatch ? firmwareMatch[1] : null,
    };
  }

  if (/poly(com)?/i.test(userAgent)) {
    const modelMatch = userAgent.match(/VVX[\s_-]?(\d{3})/i);
    const firmwareMatch = userAgent.match(/(\d+\.\d+\.\d+(?:\.\d+)?)/);
    return {
      manufacturer: 'Poly',
      model: modelMatch ? `VVX ${modelMatch[1]}` : null,
      firmware: firmwareMatch ? firmwareMatch[1] : null,
    };
  }

  return { manufacturer: null, model: null, firmware: null };
}

export function parseDevice(path: string, query: string, userAgent: string | null): ParsedDevice {
  const { manufacturer, model, firmware } = parseUserAgent(userAgent);
  return { manufacturer, model, firmware, macAddress: extractMacAddress(path, query) };
}
```

- [x] **Step 4: Run tests to verify they pass**

Run: `npm test -- parse.spec.ts`
Expected: PASS (all cases)

- [x] **Step 5: Commit**

```bash
git add src/parse.ts test/parse.spec.ts
git commit -m "feat: parse manufacturer/model/firmware from provisioning User-Agent"
```

---

### Task 4: D1 request logging

**Files:**
- Create: `src/db.ts`
- Test: `test/db.spec.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks (D1Database comes from the test/runtime binding).
- Produces: `RequestLogEntry` type and `insertRequestLog(db: D1Database, entry:
  RequestLogEntry): Promise<void>` in `src/db.ts`, used by Task 5's route wiring.

- [x] **Step 1: Write the failing test**

```ts
// test/db.spec.ts
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { insertRequestLog } from '../src/db';

describe('insertRequestLog', () => {
  it('persists a full request log row', async () => {
    await insertRequestLog(env.DB, {
      receivedAt: '2026-09-16T00:00:00.000Z',
      sourceIp: '203.0.113.5',
      manufacturer: 'Yealink',
      model: 'SIP-T48U',
      firmware: '66.85.0.15',
      macAddress: 'AA:BB:CC:DD:EE:FF',
      httpMethod: 'GET',
      path: '/aabbccddeeff.cfg',
      queryString: '',
      userAgent: 'Yealink SIP-T48U 66.85.0.15',
      headersJson: '{"user-agent":"Yealink SIP-T48U 66.85.0.15"}',
    });

    const row = await env.DB.prepare('SELECT * FROM provisioning_requests').first();
    expect(row?.mac_address).toBe('AA:BB:CC:DD:EE:FF');
    expect(row?.manufacturer).toBe('Yealink');
    expect(row?.headers_json).toContain('user-agent');
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -- db.spec.ts`
Expected: FAIL — `src/db.ts` doesn't exist yet.

- [x] **Step 3: Write the implementation**

```ts
// src/db.ts
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
}

export async function insertRequestLog(db: D1Database, entry: RequestLogEntry): Promise<void> {
  await db
    .prepare(
      `INSERT INTO provisioning_requests
        (received_at, source_ip, manufacturer, model, firmware, mac_address,
         http_method, path, query_string, user_agent, headers_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    )
    .run();
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `npm test -- db.spec.ts`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add src/db.ts test/db.spec.ts
git commit -m "feat: persist provisioning check-ins to D1"
```

---

### Task 5: Wire the provisioning capture endpoint

**Files:**
- Modify: `src/index.ts`
- Modify: `test/index.spec.ts`

**Interfaces:**
- Consumes: `parseDevice` (Task 3), `insertRequestLog` + `RequestLogEntry` (Task 4).
- Produces: nothing new for later tasks — this is the integration point for the
  provisioning side; Tasks 6–12 build the `/admin` side of `index.ts` separately.

- [x] **Step 1: Write the failing test**

```ts
// append to test/index.spec.ts
import { env } from 'cloudflare:test';

it('logs a parsed Yealink check-in to D1', async () => {
  await SELF.fetch('https://example.com/aabbccddeeff.cfg', {
    headers: {
      'User-Agent': 'Yealink SIP-T48U 66.85.0.15',
      'CF-Connecting-IP': '203.0.113.9',
    },
  });

  const row = await env.DB.prepare(
    'SELECT * FROM provisioning_requests WHERE mac_address = ?',
  )
    .bind('AA:BB:CC:DD:EE:FF')
    .first();

  expect(row?.manufacturer).toBe('Yealink');
  expect(row?.model).toBe('SIP-T48U');
  expect(row?.firmware).toBe('66.85.0.15');
  expect(row?.source_ip).toBe('203.0.113.9');
  expect(row?.path).toBe('/aabbccddeeff.cfg');
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -- index.spec.ts`
Expected: FAIL — no row is inserted yet, `src/index.ts` is still the Task 1 stub.

- [x] **Step 3: Update `src/index.ts`**

```ts
import type { Env } from './types';
import { parseDevice } from './parse';
import { insertRequestLog } from './db';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const userAgent = request.headers.get('User-Agent');
    const parsed = parseDevice(url.pathname, url.search, userAgent);

    await insertRequestLog(env.DB, {
      receivedAt: new Date().toISOString(),
      sourceIp: request.headers.get('CF-Connecting-IP'),
      manufacturer: parsed.manufacturer,
      model: parsed.model,
      firmware: parsed.firmware,
      macAddress: parsed.macAddress,
      httpMethod: request.method,
      path: url.pathname,
      queryString: url.search,
      userAgent,
      headersJson: JSON.stringify(Object.fromEntries(request.headers)),
    });

    return new Response('', { status: 200, headers: { 'Content-Type': 'text/plain' } });
  },
};
```

- [x] **Step 4: Run test to verify it passes**

Run: `npm test -- index.spec.ts`
Expected: PASS — both the Task 1 smoke test and this new test pass.

- [x] **Step 5: Commit**

```bash
git add src/index.ts test/index.spec.ts
git commit -m "feat: wire parsing and logging into the provisioning fetch handler"
```

---

### Task 6: Basic Auth middleware

**Files:**
- Create: `src/auth.ts`
- Test: `test/auth.spec.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `checkBasicAuth(request: Request, expectedUser: string, expectedPassword:
  string): boolean` and `unauthorizedResponse(): Response` in `src/auth.ts`, used by
  Task 9's `/admin` route wiring.

- [x] **Step 1: Write the failing tests**

```ts
// test/auth.spec.ts
import { describe, expect, it } from 'vitest';
import { checkBasicAuth, unauthorizedResponse } from '../src/auth';

function basicAuthHeader(user: string, password: string): string {
  return `Basic ${btoa(`${user}:${password}`)}`;
}

describe('checkBasicAuth', () => {
  it('accepts correct credentials', () => {
    const request = new Request('https://example.com/admin', {
      headers: { Authorization: basicAuthHeader('admin', 'secret') },
    });
    expect(checkBasicAuth(request, 'admin', 'secret')).toBe(true);
  });

  it('rejects incorrect credentials', () => {
    const request = new Request('https://example.com/admin', {
      headers: { Authorization: basicAuthHeader('admin', 'wrong') },
    });
    expect(checkBasicAuth(request, 'admin', 'secret')).toBe(false);
  });

  it('rejects a missing Authorization header', () => {
    const request = new Request('https://example.com/admin');
    expect(checkBasicAuth(request, 'admin', 'secret')).toBe(false);
  });

  it('rejects a malformed Authorization header', () => {
    const request = new Request('https://example.com/admin', {
      headers: { Authorization: 'Bearer sometoken' },
    });
    expect(checkBasicAuth(request, 'admin', 'secret')).toBe(false);
  });
});

describe('unauthorizedResponse', () => {
  it('returns 401 with a WWW-Authenticate header', () => {
    const response = unauthorizedResponse();
    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toContain('Basic');
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `npm test -- auth.spec.ts`
Expected: FAIL — `src/auth.ts` doesn't exist yet.

- [x] **Step 3: Write the implementation**

```ts
// src/auth.ts
export function checkBasicAuth(request: Request, expectedUser: string, expectedPassword: string): boolean {
  const header = request.headers.get('Authorization');
  if (!header || !header.startsWith('Basic ')) {
    return false;
  }

  let decoded: string;
  try {
    decoded = atob(header.slice('Basic '.length));
  } catch {
    return false;
  }

  const separatorIndex = decoded.indexOf(':');
  if (separatorIndex === -1) {
    return false;
  }

  const user = decoded.slice(0, separatorIndex);
  const password = decoded.slice(separatorIndex + 1);
  return user === expectedUser && password === expectedPassword;
}

export function unauthorizedResponse(): Response {
  return new Response('Unauthorized', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="admin"' },
  });
}
```

- [x] **Step 4: Run tests to verify they pass**

Run: `npm test -- auth.spec.ts`
Expected: PASS (all 5 cases)

- [x] **Step 5: Commit**

```bash
git add src/auth.ts test/auth.spec.ts
git commit -m "feat: add Basic Auth check for admin routes"
```

---

### Task 7: Device list query

**Files:**
- Modify: `src/db.ts`
- Modify: `test/db.spec.ts`

**Interfaces:**
- Consumes: `insertRequestLog` (Task 4, used in test setup to seed rows).
- Produces: `DeviceSummary` type and `listDevices(db: D1Database):
  Promise<DeviceSummary[]>` in `src/db.ts`, used by Task 8's `renderDashboard` and
  Task 9's route wiring.

- [x] **Step 1: Write the failing test**

```ts
// append to test/db.spec.ts
import { listDevices } from '../src/db';

describe('listDevices', () => {
  it('returns the latest row per MAC with a check-in count, newest first', async () => {
    await insertRequestLog(env.DB, {
      receivedAt: '2026-09-16T00:00:00.000Z',
      sourceIp: '203.0.113.5',
      manufacturer: 'Yealink',
      model: 'SIP-T48U',
      firmware: '66.85.0.14',
      macAddress: 'AA:BB:CC:DD:EE:FF',
      httpMethod: 'GET',
      path: '/aabbccddeeff.cfg',
      queryString: '',
      userAgent: 'Yealink SIP-T48U 66.85.0.14',
      headersJson: '{}',
    });
    await insertRequestLog(env.DB, {
      receivedAt: '2026-09-16T01:00:00.000Z',
      sourceIp: '203.0.113.5',
      manufacturer: 'Yealink',
      model: 'SIP-T48U',
      firmware: '66.85.0.15',
      macAddress: 'AA:BB:CC:DD:EE:FF',
      httpMethod: 'GET',
      path: '/aabbccddeeff.cfg',
      queryString: '',
      userAgent: 'Yealink SIP-T48U 66.85.0.15',
      headersJson: '{}',
    });
    await insertRequestLog(env.DB, {
      receivedAt: '2026-09-16T00:30:00.000Z',
      sourceIp: '203.0.113.6',
      manufacturer: 'Poly',
      model: 'VVX 411',
      firmware: '6.4.7.1181',
      macAddress: '11:22:33:44:55:66',
      httpMethod: 'GET',
      path: '/112233445566.cfg',
      queryString: '',
      userAgent: 'PolycomSoundPointIPPhone/VVX_411-UA/6.4.7.1181',
      headersJson: '{}',
    });

    const devices = await listDevices(env.DB);

    expect(devices).toHaveLength(2);
    expect(devices[0].macAddress).toBe('AA:BB:CC:DD:EE:FF');
    expect(devices[0].firmware).toBe('66.85.0.15'); // latest check-in, not the first
    expect(devices[0].checkInCount).toBe(2);
    expect(devices[1].macAddress).toBe('11:22:33:44:55:66');
    expect(devices[1].checkInCount).toBe(1);
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -- db.spec.ts`
Expected: FAIL — `listDevices` doesn't exist yet.

- [x] **Step 3: Add the implementation**

```ts
// append to src/db.ts
export interface DeviceSummary {
  macAddress: string;
  manufacturer: string | null;
  model: string | null;
  firmware: string | null;
  sourceIp: string | null;
  lastSeenAt: string;
  checkInCount: number;
}

export async function listDevices(db: D1Database): Promise<DeviceSummary[]> {
  const result = await db
    .prepare(
      `SELECT mac_address as macAddress, manufacturer, model, firmware,
              source_ip as sourceIp, received_at as lastSeenAt, checkInCount
       FROM (
         SELECT *,
                COUNT(*) OVER (PARTITION BY mac_address) as checkInCount,
                ROW_NUMBER() OVER (PARTITION BY mac_address ORDER BY received_at DESC) as rn
         FROM provisioning_requests
         WHERE mac_address IS NOT NULL
       )
       WHERE rn = 1
       ORDER BY lastSeenAt DESC`,
    )
    .all<DeviceSummary>();
  return result.results;
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `npm test -- db.spec.ts`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add src/db.ts test/db.spec.ts
git commit -m "feat: query latest-per-device inventory with check-in counts"
```

---

### Task 8: Dashboard HTML rendering

**Files:**
- Create: `src/dashboard.ts`
- Test: `test/dashboard.spec.ts`

**Interfaces:**
- Consumes: `DeviceSummary` type (Task 7).
- Produces: `renderDashboard(devices: DeviceSummary[]): string` in `src/dashboard.ts`,
  used by Task 9's route wiring.

- [x] **Step 1: Write the failing tests**

```ts
// test/dashboard.spec.ts
import { describe, expect, it } from 'vitest';
import { renderDashboard } from '../src/dashboard';
import type { DeviceSummary } from '../src/db';

const sampleDevice: DeviceSummary = {
  macAddress: 'AA:BB:CC:DD:EE:FF',
  manufacturer: 'Yealink',
  model: 'SIP-T48U',
  firmware: '66.85.0.15',
  sourceIp: '203.0.113.5',
  lastSeenAt: '2026-09-16T01:00:00.000Z',
  checkInCount: 2,
};

describe('renderDashboard', () => {
  it('includes each device field in the output', () => {
    const html = renderDashboard([sampleDevice]);
    expect(html).toContain('AA:BB:CC:DD:EE:FF');
    expect(html).toContain('Yealink');
    expect(html).toContain('SIP-T48U');
    expect(html).toContain('66.85.0.15');
    expect(html).toContain('203.0.113.5');
    expect(html).toContain('2');
  });

  it('renders a settings form for Zoom S2S credentials', () => {
    const html = renderDashboard([]);
    expect(html).toContain('action="/admin/settings"');
    expect(html).toContain('name="clientId"');
    expect(html).toContain('name="clientSecret"');
    expect(html).toContain('name="accountId"');
  });

  it('escapes HTML in device fields', () => {
    const malicious: DeviceSummary = { ...sampleDevice, model: '<script>alert(1)</script>' };
    const html = renderDashboard([malicious]);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `npm test -- dashboard.spec.ts`
Expected: FAIL — `src/dashboard.ts` doesn't exist yet.

- [x] **Step 3: Write the implementation**

```ts
// src/dashboard.ts
import type { DeviceSummary } from './db';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function renderDashboard(devices: DeviceSummary[]): string {
  const rows = devices
    .map(
      (d) => `<tr>
        <td>${escapeHtml(d.macAddress)}</td>
        <td>${escapeHtml(d.manufacturer ?? '—')}</td>
        <td>${escapeHtml(d.model ?? '—')}</td>
        <td>${escapeHtml(d.firmware ?? '—')}</td>
        <td>${escapeHtml(d.sourceIp ?? '—')}</td>
        <td>${escapeHtml(d.lastSeenAt)}</td>
        <td>${d.checkInCount}</td>
      </tr>`,
    )
    .join('\n');

  return `<!doctype html>
<html>
<head><title>Provisioning Inventory</title></head>
<body>
  <h1>Provisioning Inventory</h1>
  <table border="1">
    <thead>
      <tr><th>MAC</th><th>Manufacturer</th><th>Model</th><th>Firmware</th><th>Last IP</th><th>Last Seen</th><th>Check-ins</th></tr>
    </thead>
    <tbody>
      ${rows}
    </tbody>
  </table>
  <h2>Zoom S2S Settings</h2>
  <form method="POST" action="/admin/settings">
    <label>Client ID <input name="clientId" required></label><br>
    <label>Client Secret <input name="clientSecret" type="password" required></label><br>
    <label>Account ID <input name="accountId" required></label><br>
    <button type="submit">Save</button>
  </form>
</body>
</html>`;
}
```

- [x] **Step 4: Run tests to verify they pass**

Run: `npm test -- dashboard.spec.ts`
Expected: PASS (all 3 cases)

- [x] **Step 5: Commit**

```bash
git add src/dashboard.ts test/dashboard.spec.ts
git commit -m "feat: render admin dashboard HTML with device table and settings form"
```

---

### Task 9: Wire the `/admin` dashboard route

**Files:**
- Modify: `src/index.ts`
- Modify: `test/index.spec.ts`

**Interfaces:**
- Consumes: `checkBasicAuth`, `unauthorizedResponse` (Task 6); `listDevices` (Task 7);
  `renderDashboard` (Task 8).
- Produces: nothing new for later tasks — Task 12 adds the settings `POST` branch
  alongside this.

- [x] **Step 1: Write the failing tests**

```ts
// append to test/index.spec.ts
describe('/admin', () => {
  it('rejects requests without valid Basic Auth', async () => {
    const response = await SELF.fetch('https://example.com/admin');
    expect(response.status).toBe(401);
  });

  it('renders the dashboard for authenticated requests', async () => {
    const response = await SELF.fetch('https://example.com/admin', {
      headers: { Authorization: `Basic ${btoa('admin:secret')}` },
    });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('Provisioning Inventory');
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `npm test -- index.spec.ts`
Expected: FAIL — `/admin` currently falls through to the provisioning-capture branch and
returns an empty `200`, not the dashboard; also `env.ADMIN_USER`/`ADMIN_PASSWORD` aren't
set for tests yet.

- [x] **Step 3: Add test env vars to `wrangler.toml`**

```toml
[vars]
ADMIN_USER = "admin"
ADMIN_PASSWORD = "secret"
```

(Task 13 replaces `ADMIN_PASSWORD` with a real `wrangler secret put` value for the actual
deploy — plaintext in `wrangler.toml` is only acceptable here because this whole file is
about to be superseded for the real credential at deploy time. `ENCRYPTION_KEY`, added in
Task 10, is a `wrangler secret` from the start since it protects the Zoom client secret.)

- [x] **Step 4: Update `src/index.ts`**

```ts
import type { Env } from './types';
import { parseDevice } from './parse';
import { insertRequestLog, listDevices } from './db';
import { checkBasicAuth, unauthorizedResponse } from './auth';
import { renderDashboard } from './dashboard';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/admin') {
      if (!checkBasicAuth(request, env.ADMIN_USER, env.ADMIN_PASSWORD)) {
        return unauthorizedResponse();
      }
      const devices = await listDevices(env.DB);
      return new Response(renderDashboard(devices), {
        headers: { 'Content-Type': 'text/html' },
      });
    }

    const userAgent = request.headers.get('User-Agent');
    const parsed = parseDevice(url.pathname, url.search, userAgent);

    await insertRequestLog(env.DB, {
      receivedAt: new Date().toISOString(),
      sourceIp: request.headers.get('CF-Connecting-IP'),
      manufacturer: parsed.manufacturer,
      model: parsed.model,
      firmware: parsed.firmware,
      macAddress: parsed.macAddress,
      httpMethod: request.method,
      path: url.pathname,
      queryString: url.search,
      userAgent,
      headersJson: JSON.stringify(Object.fromEntries(request.headers)),
    });

    return new Response('', { status: 200, headers: { 'Content-Type': 'text/plain' } });
  },
};
```

- [x] **Step 5: Run tests to verify they pass**

Run: `npm test -- index.spec.ts`
Expected: PASS — all `/admin` and provisioning-capture tests pass.

- [x] **Step 6: Commit**

```bash
git add wrangler.toml src/index.ts test/index.spec.ts
git commit -m "feat: wire Basic-Auth-protected /admin dashboard route"
```

---

### Task 10: Zoom client secret encryption

**Files:**
- Create: `src/crypto.ts`
- Test: `test/crypto.spec.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `encryptSecret(plaintext: string, base64Key: string): Promise<string>` and
  `decryptSecret(encoded: string, base64Key: string): Promise<string>` in `src/crypto.ts`,
  used by Task 12's route wiring.

- [x] **Step 1: Write the failing tests**

```ts
// test/crypto.spec.ts
import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret } from '../src/crypto';

// 32 random bytes, base64-encoded — same shape as a real `wrangler secret put ENCRYPTION_KEY` value.
const TEST_KEY = 'l7GJ2Q6f1n9mYkX3wZ4pC8dT5rV0sB1eH2iJ6kL9mN0=';

describe('encryptSecret / decryptSecret', () => {
  it('round-trips a plaintext secret', async () => {
    const encrypted = await encryptSecret('super-secret-client-secret', TEST_KEY);
    const decrypted = await decryptSecret(encrypted, TEST_KEY);
    expect(decrypted).toBe('super-secret-client-secret');
  });

  it('produces different ciphertext for the same plaintext each time', async () => {
    const first = await encryptSecret('same-plaintext', TEST_KEY);
    const second = await encryptSecret('same-plaintext', TEST_KEY);
    expect(first).not.toBe(second);
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `npm test -- crypto.spec.ts`
Expected: FAIL — `src/crypto.ts` doesn't exist yet.

- [x] **Step 3: Write the implementation**

```ts
// src/crypto.ts
async function importKey(base64Key: string): Promise<CryptoKey> {
  const raw = Uint8Array.from(atob(base64Key), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encryptSecret(plaintext: string, base64Key: string): Promise<string> {
  const key = await importKey(base64Key);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);

  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return btoa(String.fromCharCode(...combined));
}

export async function decryptSecret(encoded: string, base64Key: string): Promise<string> {
  const key = await importKey(base64Key);
  const combined = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  return new TextDecoder().decode(plaintext);
}
```

- [x] **Step 4: Run tests to verify they pass**

Run: `npm test -- crypto.spec.ts`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add src/crypto.ts test/crypto.spec.ts
git commit -m "feat: AES-GCM encrypt/decrypt helpers for the Zoom client secret"
```

---

### Task 11: Zoom S2S config save/load

**Files:**
- Modify: `src/db.ts`
- Modify: `test/db.spec.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks (stores the already-encrypted secret string as-is
  — encryption itself happens in Task 12's route wiring using Task 10's functions).
- Produces: `ZoomConfigRecord` type, `saveZoomConfig(db: D1Database, record:
  ZoomConfigRecord): Promise<void>`, `getZoomConfig(db: D1Database):
  Promise<ZoomConfigRecord | null>` in `src/db.ts`, used by Task 12's route wiring.

- [x] **Step 1: Write the failing tests**

```ts
// append to test/db.spec.ts
import { getZoomConfig, saveZoomConfig } from '../src/db';

describe('saveZoomConfig / getZoomConfig', () => {
  it('returns null when nothing has been saved', async () => {
    expect(await getZoomConfig(env.DB)).toBeNull();
  });

  it('saves and reads back a config record', async () => {
    await saveZoomConfig(env.DB, {
      clientId: 'client-123',
      clientSecretEncrypted: 'ciphertext-abc',
      accountId: 'account-456',
      updatedAt: '2026-09-16T00:00:00.000Z',
    });

    const config = await getZoomConfig(env.DB);
    expect(config).toEqual({
      clientId: 'client-123',
      clientSecretEncrypted: 'ciphertext-abc',
      accountId: 'account-456',
      updatedAt: '2026-09-16T00:00:00.000Z',
    });
  });

  it('overwrites the existing record on a second save (single-row upsert)', async () => {
    await saveZoomConfig(env.DB, {
      clientId: 'client-123',
      clientSecretEncrypted: 'ciphertext-abc',
      accountId: 'account-456',
      updatedAt: '2026-09-16T00:00:00.000Z',
    });
    await saveZoomConfig(env.DB, {
      clientId: 'client-999',
      clientSecretEncrypted: 'ciphertext-xyz',
      accountId: 'account-456',
      updatedAt: '2026-09-16T02:00:00.000Z',
    });

    const config = await getZoomConfig(env.DB);
    expect(config?.clientId).toBe('client-999');

    const count = await env.DB.prepare('SELECT COUNT(*) as n FROM zoom_s2s_config').first<{ n: number }>();
    expect(count?.n).toBe(1);
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `npm test -- db.spec.ts`
Expected: FAIL — `saveZoomConfig`/`getZoomConfig` don't exist yet.

- [x] **Step 3: Add the implementation**

```ts
// append to src/db.ts
export interface ZoomConfigRecord {
  clientId: string;
  clientSecretEncrypted: string;
  accountId: string;
  updatedAt: string;
}

export async function saveZoomConfig(db: D1Database, record: ZoomConfigRecord): Promise<void> {
  await db
    .prepare(
      `INSERT INTO zoom_s2s_config (id, client_id, client_secret_encrypted, account_id, updated_at)
       VALUES (1, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         client_id = excluded.client_id,
         client_secret_encrypted = excluded.client_secret_encrypted,
         account_id = excluded.account_id,
         updated_at = excluded.updated_at`,
    )
    .bind(record.clientId, record.clientSecretEncrypted, record.accountId, record.updatedAt)
    .run();
}

export async function getZoomConfig(db: D1Database): Promise<ZoomConfigRecord | null> {
  const row = await db
    .prepare(
      `SELECT client_id as clientId, client_secret_encrypted as clientSecretEncrypted,
              account_id as accountId, updated_at as updatedAt
       FROM zoom_s2s_config WHERE id = 1`,
    )
    .first<ZoomConfigRecord>();
  return row ?? null;
}
```

- [x] **Step 4: Run tests to verify they pass**

Run: `npm test -- db.spec.ts`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add src/db.ts test/db.spec.ts
git commit -m "feat: add single-row upsert storage for Zoom S2S config"
```

---

### Task 12: Wire the `/admin/settings` save route

**Files:**
- Modify: `src/index.ts`
- Modify: `test/index.spec.ts`

**Interfaces:**
- Consumes: `encryptSecret`/`decryptSecret` (Task 10), `saveZoomConfig`/`getZoomConfig`
  (Task 11).
- Produces: nothing new for later tasks — this completes the application's routes.

Design note: the dashboard's settings form (Task 8) is write-only — it never displays a
previously saved secret back in HTML, even encrypted-then-redisplayed-as-masked. Saving
always overwrites. This is deliberate: no reason to round-trip a secret through the
browser once it's stored.

- [x] **Step 1: Add `ENCRYPTION_KEY` as a bindings var for tests**

Add to `wrangler.toml`'s `[vars]` block from Task 9:

```toml
[vars]
ADMIN_USER = "admin"
ADMIN_PASSWORD = "secret"
ENCRYPTION_KEY = "l7GJ2Q6f1n9mYkX3wZ4pC8dT5rV0sB1eH2iJ6kL9mN0="
```

(Task 13 moves this to a real `wrangler secret put ENCRYPTION_KEY` for the actual deploy.)

- [x] **Step 2: Write the failing test**

```ts
// append to test/index.spec.ts
import { decryptSecret } from '../src/crypto';
import { getZoomConfig } from '../src/db';

describe('/admin/settings', () => {
  it('rejects unauthenticated POSTs', async () => {
    const response = await SELF.fetch('https://example.com/admin/settings', { method: 'POST' });
    expect(response.status).toBe(401);
  });

  it('saves the encrypted client secret and redirects back to /admin', async () => {
    const form = new URLSearchParams({
      clientId: 'client-123',
      clientSecret: 'super-secret-value',
      accountId: 'account-456',
    });

    const response = await SELF.fetch('https://example.com/admin/settings', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${btoa('admin:secret')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
      redirect: 'manual',
    });

    expect(response.status).toBe(303);
    expect(response.headers.get('Location')).toContain('/admin');

    const config = await getZoomConfig(env.DB);
    expect(config?.clientId).toBe('client-123');
    expect(config?.accountId).toBe('account-456');

    const decrypted = await decryptSecret(config!.clientSecretEncrypted, 'l7GJ2Q6f1n9mYkX3wZ4pC8dT5rV0sB1eH2iJ6kL9mN0=');
    expect(decrypted).toBe('super-secret-value');
  });
});
```

- [x] **Step 3: Run test to verify it fails**

Run: `npm test -- index.spec.ts`
Expected: FAIL — `/admin/settings` isn't routed yet, falls through to the provisioning
branch.

- [x] **Step 4: Update `src/index.ts`**

```ts
import type { Env } from './types';
import { parseDevice } from './parse';
import { insertRequestLog, listDevices, saveZoomConfig } from './db';
import { checkBasicAuth, unauthorizedResponse } from './auth';
import { renderDashboard } from './dashboard';
import { encryptSecret } from './crypto';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/admin' || url.pathname === '/admin/settings') {
      if (!checkBasicAuth(request, env.ADMIN_USER, env.ADMIN_PASSWORD)) {
        return unauthorizedResponse();
      }

      if (url.pathname === '/admin/settings' && request.method === 'POST') {
        const form = await request.formData();
        const clientId = String(form.get('clientId') ?? '');
        const clientSecret = String(form.get('clientSecret') ?? '');
        const accountId = String(form.get('accountId') ?? '');

        await saveZoomConfig(env.DB, {
          clientId,
          clientSecretEncrypted: await encryptSecret(clientSecret, env.ENCRYPTION_KEY),
          accountId,
          updatedAt: new Date().toISOString(),
        });

        return Response.redirect(`${url.origin}/admin`, 303);
      }

      const devices = await listDevices(env.DB);
      return new Response(renderDashboard(devices), {
        headers: { 'Content-Type': 'text/html' },
      });
    }

    const userAgent = request.headers.get('User-Agent');
    const parsed = parseDevice(url.pathname, url.search, userAgent);

    await insertRequestLog(env.DB, {
      receivedAt: new Date().toISOString(),
      sourceIp: request.headers.get('CF-Connecting-IP'),
      manufacturer: parsed.manufacturer,
      model: parsed.model,
      firmware: parsed.firmware,
      macAddress: parsed.macAddress,
      httpMethod: request.method,
      path: url.pathname,
      queryString: url.search,
      userAgent,
      headersJson: JSON.stringify(Object.fromEntries(request.headers)),
    });

    return new Response('', { status: 200, headers: { 'Content-Type': 'text/plain' } });
  },
};
```

- [x] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — full suite green.

- [x] **Step 6: Commit**

```bash
git add wrangler.toml src/index.ts test/index.spec.ts
git commit -m "feat: wire /admin/settings to encrypt and save Zoom S2S credentials"
```

---

### Task 13: Expected fleet import (xlsx → seed SQL)

**Files:**
- Create: `migrations/0002_expected_devices.sql`
- Create: `src/fleet.ts`
- Create: `scripts/build-seed.ts`
- Create: `.gitignore` (add `Migrate.xlsx`, `seed/`)
- Modify: `package.json` (add `fflate` dev dependency, `seed` script)
- Test: `test/fleet.spec.ts`

**Interfaces:**
- Consumes: `normalizeMac` (Task 2).
- Produces: `ExpectedDevice` type, `parseMigrateWorkbook(bytes: Uint8Array):
  ExpectedDevice[]`, `buildSeedSql(devices: ExpectedDevice[], importedAt: string): string`
  in `src/fleet.ts`; `expected_devices` table used by Task 14.

Design note: the xlsx is parsed by a Node script, never by the Worker — the free plan's
per-request CPU budget is too small for inflating and scanning a 400 KB sheet. `src/fleet.ts`
is pure (no `node:` imports) so it runs under both vitest-pool-workers and plain
`node scripts/build-seed.ts` (Node's built-in type stripping; `.ts` extensions on imports).

- [x] **Step 1: Create `migrations/0002_expected_devices.sql`**

```sql
CREATE TABLE expected_devices (
  mac_address TEXT PRIMARY KEY,
  rc_device_id TEXT,
  name TEXT NOT NULL,
  extension TEXT,
  model TEXT,
  rc_status TEXT,
  imported_at TEXT NOT NULL
);
```

- [x] **Step 2: Write the failing tests**

`test/fleet.spec.ts` builds a tiny xlsx in memory with `fflate.zipSync` (one sheet, both
inline-string and shared-string cells) and asserts:
- hard phones with a 12-hex `Serial/MAC` come back with normalized `AA:BB:..` MACs and all
  columns mapped;
- `SoftPhone` rows and hard phones with non-MAC serials (`CCQ224502A7`) are skipped;
- `buildSeedSql` emits one `INSERT ... ON CONFLICT(mac_address) DO UPDATE` per device and
  doubles single quotes in names.

- [x] **Step 3: Run tests to verify they fail** — `npm test -- fleet.spec.ts`

- [x] **Step 4: Implement `src/fleet.ts` and `scripts/build-seed.ts`**

`parseMigrateWorkbook`: `unzipSync` → read `xl/sharedStrings.xml` (optional) and
`xl/worksheets/sheet1.xml` → regex over `<row>`/`<c>` → header row maps column letter to
header text → filter `Type === 'HardPhone'` and `normalizeMac(serial) !== null`.

`scripts/build-seed.ts`: `node scripts/build-seed.ts [Migrate.xlsx] [seed/expected_devices.sql]`.

- [x] **Step 5: Run tests to verify they pass**, then `npm run seed` against the real
  `Migrate.xlsx` and confirm it reports 423 devices.

- [x] **Step 6: Commit** — `feat: import expected fleet from RingCentral xlsx export`

---

### Task 14: Fleet view (expected vs seen) on the dashboard

**Files:**
- Modify: `src/db.ts` (replace `listDevices`/`DeviceSummary` with `listFleet`/`FleetRow`)
- Modify: `src/dashboard.ts`, `src/index.ts`
- Modify: `test/db.spec.ts`, `test/dashboard.spec.ts`, `test/index.spec.ts`

**Interfaces:**
- Consumes: `insertRequestLog` (Task 4), `expected_devices` (Task 13).
- Produces: `FleetStatus = 'seen' | 'not-seen' | 'unexpected'`, `FleetRow`,
  `listFleet(db): Promise<FleetRow[]>` in `src/db.ts`;
  `renderDashboard(rows: FleetRow[], filter: FleetStatus | 'all'): string`.

- [x] **Step 1: Write the failing tests**

- `listFleet`: seed two expected devices + check-ins for one of them + one check-in for an
  unknown MAC → three rows with statuses `seen`, `not-seen`, `unexpected`; seen row carries
  latest firmware and `checkInCount`; `not-seen` has `checkInCount: 0`.
- `renderDashboard`: summary counts (`Expected 2`, `Seen 1`, `Not seen 1`, `Unexpected 1`),
  expected name/extension/model columns, status filter hides non-matching rows, HTML escaping.
- `/admin?status=unexpected` route passes the filter through.

- [x] **Step 2: Run tests to verify they fail**

- [x] **Step 3: Implement**

`listFleet` SQL: CTE `latest` (same window query as Task 7) → `expected_devices LEFT JOIN
latest` with `CASE` status, `UNION ALL` `latest LEFT JOIN expected_devices WHERE
e.mac_address IS NULL` as `unexpected`, `ORDER BY lastSeenAt DESC NULLS LAST, expectedName`.
Dashboard computes counts from the full row set, then filters for display.

- [x] **Step 4: Run full suite** — `npm test`

- [x] **Step 5: Commit** — `feat: fleet view with expected/seen/unexpected status`

---

### Task 15: Deploy and run the lab test (manual — not code)

This task has no automated test cycle — it's the physical/manual verification the spec's
Testing plan calls for. Follow it in order; each step depends on the previous one.

- [ ] **Step 1: Create the real D1 database**

Run: `npx wrangler d1 create phone_provisioning`
Copy the `database_id` from the output into `wrangler.toml`, replacing
`REPLACE_WITH_D1_DATABASE_ID`.

- [ ] **Step 2: Apply the schema to the real database**

Run: `npx wrangler d1 migrations apply phone_provisioning --remote`

- [ ] **Step 2b: Seed the expected fleet**

```bash
npm run seed -- Migrate.xlsx
npx wrangler d1 execute phone_provisioning --remote --file seed/expected_devices.sql
```

Re-run both whenever RingCentral exports a fresh `Migrate.xlsx` — the seed is an upsert.

- [ ] **Step 3: Set real secrets**

Remove `ADMIN_PASSWORD` and `ENCRYPTION_KEY` from `wrangler.toml`'s `[vars]` block (they
were test-only plaintext values) and set them as real secrets instead:

```bash
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put ENCRYPTION_KEY   # value: `openssl rand -base64 32`
```

Keep `ADMIN_USER` in `[vars]` — it's a username, not a secret.

- [ ] **Step 4: Deploy**

Run: `npx wrangler deploy`
Note the resulting `*.workers.dev` URL, or configure a custom route on the existing
Cloudflare zone (e.g. `provision.<your-domain>`) via the Cloudflare dashboard or
`wrangler.toml`'s `routes` field.

- [ ] **Step 5: Smoke test the deployed endpoint**

Run: `curl -i https://<deployed-url>/test.cfg`
Expected: `200`, empty body, `Content-Type: text/plain`.

Run: `curl -i -u admin:<your-password> https://<deployed-url>/admin`
Expected: `200`, HTML containing "Provisioning Inventory".

- [ ] **Step 6: Register one lab phone per vendor**

In Yealink RPS, point one test T48U or T48S's MAC at the deployed URL. In Poly ZTP
(Device Management Service), do the same for one test VVX 411 or VVX 311. (Exact steps
are in each vendor's redirect-service admin console — outside this repo.)

- [ ] **Step 7: Trigger re-provisioning and verify capture**

Reboot each test phone (or trigger its "check for updates" action). Then run:

```bash
npx wrangler d1 execute phone_provisioning --remote --command "SELECT * FROM provisioning_requests ORDER BY id DESC LIMIT 5"
```

Confirm rows landed with the phone's real path/headers. Open `/admin` in a browser
(Basic Auth prompt, use the credentials from Step 3) and confirm the device appears.

- [ ] **Step 8: Refine parsing against real data if needed**

If `manufacturer`/`model`/`firmware`/`mac_address` came back `null` or wrong for either
vendor, use the captured `headers_json`/`user_agent`/`path` columns from Step 7 to update
the regexes in `src/parse.ts` (Tasks 2–3), add a test case reproducing the exact real
string, then re-run `npm test` and re-deploy (Step 4).

---

## Self-Review Notes

- **Spec coverage:** every spec component (provisioning capture, admin dashboard, Zoom
  S2S intake, data model, deployment, testing plan) has a task. The spec's "Open items"
  section is addressed by Task 13 Step 8 rather than guessed away.
- **No placeholders:** all code blocks are complete and runnable; the one genuinely
  unconfirmed area (Poly User-Agent format) is called out explicitly in Task 3 rather than
  hidden behind a TODO, with a concrete follow-up path in Task 13.
- **Type consistency checked:** `RequestLogEntry`, `DeviceSummary`, `ZoomConfigRecord`,
  and `Env` are defined once each (Tasks 1, 4, 7, 11) and referenced with the same field
  names everywhere they're consumed (Tasks 5, 8, 9, 12).

## Execution Notes (2026-09-17)

- Tasks 1–14 done; Task 15 (deploy + lab test) is manual and still open.
- Deps updated to current: wrangler 4.134, vitest 4.1, `@cloudflare/vitest-pool-workers` 0.22,
  workers-types 5.x, TypeScript 7.0. Config uses the v4 plugin API (`cloudflareTest` in
  `plugins`, not `defineWorkersConfig`). Pool has no per-test storage isolation any more —
  `test/apply-migrations.ts` wipes app tables in `beforeEach`.
- Task 7 (`listDevices`) was folded into Task 14's `listFleet`; no standalone device-list query exists.
- Test-only `ADMIN_PASSWORD`/`ENCRYPTION_KEY` live in `vitest.config.ts` miniflare bindings,
  not `wrangler.toml` `[vars]`, so nothing needs removing before deploy. Local dev reads `.dev.vars`.
- MAC extraction also handles Poly `{mac}-phone.cfg` suffixes, ignores Poly's `000000000000.cfg`
  master file, and falls back to the MAC Yealink embeds in its User-Agent.
- Compatibility date pinned to 2026-08-22 (newest the bundled workerd supports).
