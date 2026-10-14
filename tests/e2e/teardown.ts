import { rm } from 'node:fs/promises';

export default async function teardown(): Promise<void> {
  const root = process.env.CODEX_DESIGN_E2E_DATA_ROOT;
  if (root?.startsWith('/')) await rm(root, { recursive: true, force: true });
}
