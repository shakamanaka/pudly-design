import { describe, expect, it } from 'vitest';
import { buildContext } from '../../src/application/context';
import { buildDesignBrief } from '../../src/application/design-brief';
import { assessPageComposition } from '../../src/application/design-quality';
import { createDocument, createNodeBase } from '../../src/domain/defaults';
import type { DesignDocument, FrameNode, TextNode } from '../../src/domain/types';

function longTextRowPage(): DesignDocument {
  const document = createDocument('Tablet rows');
  const rootBase = createNodeBase('root', 'Page');
  const root: FrameNode = {
    ...rootBase,
    kind: 'frame',
    childIds: ['cta-row', 'footer-row'],
    layout: { ...rootBase.layout, width: { kind: 'fill' } },
  };
  const ctaRow: FrameNode = { ...createNodeBase('cta-row', 'CTA row'), kind: 'frame', childIds: ['long-cta', 'cta-action'] };
  ctaRow.layout.mode = 'horizontal';
  const footerRow: FrameNode = { ...createNodeBase('footer-row', 'Footer row'), kind: 'frame', childIds: ['footer-link', 'footer-help'] };
  footerRow.layout.mode = 'horizontal';
  const makeText = (id: string, text: string): TextNode => ({
    ...createNodeBase(id, id), kind: 'text', text, textStyle: {},
  });
  document.nodes.root = root;
  document.nodes['cta-row'] = ctaRow;
  document.nodes['footer-row'] = footerRow;
  document.nodes['long-cta'] = makeText('long-cta', 'A long action message that needs enough room to fit');
  document.nodes['cta-action'] = makeText('cta-action', 'Shop now');
  document.nodes['footer-link'] = makeText('footer-link', 'Returns');
  document.nodes['footer-help'] = makeText('footer-help', 'Contact');
  document.pages.page_1!.rootNodeIds = [root.id];
  return document;
}

describe('page legibility aggregation', () => {
  it('gives full-page requests readable action, tablet row, and store catalog guidance', () => {
    const empty = createDocument('Tablet rows');
    const request = buildContext(empty, 'tablet-row-run', 'Build a puppy shop page', [], ['node.create'], 'page_1');
    const brief = buildDesignBrief(request);

    expect(brief).toContain('light text needs a visibly dark filled action surface');
    expect(brief).toContain('At 768px, keep rows with long CTA or footer copy vertical until desktop');
    expect(brief).toContain('at least two distinct catalog items with a name, useful product detail, and a clear action');
  });

  it('retains a tablet warning when a later safe row is also present', () => {
    const empty = createDocument('Tablet rows');
    const request = buildContext(empty, 'tablet-row-run', 'Build a puppy shop page', [], ['node.create'], 'page_1');
    const issues = assessPageComposition(longTextRowPage(), request);

    expect(issues.map(issue => issue.code)).toContain('quality.tablet-layout');
  });
});
