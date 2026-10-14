import { expect, test } from '@playwright/test';

test('text canvas controls expose visible content and preserve stable keyboard selection', async ({ page }) => {
  const created = await page.request.post('/api/project/new', {
    headers: { origin: 'http://127.0.0.1:5174' },
    data: { name: 'Canvas accessible names QA' },
  });
  expect(created.status()).toBe(201);
  await page.goto('/');

  await page.getByRole('button', { name: 'Frame', exact: true }).click();
  const frame = page.locator('.canvas-node[data-node-kind="frame"]');
  await expect(frame).toHaveCount(1);
  const frameId = await frame.getAttribute('data-node-id');
  expect(frameId).toBeTruthy();

  // The selected frame becomes the new text layer's semantic parent.
  await page.getByRole('button', { name: 'Text', exact: true }).click();
  const textNode = page.locator('.canvas-node[data-node-kind="text"]');
  await expect(textNode).toHaveCount(1);
  const textId = await textNode.getAttribute('data-node-id');
  expect(textId).toBeTruthy();
  await expect(textNode).toHaveAttribute('aria-pressed', 'true');

  const nameField = page.getByRole('textbox', { name: 'Name' });
  await nameField.fill('Heading layer');
  await nameField.press('Tab');
  const contentField = page.getByRole('textbox', { name: 'Text content' });
  await contentField.fill('Welcome');
  await contentField.press('Tab');

  const canvasText = page.locator(`.canvas-node[data-node-id="${textId}"]`);
  await expect(canvasText).toHaveText('Welcome');
  await expect(canvasText).toHaveAccessibleName('Welcome');
  await expect(canvasText).toHaveAccessibleDescription('text: Heading layer');
  expect(await canvasText.ariaSnapshot()).toContain('button "Welcome"');

  // Enter and Space select the same persisted ID without selecting its parent.
  const canvasFrame = page.locator(`.canvas-node[data-node-id="${frameId}"]`);
  await canvasFrame.focus();
  await page.keyboard.press('Enter');
  await expect(canvasFrame).toHaveAttribute('aria-pressed', 'true');
  await canvasText.focus();
  await page.keyboard.press('Enter');
  await expect(canvasText).toHaveAttribute('aria-pressed', 'true');
  await expect(canvasFrame).toHaveAttribute('aria-pressed', 'false');
  await expect(canvasText).toHaveAttribute('data-node-id', textId!);

  await canvasFrame.focus();
  await page.keyboard.press('Enter');
  await canvasText.focus();
  await page.keyboard.press('Space');
  await expect(canvasText).toHaveAttribute('aria-pressed', 'true');
  await expect(canvasFrame).toHaveAttribute('aria-pressed', 'false');

  // Later text edits update the button's accessible name and survive reload.
  await contentField.fill('Updated welcome');
  await contentField.press('Tab');
  await expect(canvasText).toHaveAccessibleName('Updated welcome');
  await expect(canvasText).toHaveAccessibleDescription('text: Heading layer');
  await page.reload();
  const reloadedText = page.locator(`.canvas-node[data-node-id="${textId}"]`);
  await expect(reloadedText).toHaveAccessibleName('Updated welcome');
  await expect(reloadedText).toHaveAccessibleDescription('text: Heading layer');

  // Whitespace-only text keeps the meaningful layer fallback.
  await reloadedText.press('Enter');
  const reloadedContentField = page.getByRole('textbox', { name: 'Text content' });
  await reloadedContentField.fill('   ');
  await reloadedContentField.press('Tab');
  await expect(reloadedText).toHaveAccessibleName('text: Heading layer');
  await expect(reloadedText).not.toHaveAttribute('aria-description', /text: Heading layer/);
});
