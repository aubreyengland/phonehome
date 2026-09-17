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
  // Zoom's device list can legitimately contain the same MAC twice (e.g. a shared/duplicate
  // entry across the assigned and unassigned pages); OR REPLACE keeps the sync from throwing
  // and just lets the later row in the batch win, rather than corrupting the whole sync.
  const insert = db.prepare(
    `INSERT OR REPLACE INTO zoom_devices (mac_address, zoom_device_id, display_name, device_type, assignee, status, raw_json, synced_at)
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
  try {
    await setSetting(env.DB, SETTING.lastZoomSyncAt, now);
    await setSetting(env.DB, SETTING.lastZoomSyncResult, result.message);
  } catch (error) {
    // Recording the sync outcome is best-effort: this function must never throw, even if D1
    // is unavailable for the setting write itself.
    console.error('failed to record zoom sync result', error);
  }
  return result;
}
