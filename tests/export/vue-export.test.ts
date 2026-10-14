import { expect, test } from 'vitest';
import { VueExporter } from '../../src/adapters/export/vue';
import { createDocument, createNodeBase, validateDocument } from '../../src/domain';
import type { ComponentInstanceNode, DesignDocument, DesignNode } from '../../src/domain';

function findArtifact(result: Awaited<ReturnType<VueExporter['export']>>, name: string): string {
  const artifact = result.artifacts.find((item) => item.name === name);
  expect(artifact, `Expected exported artifact ${name}`).toBeDefined();
  return artifact!.contents;
}

function textAt(nodes: Array<Record<string, unknown>>, renderId: string): string | undefined {
  for (const node of nodes) {
    if (node.renderId === renderId && typeof node.text === 'string') return node.text;
    const children = Array.isArray(node.children) ? node.children as Array<Record<string, unknown>> : [];
    const value = textAt(children, renderId);
    if (value !== undefined) return value;
  }
  return undefined;
}

test('Vue export packages a portable app and keeps untrusted design text in JSON data', async () => {
  const document = createDocument('</script><script>alert("name")</script>');
  const maliciousText = '</script><script>alert("text")</script><img src=x onerror=alert(1)>';
  const frame: DesignNode = {
    ...createNodeBase('frame_root', 'Main frame'),
    kind: 'frame',
    layout: { ...createNodeBase('layout', 'layout').layout, width: { kind: 'fixed', value: { kind: 'literal', value: 640, unit: 'px' } }, height: { kind: 'fixed', value: { kind: 'literal', value: 420, unit: 'px' } } },
    style: { fill: { kind: 'token', tokenId: 'color.surface' }, radius: { kind: 'token', tokenId: 'radius.md' } },
    childIds: ['title'],
  };
  const title: DesignNode = {
    ...createNodeBase('title', 'Unsafe title'),
    kind: 'text',
    text: maliciousText,
    textStyle: { typographyTokenId: 'typography.body', fontSize: { kind: 'literal', value: 28, unit: 'px' }, weight: 700 },
    responsive: [{ id: 'hide-on-tablet', breakpointTokenId: 'breakpoint.tablet', priority: 0, overrides: { visible: false } }],
  };
  document.nodes[frame.id] = frame;
  document.nodes[title.id] = title;
  document.pages.page_1!.rootNodeIds.push(frame.id);

  const result = await new VueExporter().export(document);
  expect(validateDocument(document).ok).toBe(true);
  expect(result.status).toBe('succeeded');
  expect(result.target).toBe('vue');
  expect(result.fidelity.every((entry) => entry.status === 'preserved')).toBe(true);

  const expectedFiles = [
    'package.json', 'index.html', 'vite.config.js', 'src/main.ts', 'src/App.vue',
    'src/DesignNode.vue', 'src/design-rendering.ts', 'src/style.css',
    'src/design-document.json', 'src/design-tree.json',
  ];
  expect(result.artifacts.map((artifact) => artifact.name)).toEqual(expectedFiles);
  const packageContents = JSON.parse(findArtifact(result, 'package.json')) as { dependencies: Record<string, string>; devDependencies: Record<string, string>; scripts: Record<string, string> };
  expect(packageContents.dependencies.vue).toBe('3.5.43');
  expect(packageContents.devDependencies.vite).toBe('8.3.2');
  expect(packageContents.scripts).toMatchObject({ dev: 'vite', build: 'vite build' });

  const executable = result.artifacts.filter((artifact) => !artifact.name.endsWith('.json'));
  expect(executable.some((artifact) => artifact.contents.includes(maliciousText))).toBe(false);
  expect(executable.some((artifact) => artifact.contents.includes('</script><script>alert("name")'))).toBe(false);
  expect(findArtifact(result, 'src/DesignNode.vue')).toContain('{{ node.text }}');
  expect(findArtifact(result, 'src/DesignNode.vue')).not.toContain('v-html');
  expect(findArtifact(result, 'src/design-rendering.ts')).toContain('export function resolveResponsive');
  expect(findArtifact(result, 'src/design-rendering.ts')).toContain("style.flex = '1 1 0'");
  expect(findArtifact(result, 'src/style.css')).toContain('.export-node--text { white-space: pre-wrap; }');

  const exportedDocument = JSON.parse(findArtifact(result, 'src/design-document.json')) as DesignDocument;
  expect(exportedDocument).toEqual(document);
  const exportedTree = JSON.parse(findArtifact(result, 'src/design-tree.json')) as Array<{ roots: Array<Record<string, unknown>> }>;
  expect(textAt(exportedTree[0]!.roots, 'title')).toBe(maliciousText);
});

test('Vue export maps vector semantic fill to currentColor and keeps its wrapper transparent', async () => {
  const document = createDocument('Vector export');
  document.nodes.vector = {
    ...createNodeBase('vector', 'Accent'), kind: 'vector', pathData: 'M 0 0 L 10 0 L 5 10 Z', viewBox: [0, 0, 10, 10],
    style: { fill: { kind: 'literal', value: '#123456' }, textColor: { kind: 'literal', value: '#ff0000' } },
  };
  document.pages.page_1!.rootNodeIds.push('vector');
  const result = await new VueExporter().export(document);
  expect(result.status).toBe('succeeded');
  expect(findArtifact(result, 'src/DesignNode.vue')).toContain('<path :d="node.pathData" fill="currentColor" />');
  const renderer = findArtifact(result, 'src/design-rendering.ts');
  expect(renderer).toContain("backgroundColor: node.kind === 'vector' ? 'transparent'");
  expect(renderer).toContain("color: node.kind === 'vector' ? tokenColor(tokens, node.style.fill ?? node.style.textColor, '#20242b')");
});

test('Vue export resolves a component from its definition, variant, binding, and anchored slot with honest loss entries', async () => {
  const document = createDocument('Component export');
  const baseLayout = createNodeBase('temporary', 'temporary').layout;
  document.components.button = {
    id: 'button',
    name: 'Action button',
    rootTemplateNodeId: 'root',
    templateNodes: {
      root: { templateNodeId: 'root', name: 'Button root', kind: 'frame', childTemplateNodeIds: ['label'], visible: true, layout: baseLayout, constraints: {}, style: {}, responsive: [] },
      label: { templateNodeId: 'label', name: 'Label', kind: 'text', childTemplateNodeIds: [], visible: true, text: 'Default', textStyle: {}, layout: baseLayout, constraints: {}, style: {}, responsive: [] },
    },
    properties: { label: { type: 'string', required: true, defaultValue: 'Default', binding: { templateNodeId: 'label', property: 'text' } } },
    variants: { compact: { id: 'compact', name: 'Compact', propertyOverrides: { label: 'Compact' }, nodeOverrides: {} } },
    slots: { leading: { id: 'leading', name: 'Leading icon', templateAnchorNodeId: 'root', allowedKinds: ['icon'], minItems: 0, maxItems: 1 } },
  };
  const icon: DesignNode = { ...createNodeBase('leading_icon', 'Chevron'), kind: 'icon', libraryId: 'lucide', iconName: 'chevron-right' };
  const instance: ComponentInstanceNode = {
    ...createNodeBase('button_instance', 'Primary action'),
    kind: 'component-instance',
    componentId: 'button',
    variantId: 'compact',
    propertyOverrides: { label: 'Continue' },
    nodeOverrides: {},
    slotChildren: { leading: [icon.id] },
  };
  document.nodes[icon.id] = icon;
  document.nodes[instance.id] = instance;
  document.pages.page_1!.rootNodeIds.push(instance.id);

  expect(validateDocument(document).ok).toBe(true);
  const result = await new VueExporter().export(document);
  expect(result.status).toBe('partial');
  expect(result.artifacts).toHaveLength(10);
  const tree = JSON.parse(findArtifact(result, 'src/design-tree.json')) as Array<{ roots: Array<Record<string, unknown>> }>;
  const renderedInstance = tree[0]!.roots[0]!;
  const instanceChildren = renderedInstance.children as Array<Record<string, unknown>>;
  const renderedTemplateRoot = instanceChildren[0]!;
  const templateChildren = renderedTemplateRoot.children as Array<Record<string, unknown>>;
  expect(templateChildren[0]).toMatchObject({ kind: 'text', text: 'Continue', name: 'Label' });
  expect(templateChildren[1]).toMatchObject({ kind: 'icon', iconName: 'chevron-right', sourceId: 'leading_icon' });

  expect(result.fidelity).toContainEqual(expect.objectContaining({ nodeId: 'button_instance', feature: 'component-definition-variant-and-overrides', status: 'degraded', severity: 'warning' }));
  expect(result.fidelity).toContainEqual(expect.objectContaining({ nodeId: 'leading_icon', feature: 'node:icon', status: 'degraded' }));
  expect(result.diagnostics.some((item) => item.message.includes('icon library/name') && item.severity === 'warning')).toBe(true);
  const source = JSON.parse(findArtifact(result, 'src/design-document.json')) as DesignDocument;
  expect(source.components.button).toEqual(document.components.button);
  expect(source.nodes.button_instance).toEqual(instance);
});

test('Vue export rejects an unsupported document without returning partial app files', async () => {
  const document = createDocument('Future schema');
  document.schemaVersion = 999;
  const original = structuredClone(document);
  const result = await new VueExporter().export(document);
  expect(result).toMatchObject({ target: 'vue', status: 'failed', artifacts: [], fidelity: [] });
  expect(result.diagnostics.length).toBeGreaterThan(0);
  expect(document).toEqual(original);
});
