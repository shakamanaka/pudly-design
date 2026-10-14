import type { Diagnostic } from './types.js';

/** Safe, actionable failure information crossing the agent port boundary. */
export class CodingAgentError extends Error {
  readonly diagnostics: Diagnostic[];

  constructor(readonly code: string, message: string, diagnostics: Diagnostic[] = []) {
    super(message);
    this.name = 'CodingAgentError';
    this.diagnostics = structuredClone(diagnostics);
  }
}
