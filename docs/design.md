# phonehome — Technical Design

**Status:** current as of 2026-09-18 · **Runtime:** Cloudflare Worker + D1 · **Live at:** `https://phonehome.cincylab.net`

This document describes the system as built. The two dated specs under
`docs/superpowers/specs/` are the historical design records for Phase 1 (inventory) and
Phase 2 (Zoom redirect); this file supersedes them as the reference for how the code works
today. It deliberately contains no IP addresses, account identifiers, database IDs, or
secrets — the repository is public.

---

## 1. Purpose and context

A fleet of ~460 desk phones (Yealink T48S/T48U, Poly VVX 311/411/450, a few Poly IP 5000/6000
conference phones, and OBi302 ATAs) is moving from RingCentral to Zoom Phone. RingCentral still
owns the vendor zero-touch services (Yealink RPS, Poly ZTP), so the phones cannot simply be
re-pointed there. The goal is a **no-factory-reset migration**: change the DHCP provisioning
option on each site's scope to this server, let every phone check in once, hand it a tiny
vendor config file that sets its provisioning server to Zoom's model-specific assisted
provisioning URL, and let it re-home to Zoom on its own.

The server does exactly three things:

1. **Records** every request a phone makes (path, headers, User-Agent, parsed MAC/model/firmware).
2. **Decides** whether that phone may be redirected — expected in the fleet, already present in
   Zoom, model has a Zoom URL configured, global kill switch on — and if so answers with the
   redirect file. Otherwise it answers 404 with a logged reason.
3. **Mirrors** Zoom's device list (read-only) hourly so "exists in Zoom" is a local lookup.

Everything else — adding devices to Zoom, assigning users, firmware, full configs, directories,
any RingCentral API — is out of scope by design.

## 2. System overview

```
                 DHCP option 66 / 160
  Desk phone ─────────────────────────▶ Cloudflare edge ──▶ Worker (src/index.ts)
  (Yealink / Poly)   GET /{mac}.cfg                             │
                                                                ├── D1 (SQLite): request log,
                                                                │   expected fleet, Zoom mirror,
                                                                │   profiles, settings, counters
                                                                │
  Admin browser ───── Basic Auth ─────▶ /admin/*  ──────────────┤
                                                                │
  Cron (hourly) ───────────────────────▶ scheduled() ───────────┴──▶ Zoom API (S2S OAuth,
                                                                     read-only device list)
```

One Worker script, one D1 database, no queues, no KV, no Durable Objects. It runs on the
Cloudflare free plan behind a custom domain; the default `workers.dev` hostname is disabled.

## 3. Request lifecycle

`fetch()` in `src/index.ts` splits traffic on the path: anything at or under `/admin` is the
admin surface (§6); everything else is treated as a phone.

### 3.1 Provisioning path (`handleProvisioning`)

Gates run in this order:

| # | Step | Module | On failure |
|---|------|--------|------------|
| 1 | **IP allowlist** — if the `allowed_ips` setting is non-empty, the `CF-Connecting-IP` must match an entry. | `ipallow.ts`, `blocked.ts` | Bare `404` with empty body. One counter row per IP is incremented in `blocked_ips`; **no request-log row is written.** |
| 2 | **Parse** — MAC from `?mac=`, the filename prefix, or the User-Agent; manufacturer/model/firmware from the User-Agent. | `parse.ts` | Fields are null; request is still logged. |
| 3 | **Classify** the path: `/{mac}.cfg` → `mac_cfg`, `/{mac}-zoom.cfg` → `poly_device_cfg`, anything else (including Poly's all-zero `000000000000.cfg` master) → `other`. | `serve.ts` | — |
| 4 | **Load serve context** for the MAC in one query: expected model, presence in `zoom_devices`, and the model's profile, plus the kill switch. | `serve.ts` | D1 error → `404 context-error`, still logged. |
| 5 | **Decide** (pure function, see table below). | `serve.ts` | — |
| 6 | **Log** the request plus the decision (`response_status`, `response_kind`, `response_reason`). | `db.ts` | Logged to console; the phone's response is unaffected. |
| 7 | **Respond** with `Cache-Control: no-store`. | — | — |

### 3.0 The root path is answered first

`GET` or `HEAD` on `/` (and `/index.html`) returns the static landing page from
`pages/splash.ts` with `Cache-Control: public, max-age=3600`, the one deliberate exception to
the no-store rule. It is answered **before** the IP allowlist and is neither written to the
request log nor counted in `blocked_ips`.

That ordering is the whole point of the page. A domain with nothing at its root is left
*Unrated* by URL categorisation services, and corporate web filters block unrated destinations
outright. That is what stopped the first lab phone: a FortiGate answered the phone's HTTPS
request with its own block page, so nothing ever reached Cloudflare. Rating crawlers are never
on the allowlist, so a page behind it could never be rated. Keeping the response unlogged keeps
internet background noise against `/` out of the request log, which is what the allowlist was
added to achieve in the first place.

The page carries no script, no form, no redirect and no encoded payload. A login form or an
obfuscated blob on an unrated domain invites a phishing classification, which is worse than no
rating at all. Every other path, `{mac}.cfg` included, still goes through the allowlist.

### 3.2 Decision table (`decideResponse`)

Evaluated top to bottom; first match wins.

| Condition | Status | `response_kind` | `response_reason` |
|-----------|--------|-----------------|-------------------|
| `PUT` or `POST` (phones uploading logs/overrides) | 200 | `accepted` | `upload` |
| Method other than `GET`/`HEAD` | 404 | `not_found` | `unsupported-method` |
| Path is not `/{mac}.cfg` or `/{mac}-zoom.cfg` | 404 | `not_found` | `unknown-file` |
| Kill switch off (`serving_enabled` ≠ `1`) | 404 | `not_found` | `serving-off` |
| MAC not in `expected_devices` | 404 | `not_found` | `not-expected` |
| MAC not in `zoom_devices` | 404 | `not_found` | `not-in-zoom` |
| Model has no `provisioning_profiles` row | 404 | `not_found` | `no-profile` |
| Profile not enabled | 404 | `not_found` | `profile-disabled` |
| Profile has no Zoom URL | 404 | `not_found` | `no-zoom-url` |
| Profile vendor is `other` | 404 | `not_found` | `vendor-other` |
| Yealink, `{mac}.cfg` | 200 `text/plain` | `redirect` | — |
| Poly, `{mac}.cfg` (master pointing at `{mac}-zoom.cfg`) | 200 `application/xml` | `redirect` | — |
| Poly, `{mac}-zoom.cfg` (device config) | 200 `application/xml` | `redirect` | — |
| Generator threw (malformed stored URL) | 404 | `not_found` | `bad-zoom-url` |

`HEAD` follows the same path but returns an empty body.

### 3.3 What the phone receives

**Yealink** (`src/config/yealink.ts`) — a four-line auto-provision file: sets
`static.auto_provision.server.url` to the Zoom URL and disables DHCP-option and PnP
provisioning so the phone does not come back here on its next boot.

**Poly** (`src/config/poly.ts`) — two files. `{mac}.cfg` is a master `<APPLICATION>` element
whose `CONFIG_FILES` names only `{mac}-zoom.cfg`. That file sets `device.prov.serverType`
to `HTTPS`, `device.prov.serverName` to the Zoom host+path (scheme stripped), and
`device.dhcp.bootSrvUseOpt` to `Static`. XML attribute values are escaped.

Both generators are pure functions of the Zoom URL and are covered by unit tests.

## 4. Modules

| File | Responsibility |
|------|----------------|
| `src/index.ts` | Router. Provisioning handler, admin route table (`"METHOD /path"` → handler), Basic Auth + same-origin + IP gates for `/admin`, `scheduled()` export. |
| `src/serve.ts` | `classifyRequest`, `loadServeContext`, `decideResponse`. The whole "should this phone be redirected" logic; pure where possible. |
| `src/config/yealink.ts`, `src/config/poly.ts` | Config-file generators. |
| `src/parse.ts` | MAC normalisation (`AA:BB:CC:DD:EE:FF`), MAC extraction from path/query/UA, User-Agent → manufacturer/model/firmware for Yealink and Poly. |
| `src/db.ts` | Request-log insert, Zoom credential record, fleet query (`listFleet`), `settings` key/value helpers, `SETTING` key constants, kill-switch read. The fleet query filters out browser and command-line clients by User-Agent (`NON_PHONE_USER_AGENTS`) so a hand-typed config URL never counts as a check-in. |
| `src/zoom.ts` | Zoom Server-to-Server OAuth token exchange, paginated `/phone/devices` fetch (assigned + unassigned), row mapping, mirror replace, `syncZoomDevices` (never throws; records outcome in settings). |
| `src/profiles.ts` | Per-model provisioning profiles: vendor guess from RingCentral model string, HTTPS URL validation (rejects whitespace/control chars), refresh-from-fleet, list, save. |
| `src/auth.ts` | HTTP Basic Auth check with constant-time comparison of both user and password. |
| `src/crypto.ts` | AES-GCM encrypt/decrypt of the Zoom client secret with a 32-byte key; output is base64(iv ‖ ciphertext+tag). |
| `src/ipallow.ts` | IPv4/IPv6/CIDR allowlist parser (one entry per line or comma, `#` comments) and matcher. IPv4-mapped IPv6 is folded to IPv4. Bad lines are reported, good ones kept. |
| `src/blocked.ts` | `blocked_ips` counters; purge of request-log rows from non-allowlisted IPs. |
| `src/console.ts` | Debug console page and its JSON feed (`?after=<id>`), 2-second polling, client-side filter/pause. |
| `src/pages/splash.ts` | The public landing page at `/`. Static, inert, no script or form, no link to `/admin`. |
| `src/pages/layout.ts` | Shared HTML shell, nav, CSS, `escapeHtml`. |
| `src/pages/dashboard.ts`, `zoom.ts`, `profiles.ts`, `settings.ts` | Server-rendered admin pages. No framework, no client bundle. |
| `src/fleet.ts` | Parses the RingCentral `Devices` export (`.xlsx`, read as a zip of XML with `fflate`) into expected-device rows and emits upsert SQL. Used only by `scripts/build-seed.ts`, never at runtime. |
| `src/types.ts` | `Env` binding interface and `ParsedDevice`. |

Guiding rule: `index.ts` wires; every other module is testable without HTTP.

## 5. Data model

All tables live in D1. Migrations are plain SQL under `migrations/` and are applied in order
by `wrangler d1 migrations apply`.

| Table | Created in | Purpose | Key columns |
|-------|-----------|---------|-------------|
| `provisioning_requests` | 0001 (+0003) | Append-only log of every allowed phone request. | `received_at`, `source_ip`, `mac_address`, `manufacturer`, `model`, `firmware`, `http_method`, `path`, `query_string`, `user_agent`, `headers_json`, `response_status`, `response_kind`, `response_reason`. Indexes on `mac_address` and a partial index on `(mac_address, received_at) WHERE response_kind = 'redirect'`. |
| `zoom_s2s_config` | 0001 | Single-row (`id = 1`) Zoom S2S app credentials. | `client_id`, `client_secret_encrypted`, `account_id`, `updated_at`. |
| `expected_devices` | 0002 | The fleet we expect, seeded from the RingCentral export. | `mac_address` (PK), `rc_device_id`, `name`, `extension`, `model`, `rc_status`, `imported_at`. |
| `provisioning_profiles` | 0003 | One row per expected model: how to redirect it. | `model` (PK), `vendor` (`yealink`/`poly`/`other`), `zoom_url`, `enabled`, `updated_at`. |
| `zoom_devices` | 0003 | Read-only mirror of Zoom's phone device list; fully replaced on each sync. | `mac_address` (PK), `zoom_device_id`, `display_name`, `device_type`, `assignee`, `status`, `raw_json`, `synced_at`. |
| `settings` | 0003 | Key/value operational state. | `key` (PK), `value`. |
| `blocked_ips` | 0004 | Counters for requests refused by the provisioning allowlist. | `ip` (PK), `count`, `first_seen`, `last_seen`, `last_path`. |

`settings` keys (`SETTING` in `src/db.ts`):

| Key | Meaning |
|-----|---------|
| `serving_enabled` | Kill switch. Only the string `1` means on; missing row means off. |
| `allowed_ips` | Provisioning allowlist text. Empty/missing = every IP allowed (dashboard shows a warning). |
| `admin_allowed_ips` | Admin allowlist text. Empty/missing = no IP restriction on `/admin`. |
| `last_zoom_sync_at` | ISO timestamp of the last sync attempt. |
| `last_zoom_sync_result` | Human-readable outcome, e.g. `ok: 2 devices mirrored` or `error: HTTP 401`. |

The seed for `expected_devices` is generated locally from `Migrate.xlsx` by
`npm run seed` and applied with `npm run seed:apply`. Both the workbook and the generated
`seed/` directory are gitignored because they contain employee names.

## 6. Admin surface

All routes require Basic Auth (user from the `ADMIN_USER` var, password from the
`ADMIN_PASSWORD` secret). Every admin response carries `Cache-Control: no-store`.

| Route | Page / action |
|-------|---------------|
| `GET /admin` | **Fleet.** One row per expected device plus any unexpected MAC that has checked in. Columns: status (seen / not seen / unexpected), MAC, name, extension, expected model, In Zoom, last redirect, seen-as (UA), firmware, last IP, last seen, check-in count. Header shows serving state and Zoom mirror freshness. Filter via `?status=`. |
| `GET /admin/console` | **Console.** Newest 200 requests with status/kind/reason; polls `/admin/api/requests?after=<id>` every 2 s; click a row for raw UA and headers. |
| `GET /admin/api/requests` | JSON feed backing the console. |
| `GET /admin/zoom` | **Zoom.** Shows whether credentials are saved, last sync time/result, mirror size. |
| `POST /admin/zoom` | Save S2S `clientId` / `clientSecret` / `accountId`. Secret is encrypted before storage. |
| `POST /admin/zoom/sync` | Run a sync now. |
| `GET /admin/profiles` | **Profiles.** One row per model: device count, vendor select, Zoom URL, enabled checkbox. |
| `POST /admin/profiles/refresh` | Insert a disabled profile for any expected model lacking one, vendor guessed from the model string. |
| `POST /admin/profiles` | Save all rows. Rejects any non-HTTPS URL with 400. |
| `GET /admin/settings` | **Settings.** Kill switch, both allowlists, blocked-IP table. |
| `POST /admin/settings` | Save. Re-renders with 400 and the submitted text if any allowlist line is invalid or if the admin allowlist would exclude the caller's own IP. |
| `POST /admin/settings/purge` | Delete request-log rows from IPs outside the provisioning allowlist and reset `blocked_ips`. No-op when the allowlist is empty. |

**Fleet status counts phones only.** The MAC on a request is parsed from the requested filename,
so any client fetching `/{mac}.cfg` is logged against that MAC. Left unfiltered, an admin
spot-checking a URL in a browser would flip that device to *seen* and stamp a *Redirected* time,
quietly corrupting the migration progress view. `listFleet` therefore excludes requests whose
User-Agent matches a known browser or tool (Mozilla, curl, Wget, python, Go-http, and similar).
The exclusion is a denylist rather than a phone allowlist on purpose: a real device whose
User-Agent the parser does not yet recognise still counts as seen, which matters while the exact
Poly format is unconfirmed. A request with no User-Agent is kept for the same reason. The console
and the request log are unaffected and still show every request.

## 7. Security model

Ordered as the code checks them for `/admin`:

1. **Admin IP allowlist** (`admin_allowed_ips`) — checked before anything else; outsiders get
   `403`. The save handler refuses a list that would lock out the person saving it. Recovery
   if that fails anyway: delete the setting row with `wrangler d1 execute`.
2. **Password strength gate** — if `ADMIN_PASSWORD` is unset or shorter than 12 characters
   the whole admin surface returns `503` rather than run with a weak credential.
3. **Basic Auth** — constant-time comparison; both user and password are compared so a wrong
   user does not short-circuit.
4. **Same-origin check on POST** — `Sec-Fetch-Site: same-origin` or a matching `Origin`
   header is required, otherwise `403`. This is the CSRF defence; there are no tokens.

For the provisioning path:

- **Provisioning IP allowlist** (`allowed_ips`) — outsiders get an empty `404` and are only
  counted, never logged, so internet scanners cannot fill the request log.
- Only `CF-Connecting-IP` is trusted for allowlist decisions. `X-Forwarded-For` is used
  solely as a fallback for the *logged* source IP, never for access control.
- The server serves at most two file shapes and never echoes request data into a response.
- `/` is the only path answered to any IP. It is a fixed string of HTML holding no fleet
  data, device identifiers, or personnel names, and it does not advertise the admin surface.

Data at rest:

- The Zoom client secret is AES-GCM encrypted with `ENCRYPTION_KEY` (32 random bytes, base64,
  stored as a Worker secret). The key never enters D1 or the repo.
- The Zoom S2S app is read-only and uses a single device-list scope; a leaked token cannot
  modify the Zoom account.
- `Migrate.xlsx` and `seed/` are gitignored (employee names). Nothing in the repository
  identifies a person or a site.

Headers: every response from the Worker is `Cache-Control: no-store`; admin HTML escapes all
interpolated values; the console embeds JSON with `<` escaped so it cannot break out of its
`<script>` block.

## 8. Scheduled work

`wrangler.toml` declares one cron trigger, `0 * * * *`. The Worker's `scheduled()` handler
runs `syncZoomDevices`: decrypt the stored secret, exchange for an S2S token, page through
assigned and unassigned devices, map rows (skipping any without a MAC), replace the
`zoom_devices` table in a single batch, and record the outcome in `settings`. It never throws;
a failure is visible on `/admin/zoom` as the last sync result.

## 9. Configuration

| Name | Kind | Where set | Notes |
|------|------|-----------|-------|
| `ADMIN_USER` | var | `wrangler.toml` `[vars]` | Defaults to `admin`. |
| `ADMIN_PASSWORD` | secret | `wrangler secret put` | ≥ 12 chars or admin is disabled (503). |
| `ENCRYPTION_KEY` | secret | `wrangler secret put` | 32 bytes, base64. Rotating it invalidates the stored Zoom secret; re-enter it on `/admin/zoom`. |
| `DB` | D1 binding | `wrangler.toml` | Database `phone_provisioning`. |
| Kill switch, allowlists, sync status | D1 `settings` rows | `/admin/settings`, `/admin/zoom` | Runtime-editable, no redeploy. |
| Zoom credentials | D1 `zoom_s2s_config` | `/admin/zoom` | Secret stored encrypted. |
| Per-model Zoom URLs | D1 `provisioning_profiles` | `/admin/profiles` | Runtime-editable. |

Local development reads `ADMIN_PASSWORD` and `ENCRYPTION_KEY` from a gitignored `.dev.vars`.

## 10. Testing

- **Framework:** Vitest with `@cloudflare/vitest-pool-workers`, so tests run inside `workerd`
  against a real (local, in-memory) D1 with the actual bindings from `wrangler.toml`.
- **Schema:** `vitest.config.ts` reads every file in `migrations/` and `test/apply-migrations.ts`
  applies them before each test file, then truncates all application tables between tests.
  A new migration is therefore exercised by the whole suite automatically.
- **Credentials:** test-only `ADMIN_PASSWORD` and `ENCRYPTION_KEY` are injected as Miniflare
  bindings; no real secrets are needed to run the suite.
- **Coverage shape:** one spec file per module (`test/*.spec.ts`), plus `index.spec.ts` for
  end-to-end routing, auth, allowlists, and the serve path via `worker.fetch`.
- **Zoom:** `zoom.spec.ts` injects a fake `fetch`; the suite never talks to Zoom.
- **Static checks:** `npm run typecheck` runs `tsc` with `strict` over `src`, `test`, `scripts`.

Run locally:

```bash
npm ci
npm run typecheck
npm test
```

## 11. Deployment and CI/CD

### 11.1 Model

Work is committed directly to `main`. GitHub Actions runs one workflow, `.github/workflows/ci.yml`:

| Job | Trigger | Steps |
|-----|---------|-------|
| `check` | every push on any branch; every pull request | checkout → Node 22 with npm cache → `npm ci` → `npm run typecheck` → `npm test` |
| `deploy` | push to `main` only, after `check` succeeds | `wrangler d1 migrations apply phone_provisioning --remote` → `wrangler deploy` |

`deploy` runs under `concurrency: production` (one deploy at a time, no cancellation of an
in-flight deploy) and the GitHub environment `production`, so deployments appear in the
repository's Environments tab with a history.

Migrations run before the code deploy so a commit that adds a table never serves against a
database that lacks it. `migrations apply` is idempotent: it only runs files not yet recorded
in D1's `d1_migrations` table, and is a no-op on a code-only commit.

### 11.2 Secrets

Two GitHub repository secrets, used only by the `deploy` job:

| GitHub secret | Value |
|---------------|-------|
| `CLOUDFLARE_API_TOKEN` | API token created from the **Edit Cloudflare Workers** template with **D1 → Edit** added, scoped to the one account and the one zone that carries the custom domain. |
| `CLOUDFLARE_ACCOUNT_ID` | The Cloudflare account ID (Workers & Pages overview, right sidebar). |

The Worker's own secrets (`ADMIN_PASSWORD`, `ENCRYPTION_KEY`) are set once with
`wrangler secret put` and persist across deploys. The pipeline never reads or writes them.

### 11.3 What the pipeline does not do

- No post-deploy smoke test. The provisioning path answers non-allowlisted IPs with an empty
  404 and `/admin` with 403, so a GitHub runner cannot observe anything meaningful.
- No preview environments, no Dependabot, no branch protection. Add when a second contributor
  appears.

### 11.4 Manual deploy (fallback)

```bash
npx wrangler login
npx wrangler d1 migrations apply phone_provisioning --remote
npx wrangler deploy
```

## 12. Operational runbook

| Situation | Action |
|-----------|--------|
| Stop all redirects immediately | `/admin/settings` → untick **Serve** → Save. Every `{mac}.cfg` becomes `404 serving-off` on the next request. |
| A phone isn't redirecting | `/admin/console`, filter by its MAC. The `response_reason` column names the failed gate (§3.2). Click the row for its raw headers and User-Agent. |
| Phone not showing up at all | Its egress IP is probably outside `allowed_ips`: check the **Blocked IPs** table on `/admin/settings`, add the IP/CIDR, Save. |
| Zoom mirror stale or erroring | `/admin/zoom` shows the last result. `HTTP 400/401` = S2S app not activated or wrong account ID; `ok` with 0 devices = MAC field name mismatch, inspect `raw_json` in `zoom_devices`. |
| New model appears in the fleet | `/admin/profiles` → **Refresh models from fleet**, set vendor and Zoom URL, tick enabled, Save all. |
| Lost admin password | `npx wrangler secret put ADMIN_PASSWORD` (≥ 12 chars). Takes effect immediately. |
| Locked out by admin IP allowlist | `npx wrangler d1 execute phone_provisioning --remote --command "DELETE FROM settings WHERE key = 'admin_allowed_ips'"` |
| Scanner noise in the log | Set `allowed_ips`, then `/admin/settings` → **Purge non-allowlisted history**. |
| Re-import the fleet from a new RingCentral export | Replace `Migrate.xlsx`, `npm run seed`, `npm run seed:apply`. Upserts by MAC. |

### Lab-test sequence (before any production DHCP change)

1. Kill switch OFF. `curl -i https://phonehome.cincylab.net/<mac>.cfg` from an allowlisted IP →
   404, console shows `serving-off`.
2. Add the lab phone in Zoom admin → `/admin/zoom` **Sync now** → phone shows **In Zoom** on `/admin`.
3. `/admin/profiles`: paste the model's Zoom assisted-provisioning URL, vendor, enabled, Save all.
4. Switch ON. Same curl → 200 with the redirect body; console shows `redirect`.
5. Point the lab DHCP scope's option 66 (Yealink) / 160 (Poly) at `https://phonehome.cincylab.net`,
   reboot the phone, watch the console: common file → `404 unknown-file`, `{mac}.cfg` →
   `200 redirect`, then silence from that MAC and the phone registering in Zoom.
6. Switch OFF again until the production rollout is scheduled.

## 13. Known open items

- Whether RingCentral-locked phones accept our config without a factory reset.
- Poly tolerance of 404s for `sip.ld` and the shared `000000000000.cfg` master.
- The exact Poly VVX User-Agent format on current UCS firmware (the parser is regex-based
  and may need widening once real phones are observed).
- OBi302 ATAs are classified vendor `other` and are never redirected; they need a separate plan.
