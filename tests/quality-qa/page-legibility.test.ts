import { describe, expect, it } from 'vitest';
import { assessPageComposition } from '../../src/application/design-quality';
import { buildContext } from '../../src/application/context';
import { resolveResponsiveLayout } from '../../src/domain';
import { createDocument, createNodeBase } from '../../src/domain/defaults';
import type { ColorValue, DesignDocument, FrameNode, TextNode } from '../../src/domain/types';

const literal = (value: string) => ({ kind: 'literal' as const, value: value as `#${string}` });
const token = (tokenId: string): ColorValue => ({ kind: 'token', tokenId });

function pageRequest(prompt = 'Build a puppy shop page', selectedNodeIds: string[] = [], contextDocument = createDocument('Puppy shop')) {
  return buildContext(contextDocument, 'legibility-qa', prompt, selectedNodeIds, ['node.create'], 'page_1');
}

function textNode(id: string, text: string, options: {
  color?: ColorValue;
  size?: number;
  weight?: number;
  visible?: boolean;
  width?: 'hug' | 'fill';
  fill?: ColorValue;
} = {}): TextNode {
  const node: TextNode = {
    ...createNodeBase(id, id), kind: 'text', text,
    textStyle: {
      fontSize: { kind: 'literal', value: options.size ?? 16, unit: 'px' },
      weight: options.weight ?? 400,
    },
  };
  if (options.color) node.style.textColor = options.color;
  if (options.fill) node.style.fill = options.fill;
  if (options.visible !== undefined) node.visible = options.visible;
  if (options.width) node.layout.width = { kind: options.width };
  return node;
}

function pageWithText(text: TextNode, background: ColorValue = literal('#FFFFFF')): DesignDocument {
  const document = createDocument('Puppy shop');
  const root: FrameNode = {
    ...createNodeBase('root', 'Page'), kind: 'frame', childIds: ['surface'],
    layout: { ...createNodeBase('root', 'Page').layout, width: { kind: 'fill' }, height: { kind: 'hug' } },
  };
  const surface: FrameNode = { ...createNodeBase('surface', 'Surface'), kind: 'frame', childIds: [text.id], style: { fill: background } };
  document.nodes.root = root;
  document.nodes.surface = surface;
  document.nodes[text.id] = text;
  document.pages.page_1!.rootNodeIds = ['root'];
  return document;
}

function rowDocument(textWidth: 'hug' | 'fill', desktopOnly = false): DesignDocument {
  const document = createDocument('Puppy shop');
  const root: FrameNode = { ...createNodeBase('root', 'Page'), kind: 'frame', childIds: ['hero'] };
  root.layout.width = { kind: 'fill' };
  const hero: FrameNode = { ...createNodeBase('hero', 'Hero'), kind: 'frame', childIds: ['long-copy', 'action'] };
  hero.layout.mode = 'vertical';
  hero.responsive = [{
    id: desktopOnly ? 'desktop-row' : 'tablet-row',
    breakpointTokenId: desktopOnly ? 'breakpoint.desktop' : 'breakpoint.tablet', priority: 0,
    overrides: { layout: { mode: 'horizontal' } },
  }];
  const longCopy = textNode('long-copy', 'Comfortable essentials designed for every curious dog and their family.', { width: textWidth });
  const action = textNode('action', 'Shop the collection');
  document.nodes.root = root;
  document.nodes.hero = hero;
  document.nodes['long-copy'] = longCopy;
  document.nodes.action = action;
  document.pages.page_1!.rootNodeIds = ['root'];
  return document;
}

function codes(document: DesignDocument, prompt = 'Build a puppy shop page') {
  return assessPageComposition(document, pageRequest(prompt)).map(issue => issue.code);
}

describe('page legibility structural checks', () => {
  it('flags white authored text on a cream section background', () => {
    const document = pageWithText(textNode('cta', 'Shop now', { color: literal('#FFFFFF') }), literal('#FFF7E6'));
    expect(codes(document)).toContain('quality.text-contrast');
  });

  it('accepts white text on dark text-owned, parent, and nested opaque backgrounds', () => {
    const ownFill = pageWithText(textNode('cta', 'Shop now', { color: literal('#FFFFFF'), fill: literal('#111111') }), literal('#FFF7E6'));
    expect(codes(ownFill)).not.toContain('quality.text-contrast');

    const nested = pageWithText(textNode('cta', 'Shop now', { color: literal('#FFFFFF') }), literal('#111111'));
    const inner: FrameNode = { ...createNodeBase('inner', 'Transparent grouping'), kind: 'frame', childIds: ['cta'] };
    nested.nodes.surface!.childIds = ['inner'];
    nested.nodes.inner = inner;
    expect(codes(nested)).not.toContain('quality.text-contrast');
  });

  it('flags normal body text below 4.5:1 but allows large text above 3:1', () => {
    const body = pageWithText(textNode('body', 'Everyday gear for curious dogs.', { color: literal('#777777'), size: 16 }));
    expect(codes(body)).toContain('quality.text-contrast');

    const large = pageWithText(textNode('large', 'Shop the collection', { color: literal('#888888'), size: 24 }));
    expect(codes(large)).not.toContain('quality.text-contrast');

    const boldLarge = pageWithText(textNode('bold-large', 'Shop the collection', { color: literal('#888888'), size: 19, weight: 700 }));
    expect(codes(boldLarge)).not.toContain('quality.text-contrast');
    const regularMedium = pageWithText(textNode('regular-medium', 'Shop the collection', { color: literal('#888888'), size: 19, weight: 400 }));
    expect(codes(regularMedium)).toContain('quality.text-contrast');

    const tokenLarge = pageWithText(textNode('token-large', 'Shop the collection', { color: literal('#888888') }));
    const tokenText = tokenLarge.nodes['token-large'] as TextNode;
    delete tokenText.textStyle.fontSize;
    tokenText.textStyle.typographyTokenId = 'typography.title';
    expect(codes(tokenLarge)).not.toContain('quality.text-contrast');
  });

  it('uses the default white artboard when no authored ancestor background exists', () => {
    const document = pageWithText(textNode('body', 'Everyday gear for curious dogs.', { color: literal('#777777') }));
    delete document.nodes.surface!.style.fill;
    expect(codes(document)).toContain('quality.text-contrast');
  });

  it('flags large text below 3:1 and resolves color tokens as authored colors', () => {
    const large = pageWithText(textNode('large', 'Shop the collection', { color: literal('#999999'), size: 24 }));
    expect(codes(large)).toContain('quality.text-contrast');

    const tokenColors = pageWithText(textNode('token-copy', 'Shop now', { color: token('color.white') }), token('color.cream'));
    tokenColors.tokens['color.white'] = { id: 'color.white', name: 'White', category: 'color', value: { hex: '#FFFFFF' } };
    tokenColors.tokens['color.cream'] = { id: 'color.cream', name: 'Cream', category: 'color', value: { hex: '#FFF7E6' } };
    expect(codes(tokenColors)).toContain('quality.text-contrast');
  });

  it('leaves unsupported translucent combinations inconclusive', () => {
    const document = pageWithText(textNode('copy', 'Shop now', { color: literal('#FFFFFF') }));
    document.tokens['color.translucent'] = {
      id: 'color.translucent', name: 'Translucent surface', category: 'color', value: { hex: '#FFF7E6', alpha: 0.5 },
    };
    document.nodes.surface!.style.fill = token('color.translucent');
    expect(codes(document)).not.toContain('quality.text-contrast');
  });

  it('ignores invisible text when assessing contrast', () => {
    const document = pageWithText(textNode('hidden-copy', 'Hidden text', { color: literal('#777777'), visible: false }));
    expect(codes(document)).not.toContain('quality.text-contrast');
  });

  it('does not expand contrast review to components or selected-subtree edits', () => {
    const document = pageWithText(textNode('copy', 'Shop now', { color: literal('#FFFFFF') }), literal('#FFF7E6'));
    expect(codes(document, 'Create a minimal button component')).not.toContain('quality.text-contrast');
    expect(assessPageComposition(document, pageRequest('Update the selected action', ['copy'], document)).map(issue => issue.code)).not.toContain('quality.text-contrast');
  });

  it('flags long hug copy in a horizontal tablet row', () => {
    const document = rowDocument('hug');
    expect(resolveResponsiveLayout(document, document.nodes.hero!, 768).layout.mode).toBe('horizontal');
    expect(codes(document)).toContain('quality.tablet-layout');
  });

  it('retains a tablet violation when a later horizontal row is safe', () => {
    const document = rowDocument('hug');
    const root = document.nodes.root as FrameNode;
    const safeRow: FrameNode = { ...createNodeBase('safe-row', 'Compact links'), kind: 'frame', childIds: ['safe-a', 'safe-b'] };
    safeRow.layout.mode = 'horizontal';
    const first = textNode('safe-a', 'Shop');
    const second = textNode('safe-b', 'About');
    document.nodes['safe-row'] = safeRow;
    document.nodes['safe-a'] = first;
    document.nodes['safe-b'] = second;
    root.childIds.push('safe-row');

    expect(codes(document)).toContain('quality.tablet-layout');
  });

  it('accepts long fill copy and a row that begins only at desktop width', () => {
    const fillBody = rowDocument('fill');
    expect(codes(fillBody)).not.toContain('quality.tablet-layout');

    const desktopRow = rowDocument('hug', true);
    expect(resolveResponsiveLayout(desktopRow, desktopRow.nodes.hero!, 768).layout.mode).toBe('vertical');
    expect(codes(desktopRow)).not.toContain('quality.tablet-layout');
  });

  it('allows two fill columns at tablet while retaining the mobile stack guard', () => {
    const document = rowDocument('fill');
    const hero = document.nodes.hero as FrameNode;
    hero.childIds = ['column-a', 'column-b'];
    const first: FrameNode = { ...createNodeBase('column-a', 'Column A'), kind: 'frame' };
    const second: FrameNode = { ...createNodeBase('column-b', 'Column B'), kind: 'frame' };
    first.layout.width = { kind: 'fill' };
    second.layout.width = { kind: 'fill' };
    document.nodes['column-a'] = first;
    document.nodes['column-b'] = second;

    expect(resolveResponsiveLayout(document, hero, 375).layout.mode).toBe('vertical');
    expect(resolveResponsiveLayout(document, hero, 768).layout.mode).toBe('horizontal');
    expect(codes(document)).not.toContain('quality.tablet-layout');
    expect(codes(document)).not.toContain('quality.mobile-layout');

    const mobileRow = rowDocument('fill');
    const mobileHero = mobileRow.nodes.hero as FrameNode;
    mobileHero.layout.mode = 'horizontal';
    mobileHero.responsive = [];
    mobileHero.childIds = ['column-a', 'column-b'];
    const mobileColumnA: FrameNode = { ...createNodeBase('column-a', 'Column A'), kind: 'frame' };
    const mobileColumnB: FrameNode = { ...createNodeBase('column-b', 'Column B'), kind: 'frame' };
    mobileColumnA.layout.width = { kind: 'fill' };
    mobileColumnB.layout.width = { kind: 'fill' };
    mobileRow.nodes['column-a'] = mobileColumnA;
    mobileRow.nodes['column-b'] = mobileColumnB;
    expect(codes(mobileRow)).toContain('quality.mobile-layout');
  });

  it('exempts long hug rows from tablet review for minimal component requests and scoped edits', () => {
    const document = rowDocument('hug');
    expect(codes(document, 'Create a minimal card component')).not.toContain('quality.tablet-layout');
    expect(assessPageComposition(document, pageRequest('Change selected text', ['long-copy'], document)).map(issue => issue.code)).not.toContain('quality.tablet-layout');
  });
});
