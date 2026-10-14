import { DEFAULT_COMPONENT_CATALOG, DEFAULT_DESIGN_SYSTEM_POLICY } from '../domain/index';
import type { CodingAgentRequest, DesignDocument, DesignNode } from '../domain/index';

export function collectSubtree(document: DesignDocument, roots: string[]): string[] {
  const found = new Set<string>();
  const pending = [...roots];
  while (pending.length) {
    const id = pending.pop();
    if (!id || found.has(id)) continue;
    const node = Object.hasOwn(document.nodes, id) ? document.nodes[id] : undefined;
    if (!node) throw new Error('Selection refers to a missing node.');
    found.add(id);
    pending.push(...node.childIds);
    if (node.kind === 'component-instance') pending.push(...Object.values(node.slotChildren).flat());
  }
  return [...found];
}

export function buildContext(document: DesignDocument, runId: string, prompt: string, selectedNodeIds: string[], capabilities: string[], requestedPageId?: string): CodingAgentRequest {
  const selectedPages = selectedNodeIds.length ? document.pageOrder.filter(id => {
    const page = document.pages[id];
    const members = new Set(collectSubtree(document, page?.rootNodeIds ?? []));
    return selectedNodeIds.some(selected => members.has(selected));
  }) : [];
  if (selectedPages.length > 1) throw new Error('Select nodes from one page for a scoped request.');
  if (requestedPageId !== undefined && !Object.hasOwn(document.pages, requestedPageId)) throw new Error('The requested page does not exist.');
  if (requestedPageId !== undefined && selectedPages.length && selectedPages[0] !== requestedPageId) throw new Error('Selected nodes do not belong to the requested page.');
  const pageId = requestedPageId ?? selectedPages[0] ?? document.pageOrder[0];
  const page = pageId ? document.pages[pageId] : undefined;
  const includedIds = collectSubtree(document, selectedNodeIds.length ? selectedNodeIds : page?.rootNodeIds ?? []);
  const nodes: Record<string, DesignNode> = {};
  for (const id of includedIds) {
    const node = document.nodes[id];
    if (node) nodes[id] = structuredClone(node);
  }
  const ancestorFrames = new Set<string>();
  for (const selectedId of selectedNodeIds) {
    let child = selectedId;
    const visited = new Set<string>();
    while (!visited.has(child)) {
      visited.add(child);
      const parent = Object.values(document.nodes).find(candidate => candidate.childIds.includes(child) || (candidate.kind === 'component-instance' && Object.values(candidate.slotChildren).some(children => children.includes(child))));
      if (!parent) break;
      if (parent.kind === 'frame') ancestorFrames.add(parent.id);
      child = parent.id;
    }
  }
  return {
    runId, documentId: document.id, baseRevision: document.revision, prompt,
    selectedNodeIds: [...selectedNodeIds], operationCapabilities: capabilities,
    resolvedContext: [
      { scope: 'project', sourceId: document.id },
      { scope: 'design-system', sourceId: 'codex-default' },
      ...(pageId ? [{ scope: 'page' as const, sourceId: pageId }] : []),
      ...[...ancestorFrames].sort().map(sourceId => ({ scope: 'frame' as const, sourceId })),
      { scope: 'selection', includedNodeIds: includedIds },
    ],
    documentFragment: {
      documentId: document.id, revision: document.revision,
      ...(page ? { page: structuredClone(page) } : {}), nodes,
      tokens: structuredClone(document.tokens), components: structuredClone(document.components),
    },
    designSystemContext: {
      policy: structuredClone(DEFAULT_DESIGN_SYSTEM_POLICY),
      catalog: structuredClone(DEFAULT_COMPONENT_CATALOG),
    },
  };
}
