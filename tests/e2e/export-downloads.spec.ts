import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { strFromU8, unzipSync } from 'fflate';

test('all three exports download actual artifacts and adapter failure stays actionable', async ({ page }) => {
  const created = await page.request.post('/api/project/new', { headers: { origin: 'http://127.0.0.1:5174' }, data: { name: 'Export browser QA' } });
  expect(created.status()).toBe(201);
  await page.goto('/');
  await page.getByRole('button', { name: 'Text', exact: true }).click();
  const textNode = page.locator('.canvas-node[data-node-kind="text"]');
  await expect(textNode).toHaveCount(1);
  await textNode.press('Enter');
  const content = page.getByRole('textbox', { name: 'Text content' });
  await content.fill('Portable browser export');
  await content.press('Tab');
  await expect(textNode).toContainText('Portable browser export');
  const before = (await (await page.request.get('/api/project')).json()).project;

  for (const label of ['Native', 'Vue', 'Figma plugin']) {
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: label, exact: true }).click();
    const download = await downloadPromise;
    expect(await download.failure()).toBeNull();
    const path = await download.path();
    expect(path).not.toBeNull();
    const bytes = await readFile(path!);
    if (label === 'Native') {
      expect(JSON.parse(bytes.toString())).toEqual(before.document);
      await expect(page.locator('.export-result')).toContainText('NATIVE export · succeeded');
    } else {
      const files = unzipSync(bytes);
      const report = JSON.parse(strFromU8(files['fidelity-report.json']!));
      expect(report.target).toBe(label === 'Vue' ? 'vue' : 'figma');
      const hasLimits = report.fidelity.some((entry: { status: string }) => entry.status !== 'preserved');
      expect(report.status).toBe(hasLimits ? 'partial' : 'succeeded');
      if (label === 'Figma plugin') expect(hasLimits).toBe(true);
      expect(JSON.parse(strFromU8(files[label === 'Vue' ? 'src/design-document.json' : 'design-document.json']!))).toEqual(before.document);
      if (label === 'Vue') {
        expect(files['src/App.vue']).toBeDefined();
        expect(JSON.parse(strFromU8(files['package.json']!)).scripts.build).toBeTruthy();
      } else {
        expect(files['code.js']).toBeDefined();
        expect(strFromU8(files['README.md']!)).toContain('plugin ID');
        await expect(page.locator('.message-banner[role="status"]')).toContainText('Follow its README');
      }
    }
  }
  expect((await (await page.request.get('/api/project')).json()).project).toEqual(before);

  await page.route('**/api/export', route => route.fulfill({ json: { target: 'figma', status: 'failed', artifacts: [], fidelity: [], diagnostics: [{ code: 'export.unavailable', severity: 'error', message: 'Target unavailable. Retry after recovery.' }] } }));
  const downloads: string[] = [];
  page.on('download', download => downloads.push(download.suggestedFilename()));
  await page.getByRole('button', { name: 'Figma plugin', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Target unavailable. Retry after recovery.');
  await expect(page.locator('.export-result')).toContainText('FIGMA export · failed');
  await expect(page.locator('.message-banner[role="status"]')).toHaveCount(0);
  expect(downloads).toEqual([]);
});
