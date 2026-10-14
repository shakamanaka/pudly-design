import { expect, test } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const enabled = process.env.CODEX_DESIGN_LIVE === '1';

test.skip(!enabled, 'Set CODEX_DESIGN_LIVE=1 to exercise the authenticated Codex CLI.');
test.setTimeout(690_000);

test('a live Codex card supports a selected AI edit and a separate inspector edit', async ({ page }, testInfo) => {
  const created = await page.request.post('/api/project/new', { headers: { origin: 'http://127.0.0.1:5174' }, data: { name: 'Live Codex browser QA' } });
  expect(created.status()).toBe(201);
  await page.goto('/');

  const providerMenu = page.locator('.provider-menu > summary');
  await providerMenu.click();
  const connectionPanel = page.getByRole('region', { name: 'AI connection' });
  await expect(connectionPanel).toBeVisible();
  await page.getByLabel('Provider connection').selectOption('codex-local');
  await page.getByLabel('Model picker').selectOption('__custom__');
  await page.getByLabel('Model ID').fill('gpt-6.1-sol');
  await page.getByLabel('Model effort').selectOption('low');
  await page.getByRole('button', { name: 'Test connection', exact: true }).click();
  await expect(connectionPanel.locator('.provider-panel__hint[role="status"]')).toContainText('This model and effort are verified for this connection.', { timeout: 45_000 });
  await expect(connectionPanel.locator('.provider-panel__status')).toHaveText('Verified');
  await providerMenu.click();

  const runResponse = () => page.waitForResponse((response) =>
    response.request().method() === 'POST' && response.url().endsWith('/api/runs'),
  );
  const prompt = page.getByRole('textbox', { name: 'Describe a design or edit' });
  await prompt.fill(
    'Create a compact card for Harvest, an agricultural operations app, with a polished onboarding style. Include a frame, the exact title “Welcome to Harvest”, a short supporting sentence, and a clear primary action.',
  );
  const initialRunResponse = runResponse();
  await page.getByRole('button', { name: 'Generate design' }).click();
  const initialRunId = (await (await initialRunResponse).json() as { runId: string }).runId;

  // A committed document alone is not enough: the UI must acknowledge that
  // the committed revision rendered and passed its post-render QA state.
  await expect(page.locator('.run-sidebar__state')).toHaveText('Design saved', { timeout: 310_000 });
  const initialRevision = await page.locator('.revision-pill').textContent();
  expect(initialRevision).toMatch(/^v\d+$/);

  const renderedNodes = page.locator('.canvas-node[data-node-id]');
  await expect(renderedNodes.first()).toBeVisible({ timeout: 15_000 });
  expect(await renderedNodes.count()).toBeGreaterThanOrEqual(3);
  const ids = await renderedNodes.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-node-id')));
  expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true);
  expect(new Set(ids).size).toBe(ids.length);

  const title = page.locator('.canvas-node[data-node-kind="text"]').filter({ hasText: 'Welcome to Harvest' }).first();
  await expect(title).toBeVisible();
  await expect(title).toBeInViewport();
  const titleId = await title.getAttribute('data-node-id');
  expect(titleId).toBeTruthy();
  await title.press('Enter');
  await expect(title).toHaveAttribute('aria-pressed', 'true');

  // This second prompt is a real Codex request scoped to the selected stable
  // node ID; verify the document revision advances and the node identity stays.
  const selectedEdit = 'Change selected title to Harvest starts here';
  await prompt.fill(selectedEdit);
  const selectedEditResponse = runResponse();
  await page.getByRole('button', { name: 'Generate design' }).click();
  const selectedEditRunId = (await (await selectedEditResponse).json() as { runId: string }).runId;
  await expect(page.locator('.run-sidebar__request')).toHaveText(selectedEdit);
  await expect(page.locator('.run-sidebar__state')).toHaveText('Design saved', { timeout: 310_000 });
  const aiRevision = Number((await page.locator('.revision-pill').textContent())?.slice(1));
  expect(aiRevision).toBe(Number(initialRevision?.slice(1)) + 1);
  const aiEditedTitle = page.locator(`.canvas-node[data-node-id="${titleId}"]`);
  await expect(aiEditedTitle).toContainText('Harvest starts here');
  await expect(aiEditedTitle).toHaveAttribute('aria-pressed', 'true');

  // Apply another edit directly through the inspector to distinguish the
  // semantic-operation path from the agent path.
  const titleEditor = page.getByRole('textbox', { name: 'Text content' });
  await titleEditor.fill('Harvest starts here!');
  await titleEditor.press('Tab');
  await expect(aiEditedTitle).toContainText('Harvest starts here!');
  await expect(page.locator('.revision-pill')).toHaveText(`v${aiRevision + 1}`);

  await page.reload();
  await expect(page.locator(`.canvas-node[data-node-id="${titleId}"]`)).toContainText('Harvest starts here!');
  await expect(page.locator(`.canvas-node[data-node-id="${titleId}"]`)).toBeInViewport();

  // Attach inspectable evidence from the actual service and rendered UI.
  const evidenceDirectory = join(process.cwd(), '.codex-design', 'evidence', 'live-browser');
  await mkdir(evidenceDirectory, { recursive: true });
  const screenshot = await page.screenshot({ fullPage: true });
  await writeFile(join(evidenceDirectory, 'final.png'), screenshot);
  await testInfo.attach('live-codex-final.png', { body: screenshot, contentType: 'image/png' });
  for (const [name, runId] of [['initial', initialRunId], ['selected-title-edit', selectedEditRunId]] as const) {
    const response = await page.request.get(`http://127.0.0.1:5174/api/runs/${encodeURIComponent(runId)}`);
    expect(response.ok()).toBe(true);
    const runResult = await response.json() as { run: { providerSelection?: Record<string, unknown> } };
    expect(runResult.run.providerSelection).toMatchObject({
      providerId: 'codex',
      connectionId: 'codex-local',
      modelId: 'gpt-6.1-sol',
      effort: 'low',
      verificationStatus: 'verified',
      policy: 'manual',
    });
    const body = Buffer.from(JSON.stringify(runResult, null, 2));
    await writeFile(join(evidenceDirectory, `${name}-run.json`), body);
    await testInfo.attach(`live-codex-${name}-run.json`, { body, contentType: 'application/json' });
  }
  const projectResponse = await page.request.get('http://127.0.0.1:5174/api/project');
  const projectBody = Buffer.from(JSON.stringify(await projectResponse.json(), null, 2));
  await writeFile(join(evidenceDirectory, 'final-project.json'), projectBody);
  await testInfo.attach('live-codex-final-project.json', { body: projectBody, contentType: 'application/json' });
});
