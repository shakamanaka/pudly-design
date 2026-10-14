import { describe, expect, it, vi } from 'vitest';
import { CodexModelCatalog, collectCodexModelPages, type CodexModelListRequest } from '../../src/adapters/providers/codex-model-catalog.js';

describe('Codex model catalog', () => {
  it('loads every page, preserves native order and keeps hidden/default metadata', async () => {
    const requests: CodexModelListRequest[] = [];
    const result = await collectCodexModelPages(async request => {
      requests.push(request);
      if (request.cursor === undefined) return {
        data: [{ id: 'picker-a', model: 'gpt-next', displayName: 'GPT Next', hidden: false, defaultReasoningEffort: 'minimal', supportedReasoningEfforts: [{ reasoningEffort: 'minimal' }, { reasoningEffort: 'ultra' }] }],
        nextCursor: 'page-2',
      };
      return {
        data: [{ id: 'picker-hidden', model: 'gpt-hidden', displayName: 'Hidden Model', hidden: true, defaultReasoningEffort: 'none', supportedReasoningEfforts: [{ reasoningEffort: 'none' }, { reasoningEffort: 'high' }] }],
        nextCursor: null,
      };
    });

    expect(requests).toEqual([
      { limit: 100, includeHidden: true },
      { limit: 100, includeHidden: true, cursor: 'page-2' },
    ]);
    expect(result).toEqual({
      catalogStatus: 'known',
      models: [
        { id: 'gpt-next', catalogId: 'picker-a', label: 'GPT Next', availability: 'unknown', entitlement: null, defaultEffort: 'minimal', supportedEfforts: ['minimal', 'ultra'], hidden: false },
        { id: 'gpt-hidden', catalogId: 'picker-hidden', label: 'Hidden Model', availability: 'unknown', entitlement: null, defaultEffort: 'none', supportedEfforts: ['none', 'high'], hidden: true },
      ],
    });
  });

  it('returns a partial catalog on malformed later pages or cursor loops', async () => {
    const malformed = await collectCodexModelPages(async request => request.cursor
      ? { data: 'not-an-array', nextCursor: null }
      : { data: [{ id: 'gpt-valid', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }], nextCursor: 'next' });
    expect(malformed).toMatchObject({ catalogStatus: 'partial', models: [{ id: 'gpt-valid' }] });

    const loop = await collectCodexModelPages(async request => ({
      data: [{ id: request.cursor ?? 'gpt-valid', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }],
      nextCursor: 'repeat',
    }));
    expect(loop.catalogStatus).toBe('partial');
  });

  it('does not invent efforts and reports unknown when the first page is unusable', async () => {
    const missingEfforts = await collectCodexModelPages(async () => ({ data: [{ id: 'gpt-no-efforts' }], nextCursor: null }));
    expect(missingEfforts).toMatchObject({ catalogStatus: 'partial', models: [{ id: 'gpt-no-efforts', supportedEfforts: [] }] });
    const invalid = await collectCodexModelPages(async () => ({ data: null, nextCursor: null }));
    expect(invalid).toEqual({ catalogStatus: 'unknown', models: [] });
  });

  it('bounds a stalled injected reader and returns an unknown catalog', async () => {
    const stalled = vi.fn(() => new Promise<never>(() => undefined));
    const started = Date.now();
    const result = await CodexModelCatalog.discover(stalled, { timeoutMs: 20 });
    expect(Date.now() - started).toBeLessThan(500);
    expect(stalled).toHaveBeenCalledOnce();
    expect(result).toEqual({ catalogStatus: 'unknown', models: [] });
  });
});
