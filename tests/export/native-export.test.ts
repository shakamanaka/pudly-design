import { expect, test } from 'vitest';
import { NativeExporter } from '../../src/adapters/export/native';
import { createDocument, createNodeBase, validateDocument } from '../../src/domain';

test('native export roundTripsSupportedDocumentLosslessly with semantic tokens and responsive content', async () => {
  const document = createDocument('Portable design');
  document.nodes.title = {
    ...createNodeBase('title', 'Title'), kind: 'text', text: '<script>untrusted text</script>',
    textStyle: { typographyTokenId: 'typography.body' },
    responsive: [{ id: 'desktop', breakpointTokenId: 'breakpoint.desktop', priority: 0, overrides: { visible: false } }],
  };
  document.pages.page_1!.rootNodeIds.push('title');
  const result = await new NativeExporter().export(document);
  expect(result.status).toBe('succeeded');
  const serialized = result.artifacts[0]?.contents;
  expect(serialized).toBeDefined();
  const restored: unknown = JSON.parse(serialized!);
  expect(validateDocument(restored).ok).toBe(true);
  expect(restored).toEqual(document);
  expect(result.fidelity.every(entry => entry.status === 'preserved')).toBe(true);
});

test('native export rejects unsupported schema without producing an artifact or changing input', async () => {
  const document = createDocument('Future design');
  document.schemaVersion = 999;
  const original = structuredClone(document);
  const result = await new NativeExporter().export(document);
  expect(result.status).toBe('failed');
  expect(result.artifacts).toEqual([]);
  expect(result.diagnostics.length).toBeGreaterThan(0);
  expect(document).toEqual(original);
});
