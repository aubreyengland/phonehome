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
const ALL_ZERO_MAC = '00:00:00:00:00:00';

/**
 * Only two paths are ever served: `/{mac}.cfg` and `/{mac}-zoom.cfg`, at the root.
 * `000000000000.cfg` is a Poly shared master file, not a device — see `parse.ts`.
 */
export function classifyRequest(pathname: string): RequestFile {
  const match = pathname.match(MAC_CFG_RE);
  const mac = match ? normalizeMac(match[1]!) : null;
  if (!match || !mac || mac === ALL_ZERO_MAC) {
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
