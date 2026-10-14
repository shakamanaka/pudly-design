import { describe, expect, it } from 'vitest';
import { buildContext } from '../../src/application/context';
import { assessPageComposition } from '../../src/application/design-quality';
import { createDocument, createNodeBase } from '../../src/domain/defaults';
import type { DesignDocument, FrameNode, VectorNode } from '../../src/domain/types';

function makePage(vector: VectorNode): DesignDocument {
  const document = createDocument('Vector bounds');
  const rootBase = createNodeBase('root', 'Page');
  const root: FrameNode = {
    ...rootBase,
    kind: 'frame',
    childIds: [vector.id],
    layout: { ...rootBase.layout, width: { kind: 'fill' }, height: { kind: 'hug' } },
  };
  document.nodes.root = root;
  document.nodes[vector.id] = vector;
  document.pages.page_1!.rootNodeIds = [root.id];
  return document;
}

function vectorNode(): VectorNode {
  return {
    ...createNodeBase('illustration', 'Illustration'),
    kind: 'vector',
    pathData: 'M 0 0 L 10 10 Z',
    viewBox: [0, 0, 10, 10],
  };
}

function request(prompt = 'Create a puppy store page') {
  const empty = createDocument('Vector bounds');
  return buildContext(empty, 'vector-quality-run', prompt, [], ['node.create'], 'page_1');
}

function vectorBoundsIssues(document: DesignDocument, prompt?: string) {
  return assessPageComposition(document, request(prompt)).filter(issue => issue.code === 'quality.vector-bounds');
}

describe('page vector bounds quality check', () => {
  it('reports a visible vector with hug sizing at either reviewed viewport', () => {
    const vector = vectorNode();
    expect(vector.layout.width.kind).toBe('hug');
    expect(vector.layout.height.kind).toBe('hug');

    const issues = vectorBoundsIssues(makePage(vector));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ code: 'quality.vector-bounds', severity: 'error' });
    expect(issues[0]?.message).toContain('375px and 1440px');
  });

  it('accepts vectors whose axes are explicitly bounded with fixed or fill sizing', () => {
    const vector = vectorNode();
    vector.layout.width = { kind: 'fixed', value: { kind: 'literal', value: 240, unit: 'px' } };
    vector.layout.height = { kind: 'fill' };

    expect(vectorBoundsIssues(makePage(vector))).toEqual([]);
  });

  it('checks responsive sizing at both 375px and 1440px', () => {
    const vector = vectorNode();
    vector.layout.width = { kind: 'fixed', value: { kind: 'literal', value: 240, unit: 'px' } };
    vector.layout.height = { kind: 'fixed', value: { kind: 'literal', value: 180, unit: 'px' } };
    vector.responsive = [{
      id: 'desktop-hug-height',
      breakpointTokenId: 'breakpoint.desktop',
      priority: 0,
      overrides: { layout: { height: { kind: 'hug' } } },
    }];

    expect(vectorBoundsIssues(makePage(vector))).toHaveLength(1);
  });

  it('ignores hug sizing while a vector is hidden and accepts bounded sizing when responsive visibility shows it', () => {
    const vector = vectorNode();
    vector.visible = false;
    vector.responsive = [{
      id: 'show-bounded-desktop-art',
      breakpointTokenId: 'breakpoint.desktop',
      priority: 0,
      overrides: {
        visible: true,
        layout: {
          width: { kind: 'fixed', value: { kind: 'literal', value: 240, unit: 'px' } },
          height: { kind: 'fixed', value: { kind: 'literal', value: 180, unit: 'px' } },
        },
      },
    }];

    expect(vectorBoundsIssues(makePage(vector))).toEqual([]);
  });

  it('keeps scoped edits exempt from page vector bounds review', () => {
    const vector = vectorNode();
    expect(vectorBoundsIssues(makePage(vector), 'Create a minimal illustration component')).toEqual([]);
  });
});
