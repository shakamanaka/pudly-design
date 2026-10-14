import { expect, test } from '@playwright/test';
import { createDefaultDesignSystem, createDocument, createNodeBase } from '../../src/domain/index';
import type { ComponentInstanceNode } from '../../src/domain/types';
import { sealEnvelope } from '../../src/application/integrity';

test('Button and Card templates honor browser bounds, hug sizing, breakpoints, and keyboard selection', async ({ page }) => {
  const document = createDocument('Component browser QA');
  const system = createDefaultDesignSystem();
  system.components.button!.templateNodes['button-root']!.responsive = [{
    id: 'desktop-gap',
    breakpointTokenId: 'breakpoint.desktop',
    priority: 1,
    overrides: { layout: { gap: { kind: 'literal', value: 30, unit: 'px' } } },
  }];
  Object.assign(document.tokens, system.tokens);
  Object.assign(document.components, system.components);
  const buttonBase = createNodeBase('button_instance', 'Buy now');
  const button: ComponentInstanceNode = {
    ...buttonBase,
    kind: 'component-instance',
    componentId: 'button',
    variantId: 'primary',
    propertyOverrides: { label: 'Buy now' },
    nodeOverrides: {},
    slotChildren: {},
    layout: { ...buttonBase.layout, width: { kind: 'fixed', value: { kind: 'literal', value: 180, unit: 'px' } }, height: { kind: 'fixed', value: { kind: 'literal', value: 44, unit: 'px' } } },
  };
  const cardBase = createNodeBase('card_instance', 'Product card');
  const card: ComponentInstanceNode = {
    ...cardBase,
    kind: 'component-instance',
    componentId: 'card',
    variantId: 'standard',
    propertyOverrides: { title: 'Product card', description: 'Browser-rendered component' },
    nodeOverrides: {},
    slotChildren: {},
    layout: { ...cardBase.layout, width: { kind: 'fixed', value: { kind: 'literal', value: 320, unit: 'px' } }, height: { kind: 'fixed', value: { kind: 'literal', value: 120, unit: 'px' } } },
  };
  const hugButton = structuredClone(button);
  hugButton.id = 'button_hug';
  hugButton.name = 'Hug button';
  hugButton.propertyOverrides = { label: 'Hug button' };
  hugButton.layout = { ...hugButton.layout, width: { kind: 'hug' }, height: { kind: 'hug' } };
  document.nodes[button.id] = button;
  document.nodes[card.id] = card;
  document.nodes[hugButton.id] = hugButton;
  document.pages.page_1!.rootNodeIds.push(button.id, card.id, hugButton.id);
  const project = sealEnvelope({ formatVersion: 1, document, history: { undoableEntries: [], cursor: 0, auditTransitions: [], snapshots: [] }, appliedBatchIds: [], integrityHash: '' });
  await page.route('**/api/project', async (route) => route.fulfill({ json: { project } }));

  await page.goto(process.env.COMPONENT_QA_VITE_URL ?? '/');
  const assertCanvasOriginReachable = async () => {
    const scroll = page.locator('.canvas-scroll');
    const artboard = page.locator('.page-artboard');
    const viewport = await scroll.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, top: rect.top, right: rect.left + element.clientWidth, bottom: rect.top + element.clientHeight };
    });
    const origin = await artboard.boundingBox();
    expect(origin, 'Expected the page artboard to have visible bounds').not.toBeNull();
    expect(origin!.x).toBeGreaterThanOrEqual(viewport.left);
    expect(origin!.y).toBeGreaterThanOrEqual(viewport.top);
    expect(origin!.x).toBeLessThan(viewport.right);
    expect(origin!.y).toBeLessThan(viewport.bottom);
  };
  await assertCanvasOriginReachable();
  const buttonCanvasNode = page.locator('[data-node-id="button_instance"]');
  const cardCanvasNode = page.locator('[data-node-id="card_instance"]');
  const hugCanvasNode = page.locator('[data-node-id="button_hug"]');
  await expect(buttonCanvasNode).toBeVisible();
  await expect(buttonCanvasNode.locator('[data-template-node-id="button-label"]')).toContainText('Buy now');
  await expect(cardCanvasNode.locator('[data-template-node-id="card-title"]')).toContainText('Product card');
  await expect(cardCanvasNode.locator('[data-template-node-id="card-description"]')).toContainText('Browser-rendered component');
  await expect(hugCanvasNode.locator('[data-template-node-id="button-label"]')).toContainText('Hug button');
  const buttonRoot = buttonCanvasNode.locator('[data-template-node-id="button-root"]');
  await expect(buttonRoot).toHaveCSS('gap', '30px');

  await buttonCanvasNode.focus();
  await page.keyboard.press('Enter');
  await expect(buttonCanvasNode).toHaveClass(/is-selected/);
  await expect(buttonCanvasNode).toHaveAttribute('aria-pressed', 'true');

  const buttonBox = await buttonCanvasNode.locator('[data-template-node-id="button-root"]').boundingBox();
  const cardBox = await cardCanvasNode.locator('[data-template-node-id="card-root"]').boundingBox();
  const instanceBoxes = { button: await buttonCanvasNode.boundingBox(), card: await cardCanvasNode.boundingBox() };
  expect(buttonBox?.width).toBeGreaterThan(0);
  expect(buttonBox?.height).toBeGreaterThan(0);
  expect(cardBox?.width).toBeGreaterThan(0);
  expect(cardBox?.height).toBeGreaterThan(0);
  // The visible template root must fill the persisted instance's selectable
  // bounds; otherwise the inspector selection outline includes empty space.
  expect(buttonBox?.width).toBeCloseTo(instanceBoxes.button?.width ?? 0, 0);
  expect(buttonBox?.height).toBeCloseTo(instanceBoxes.button?.height ?? 0, 0);
  expect(cardBox?.width).toBeCloseTo(instanceBoxes.card?.width ?? 0, 0);
  expect(cardBox?.height).toBeCloseTo(instanceBoxes.card?.height ?? 0, 0);
  await expect(buttonRoot).toHaveCSS('padding', '16px');
  await expect(buttonCanvasNode).toHaveCSS('padding', '0px');
  const hugRootBox = await hugCanvasNode.locator('[data-template-node-id="button-root"]').boundingBox();
  const hugInstanceBox = await hugCanvasNode.boundingBox();
  expect(hugRootBox?.width).toBeCloseTo(hugInstanceBox?.width ?? 0, 0);
  expect(hugRootBox?.height).toBeCloseTo(hugInstanceBox?.height ?? 0, 0);

  await page.getByRole('button', { name: 'Mobile preview' }).click();
  await expect(buttonRoot).toHaveCSS('gap', '8px');
  await page.reload();
  await expect(page.locator('[data-node-id="button_instance"]')).toBeVisible();
  await assertCanvasOriginReachable();
});
