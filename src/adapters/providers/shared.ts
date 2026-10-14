import { CodingAgentError } from '../../domain/agent-error.js';
import type { CodingAgentRequest, CodingAgentResponse, Diagnostic, OperationType, RunEvent, RunState } from '../../domain/types.js';
import { AgentProtocolError, buildResponseSchema, parseAgentResponse } from '../codex/protocol.js';
import { operationReference } from '../codex/operation-reference.js';
import { buildDesignBrief } from '../../application/design-brief.js';

export const DEFAULT_PROVIDER_TIMEOUT_MS = 300_000;
export const MAX_PROVIDER_OUTPUT_BYTES = 1_048_576;
export const MAX_PROVIDER_PROMPT_BYTES = 262_144;
const KNOWN_OPERATIONS = new Set<OperationType>(['node.create', 'node.delete', 'node.move', 'property.set', 'layout.set', 'style.set']);

export class ProviderAdapterError extends CodingAgentError {
  constructor(message: string, code: string) { super(code, message); this.name = 'ProviderAdapterError'; }
}

export function providerPrompt(request: CodingAgentRequest, providerName: string): { prompt: string; capabilities: OperationType[]; schema: Record<string, unknown> } {
  if (!request.runId || !Array.isArray(request.operationCapabilities) || request.operationCapabilities.length === 0) throw new ProviderAdapterError('No design operation capabilities were negotiated.', 'capability.empty');
  const capabilities = [...new Set(request.operationCapabilities)];
  if (capabilities.some(value => !KNOWN_OPERATIONS.has(value as OperationType))) throw new ProviderAdapterError('The run requested an unsupported design operation capability.', 'capability.unsupported');
  const typed = capabilities as OperationType[];
  const schema = buildResponseSchema(typed);
  const toolInstruction = providerName.trim().toLowerCase() === 'claude code'
    ? "Return only the JSON object required by the supplied schema. Use Claude Code's built-in StructuredOutput mechanism required for this schema-constrained response; it is the only permitted tool-like mechanism. Do not use filesystem, network, command-execution, or any other tools."
    : 'Return only the JSON object required by the supplied schema. Do not write files, use tools, or run commands.';
  const prompt = [
    `You produce semantic design operations for Pudly using ${providerName}.`,
    toolInstruction,
    buildDesignBrief(request),
    'Only propose operation types listed in operationCapabilities. Do not modify existing nodes outside the provided document fragment. New nodes require new unique IDs.',
    'Use operations to create or edit the design. The application validates all output and may reject it.',
    operationReference(request),
    'Input JSON follows:',
    JSON.stringify(request),
  ].join('\n');
  if (Buffer.byteLength(prompt, 'utf8') > MAX_PROVIDER_PROMPT_BYTES) throw new ProviderAdapterError('The scoped design prompt exceeds the configured size limit.', 'prompt.too_large');
  return { prompt, capabilities: typed, schema };
}

export function parseProviderJson(text: string, capabilities: readonly OperationType[]): CodingAgentResponse {
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch { throw new ProviderAdapterError('The provider returned an invalid structured response.', 'protocol.invalid_response'); }
  try { return parseAgentResponse(parsed, capabilities); }
  catch (error) {
    if (error instanceof AgentProtocolError) {
      const codes: Record<string, string> = {
        'protocol.capability': 'protocol.capability', 'protocol.unknown_field': 'protocol.unknown_field',
        'protocol.missing_field': 'protocol.missing_field', 'protocol.shape': 'protocol.shape',
        'protocol.unsafe_key': 'protocol.unsafe_key', 'protocol.duplicate_key': 'protocol.duplicate_key',
        'protocol.response_shape': 'protocol.response_shape', 'protocol.operation_count': 'protocol.operation_count',
        'protocol.summary_limit': 'protocol.summary_limit', 'protocol.response_limit': 'protocol.response_limit',
        'protocol.operation_shape': 'protocol.operation_shape',
      };
      const code = codes[error.code] ?? 'protocol.invalid_response';
      const messages: Record<string, string> = {
        'protocol.capability': 'The provider returned an operation outside the negotiated design capabilities.',
        'protocol.unknown_field': 'The provider returned an unsupported field in its design response.',
        'protocol.missing_field': 'The provider omitted a required field from its design response.',
        'protocol.shape': 'The provider returned a design operation with invalid field values or structure.',
        'protocol.unsafe_key': 'The provider returned an unsafe key in its design response.',
        'protocol.duplicate_key': 'The provider returned duplicate keys in its design response.',
        'protocol.operation_count': 'The provider returned more than 500 design operations.',
        'protocol.summary_limit': 'The provider response summary exceeds the supported length.',
        'protocol.response_limit': 'The provider response exceeds the supported size limit.',
        'protocol.operation_shape': 'The provider returned a design operation with an invalid structure.',
        'protocol.response_shape': 'The provider response is not a plain JSON object.',
      };
      throw new ProviderAdapterError(messages[code] ?? 'The provider returned a design response that could not be validated.', code);
    }
    throw new ProviderAdapterError('The provider returned a design response that could not be validated.', 'protocol.invalid_response');
  }
}

export function lifecycleEvents(runId: string, state: RunState): RunEvent {
  return { type: 'state', runId, state, at: new Date().toISOString() };
}
export function diagnosticEvent(runId: string, code: string, message: string): RunEvent {
  const diagnostic: Diagnostic = { code, message, severity: 'error' };
  return { type: 'diagnostic', runId, diagnostic };
}
export function resultEvents(runId: string, response: CodingAgentResponse): RunEvent[] {
  return response.operations.map((operation, index) => ({ type: 'operation-proposed', runId, index, operationType: operation.type }));
}
export function safeJsonContent(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.content === 'string') return record.content;
  if (typeof record.structured_output === 'object' && record.structured_output !== null) return JSON.stringify(record.structured_output);
  if (typeof record.result === 'string') {
    try { const parsed: unknown = JSON.parse(record.result); return JSON.stringify(parsed); } catch { return undefined; }
  }
  return undefined;
}
