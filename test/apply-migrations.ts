import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeEach } from 'vitest';

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

// This pool version has no per-test storage isolation, so wipe every app table
// before each test. Schema (from migrations/) is left intact.
const tables = await env.DB.prepare(
  `SELECT name FROM sqlite_master
   WHERE type = 'table' AND name NOT IN ('d1_migrations', 'sqlite_sequence') AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*'`,
).all<{ name: string }>();

beforeEach(async () => {
  await env.DB.batch(tables.results.map((t) => env.DB.prepare(`DELETE FROM "${t.name}"`)));
});
