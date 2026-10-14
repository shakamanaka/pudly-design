import { expect, test } from '@playwright/test';

test('selection, inspector edits, history, snapshots, and reopen use saved document state', async ({ page }) => {
  const created = await page.request.post('/api/project/new', { headers: { origin: 'http://127.0.0.1:5174' }, data: { name: 'Browser editing QA' } });
  expect(created.status()).toBe(201);
  await page.goto('/');
  await expect(page.getByRole('main', { name: 'Codex Design workspace' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Design canvas' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Describe a design or edit' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Desktop preview' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Tablet preview' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Mobile preview' })).toBeVisible();

  await expect(page.getByRole('region', { name: 'Design canvas' })).toBeVisible();
  await page.getByRole('button', { name: 'Text', exact: true }).click();
  const textNode = page.locator('.canvas-node[data-node-kind="text"]');
  await expect(textNode).toHaveCount(1);

  // Canvas layers expose their stable design identity through an accessible
  // keyboard target; selection opens the type-aware inspector.
  await textNode.press('Enter');
  await expect(textNode).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('complementary', { name: 'Inspector' })).toBeVisible();
  const content = page.getByRole('textbox', { name: 'Text content' });
  await expect(content).toBeVisible();
  await content.fill('Canvas hello');
  await content.press('Tab');
  await expect(page.locator('.canvas-node[data-node-kind="text"]')).toContainText('Canvas hello');
  await expect(page.getByRole('status')).toContainText('Saved as revision');

  // Undo and redo are durable document transitions surfaced by the UI.
  const undo = page.getByRole('button', { name: 'Undo' });
  const redo = page.getByRole('button', { name: 'Redo' });
  await expect(undo).toBeEnabled();
  await undo.click();
  await expect(textNode).not.toContainText('Canvas hello');
  await expect(redo).toBeEnabled();
  await redo.click();
  await expect(textNode).toContainText('Canvas hello');
  await textNode.press('Enter');

  // A named snapshot survives a later edit and restores its captured state.
  await page.getByText('History', { exact: true }).click();
  await page.getByPlaceholder('Milestone name').fill('Baseline text');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Snapshot saved.');

  await content.fill('Later state');
  await content.press('Tab');
  await expect(textNode).toContainText('Later state');
  const savedSnapshot = page.locator('.snapshot-row').filter({ hasText: 'Baseline text' });
  await expect(savedSnapshot).toBeVisible();
  await savedSnapshot.getByRole('button', { name: 'Restore' }).click();
  await expect(textNode).toContainText('Canvas hello');

  // Closing/reopening the browser page reloads the project through the real
  // local service and must restore both the committed document and its history.
  await page.reload();
  await expect(page.locator('.canvas-node[data-node-kind="text"]')).toContainText('Canvas hello');
  await expect(page.getByRole('button', { name: 'Undo' })).toBeEnabled();
  await page.getByText('History', { exact: true }).click();
  await expect(page.locator('.snapshot-row').filter({ hasText: 'Baseline text' })).toBeVisible();
});
