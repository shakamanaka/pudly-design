import { DEFAULT_OPERATION_CAPABILITIES } from './defaults.js';
import { MAX_BATCH_BYTES, MAX_BATCH_OPERATIONS } from './validation-utils.js';
import { validateDocument } from './document.js';
import { DEFAULT_DESIGN_SYSTEM_POLICY, validateDesignSystem } from './design-system-policy.js';
import type {
  ApplyResult,
  DesignDocument,
  Diagnostic,
  Layout,
  NodeId,
  NodeLocation,
  Operation,
  OperationBatch,
  OperationScope,
  OperationType,
  PageId,
  PropertyMutation,
  SemanticStyle,
  ValidationResult,
} from './types.js';
import {
  addDiagnostic,
  hasOnlyKeys,
  inspectJsonGraph,
  isNonNegativeInteger,
  isRecord,
  safeSerializedSize,
  validationFailure,
  validationOk,
} from './validation-utils.js';

export const SUPPORTED_OPERATION_TYPES: readonly OperationType[] = DEFAULT_OPERATION_CAPABILITIES;

function fail<T>(diagnostics: Diagnostic[]): ValidationResult<T> {
  return validationFailure(diagnostics);
}
function checkOperation(value: unknown, path: string, ds: Diagnostic[]): value is Operation {
  if (!isRecord(value) || typeof value.type !== 'string') {
    addDiagnostic(ds, 'operation.shape', 'Operation must be an object with a type.', path);
    return false;
  }
  const type = value.type;
  const keysByType: Record<string, readonly string[]> = {
    'node.create': ['type', 'node', 'parentId', 'pageId', 'index'],
    'node.delete': ['type', 'nodeId', 'mode'],
    'node.move': ['type', 'nodeId', 'parentId', 'pageId', 'index'],
    'property.set': ['type', 'nodeId', 'change'],
    'layout.set': ['type', 'nodeId', 'value'],
    'style.set': ['type', 'nodeId', 'value'],
  };
  const keys = keysByType[type];
  if (keys === undefined || !SUPPORTED_OPERATION_TYPES.includes(type as OperationType)) {
    addDiagnostic(ds, 'operation.unsupported', `Operation type ${type} is not implemented.`, `${path}.type`);
    return false;
  }
  let valid = hasOnlyKeys(value, keys, path, ds);
  const stringValue = (field: string, optional = false) => {
    if (optional && value[field] === undefined) return;
    if (typeof value[field] !== 'string' || value[field] === '') {
      addDiagnostic(ds, 'operation.string', `${field} must be a non-empty string.`, `${path}.${field}`);
      valid = false;
    }
  };
  const indexValue = (field: string) => {
    if (!isNonNegativeInteger(value[field])) {
      addDiagnostic(ds, 'operation.index', `${field} must be a non-negative safe integer.`, `${path}.${field}`);
      valid = false;
    }
  };
  switch (type) {
    case 'node.create':
      stringValue('pageId'); stringValue('parentId', true); indexValue('index');
      if (!isRecord(value.node) || typeof value.node.kind !== 'string') {
        addDiagnostic(ds, 'operation.node', 'node.create requires a typed design node.', `${path}.node`);
        valid = false;
      } else if (!Array.isArray(value.node.childIds) || value.node.childIds.length !== 0) {
        addDiagnostic(ds, 'operation.node-children', 'Created nodes must start with empty childIds.', `${path}.node.childIds`);
        valid = false;
      }
      break;
    case 'node.delete':
      stringValue('nodeId');
      if (value.mode !== 'subtree' && value.mode !== 'reject-if-children') {
        addDiagnostic(ds, 'operation.delete-mode', 'Delete mode must be subtree or reject-if-children.', `${path}.mode`);
        valid = false;
      }
      break;
    case 'node.move':
      stringValue('nodeId'); stringValue('pageId'); stringValue('parentId', true); indexValue('index');
      break;
    case 'property.set':
      stringValue('nodeId');
      if (!isRecord(value.change) || !hasOnlyKeys(value.change, ['property', 'value'], `${path}.change`, ds)) valid = false;
      else if (value.change.property === 'name' || value.change.property === 'text' || value.change.property === 'variantId') {
        if (typeof value.change.value !== 'string') { addDiagnostic(ds, 'operation.property-value', 'Property value must be a string.', `${path}.change.value`); valid = false; }
      } else if (value.change.property === 'visible') {
        if (typeof value.change.value !== 'boolean') { addDiagnostic(ds, 'operation.property-value', 'visible value must be boolean.', `${path}.change.value`); valid = false; }
      } else if (value.change.property === 'propertyOverrides') {
        if (!isRecord(value.change.value)) { addDiagnostic(ds, 'operation.property-value', 'propertyOverrides must be an object.', `${path}.change.value`); valid = false; }
      } else { addDiagnostic(ds, 'operation.property', 'Unsupported property mutation.', `${path}.change.property`); valid = false; }
      break;
    case 'layout.set':
      stringValue('nodeId');
      if (!isRecord(value.value)) { addDiagnostic(ds, 'operation.layout', 'Layout value must be an object.', `${path}.value`); valid = false; }
      break;
    case 'style.set':
      stringValue('nodeId');
      if (!isRecord(value.value)) { addDiagnostic(ds, 'operation.style', 'Style value must be an object.', `${path}.value`); valid = false; }
      break;
  }
  return valid;
}

export function parseBatch(input: unknown): ValidationResult<OperationBatch> {
  const diagnostics = inspectJsonGraph(input, 100_000, 80);
  if (diagnostics.length > 0) return fail(diagnostics);
  const bytes = safeSerializedSize(input);
  if (bytes === null || bytes > MAX_BATCH_BYTES) {
    addDiagnostic(diagnostics, 'limit.batch-bytes', `Batch exceeds ${MAX_BATCH_BYTES} serialized bytes.`, '$');
    return fail(diagnostics);
  }
  if (!isRecord(input)) {
    addDiagnostic(diagnostics, 'batch.object', 'Batch must be a plain object.', '$');
    return fail(diagnostics);
  }
  hasOnlyKeys(input, ['id', 'documentId', 'expectedRevision', 'source', 'actorId', 'runId', 'capabilitySet', 'operations'], '$', diagnostics);
  for (const key of ['id', 'documentId'] as const) if (typeof input[key] !== 'string' || input[key] === '') addDiagnostic(diagnostics, 'batch.id', `${key} must be a non-empty string.`, `$.${key}`);
  if (!isNonNegativeInteger(input.expectedRevision)) addDiagnostic(diagnostics, 'batch.revision', 'expectedRevision must be a non-negative safe integer.', '$.expectedRevision');
  if (!['agent', 'inspector', 'toolbar', 'keyboard', 'system'].includes(String(input.source))) addDiagnostic(diagnostics, 'batch.source', 'Unsupported batch source.', '$.source');
  for (const optional of ['actorId', 'runId'] as const) if (input[optional] !== undefined && typeof input[optional] !== 'string') addDiagnostic(diagnostics, 'batch.field', `${optional} must be a string.`, `$.${optional}`);
  if (!Array.isArray(input.capabilitySet) || input.capabilitySet.some((cap) => typeof cap !== 'string')) addDiagnostic(diagnostics, 'batch.capabilities', 'capabilitySet must be an array of operation names.', '$.capabilitySet');
  if (!Array.isArray(input.operations)) addDiagnostic(diagnostics, 'batch.operations', 'operations must be an array.', '$.operations');
  else {
    if (input.operations.length === 0) addDiagnostic(diagnostics, 'batch.empty', 'Batch must contain at least one operation.', '$.operations');
    if (input.operations.length > MAX_BATCH_OPERATIONS) {
      addDiagnostic(diagnostics, 'limit.operations', `Batch exceeds ${MAX_BATCH_OPERATIONS} operations.`, '$.operations');
      return fail(diagnostics);
    }
    input.operations.forEach((op, index) => {
      const before = diagnostics.length;
      if (!checkOperation(op, `$.operations[${index}]`, diagnostics) && diagnostics.length === before) addDiagnostic(diagnostics, 'operation.shape', 'Operation payload is malformed.', `$.operations[${index}]`, undefined, index);
    });
  }
  if (Array.isArray(input.capabilitySet)) {
    const caps = new Set(input.capabilitySet.filter((c): c is string => typeof c === 'string'));
    for (const [index, op] of (Array.isArray(input.operations) ? input.operations : []).entries()) {
      if (isRecord(op) && typeof op.type === 'string' && !caps.has(op.type)) addDiagnostic(diagnostics, 'operation.capability', 'Operation is not included in the negotiated capability set.', `$.operations[${index}].type`, undefined, index);
      if (isRecord(op) && typeof op.type === 'string' && !SUPPORTED_OPERATION_TYPES.includes(op.type as OperationType)) addDiagnostic(diagnostics, 'operation.unavailable', 'Operation is not implemented by this runtime.', `$.operations[${index}].type`, undefined, index);
    }
    for (const cap of caps) if (!SUPPORTED_OPERATION_TYPES.includes(cap as OperationType)) addDiagnostic(diagnostics, 'operation.capability-unavailable', `Capability ${cap} is not implemented.`, '$.capabilitySet');
  }
  if (diagnostics.length > 0) return fail(diagnostics);
  return validationOk(input as unknown as OperationBatch, diagnostics);
}

function locateNode(document: DesignDocument, nodeId: NodeId): (NodeLocation & { slotId?: string }) | null {
  for (const page of Object.values(document.pages)) {
    const index = page.rootNodeIds.indexOf(nodeId);
    if (index >= 0) return { pageId: page.id, index };
  }
  for (const node of Object.values(document.nodes)) {
    if (node.kind === 'frame' || node.kind === 'group') {
      const index = node.childIds.indexOf(nodeId);
      if (index >= 0) return { pageId: findPageId(document, node.id), parentId: node.id, index };
    }
    if (node.kind === 'component-instance') {
      for (const [slotId, ids] of Object.entries(node.slotChildren)) {
        const index = ids.indexOf(nodeId);
        if (index >= 0) return { pageId: findPageId(document, node.id), parentId: node.id, index, slotId };
      }
    }
  }
  return null;
}
function findPageId(document: DesignDocument, nodeId: NodeId): PageId {
  let current = nodeId;
  const seen = new Set<string>();
  while (!seen.has(current)) {
    seen.add(current);
    const location = locateNodeShallow(document, current);
    if (location === null) return document.pageOrder[0] ?? '';
    if (location.parentId === undefined) return location.pageId;
    current = location.parentId;
  }
  return document.pageOrder[0] ?? '';
}
function locateNodeShallow(document: DesignDocument, nodeId: NodeId): NodeLocation | null {
  for (const page of Object.values(document.pages)) {
    const index = page.rootNodeIds.indexOf(nodeId);
    if (index >= 0) return { pageId: page.id, index };
  }
  for (const parent of Object.values(document.nodes)) {
    const children = parent.kind === 'frame' || parent.kind === 'group' ? parent.childIds : parent.kind === 'component-instance' ? Object.values(parent.slotChildren).flat() : [];
    const index = children.indexOf(nodeId);
    if (index >= 0) return { pageId: '', parentId: parent.id, index };
  }
  return null;
}
function removeFromOwner(document: DesignDocument, nodeId: NodeId): NodeLocation | null {
  const location = locateNode(document, nodeId);
  if (location === null) return null;
  if (location.parentId === undefined) {
    document.pages[location.pageId]?.rootNodeIds.splice(location.index, 1);
  } else {
    const parent = document.nodes[location.parentId];
    if (parent?.kind === 'frame' || parent?.kind === 'group') parent.childIds.splice(location.index, 1);
    else if (parent?.kind === 'component-instance') {
      const slot = Object.entries(parent.slotChildren).find(([, ids]) => ids.includes(nodeId))?.[0];
      if (slot !== undefined) parent.slotChildren[slot]?.splice(location.index, 1);
    }
  }
  return location;
}
function insertAt(document: DesignDocument, nodeId: NodeId, pageId: PageId, parentId: NodeId | undefined, index: number): boolean {
  if (parentId === undefined) {
    const page = document.pages[pageId];
    if (page === undefined || index > page.rootNodeIds.length) return false;
    page.rootNodeIds.splice(index, 0, nodeId);
    return true;
  }
  const parent = document.nodes[parentId];
  if (parent?.kind === 'frame' || parent?.kind === 'group') {
    if (index > parent.childIds.length) return false;
    parent.childIds.splice(index, 0, nodeId);
    return true;
  }
  return false;
}
function collectSubtree(document: DesignDocument, rootId: NodeId): NodeId[] {
  const result: NodeId[] = [];
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop();
    if (id === undefined) continue;
    const node = document.nodes[id];
    if (node === undefined) continue;
    result.push(id);
    const children = node.kind === 'frame' || node.kind === 'group' ? node.childIds : node.kind === 'component-instance' ? Object.values(node.slotChildren).flat() : [];
    for (let i = children.length - 1; i >= 0; i -= 1) if (children[i] !== undefined) stack.push(children[i]!);
  }
  return result;
}
function authorized(nodeId: string, batch: OperationBatch, scope?: OperationScope, operationIndex?: number, createdNodeIds?: ReadonlySet<string>): Diagnostic | null {
  const allowedOps = scope?.allowedOperationTypes ?? SUPPORTED_OPERATION_TYPES;
  const op = operationIndex === undefined ? undefined : batch.operations[operationIndex];
  if (op !== undefined && !allowedOps.includes(op.type)) { const diagnostic: Diagnostic = { code: 'scope.operation', message: 'Operation is outside the authorized capability scope.', severity: 'error' }; if (operationIndex !== undefined) diagnostic.operationIndex = operationIndex; return diagnostic; }
  if (scope?.allowedNodeIds !== undefined && !scope.allowedNodeIds.includes(nodeId) && !createdNodeIds?.has(nodeId)) { const diagnostic: Diagnostic = { code: 'scope.node', message: 'Node is outside the authorized selection scope.', severity: 'error', targetId: nodeId }; if (operationIndex !== undefined) diagnostic.operationIndex = operationIndex; return diagnostic; }
  return null;
}
function applyOne(document: DesignDocument, operation: Operation, index: number, batch: OperationBatch, scope?: OperationScope, createdNodeIds?: Set<string>): { inverse?: Operation[]; diagnostic?: Diagnostic } {
  const bad = (code: string, message: string, targetId?: string): { diagnostic: Diagnostic } => {
    const d: Diagnostic = { code, message, severity: 'error', operationIndex: index };
    if (targetId !== undefined) d.targetId = targetId;
    return { diagnostic: d };
  };
  if (operation.type !== 'node.create' && !Object.hasOwn(document.nodes, operation.nodeId)) return bad('node.missing', 'Operation target does not exist.', operation.nodeId);
  if (operation.type === 'node.create') {
    const node = structuredClone(operation.node);
    if (Object.hasOwn(document.nodes, node.id)) return bad('node.id-duplicate', 'Node ID already exists.', node.id);
    if (operation.parentId !== undefined) {
      const parent = document.nodes[operation.parentId];
      if (parent?.kind !== 'frame' && parent?.kind !== 'group') return bad('node.parent', 'New node parent must be an existing frame or group.', operation.parentId);
      const auth = authorized(operation.parentId, batch, scope, index, createdNodeIds); if (auth) return { diagnostic: auth };
    }
    if (!Object.hasOwn(document.pages, operation.pageId)) return bad('page.missing', 'Target page does not exist.', operation.pageId);
    if (scope?.allowedNodeIds !== undefined && operation.parentId === undefined && !(scope.allowedPageIds ?? []).includes(operation.pageId)) return bad('scope.page', 'Creating a page-root node is outside the authorized scope.', operation.pageId);
    if (operation.parentId !== undefined && findPageId(document, operation.parentId) !== operation.pageId) return bad('node.page-mismatch', 'Parent node belongs to a different page.', operation.parentId);
    if (operation.index > (operation.parentId ? (document.nodes[operation.parentId] as { childIds: string[] }).childIds.length : document.pages[operation.pageId]!.rootNodeIds.length)) return bad('node.index', 'Insertion index is out of bounds.');
    document.nodes[node.id] = node;
    if (!insertAt(document, node.id, operation.pageId, operation.parentId, operation.index)) return bad('node.insert', 'Could not insert new node.');
    if (scope?.allowedNodeIds !== undefined) createdNodeIds?.add(node.id);
    return { inverse: [{ type: 'node.delete', nodeId: node.id, mode: 'subtree' }] };
  }
  if (operation.type === 'node.delete') {
    const auth = authorized(operation.nodeId, batch, scope, index, createdNodeIds); if (auth) return { diagnostic: auth };
    const node = document.nodes[operation.nodeId];
    if (node === undefined) return bad('node.missing', 'Node to delete does not exist.', operation.nodeId);
    const children = node.kind === 'frame' || node.kind === 'group' ? node.childIds : node.kind === 'component-instance' ? Object.values(node.slotChildren).flat() : [];
    if (operation.mode === 'reject-if-children' && children.length > 0) return bad('node.has-children', 'Node has children and delete mode rejects them.', operation.nodeId);
    const location = locateNode(document, operation.nodeId);
    if (location === null) return bad('node.unowned', 'Node has no owner.', operation.nodeId);
    if ('slotId' in location && location.slotId !== undefined) return bad('operation.slot-unsupported', 'Direct deletion of component slot children is not implemented.', operation.nodeId);
    const all = operation.mode === 'subtree' ? collectSubtree(document, operation.nodeId) : [operation.nodeId];
    if (all.some((id) => { const item = document.nodes[id]; return item?.kind === 'component-instance' && Object.values(item.slotChildren).some((ids) => ids.length > 0); })) return bad('operation.slot-unsupported', 'Subtree deletion cannot be inverted when component slot content exists in the walking skeleton.', operation.nodeId);
    const inverse: Operation[] = [];
    for (const id of all) {
      const current = document.nodes[id];
      if (current === undefined) continue;
      const loc = locateNode(document, id);
      if (loc === null) return bad('node.unowned', 'Deleted node has no owner.', id);
      const copy = structuredClone(current);
      copy.childIds = [];
      if (copy.kind === 'component-instance' && Object.values(copy.slotChildren).some((ids) => ids.length > 0)) return bad('operation.slot-unsupported', 'Subtree deletion cannot be inverted when component slot content exists in the walking skeleton.', id);
      if (copy.kind === 'component-instance') copy.slotChildren = Object.fromEntries(Object.keys(copy.slotChildren).map((slotId) => [slotId, []]));
      inverse.push({ type: 'node.create', node: copy, pageId: loc.pageId, ...(loc.parentId === undefined ? {} : { parentId: loc.parentId }), index: loc.index });
    }
    removeFromOwner(document, operation.nodeId);
    for (const id of all) delete document.nodes[id];
    return { inverse };
  }
  if (operation.type === 'node.move') {
    const auth = authorized(operation.nodeId, batch, scope, index, createdNodeIds); if (auth) return { diagnostic: auth };
    if (!document.nodes[operation.nodeId]) return bad('node.missing', 'Node to move does not exist.', operation.nodeId);
    if (!Object.hasOwn(document.pages, operation.pageId)) return bad('page.missing', 'Target page does not exist.', operation.pageId);
    if (operation.parentId !== undefined) {
      const parent = document.nodes[operation.parentId];
      if (parent?.kind !== 'frame' && parent?.kind !== 'group') return bad('node.parent', 'Target parent must be an existing frame or group.', operation.parentId);
      if (findPageId(document, operation.parentId) !== operation.pageId) return bad('node.page-mismatch', 'Parent node belongs to a different page.', operation.parentId);
      const parentAuth = authorized(operation.parentId, batch, scope, index, createdNodeIds); if (parentAuth) return { diagnostic: parentAuth };
    }
    const old = locateNode(document, operation.nodeId);
    if (old === null) return bad('node.unowned', 'Node has no current owner.', operation.nodeId);
    if ('slotId' in old && old.slotId !== undefined) return bad('operation.slot-unsupported', 'Moving component slot children is not implemented.', operation.nodeId);
    const subtree = new Set(collectSubtree(document, operation.nodeId));
    if (operation.parentId !== undefined && subtree.has(operation.parentId)) return bad('node.cycle', 'Cannot move a node into its own subtree.', operation.parentId);
    const oldOperation: Operation = { type: 'node.move', nodeId: operation.nodeId, pageId: old.pageId, index: old.index, ...(old.parentId === undefined ? {} : { parentId: old.parentId }),  };
    removeFromOwner(document, operation.nodeId);
    if (scope?.allowedNodeIds !== undefined && operation.parentId === undefined && !(scope.allowedPageIds ?? []).includes(operation.pageId)) return bad('scope.page', 'Moving a node to a page root is outside the authorized scope.', operation.pageId);
    if (!insertAt(document, operation.nodeId, operation.pageId, operation.parentId, operation.index)) return bad('node.index', 'Target insertion index is out of bounds.');
    return { inverse: [oldOperation] };
  }
  const nodeId = operation.nodeId;
  const auth = authorized(nodeId, batch, scope, index, createdNodeIds); if (auth) return { diagnostic: auth };
  const node = document.nodes[nodeId];
  if (node === undefined) return bad('node.missing', 'Operation target does not exist.', nodeId);
  if (operation.type === 'property.set') {
    const change = operation.change as PropertyMutation;
    if (change.property === 'name') { const old = node.name; node.name = change.value; return { inverse: [{ type: 'property.set', nodeId, change: { property: 'name', value: old } }] }; }
    if (change.property === 'visible') { const old = node.visible; node.visible = change.value; return { inverse: [{ type: 'property.set', nodeId, change: { property: 'visible', value: old } }] }; }
    if (change.property === 'variantId' || change.property === 'propertyOverrides') {
      if (node.kind !== 'component-instance') return bad('node.property-kind', 'Component properties require a component instance.', nodeId);
      if (change.property === 'variantId') {
        const old = node.variantId; node.variantId = change.value;
        return { inverse: [{ type: 'property.set', nodeId, change: { property: 'variantId', value: old } }] };
      }
      const old = structuredClone(node.propertyOverrides); node.propertyOverrides = structuredClone(change.value);
      return { inverse: [{ type: 'property.set', nodeId, change: { property: 'propertyOverrides', value: old } }] };
    }
    if (node.kind !== 'text') return bad('node.property-kind', 'Only text nodes have editable text content.', nodeId);
    const old = node.text; node.text = change.value;
    return { inverse: [{ type: 'property.set', nodeId, change: { property: 'text', value: old } }] };
  }
  if (operation.type === 'layout.set') {
    const old = structuredClone(node.layout); node.layout = structuredClone(operation.value as Layout);
    return { inverse: [{ type: 'layout.set', nodeId, value: old }] };
  }
  if (operation.type === 'style.set') {
    const old = structuredClone(node.style); node.style = structuredClone(operation.value as SemanticStyle);
    return { inverse: [{ type: 'style.set', nodeId, value: old }] };
  }
  return bad('operation.unsupported', 'Operation is not implemented.', nodeId);
}

export function applyBatch(
  documentInput: unknown,
  batchInput: unknown,
  appliedBatchIds: ReadonlySet<string> | readonly string[],
  scope?: OperationScope,
): ApplyResult {
  const batchResult = parseBatch(batchInput);
  const batchId = isRecord(batchInput) && typeof batchInput.id === 'string' ? batchInput.id : 'invalid-batch';
  const revision = isRecord(documentInput) && typeof documentInput.revision === 'number' ? documentInput.revision : 0;
  const reject = (diagnostics: Diagnostic[], id = batchId, rev = revision): ApplyResult => {
    if (diagnostics.length === 0) diagnostics.push({ code: 'batch.rejected', message: 'Batch was rejected.', severity: 'error' });
    return { status: 'rejected', batchId: id, revision: rev, diagnostics: diagnostics as [Diagnostic, ...Diagnostic[]] };
  };
  if (!batchResult.ok) return reject(batchResult.diagnostics);
  const docResult = validateDocument(documentInput);
  if (!docResult.ok) return reject(docResult.diagnostics, batchResult.value.id);
  const document = docResult.value;
  const batch = batchResult.value;
  if (batch.documentId !== document.id) return reject([{ code: 'batch.document', message: 'Batch targets another document.', severity: 'error' }], batch.id, document.revision);
  if (batch.expectedRevision !== document.revision) return reject([{ code: 'revision.conflict', message: 'Expected revision differs from current revision.', severity: 'error' }], batch.id, document.revision);
  const applied = appliedBatchIds instanceof Set ? appliedBatchIds : new Set(appliedBatchIds);
  if (applied.has(batch.id)) return reject([{ code: 'batch.duplicate', message: 'Batch ID has already been applied.', severity: 'error' }], batch.id, document.revision);
  const granted = scope?.allowedOperationTypes ?? SUPPORTED_OPERATION_TYPES;
  for (const [index, op] of batch.operations.entries()) {
    if (!granted.includes(op.type)) return reject([{ code: 'scope.operation', message: 'Operation is not allowed by the active scope.', severity: 'error', operationIndex: index }], batch.id, document.revision);
  }
  const draft = structuredClone(document);
  const inverses: Operation[][] = [];
  const createdNodeIds = scope?.allowedNodeIds === undefined ? undefined : new Set<string>();
  for (const [index, operation] of batch.operations.entries()) {
    const result = applyOne(draft, operation, index, batch, scope, createdNodeIds);
    if (result.diagnostic !== undefined) return reject([result.diagnostic], batch.id, document.revision);
    inverses.push(result.inverse ?? []);
    const intermediate = validateDocument(draft);
    if (!intermediate.ok) {
      const indexed = intermediate.diagnostics.map((diagnostic) => ({ ...diagnostic, operationIndex: index }));
      return reject(indexed, batch.id, document.revision);
    }
  }
  draft.revision = document.revision + 1;
  const final = validateDocument(draft);
  if (!final.ok) return reject(final.diagnostics, batch.id, document.revision);
  const policyDiagnostics = validateDesignSystem(final.value, scope?.policy ?? DEFAULT_DESIGN_SYSTEM_POLICY);
  if (policyDiagnostics.some(issue => issue.severity === 'error')) return reject(policyDiagnostics, batch.id, document.revision);
  const inverseOperations = inverses.reverse().flat();
  return {
    status: 'committed',
    batchId: batch.id,
    beforeRevision: document.revision,
    revision: draft.revision,
    document: final.value,
    diagnostics: policyDiagnostics,
    inverseOperations,
  };
}
