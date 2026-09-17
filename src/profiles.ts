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
  // new URL() silently strips control/whitespace characters (CR, LF, tab, space, etc.) before
  // parsing, so a string containing them could pass validation here yet still carry the raw
  // control characters into storage and, later, into a generated config file. Reject them outright.
  if (/[\s\x00-\x1f]/.test(value)) {
    return false;
  }
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
