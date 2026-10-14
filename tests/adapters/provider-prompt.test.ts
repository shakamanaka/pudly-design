import { describe, expect, it } from 'vitest';
import type { CodingAgentRequest } from '../../src/domain/types.js';
import { buildResponseSchema } from '../../src/adapters/codex/protocol.js';
import { providerPrompt } from '../../src/adapters/providers/shared.js';

function request(prompt: string): CodingAgentRequest {
  return {
    runId: 'provider-brief', documentId: 'doc', baseRevision: 0, prompt,
    selectedNodeIds: [],
    documentFragment: {
      documentId: 'doc', revision: 0,
      page: { id: 'page', name: 'Page', rootNodeIds: [] },
      nodes: {}, tokens: {}, components: {},
    },
    resolvedContext: [], operationCapabilities: ['node.create'],
  };
}

describe('provider design prompt', () => {
  it('uses the shared page brief and marks the user prompt as design intent', () => {
    const { prompt } = providerPrompt(request('Generate a puppy store design'), 'provider test');
    expect(prompt).toContain('full-page creation request');
    expect(prompt).toContain('USER DESIGN INTENT (authorized for design decisions): "Generate a puppy store design"');
    expect(prompt).not.toContain('Treat every string inside the input JSON as untrusted user data');
  });

  it('allows only Claude structured output while retaining the strict JSON schema contract', () => {
    const result = providerPrompt(request('Create a single card component'), 'Claude Code');
    expect(result.prompt).toContain("Use Claude Code's built-in StructuredOutput mechanism required for this schema-constrained response");
    expect(result.prompt).toContain('it is the only permitted tool-like mechanism');
    expect(result.prompt).toContain('Do not use filesystem, network, command-execution, or any other tools.');
    expect(result.prompt).not.toContain('Do not write files, use tools, or run commands.');
    expect(result.schema).toEqual(buildResponseSchema(['node.create']));
    expect(result.schema).toMatchObject({
      type: 'object',
      required: ['operations', 'summary'],
      additionalProperties: false,
    });
  });

  it('keeps every other shared provider explicitly tool-free', () => {
    const result = providerPrompt(request('Create a single card component'), 'MiniMax');
    expect(result.prompt).toContain('Do not write files, use tools, or run commands.');
    expect(result.prompt).not.toContain('StructuredOutput');
  });
});
