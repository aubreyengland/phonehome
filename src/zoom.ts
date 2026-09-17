export async function countZoomDevices(db: D1Database): Promise<number> {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM zoom_devices').first<{ n: number }>();
  return row?.n ?? 0;
}
