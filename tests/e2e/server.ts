import { resolve } from 'node:path';
import { startServer } from '../../server/index';
import { createBrowserProviderFixture } from '../provider-qa/fixtures/browser-provider';

const dataRoot = process.env.CODEX_DESIGN_E2E_DATA_ROOT;
if (!dataRoot) throw new Error('Browser server requires isolated test storage.');
const liveCodexMode = process.env.CODEX_DESIGN_LIVE === '1';
const fixtureMode = !liveCodexMode && process.env.CODEX_DESIGN_PROVIDER_FIXTURE !== '0';
const providers = fixtureMode ? await createBrowserProviderFixture(resolve(dataRoot, 'provider-fixture')) : undefined;
await startServer({ ...(providers ? { providers } : {}), dataDirectory: resolve(dataRoot, 'projects'), staticDirectory: resolve(process.cwd(), 'dist') });
