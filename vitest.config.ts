import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';
import path from 'node:path';

const migrations = await readD1Migrations(path.join(import.meta.dirname, 'migrations'));

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.toml' },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: migrations,
          // Test-only credentials; real deploys use `wrangler secret put` (see plan Task 15).
          ADMIN_PASSWORD: 'secret',
          ENCRYPTION_KEY: 'l7GJ2Q6f1n9mYkX3wZ4pC8dT5rV0sB1eH2iJ6kL9mN0=',
        },
      },
    }),
  ],
  test: {
    setupFiles: ['./test/apply-migrations.ts'],
  },
});
