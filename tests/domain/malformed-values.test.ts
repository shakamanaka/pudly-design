import { expect, test } from 'vitest';
import { createDocument, createNodeBase, validateDocument } from '../../src/domain';

test.each([
  { kind: 'text', text: 'Invalid weight', textStyle: { weight: 1001 } },
  { kind: 'image', assetId: 'asset', fit: 'invented' },
])('invalid node values cannot bypass validation through a missing diagnostic: $kind', payload => {
  const document = createDocument('Invalid');
  const raw = { ...document, nodes: { invalid: { ...createNodeBase('invalid', 'Invalid'), ...payload } } };
  raw.pages.page_1!.rootNodeIds.push('invalid');
  const result = validateDocument(raw);
  expect(result.ok).toBe(false);
  expect(result.diagnostics.length).toBeGreaterThan(0);
});

test.each([
  { id: 'bad', name: 'Bad', category: 'color', value: { hex: 'red' } },
  { id: 'bad', name: 'Bad', category: 'typography', value: { fontFamily: 'Inter', fontSizePx: 16, weight: 1001, lineHeight: 1.5 } },
  { id: 'bad', name: 'Bad', category: 'motion', value: { durationMs: 100, easing: 'invented' } },
])('invalid $category token values always produce a blocking diagnostic', token => {
  const document = createDocument('Invalid');
  const result = validateDocument({ ...document, tokens: { ...document.tokens, bad: token } });
  expect(result.ok).toBe(false);
  expect(result.diagnostics.length).toBeGreaterThan(0);
});
