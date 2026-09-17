// Usage: node scripts/build-seed.ts [Migrate.xlsx] [seed/expected_devices.sql]
// Then:  npx wrangler d1 execute phone_provisioning --remote --file seed/expected_devices.sql
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildSeedSql, parseMigrateWorkbook } from '../src/fleet.ts';

const [input = 'Migrate.xlsx', output = 'seed/expected_devices.sql'] = process.argv.slice(2);

const devices = parseMigrateWorkbook(new Uint8Array(readFileSync(input)));
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, buildSeedSql(devices, new Date().toISOString()));

const byModel = new Map<string, number>();
for (const d of devices) byModel.set(d.model ?? '(no model)', (byModel.get(d.model ?? '(no model)') ?? 0) + 1);
console.log(`${devices.length} expected devices -> ${output}`);
for (const [model, n] of [...byModel].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${model}`);
