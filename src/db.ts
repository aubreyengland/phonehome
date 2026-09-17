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
