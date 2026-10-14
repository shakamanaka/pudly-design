import { validateProviderRunMetadata } from './providers.js';
import { parseBatch } from './operations.js';
import { validateComponents } from './component-validation.js';
import { validateNode, validateToken, type TokenIndex } from './document-shapes.js';
import type { AgentRunRecord, ContextReference, DesignDocumentFragment, Diagnostic, RunState, ValidationResult } from './types.js';
import { addDiagnostic, hasOnlyKeys, inspectJsonGraph, isNonNegativeInteger, isRecord, safeSerializedSize, validationFailure, validationOk } from './validation-utils.js';

export const MAX_RUN_RECORD_BYTES = 8 * 1024 * 1024;
const MAX_RUN_DIAGNOSTICS = 2_000;
const MAX_RUN_OPERATIONS = 500;
const RUN_STATES: readonly RunState[] = [
  'QUEUED', 'PLANNING', 'RUNNING', 'VALIDATING_OPERATIONS', 'APPLYING', 'RENDERING', 'QA', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'ROLLED_BACK',
];
const CONTEXT_SCOPES: readonly ContextReference['scope'][] = [
  'global', 'product', 'project', 'design-system', 'page', 'frame', 'component', 'selection',
];

function invalid(diagnostics: Diagnostic[]): ValidationResult<AgentRunRecord> {
  return validationFailure(diagnostics);
}

function requiredString(value: unknown, path: string, diagnostics: Diagnostic[], maxLength = 4_000): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    addDiagnostic(diagnostics, 'run-record.string', `Expected a non-empty string no longer than ${maxLength} characters.`, path);
    return false;
  }
  return true;
}

function checkDiagnostic(value: unknown, path: string, diagnostics: Diagnostic[]): void {
  if (!isRecord(value)) { addDiagnostic(diagnostics, 'run-record.diagnostic-shape', 'Diagnostic must be an object.', path); return; }
  if (!hasOnlyKeys(value, ['code', 'message', 'severity', 'operationIndex', 'targetId', 'path', 'details'], path, diagnostics)) return;
  requiredString(value.code, `${path}.code`, diagnostics, 160);
  requiredString(value.message, `${path}.message`, diagnostics, 2_000);
  if (!['error', 'warning', 'info'].includes(String(value.severity))) addDiagnostic(diagnostics, 'run-record.diagnostic-severity', 'Diagnostic severity is invalid.', `${path}.severity`);
  if (value.operationIndex !== undefined && !isNonNegativeInteger(value.operationIndex)) addDiagnostic(diagnostics, 'run-record.diagnostic-index', 'Diagnostic operationIndex must be a non-negative safe integer.', `${path}.operationIndex`);
  for (const field of ['targetId', 'path'] as const) if (value[field] !== undefined) requiredString(value[field], `${path}.${field}`, diagnostics, 2_000);
  if (value.details !== undefined) {
    if (!isRecord(value.details)) addDiagnostic(diagnostics, 'run-record.diagnostic-details', 'Diagnostic details must be a scalar object.', `${path}.details`);
    else for (const [key, detail] of Object.entries(value.details)) {
      if (!key || key.length > 160 || !(detail === null || ['string', 'number', 'boolean'].includes(typeof detail)) || (typeof detail === 'number' && !Number.isFinite(detail)) || (typeof detail === 'string' && detail.length > 2_000)) {
        addDiagnostic(diagnostics, 'run-record.diagnostic-details', 'Diagnostic detail keys and values must be bounded scalars.', `${path}.details.${key}`);
      }
    }
  }
}

function checkContext(value: unknown, path: string, diagnostics: Diagnostic[]): void {
  if (!isRecord(value)) { addDiagnostic(diagnostics, 'run-record.context-shape', 'Context reference must be an object.', path); return; }
  if (!hasOnlyKeys(value, ['scope', 'sourceId', 'includedNodeIds'], path, diagnostics)) return;
  if (!CONTEXT_SCOPES.includes(value.scope as ContextReference['scope'])) addDiagnostic(diagnostics, 'run-record.context-scope', 'Context scope is invalid.', `${path}.scope`);
  if (value.sourceId !== undefined) requiredString(value.sourceId, `${path}.sourceId`, diagnostics, 256);
  if (value.includedNodeIds !== undefined) {
    if (!Array.isArray(value.includedNodeIds) || value.includedNodeIds.length > 10_000) addDiagnostic(diagnostics, 'run-record.context-nodes', 'includedNodeIds must be an array of at most 10,000 IDs.', `${path}.includedNodeIds`);
    else value.includedNodeIds.forEach((id, index) => requiredString(id, `${path}.includedNodeIds[${index}]`, diagnostics, 256));
  }
}

function checkPolicy(value: unknown, path: string, diagnostics: Diagnostic[]): void {
  if (!isRecord(value)) { addDiagnostic(diagnostics, 'run-record.policy-shape', 'Design-system policy must be an object.', path); return; }
  if (!hasOnlyKeys(value, ['rules', 'minimumSpacingPx'], path, diagnostics)) return;
  if (!isRecord(value.rules)) { addDiagnostic(diagnostics, 'run-record.policy-rules', 'Policy rules must be an object.', `${path}.rules`); return; }
  if (!hasOnlyKeys(value.rules, ['literal-color', 'literal-spacing', 'minimum-spacing', 'detached-instance'], `${path}.rules`, diagnostics)) return;
  for (const rule of ['literal-color', 'literal-spacing', 'minimum-spacing', 'detached-instance']) {
    if (!['off', 'info', 'warning', 'error'].includes(String(value.rules[rule]))) addDiagnostic(diagnostics, 'run-record.policy-severity', 'Policy rule severity is invalid.', `${path}.rules.${rule}`);
  }
  if (typeof value.minimumSpacingPx !== 'number' || !Number.isFinite(value.minimumSpacingPx) || value.minimumSpacingPx < 0) addDiagnostic(diagnostics, 'run-record.policy-spacing', 'minimumSpacingPx must be finite and non-negative.', `${path}.minimumSpacingPx`);
}

function checkFragment(value: unknown, path: string, diagnostics: Diagnostic[]): void {
  if (!isRecord(value)) { addDiagnostic(diagnostics, 'run-record.fragment-shape', 'Document fragment must be an object.', path); return; }
  if (!hasOnlyKeys(value, ['documentId', 'revision', 'page', 'nodes', 'tokens', 'components'], path, diagnostics)) return;
  requiredString(value.documentId, `${path}.documentId`, diagnostics, 256);
  if (!isNonNegativeInteger(value.revision)) addDiagnostic(diagnostics, 'run-record.fragment-revision', 'Fragment revision must be a non-negative safe integer.', `${path}.revision`);
  if (value.page !== undefined) {
    if (!isRecord(value.page)) { addDiagnostic(diagnostics, 'run-record.fragment-page-shape', 'Fragment page must be an object.', `${path}.page`); return; }
    if (!hasOnlyKeys(value.page, ['id', 'name', 'rootNodeIds'], `${path}.page`, diagnostics)) return;
    requiredString(value.page.id, `${path}.page.id`, diagnostics, 256);
    requiredString(value.page.name, `${path}.page.name`, diagnostics, 256);
    if (!Array.isArray(value.page.rootNodeIds) || value.page.rootNodeIds.length > 10_000) addDiagnostic(diagnostics, 'run-record.fragment-page', 'Page rootNodeIds must be a bounded array.', `${path}.page.rootNodeIds`);
    else value.page.rootNodeIds.forEach((id, index) => requiredString(id, `${path}.page.rootNodeIds[${index}]`, diagnostics, 256));
  }
  for (const field of ['nodes', 'tokens', 'components'] as const) if (!isRecord(value[field])) addDiagnostic(diagnostics, 'run-record.fragment-record', `${field} must be an object.`, `${path}.${field}`);
  if (!isRecord(value.nodes) || !isRecord(value.tokens) || !isRecord(value.components)) return;
  if (Object.keys(value.nodes).length > 10_000 || Object.keys(value.tokens).length > 10_000 || Object.keys(value.components).length > 2_000) {
    addDiagnostic(diagnostics, 'run-record.fragment-limit', 'Design fragment exceeds its record count limit.', path);
    return;
  }
  const tokens: TokenIndex = new Map();
  for (const [tokenId, token] of Object.entries(value.tokens)) {
    const before = diagnostics.length;
    if (validateToken(token, `${path}.tokens.${tokenId}`, diagnostics)) tokens.set(tokenId, token as DesignDocumentFragment['tokens'][string]);
    else if (diagnostics.length === before) addDiagnostic(diagnostics, 'run-record.fragment-token', 'Token shape is invalid.', `${path}.tokens.${tokenId}`);
  }
  for (const [nodeId, node] of Object.entries(value.nodes)) {
    const before = diagnostics.length;
    if (!validateNode(node, `${path}.nodes.${nodeId}`, diagnostics, tokens) && diagnostics.length === before) addDiagnostic(diagnostics, 'run-record.fragment-node', 'Node shape is invalid.', `${path}.nodes.${nodeId}`);
    if (isRecord(node) && node.id !== nodeId) addDiagnostic(diagnostics, 'run-record.fragment-node-id', 'Node map key must match its id.', `${path}.nodes.${nodeId}.id`);
  }
  validateComponents({ components: value.components, nodes: value.nodes, tokens: value.tokens }, diagnostics);
}

/** Strictly validates persisted run data before it enters the application. */
export function validateAgentRunRecord(input: unknown): ValidationResult<AgentRunRecord> {
  const diagnostics = inspectJsonGraph(input, 1_000_000, 100);
  if (diagnostics.length > 0) return invalid(diagnostics);
  const size = safeSerializedSize(input);
  if (size === null || size > MAX_RUN_RECORD_BYTES) {
    addDiagnostic(diagnostics, 'limit.run-record-bytes', `Run record exceeds ${MAX_RUN_RECORD_BYTES} serialized bytes.`, '$');
    return invalid(diagnostics);
  }
  const keys = ['id', 'documentId', 'baseRevision', 'committedRevision', 'operations', 'userRequest', 'selectedNodeIds', 'resolvedContext', 'operationCapabilities', 'state', 'startedAt', 'finishedAt', 'batchId', 'validationResults', 'snapshotBefore', 'snapshotAfter', 'qaResults', 'designSystemContext', 'documentFragment', 'providerSelection'];
  if (!isRecord(input)) { addDiagnostic(diagnostics, 'run-record.object', 'Run record must be an object.', '$'); return invalid(diagnostics); }
  if (!hasOnlyKeys(input, keys, '$', diagnostics)) return invalid(diagnostics);
  if (input.providerSelection !== undefined) {
    const parsed = validateProviderRunMetadata(input.providerSelection);
    if (!parsed.ok) addDiagnostic(diagnostics, parsed.code, parsed.message, '$.providerSelection');
  }
  if (typeof input.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.id)) addDiagnostic(diagnostics, 'run-record.id', 'Run ID must be a UUID.', '$.id');
  requiredString(input.documentId, '$.documentId', diagnostics, 256);
  if (!isNonNegativeInteger(input.baseRevision)) addDiagnostic(diagnostics, 'run-record.revision', 'baseRevision must be a non-negative safe integer.', '$.baseRevision');
  if (input.committedRevision !== undefined && !isNonNegativeInteger(input.committedRevision)) addDiagnostic(diagnostics, 'run-record.revision', 'committedRevision must be a non-negative safe integer.', '$.committedRevision');
  requiredString(input.userRequest, '$.userRequest', diagnostics, 20_000);
  requiredString(input.startedAt, '$.startedAt', diagnostics, 100);
  if (!Array.isArray(input.selectedNodeIds) || input.selectedNodeIds.length > 10_000) addDiagnostic(diagnostics, 'run-record.selection', 'selectedNodeIds must be a bounded array.', '$.selectedNodeIds');
  else input.selectedNodeIds.forEach((id, index) => requiredString(id, `$.selectedNodeIds[${index}]`, diagnostics, 256));
  if (!Array.isArray(input.resolvedContext) || input.resolvedContext.length > 100) addDiagnostic(diagnostics, 'run-record.context', 'resolvedContext must be an array of at most 100 entries.', '$.resolvedContext');
  else input.resolvedContext.forEach((entry, index) => checkContext(entry, `$.resolvedContext[${index}]`, diagnostics));
  if (!Array.isArray(input.operationCapabilities) || input.operationCapabilities.length > 100) addDiagnostic(diagnostics, 'run-record.capabilities', 'operationCapabilities must be a bounded array.', '$.operationCapabilities');
  else input.operationCapabilities.forEach((capability, index) => requiredString(capability, `$.operationCapabilities[${index}]`, diagnostics, 128));
  if (!RUN_STATES.includes(input.state as RunState)) addDiagnostic(diagnostics, 'run-record.state', 'Run state is invalid.', '$.state');
  for (const field of ['startedAt', 'finishedAt'] as const) {
    if (input[field] !== undefined && (typeof input[field] !== 'string' || Number.isNaN(Date.parse(input[field] as string)))) addDiagnostic(diagnostics, 'run-record.timestamp', `${field} must be a valid timestamp.`, `$.${field}`);
  }
  for (const field of ['batchId', 'snapshotBefore', 'snapshotAfter'] as const) if (input[field] !== undefined) requiredString(input[field], `$.${field}`, diagnostics, 256);
  for (const field of ['validationResults', 'qaResults'] as const) {
    if (!Array.isArray(input[field]) || input[field].length > MAX_RUN_DIAGNOSTICS) addDiagnostic(diagnostics, 'run-record.diagnostics', `${field} must contain at most ${MAX_RUN_DIAGNOSTICS} diagnostics.`, `$.${field}`);
    else input[field].forEach((item, index) => checkDiagnostic(item, `$.${field}[${index}]`, diagnostics));
  }
  if (input.operations !== undefined) {
    if (!Array.isArray(input.operations) || input.operations.length === 0 || input.operations.length > MAX_RUN_OPERATIONS) addDiagnostic(diagnostics, 'run-record.operations', `operations must contain 1 to ${MAX_RUN_OPERATIONS} operations.`, '$.operations');
    else {
      const parsed = parseBatch({
        id: input.batchId ?? 'run-record-validation', documentId: input.documentId,
        expectedRevision: input.baseRevision, source: 'agent', runId: input.id,
        capabilitySet: input.operationCapabilities, operations: input.operations,
      });
      if (!parsed.ok) diagnostics.push(...parsed.diagnostics.map(item => ({ ...item, path: item.path ? `$.operations${item.path.slice('$.operations'.length)}` : '$.operations' })));
    }
  }
  if (input.designSystemContext !== undefined) {
    if (!isRecord(input.designSystemContext)) { addDiagnostic(diagnostics, 'run-record.design-system-context', 'Design-system context must be an object.', '$.designSystemContext'); return invalid(diagnostics); }
    if (!hasOnlyKeys(input.designSystemContext, ['policy', 'catalog'], '$.designSystemContext', diagnostics)) return invalid(diagnostics);
    checkPolicy(input.designSystemContext.policy, '$.designSystemContext.policy', diagnostics);
    if (!isRecord(input.designSystemContext.catalog) || Object.keys(input.designSystemContext.catalog).length > 2_000) addDiagnostic(diagnostics, 'run-record.catalog', 'Component catalog must be a bounded object.', '$.designSystemContext.catalog');
    else for (const [id, entry] of Object.entries(input.designSystemContext.catalog)) {
      const path = `$.designSystemContext.catalog.${id}`;
      if (!isRecord(entry)) { addDiagnostic(diagnostics, 'run-record.catalog-entry', 'Catalog entry must be an object.', path); continue; }
      if (!hasOnlyKeys(entry, ['semanticRole', 'description', 'usageRules'], path, diagnostics)) continue;
      requiredString(entry.semanticRole, `${path}.semanticRole`, diagnostics, 256);
      requiredString(entry.description, `${path}.description`, diagnostics, 2_000);
      if (!Array.isArray(entry.usageRules) || entry.usageRules.length > 100) addDiagnostic(diagnostics, 'run-record.catalog-rules', 'usageRules must be a bounded array.', `${path}.usageRules`);
      else entry.usageRules.forEach((rule, index) => requiredString(rule, `${path}.usageRules[${index}]`, diagnostics, 1_000));
    }
  }
  if (input.documentFragment !== undefined) checkFragment(input.documentFragment, '$.documentFragment', diagnostics);
  if (diagnostics.length > 0) return invalid(diagnostics);
  return validationOk(input as unknown as AgentRunRecord, diagnostics);
}
