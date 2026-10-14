import { describe, expect, it } from 'vitest';
import type { CodingAgentRequest } from '../../src/domain/types.js';
import { buildDesignBrief, designGenerationTimeout, inferDesignIntent } from '../../src/application/design-brief.js';

function request(prompt: string, overrides: Partial<CodingAgentRequest> = {}): CodingAgentRequest {
  return {
    runId: 'brief-test', documentId: 'doc', baseRevision: 0, prompt,
    selectedNodeIds: [],
    documentFragment: {
      documentId: 'doc', revision: 0,
      page: { id: 'page', name: 'Page', rootNodeIds: [] },
      nodes: {}, tokens: {}, components: {},
    },
    resolvedContext: [], operationCapabilities: ['node.create', 'property.set', 'layout.set', 'style.set'],
    ...overrides,
  };
}

describe('design brief', () => {
  it('infers a complete page from an unselected full-page creation request', () => {
    expect(inferDesignIntent(request('Generate a puppy store design'))).toBe('page');
    const brief = buildDesignBrief(request('Generate a puppy store design'));
    expect(brief).toContain('full-page creation request');
    expect(brief).toContain('brand/header with navigation');
    expect(brief).toContain('fill available width');
    expect(brief).toContain('mobile first for a 375px canvas');
    expect(brief).toContain('keep the hero and product/catalog content vertical');
    expect(brief).toContain('Never put the full navigation into one long text string');
    expect(brief).toContain('inclusive min-width semantics');
    expect(brief).toContain('Never treat a breakpoint as a max-width condition');
    expect(brief).toContain('tablet token value (768px by default) and above');
    expect(brief).toContain('desktop token value (1024px by default) and above');
    expect(brief).toContain('Generate a puppy store design');
  });

  it('preserves component-only and minimal requests', () => {
    expect(inferDesignIntent(request('Create a single card component'))).toBe('component');
    expect(inferDesignIntent(request('Create a minimal design'))).toBe('component');
    expect(inferDesignIntent(request('Create an editable fixture text label'))).toBe('component');
    expect(inferDesignIntent(request('Generate a minimal landing page'))).toBe('page');
    expect(inferDesignIntent(request('Generate a puppy store page and verify the hero is clear'))).toBe('page');
    expect(inferDesignIntent(request('Design a login screen'))).toBe('page');
    expect(inferDesignIntent(request('Build a digital app'))).toBe('page');
    expect(buildDesignBrief(request('Create a single card component'))).toContain('do not expand it into a full page');
  });

  it('keeps selected and existing-document work scoped as edits', () => {
    expect(inferDesignIntent(request('Generate a complete store page', { selectedNodeIds: ['node_1'] }))).toBe('edit');
    expect(inferDesignIntent(request('Create a store page', {
      documentFragment: {
        documentId: 'doc', revision: 0,
        page: { id: 'page', name: 'Page', rootNodeIds: ['node_1'] },
        nodes: { node_1: { id: 'node_1' } as never }, tokens: {}, components: {},
      },
    }))).toBe('edit');
    expect(buildDesignBrief(request('Update the heading'))).toContain('Preserve unrelated design content');
  });

  it('does not infer a page from verification or review requests', () => {
    expect(inferDesignIntent(request('Verify whether the puppy store layout fills the page'))).toBe('edit');
    expect(buildDesignBrief(request('Review the page and explain its hierarchy'))).toContain('Do not expand an edit or a verification');
  });

  it('budgets more time for complete pages and preserves explicit deadlines', () => {
    expect(designGenerationTimeout(request('Generate a puppy store design'))).toBe(600_000);
    expect(designGenerationTimeout(request('Create a single card component'))).toBe(300_000);
    expect(designGenerationTimeout(request('Generate a puppy store design'), 12_345)).toBe(12_345);
    expect(designGenerationTimeout(request('Create a single card component'), 12_345)).toBe(12_345);
  });

  it('keeps short-page and native illustration recommendations bounded without making them limits', () => {
    const brief = buildDesignBrief(request('Generate a puppy store design'));
    expect(brief).toContain('aim for roughly 25–45 authored semantic nodes');
    expect(brief).toContain('Reuse available components');
    expect(brief).toContain('prefer 2–4 distinct, simple native vector illustration layers');
    expect(brief).toContain('this is visual guidance, not a hard operation or geometry cap');
    expect(buildDesignBrief(request('Create a complex multi-page marketplace with detailed product systems and extensive content for several audience groups across many unique sections')))
      .not.toContain('aim for roughly 25–45 authored semantic nodes');
  });
});
