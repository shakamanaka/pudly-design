import type { DesignNode, Diagnostic, Page } from './types.js';
import { addDiagnostic, isRecord } from './validation-utils.js';

export function validateOwnership(doc: Record<string, unknown>, ds: Diagnostic[]): void {
  const pages = doc.pages as Record<string, Page>;
  const nodes = doc.nodes as Record<string, DesignNode>;
  const owners = new Map<string, string>();
  const edges = new Map<string, string[]>();
  const own = (id: string, owner: string, path: string) => {
    if (!Object.hasOwn(nodes, id)) addDiagnostic(ds, 'node.missing', 'Owned node does not exist.', path, id);
    const previous = owners.get(id);
    if (previous !== undefined) addDiagnostic(ds, 'node.multiple-owners', `Node already owned by ${previous}.`, path, id);
    else owners.set(id, owner);
  };
  for (const [pageId, page] of Object.entries(pages)) {
    if (!isRecord(page) || !Array.isArray(page.rootNodeIds)) continue;
    page.rootNodeIds.forEach((id, index) => { if (typeof id === 'string') own(id, `page:${pageId}`, `pages.${pageId}.rootNodeIds[${index}]`); });
  }
  for (const rawNode of Object.values(nodes)) {
    if (!isRecord(rawNode) || typeof rawNode.id !== 'string') continue;
    const node = rawNode as unknown as DesignNode;
    const childIds: string[] = [];
    if (node.kind === 'frame' || node.kind === 'group') {
      node.childIds.forEach((id, index) => {
        own(id, `node:${node.id}`, `nodes.${node.id}.childIds[${index}]`);
        childIds.push(id);
      });
    } else if (node.kind === 'component-instance') {
      if (node.childIds.length > 0) addDiagnostic(ds, 'node.instance-children', 'Component instance childIds must be empty; use declared slotChildren.', `nodes.${node.id}.childIds`, node.id);
      for (const [slot, ids] of Object.entries(node.slotChildren)) ids.forEach((id, index) => {
        own(id, `slot:${node.id}:${slot}`, `nodes.${node.id}.slotChildren.${slot}[${index}]`);
        childIds.push(id);
      });
    }
    edges.set(node.id, childIds);
  }
  for (const id of Object.keys(nodes)) if (!owners.has(id)) addDiagnostic(ds, 'node.unowned', 'Node must have exactly one page, parent, or component-slot owner.', `nodes.${id}`, id);

  const color = new Map<string, 0 | 1 | 2>();
  const roots = Object.values(pages).flatMap(page => isRecord(page) && Array.isArray(page.rootNodeIds) ? page.rootNodeIds : []);
  for (const start of [...roots, ...Object.keys(nodes)]) {
    if ((color.get(start) ?? 0) !== 0) continue;
    const stack: Array<{ id: string; depth: number; exiting: boolean }> = [{ id: start, depth: 1, exiting: false }];
    while (stack.length > 0) {
      const item = stack.pop();
      if (item === undefined) break;
      if (item.exiting) { color.set(item.id, 2); continue; }
      const state = color.get(item.id) ?? 0;
      if (state === 1) { addDiagnostic(ds, 'node.cycle', 'Node ownership graph contains a cycle.', `nodes.${item.id}`, item.id); continue; }
      if (state === 2) continue;
      if (item.depth > 64) { addDiagnostic(ds, 'limit.depth', 'Node ownership exceeds depth 64.', `nodes.${item.id}`, item.id); continue; }
      color.set(item.id, 1);
      stack.push({ ...item, exiting: true });
      for (const child of edges.get(item.id) ?? []) stack.push({ id: child, depth: item.depth + 1, exiting: false });
    }
  }
}
