import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

// The local service stores projects relative to its working directory. Give
// every Playwright invocation a disposable root so browser tests never open
// or mutate a user's normal project store.
const isolatedDataRoot = mkdtempSync(join(tmpdir(), 'codex-design-e2e-'));
process.env.CODEX_DESIGN_E2E_DATA_ROOT = isolatedDataRoot;
const repositoryRoot = process.cwd();
const tsxCli = resolve(repositoryRoot, 'node_modules/tsx/dist/cli.mjs');
const serverEntry = resolve(repositoryRoot, 'tests/e2e/server.ts');
const liveCodexMode = process.env.CODEX_DESIGN_LIVE === '1';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://127.0.0.1:5174',
    trace: 'retain-on-failure',
    video: 'on',
    ...devices['Desktop Chrome'],
  },
  webServer: {
    command: `node "${tsxCli}" "${serverEntry}"`,
    url: 'http://127.0.0.1:5174/api/capabilities',
    reuseExistingServer: false,
    cwd: repositoryRoot,
    timeout: 30_000,
    env: {
      CODEX_DESIGN_E2E_DATA_ROOT: isolatedDataRoot,
      CODEX_DESIGN_LIVE: liveCodexMode ? '1' : '0',
      CODEX_DESIGN_PROVIDER_FIXTURE: liveCodexMode ? '0' : '1',
    },
  },
  globalTeardown: './tests/e2e/teardown.ts',
});
