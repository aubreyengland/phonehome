/** Persistence for requests refused by the IP allowlist: one counter row per IP, no request log. */

export interface BlockedIpRow {
  ip: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
  lastPath: string | null;
}

export async function recordBlockedIp(db: D1Database, ip: string, path: string, now: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO blocked_ips (ip, count, first_seen, last_seen, last_path) VALUES (?, 1, ?, ?, ?)
       ON CONFLICT(ip) DO UPDATE SET count = count + 1, last_seen = excluded.last_seen, last_path = excluded.last_path`,
    )
    .bind(ip, now, now, path)
    .run();
}

export async function listBlockedIps(db: D1Database, limit = 20): Promise<BlockedIpRow[]> {
  const result = await db
    .prepare(
      `SELECT ip, count, first_seen AS firstSeen, last_seen AS lastSeen, last_path AS lastPath
       FROM blocked_ips ORDER BY count DESC, last_seen DESC LIMIT ?`,
    )
    .bind(limit)
    .all<BlockedIpRow>();
  return result.results;
}

export async function clearBlockedIps(db: D1Database): Promise<void> {
  await db.prepare('DELETE FROM blocked_ips').run();
}

export async function listRequestSourceIps(db: D1Database): Promise<string[]> {
  const result = await db
    .prepare('SELECT DISTINCT source_ip AS ip FROM provisioning_requests WHERE source_ip IS NOT NULL')
    .all<{ ip: string }>();
  return result.results.map((r) => r.ip);
}

/** Deletes request-log rows from the given IPs. Returns the number of rows removed. */
export async function deleteRequestsFromIps(db: D1Database, ips: string[]): Promise<number> {
  if (ips.length === 0) return 0;
  const stmt = db.prepare('DELETE FROM provisioning_requests WHERE source_ip = ?');
  const results = await db.batch(ips.map((ip) => stmt.bind(ip)));
  return results.reduce((n, r) => n + (r.meta?.changes ?? 0), 0);
}
