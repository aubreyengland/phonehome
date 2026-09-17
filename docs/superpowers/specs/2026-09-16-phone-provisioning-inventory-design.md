# Phone Provisioning Inventory Server — Design Spec

**Date:** 2026-09-16
**Status:** Approved for implementation (Phase 1)

## Problem

Migrating a desk phone fleet from RingCentral to Zoom Phone without factory-resetting
devices. Target hardware: Yealink T48U / T48S, Poly VVX 411 / VVX 311. These phones are
currently pointed at RingCentral's provisioning server via each vendor's cloud redirect
service (Yealink RPS, Poly ZTP), keyed by MAC address.

Phase 1 goal: stand up a server that vendor redirect services can point a *test group* of
phones at, capture every incoming provisioning check-in, and identify the device (MAC,
model, firmware, manufacturer, source IP) — without yet serving real config or touching
Zoom's API. This builds the inventory and request-format knowledge needed before deciding
how phase 2 (actual cutover) works.

## Non-goals (Phase 1)

- Not generating real Yealink/Poly provisioning config files.
- Not calling Zoom's API (S2S credentials are accepted and stored, not used yet).
- Not rolling out to the production fleet — lab/test MACs only.

## Architecture

Cloudflare Worker (TypeScript), backed by D1 (Cloudflare's SQLite-compatible managed DB).
Domain is already on Cloudflare, and this is a one-time ~300-phone migration — plain
Workers (no Containers tier) fits entirely inside the free plan (100k requests/day),
avoiding the $5/mo Workers Paid + container billing that a containerized FastAPI service
would require. TLS/HTTPS is handled automatically by Cloudflare for any route on the zone.

### Components

1. **Provisioning capture endpoint** — Worker `fetch` handler matches every path (catch-all).
   Yealink and Poly phones request oddly-shaped filenames during their boot/provisioning
   sequence (`{MAC}.cfg`, model-specific cfg, common cfg, etc.) — a catch-all avoids having
   to pre-enumerate every filename pattern either vendor might request.

   Per request, extract and persist:
   - `source_ip` (respect `X-Forwarded-For` if behind a load balancer/proxy)
   - `manufacturer`, `model`, `firmware` — parsed primarily from the `User-Agent` header,
     which both Yealink and Poly embed model/firmware info into. **Exact format is
     unconfirmed against real devices** — see Open Items.
   - `mac_address` — best-effort extraction from path, query string, or User-Agent,
     normalized to a consistent format (uppercase, colon-delimited) when found.
   - Full raw request data: HTTP method, path, query string, all headers as JSON.
     Keeping raw data means parsing logic can be improved retroactively without needing
     to re-capture from physical devices.

   Response: `200 OK`, empty body, `Content-Type: text/plain`. This is a deliberately
   inert response — the phone receives no new configuration and simply retries on its
   normal polling interval, which is safe for a lab test group. Vendor-specific tolerance
   for `200` vs `404` vs other codes is unconfirmed — first lab run settles it.

2. **Admin dashboard** — single Worker-rendered HTML page listing captured devices: most
   recent check-in per MAC, check-in count, manufacturer/model/firmware/IP, with basic
   filtering. Protected by HTTP Basic Auth (credentials from a Worker secret via
   `wrangler secret put`) — this route is the only one that needs protecting, since the
   provisioning endpoint has to stay open for unauthenticated phone check-ins.

3. **Zoom S2S credential intake** — a settings form on the (protected) admin dashboard to
   accept and store a Zoom Server-to-Server OAuth app's Client ID, Client Secret, and
   Account ID. Secret is encrypted at rest using the Worker runtime's Web Crypto API
   (AES-GCM), with the encryption key held as a Worker secret, never committed. No token
   exchange or Zoom API calls happen in Phase 1 — this only makes the credentials
   available and ready for Phase 2.

### Data model

```
provisioning_requests
  id                INTEGER PRIMARY KEY
  received_at       TIMESTAMP
  source_ip         TEXT
  manufacturer      TEXT NULL
  model             TEXT NULL
  firmware          TEXT NULL
  mac_address       TEXT NULL
  http_method       TEXT
  path              TEXT
  query_string      TEXT
  user_agent        TEXT
  headers_json      TEXT   -- full raw headers, JSON-encoded

zoom_s2s_config
  id                     INTEGER PRIMARY KEY
  client_id              TEXT
  client_secret_encrypted TEXT
  account_id             TEXT
  updated_at             TIMESTAMP
```

Dashboard's device list is a query grouping `provisioning_requests` by `mac_address`,
taking the most recent row per group plus a count.

## Open items (known unknowns, not guessed)

- **Exact Yealink RPS / Poly ZTP check-in request shape** (headers, path conventions,
  User-Agent string format) is not confirmed. First implementation task is: point one
  lab phone per vendor at the deployed server via RPS/ZTP, capture the raw request
  (already persisted via `headers_json`/`path`/`user_agent` regardless of whether parsing
  succeeds), then write the manufacturer/model/firmware/MAC parser against real captured
  data — not assumed formats.
- Response code tolerance (`200` vs `404`) for each vendor when no real config is served —
  determined empirically during lab testing, adjust if a phone shows a provisioning error
  on-screen or retries abnormally fast.

## Deployment

Deployed as a Cloudflare Worker via `wrangler deploy`, bound to a subdomain on the
existing Cloudflare-managed zone (e.g. `provision.<domain>`) with a D1 database binding.
No Containers tier, no separate TLS/cert management, no idle cost — fits the free Workers
plan for this request volume.

## Testing plan

1. Deploy server, confirm catch-all endpoint responds `200` to a manual `curl`.
2. Register 1 test MAC per vendor (Yealink T48U or T48S; Poly VVX 411 or VVX 311) in
   RPS/ZTP pointing at the deployed URL.
3. Reboot/trigger re-provisioning check on each test phone, confirm a row lands in
   `provisioning_requests` with the raw headers/path captured.
4. Write parsers for manufacturer/model/firmware/MAC extraction against the captured raw
   data; confirm parsed fields populate correctly on a second check-in.
5. Verify dashboard renders the device list and Zoom S2S settings form saves/encrypts
   correctly (round-trip: save, restart app, confirm secret decrypts back to original).

## Cost

Free Cloudflare Workers plan: 100k requests/day, D1 included on same plan. ~300 phones
doing a handful of boot-sequence check-ins each during a one-time lab test is nowhere
near that limit — expected cost: $0. Revisit only if this grows past a one-time migration
into an ongoing service.

## Phase 2 (not in scope now)

Once inventory + request-format knowledge exists: decide whether to (a) redirect
identified phones to Zoom's own provisioning cloud via the Zoom S2S-authenticated Devices
API, or (b) generate vendor config files directly. That decision explicitly deferred to
after Phase 1 data is in hand.

## Addendum (2026-09-17): Expected fleet import

RingCentral's device export (`Migrate.xlsx`, sheet `Devices`, columns `Action, Device ID,
Name, Extension Number, Type, Model, Serial/MAC, Status`) lists the whole fleet expected to
migrate. Phase 1 imports it so the dashboard can show **seen vs. not-yet-seen vs.
unexpected** per MAC instead of only what has checked in.

Fleet composition (hard phones with a valid 12-hex MAC in `Serial/MAC`):

| Model                            | Rows | With MAC |
|----------------------------------|-----:|---------:|
| Yealink T48S                     |  310 |      308 |
| Yealink T48U                     |   41 |       41 |
| Polycom OBi302 (ATA)             |   35 |       35 |
| Polycom VVX411                   |   26 |       26 |
| Cisco SPA-122 / 191 ATA          |   34 |        0 |
| Polycom VVX450                   |    5 |        5 |
| Polycom IP 5000 / 6000           |    5 |        5 |
| Polycom VVX311                   |    3 |        3 |

Only `Type = HardPhone` rows with a valid MAC are imported (425). Softphones, paging, and
Cisco ATAs (serials, not MACs) are skipped. Models outside the Phase 1 target hardware
(VVX450, conference phones, OBi302) are imported as-is; the dashboard shows the expected
model so they are easy to filter out later.

### Component 4: fleet seed script

`scripts/build-seed.ts` (run with `node`, no build step) parses the xlsx with `fflate`
and emits `seed/expected_devices.sql` — one upsert per device. Applied with
`wrangler d1 execute phone_provisioning --remote --file seed/expected_devices.sql`.
Parsing lives in `src/fleet.ts` so it is unit-tested like everything else; the script is
a thin file-IO wrapper. The Worker itself never parses xlsx (free-plan CPU limit).

`Migrate.xlsx` and `seed/` are gitignored — they contain employee names.

### Data model addition

```
expected_devices
  mac_address   TEXT PRIMARY KEY   -- normalized AA:BB:CC:DD:EE:FF
  rc_device_id  TEXT
  name          TEXT NOT NULL
  extension     TEXT
  model         TEXT
  rc_status     TEXT               -- Online/Offline as exported
  imported_at   TEXT NOT NULL
```

### Dashboard change

Device list becomes a fleet view: `expected_devices` LEFT JOIN latest check-in per MAC,
plus check-ins whose MAC is not in the expected list (`unexpected`). Summary counts
(expected / seen / not seen / unexpected) at the top; `?status=` query filter.
