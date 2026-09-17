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

export type FleetStatus = 'seen' | 'not-seen' | 'unexpected';

/** One row of the dashboard: an expected device, a seen device, or both. */
export interface FleetRow {
  macAddress: string;
  status: FleetStatus;
  expectedName: string | null;
  expectedExtension: string | null;
  expectedModel: string | null;
  rcStatus: string | null;
  manufacturer: string | null;
  model: string | null;
  firmware: string | null;
  sourceIp: string | null;
  lastSeenAt: string | null;
  checkInCount: number;
}

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
       )
       SELECT * FROM (
       SELECT e.mac_address AS macAddress,
              CASE WHEN l.mac_address IS NULL THEN 'not-seen' ELSE 'seen' END AS status,
              e.name AS expectedName,
              e.extension AS expectedExtension,
              e.model AS expectedModel,
              e.rc_status AS rcStatus,
              l.manufacturer AS manufacturer,
              l.model AS model,
              l.firmware AS firmware,
              l.source_ip AS sourceIp,
              l.received_at AS lastSeenAt,
              COALESCE(l.check_in_count, 0) AS checkInCount
       FROM expected_devices e
       LEFT JOIN latest l ON l.mac_address = e.mac_address
       UNION ALL
       SELECT l.mac_address, 'unexpected', NULL, NULL, NULL, NULL,
              l.manufacturer, l.model, l.firmware, l.source_ip, l.received_at, l.check_in_count
       FROM latest l
       LEFT JOIN expected_devices e ON e.mac_address = l.mac_address
       WHERE e.mac_address IS NULL
       )
       ORDER BY lastSeenAt DESC NULLS LAST, expectedName`,
    )
    .all<FleetRow>();
  return result.results;
}
