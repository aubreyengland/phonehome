# Zoom Redirect Provisioning — Phase 2 Design Spec

**Date:** 2026-09-17
**Status:** Approved for implementation
**Builds on:** `2026-09-16-phone-provisioning-inventory-design.md` (Phase 1, deployed at
`https://phonehome.cincylab.net`)

## Problem

Phase 1 captures check-ins and answers every request with an inert `200`. It knows the
expected fleet (423 MACs from the RingCentral export) but does nothing for a phone.

The migration goal: each desk phone gets its DHCP provisioning option (Yealink option 66,
Poly option 160/66) pointed at this server. The phone checks in, this server answers with a
tiny vendor config file that sets the phone's provisioning server to Zoom's model-specific
assisted-provisioning URL, and the phone re-homes to Zoom. No factory reset, no per-phone
manual URL entry, no touching Yealink RPS / Poly ZTP (still owned by RingCentral).

Three things are needed to do that safely:

1. **Serve config per MAC** — only to phones that are expected, already exist in Zoom, and
   whose model has a Zoom URL configured; with a global kill switch.
2. **Read-only Zoom sync** — mirror Zoom's device list so "exists in Zoom" is a local lookup.
3. **Debug console** — near-real-time view of every request and what was answered, for lab
   testing and troubleshooting on the day.

Plus: the Zoom S2S credential form moves off the fleet dashboard onto its own admin page.

## Non-goals

- Adding devices to Zoom (done by hand in Zoom admin; the S2S app stays read-only).
- Assigning phones to users/extensions in Zoom.
- Touching Yealink RPS, Poly ZTP, or any RingCentral API.
- Serving anything but the redirect file: no firmware, no full config, no directories.
- Push-based (SSE/WebSocket) console. Polling is enough.

## Architecture

Same single Cloudflare Worker + D1, same free plan. New modules:

```
src/
  serve.ts        # decision: request path + tables + settings -> what to answer
  config/
    yealink.ts    # {mac}.cfg text generator
    poly.ts       # {mac}.cfg master XML + {mac}-zoom.cfg generator
  zoom.ts         # S2S token exchange + paginated device list (read-only)
  console.ts      # /admin/console page + /admin/api/requests JSON
  pages/          # admin HTML renderers split per page (dashboard, zoom, profiles, settings)
```

`index.ts` stays a router. A `scheduled()` export runs the hourly Zoom sync via a cron
trigger in `wrangler.toml` (`crons = ["0 * * * *"]`).

## 1. Provisioning endpoint

Every non-`/admin` request is still logged in full (Phase 1 guarantee unchanged). The
response is decided by `serve.ts`:

| Request | Condition | Response |
|---|---|---|
| `GET /{mac}.cfg` | MAC in `expected_devices` **and** in `zoom_devices` **and** its model's profile is `enabled` with a `zoom_url` **and** `serving_enabled = 1` | vendor redirect file, `200` |
| `GET /{mac}-zoom.cfg` (Poly second file) | same condition | Poly device config, `200` |
| `GET /{mac}.cfg`, any condition false | | `404`, empty |
| Any other `GET` (`y000000000065.cfg`, `000000000000.cfg`, `{mac}-phone.cfg`, …) | | `404`, empty |
| `PUT` / `POST` (Poly override uploads, logs) | | `200`, empty — accepted and discarded |

Change from Phase 1: unknown files get `404` instead of empty `200`. Both vendors treat a
missing optional file as "skip and continue"; the lab run confirms this on real phones
before any production DHCP change.

Every logged row gains `response_status` (int) and `response_kind`
(`redirect` | `not_found` | `accepted`). The decision reason (e.g. `not-in-zoom`,
`profile-disabled`, `serving-off`) is stored in `response_reason` so the console can say
*why* a phone got a 404.

MAC extraction is unchanged; the vendor for the file format comes from the device's profile
(`vendor` column), not from the User-Agent, so an odd UA cannot produce the wrong format.

## 2. Vendor config generators

Pure functions: `(mac, profile) -> { body, contentType }`. Unit-tested against exact
expected strings.

**Yealink** — `{mac}.cfg`, `text/plain`:

```
#!version:1.0.0.1
static.auto_provision.server.url = <zoom_url>
static.auto_provision.dhcp_option.enable = 0
static.auto_provision.pnp_enable = 0
```

Disabling DHCP-option and PnP lookups is required: otherwise the next boot asks DHCP again,
lands back here, and loops. After this file applies, the phone's stored server is Zoom's.

**Poly** — `{mac}.cfg`, `application/xml`, master config that references one file:

```xml
<?xml version="1.0" standalone="yes"?>
<APPLICATION APP_FILE_PATH="sip.ld" CONFIG_FILES="{mac}-zoom.cfg" MISC_FILES=""
  LOG_FILE_DIRECTORY="" OVERRIDES_DIRECTORY="" CONTACTS_DIRECTORY="" LICENSE_DIRECTORY=""
  USER_PROFILES_DIRECTORY="" CALL_LISTS_DIRECTORY="" COREFILE_DIRECTORY=""/>
```

`{mac}-zoom.cfg`, `application/xml`:

```xml
<?xml version="1.0" encoding="utf-8" standalone="yes"?>
<polycomConfig>
  <device device.set="1"
    device.prov.serverType.set="1" device.prov.serverType="HTTPS"
    device.prov.serverName.set="1" device.prov.serverName="<zoom host+path, no scheme>"
    device.dhcp.bootSrvUseOpt.set="1" device.dhcp.bootSrvUseOpt="Static"/>
</polycomConfig>
```

`{mac}` in file names is lowercase, no separators, as the phones request it.

## 3. Data model (migration `0003_phase2.sql`)

```
provisioning_profiles          -- one row per distinct expected_devices.model
  model        TEXT PRIMARY KEY   -- exact xlsx string, e.g. "Yealink T48S"
  vendor       TEXT NOT NULL      -- 'yealink' | 'poly' | 'other'; seeded from the model string
  zoom_url     TEXT               -- pasted from Zoom admin; NULL = not configured
  enabled      INTEGER NOT NULL DEFAULT 0
  updated_at   TEXT NOT NULL

zoom_devices                   -- mirror of GET /phone/devices; replaced wholesale per sync
  mac_address     TEXT PRIMARY KEY   -- normalized AA:BB:CC:DD:EE:FF
  zoom_device_id  TEXT NOT NULL
  display_name    TEXT
  device_type     TEXT
  assignee        TEXT               -- display name / extension as Zoom returns it, JSON if object
  status          TEXT
  raw_json        TEXT NOT NULL      -- the device object as Zoom returned it (field names unverified)
  synced_at       TEXT NOT NULL

settings                       -- key/value
  key   TEXT PRIMARY KEY          -- serving_enabled ('0'|'1'), last_zoom_sync_at,
  value TEXT NOT NULL             -- last_zoom_sync_result ('ok: N devices' | 'error: …')

provisioning_requests  + response_status INTEGER, response_kind TEXT, response_reason TEXT
```

`provisioning_profiles` rows are created by a "Refresh models" action on the profiles
page (inserts any `expected_devices.model` not yet present, vendor guessed from the string:
`Yealink*` → yealink, `Polycom VVX*` / `Polycom IP*` → poly, else other). Nothing to type but
URLs. The fleet view gains **In Zoom** and **Redirected** (last `redirect` timestamp).

## 4. Zoom client (read-only)

`zoom.ts` exposes `syncZoomDevices(env): Promise<SyncResult>`:

1. Load S2S config, decrypt the client secret with the Phase 1 crypto helper.
2. `POST https://zoom.us/oauth/token` with `grant_type=account_credentials&account_id=…`
   and `Authorization: Basic base64(clientId:clientSecret)`. Token is used once per sync,
   never stored.
3. `GET https://api.zoom.us/v2/phone/devices?type=assigned&page_size=100` and the same with
   `type=unassigned`, following `next_page_token` until empty.
4. Normalize each device's MAC with `normalizeMac`; skip devices without a parseable MAC.
5. Replace `zoom_devices` in one D1 batch (`DELETE` + inserts) so a failed sync never leaves
   a half-empty mirror — on any error the previous mirror stays.
6. Write `last_zoom_sync_at` / `last_zoom_sync_result` to `settings`.

Scope required: `phone:read:list_devices:admin` only. Triggered by the **Sync now** button
(`POST /admin/zoom/sync`) and the hourly cron. Failures are recorded, shown on the Zoom page,
and never surface to a phone.

## 5. Admin pages

All `/admin*` routes share one Basic Auth check and `Cache-Control: no-store`.

- `/admin` — fleet dashboard. Existing table plus In Zoom / Redirected columns; header shows
  kill-switch state and last Zoom sync.
- `/admin/console` — debug console. Last 200 requests newest-first; the page polls
  `GET /admin/api/requests?after=<id>` every 2 s and prepends new rows; pause button; filter
  box (client-side) for MAC / path / UA / reason; clicking a row expands raw `headers_json`
  and the response kind + reason. Serving a request logs before responding, so rows appear
  in order.
- `/admin/zoom` — S2S credentials form (moved from `/admin`), Sync now button, last sync
  time and result, mirrored device count.
- `/admin/profiles` — one form: rows of model / count / vendor select / Zoom URL / enabled.
  "Refresh models" button.
- `/admin/settings` — the `serving_enabled` kill switch. Off = every `{mac}.cfg` is 404.

Plain HTML forms, minimal inline CSS as in Phase 1, no framework. Console polling is the
only JavaScript.

## 6. Operational flow (per model, lab first)

1. Add one lab phone in Zoom admin. Click Sync now; confirm it shows In Zoom.
2. Paste that model's Zoom provisioning URL on `/admin/profiles`, enable it.
3. Turn `serving_enabled` on.
4. Set the lab phone's DHCP option (or a lab DHCP scope) to `https://phonehome.cincylab.net`,
   reboot, watch `/admin/console`.
5. Confirm the phone registers with Zoom. Repeat with the other vendor.
6. Only then roll the DHCP option to production scopes.

## Open items (settled only by the lab phones)

- Whether a RingCentral-configured phone accepts an unsigned/unencrypted config from a new
  server (Yealink `static.auto_provision.custom.protect`, Poly config encryption) without a
  factory reset. If not, Phase 2 falls back to a reset-based flow — out of scope here.
- Whether the phone re-provisions against Zoom immediately after applying the redirect or
  only on the next reboot.
- Whether RC's config disabled DHCP-option lookup on Yealink (`dhcp_option.enable = 0`),
  which would mean the phone never contacts this server at all.
- Exact Poly User-Agent format (carried over from Phase 1).
- `404` tolerance for the common files on each vendor (carried over).

## Testing

- **Unit:** generators (exact string match), `decideResponse()` for every row of the table in
  section 1, Zoom client against a stubbed `fetch` (token, pagination, MAC normalization,
  error leaves mirror intact), profile vendor guessing.
- **Integration (existing pool):** `GET /{mac}.cfg` with expected + zoom + profile + switch
  → redirect body and `response_kind = redirect` logged; each condition removed → 404 with
  the matching `response_reason`; PUT → 200 `accepted`; `/admin/api/requests?after=` returns
  only newer rows; sync endpoint updates `zoom_devices` and settings.
- **Lab:** section 6.

## Cost

Unchanged. Console polling at 2 s ≈ 1,800 req/hour while open; hourly cron is 24 req/day.
Both trivial against 100k/day.
