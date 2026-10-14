import type { DesignDocument, DesignToken, Layout, NodeBase } from './types';
import { createDefaultDesignSystem } from './default-system';

export const DOCUMENT_SCHEMA_VERSION = 1;

export const DEFAULT_TOKENS: readonly DesignToken[] = Object.values(createDefaultDesignSystem().tokens);

export const DEFAULT_OPERATION_CAPABILITIES = [
  'node.create',
  'node.delete',
  'node.move',
  'property.set',
  'layout.set',
  'style.set',
] as const;

export const NODE_KINDS = [
  'frame',
  'group',
  'text',
  'image',
  'icon',
  'vector',
  'component-instance',
] as const;

export const DEFAULT_LAYOUT: Layout = {
  mode: 'vertical',
  width: { kind: 'hug' },
  height: { kind: 'hug' },
  align: 'stretch',
  justify: 'start',
  gap: { kind: 'literal', value: 0, unit: 'px' },
  padding: {
    top: { kind: 'literal', value: 0, unit: 'px' },
    right: { kind: 'literal', value: 0, unit: 'px' },
    bottom: { kind: 'literal', value: 0, unit: 'px' },
    left: { kind: 'literal', value: 0, unit: 'px' },
  },
};

export function createNodeBase(id: string, name: string): NodeBase {
  return {
    id,
    name,
    childIds: [],
    visible: true,
    layout: structuredClone(DEFAULT_LAYOUT),
    constraints: {},
    style: {},
    responsive: [],
  };
}

export function createDocument(name: string, id = 'doc_1', pageId = 'page_1'): DesignDocument {
  const page = { id: pageId, name: 'Page 1', rootNodeIds: [] };
  const system = createDefaultDesignSystem();
  return {
    schemaVersion: DOCUMENT_SCHEMA_VERSION,
    id,
    name,
    revision: 0,
    pageOrder: [pageId],
    pages: { [pageId]: page },
    nodes: {},
    tokens: system.tokens,
    components: system.components,
    metadata: {},
  };
}
