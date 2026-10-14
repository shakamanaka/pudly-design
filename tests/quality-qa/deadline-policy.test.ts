import { describe, expect, it } from 'vitest';
import { buildContext } from '../../src/application/context';
import {
  DEFAULT_DESIGN_TIMEOUT_MS,
  designGenerationTimeout,
  FULL_PAGE_DESIGN_TIMEOUT_MS,
} from '../../src/application/design-brief';
import { createDocument } from '../../src/domain/defaults';

function request(prompt: string) {
  return buildContext(createDocument('Timeout policy'), 'timeout-qa', prompt, [], ['node.create'], 'page_1');
}

describe('design generation timeout policy', () => {
  it('gives full-page creation the larger bounded generation budget', () => {
    expect(designGenerationTimeout(request('Build a simple puppy shop page'))).toBe(FULL_PAGE_DESIGN_TIMEOUT_MS);
    expect(FULL_PAGE_DESIGN_TIMEOUT_MS).toBe(600_000);
    expect(FULL_PAGE_DESIGN_TIMEOUT_MS).toBeGreaterThan(DEFAULT_DESIGN_TIMEOUT_MS);
  });

  it('keeps component and scoped-edit requests on the ordinary budget', () => {
    expect(designGenerationTimeout(request('Create a minimal button component'))).toBe(DEFAULT_DESIGN_TIMEOUT_MS);
    expect(designGenerationTimeout(request('Change the selected label'))).toBe(DEFAULT_DESIGN_TIMEOUT_MS);
  });

  it('preserves an explicitly configured adapter deadline for a full-page request', () => {
    expect(designGenerationTimeout(request('Build a simple puppy shop page'), 275)).toBe(275);
  });
});
