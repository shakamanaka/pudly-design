import { expect, test } from '@playwright/test';
import { createNodeBase } from '../../src/domain/defaults';
import type { PersistedProjectEnvelope } from '../../src/domain/types';

test.use({ video: 'on' });

const origin = 'http://127.0.0.1:5174';

async function createSavedDesign(page: import('@playwright/test').Page, name: string, tag: string) {
  const created = await page.request.post('/api/project/new', { headers: { origin }, data: { name } });
  expect(created.status()).toBe(201);
  const envelope = (await created.json()).project as PersistedProjectEnvelope;
  const pageId = envelope.document.pageOrder[0]!;
  const frame = { ...createNodeBase(`${tag}_frame`, `${name} frame`), kind: 'frame' as const };
  const text = { ...createNodeBase(`${tag}_heading`, `${name} heading`), kind: 'text' as const, text: `${name} preview heading`, textStyle: {} };
  const structure = await page.request.post('/api/operations', {
    headers: { origin },
    data: { batch: {
      id: `${tag}_create`, documentId: envelope.document.id, expectedRevision: 0, source: 'toolbar',
      capabilitySet: ['node.create'],
      operations: [
        { type: 'node.create', node: frame, pageId, index: 0 },
        { type: 'node.create', node: text, pageId, parentId: frame.id, index: 0 },
      ],
    } },
  });
  expect(structure.status()).toBe(200);
  const project = (await structure.json()).project as PersistedProjectEnvelope;
  const renamed = await page.request.post('/api/operations', {
    headers: { origin },
    data: { batch: {
      id: `${tag}_rename`, documentId: envelope.document.id, expectedRevision: project.document.revision, source: 'inspector',
      capabilitySet: ['property.set'],
      operations: [{ type: 'property.set', nodeId: frame.id, change: { property: 'name', value: `${name} reviewed` } }],
    } },
  });
  expect(renamed.status()).toBe(200);
  return { id: envelope.document.id, frameId: frame.id, previewText: text.text };
}

function savedProjectItem(page: import('@playwright/test').Page, name: string) {
  return page.getByRole('list', { name: 'Saved projects' }).getByRole('listitem').filter({ hasText: name });
}

async function openExplorer(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Your projects' })).toBeVisible();
}

test('grid and list previews stay inert while opening and creating durable projects', async ({ page }) => {
  const historical = await createSavedDesign(page, 'Historical storefront', 'historical');
  const active = await page.request.post('/api/project/new', { headers: { origin }, data: { name: 'Current workspace' } });
  expect(active.status()).toBe(201);
  await page.goto('/');

  await openExplorer(page);
  const dialog = page.getByRole('dialog', { name: 'Your projects' });
  const historicalItem = savedProjectItem(page, 'Historical storefront');
  await expect(historicalItem).toBeVisible();
  await expect(historicalItem).toContainText('Historical storefront preview heading');
  await expect(historicalItem.locator('.project-card__preview-frame')).toHaveAttribute('inert', '');
  await expect(page.getByRole('button', { name: 'Grid' })).toHaveAttribute('aria-pressed', 'true');

  const currentBeforePreview = await page.request.get('/api/project');
  const currentId = (await currentBeforePreview.json()).project.document.id;
  await expect(historicalItem.getByRole('button', { name: 'Open project' })).toBeEnabled();
  expect((await (await page.request.get('/api/project')).json()).project.document.id).toBe(currentId);

  await page.getByRole('button', { name: 'List', exact: true }).click();
  await expect(page.getByRole('button', { name: 'List', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(historicalItem).toContainText('Revision 2');
  await historicalItem.getByRole('button', { name: 'Open project' }).click();
  await expect(dialog).toBeHidden();
  const opened = await page.request.get('/api/project');
  const openedEnvelope = (await opened.json()).project as PersistedProjectEnvelope;
  expect(openedEnvelope.document.id).toBe(historical.id);
  expect(openedEnvelope.document.nodes[historical.frameId]?.name).toBe('Historical storefront reviewed');
  expect(openedEnvelope.history.undoableEntries).toHaveLength(2);
  await expect(page.locator(`[data-node-id="${historical.frameId}"]`)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Undo' })).toBeEnabled();

  await openExplorer(page);
  await page.getByRole('textbox', { name: 'Create a project' }).fill('UI created project');
  await page.getByRole('button', { name: 'Create project', exact: true }).click();
  await expect(dialog).toBeHidden();
  const created = await page.request.get('/api/project');
  expect((await created.json()).project.document.name).toBe('UI created project');
  await page.reload();
  expect((await (await page.request.get('/api/project')).json()).project.document.name).toBe('UI created project');

  await openExplorer(page);
  const closeButton = page.getByRole('button', { name: 'Close project explorer' });
  await expect(closeButton).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(dialog.getByRole('button', { name: 'Done', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(closeButton).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('button', { name: 'Projects', exact: true })).toBeFocused();
});

test('canceled and inactive removal preserve selection, active removal clears it, and narrow dialog content scrolls', async ({ page }) => {
  const inactive = await createSavedDesign(page, 'Inactive archive', 'inactive');
  for (let index = 0; index < 4; index += 1) {
    const extra = await page.request.post('/api/project/new', { headers: { origin }, data: { name: `Scroll fixture ${index}` } });
    expect(extra.status()).toBe(201);
  }
  const activeResponse = await page.request.post('/api/project/new', { headers: { origin }, data: { name: 'Active workspace' } });
  expect(activeResponse.status()).toBe(201);
  await page.goto('/');
  await page.setViewportSize({ width: 390, height: 620 });
  await openExplorer(page);

  const inactiveItem = savedProjectItem(page, 'Inactive archive');
  await inactiveItem.getByRole('button', { name: 'Remove', exact: true }).click();
  const confirmation = page.getByRole('group', { name: 'Confirm removal of Inactive archive' });
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(confirmation).toBeHidden();
  expect((await (await page.request.get('/api/project')).json()).project.document.name).toBe('Active workspace');
  await expect(inactiveItem).toBeVisible();

  const dialog = page.getByRole('dialog', { name: 'Your projects' });
  const bounds = await dialog.boundingBox();
  expect(bounds).toBeTruthy();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(391);
  const list = page.getByRole('list', { name: 'Saved projects' });
  await expect(list).toBeVisible();
  const scrollRegion = page.locator('.project-explorer__scroll');
  expect(await scrollRegion.evaluate(element => element.scrollHeight)).toBeGreaterThan(await scrollRegion.evaluate(element => element.clientHeight));

  await inactiveItem.getByRole('button', { name: 'Remove', exact: true }).click();
  await page.getByRole('group', { name: 'Confirm removal of Inactive archive' }).getByRole('button', { name: 'Remove project', exact: true }).click();
  await expect(savedProjectItem(page, 'Inactive archive')).toHaveCount(0);
  expect((await (await page.request.get('/api/project')).json()).project.document.name).toBe('Active workspace');

  const activeItem = savedProjectItem(page, 'Active workspace');
  await activeItem.getByRole('button', { name: 'Remove', exact: true }).click();
  await page.getByRole('group', { name: 'Confirm removal of Active workspace' }).getByRole('button', { name: 'Remove project', exact: true }).click();
  await expect(dialog).toBeVisible();
  await expect(savedProjectItem(page, 'Active workspace')).toHaveCount(0);
  expect((await (await page.request.get('/api/project')).json()).project).toBeNull();
  await page.reload();
  expect((await (await page.request.get('/api/project')).json()).project).toBeNull();
  expect(inactive.id).toBeTruthy();
});

test('a trash-storage failure keeps the project selected and gives the user an actionable error', async ({ page }) => {
  const created = await page.request.post('/api/project/new', { headers: { origin }, data: { name: 'Removal failure fixture' } });
  expect(created.status()).toBe(201);
  await page.route('**/api/projects/*', async route => {
    if (route.request().method() === 'DELETE') {
      await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'project.trash', message: 'Local trash storage is unavailable.' } }) });
      return;
    }
    await route.continue();
  });
  await page.goto('/');
  await openExplorer(page);
  const item = savedProjectItem(page, 'Removal failure fixture');
  await item.getByRole('button', { name: 'Remove', exact: true }).click();
  await page.getByRole('group', { name: 'Confirm removal of Removal failure fixture' }).getByRole('button', { name: 'Remove project', exact: true }).click();

  await expect(page.getByRole('alert')).toContainText('Could not remove “Removal failure fixture”');
  await expect(item).toBeVisible();
  expect((await (await page.request.get('/api/project')).json()).project.document.name).toBe('Removal failure fixture');
});
