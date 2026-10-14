import { describe, expect, it } from 'vitest';
import { assessPageComposition } from '../../src/application/design-quality';
import { buildContext } from '../../src/application/context';
import { resolveResponsiveLayout } from '../../src/domain';
import { createDocument, createNodeBase } from '../../src/domain/defaults';
import type { DesignDocument, FrameNode, TextNode, VectorNode } from '../../src/domain/types';

function compositionDocument(): DesignDocument {
  const document = createDocument('Puppy shop');
  const root: FrameNode = {
    ...createNodeBase('root', 'Page'), kind: 'frame', childIds: ['navigation', 'hero', 'catalog', 'footer'],
    layout: { ...createNodeBase('root', 'Page').layout, width: { kind: 'fill' }, height: { kind: 'hug' } },
  };
  document.nodes.root = root;
  document.pages.page_1!.rootNodeIds = ['root'];
  for (const [id, label] of [['navigation', 'Navigation'], ['hero', 'Hero'], ['catalog', 'Catalog'], ['footer', 'Footer']] as const) {
    const childIds = id === 'hero' ? ['heading', 'intro', 'hero-art'] : [];
    document.nodes[id] = { ...createNodeBase(id, label), kind: 'frame', childIds };
  }
  // Three sections include six authored copy nodes and one real native vector.
  document.nodes.navigation!.childIds = ['brand', 'shop-link'];
  document.nodes.catalog!.childIds = ['catalog-title', 'product-copy'];
  document.nodes.footer!.childIds = ['trust-copy', 'footer-copy'];
  const copy = [
    ['brand', 'Paws & Co', 24], ['shop-link', 'Shop', 16], ['heading', 'A happier walk starts here', 40],
    ['intro', 'Everyday gear made for curious dogs.', 18], ['catalog-title', 'Find their new favorite', 28],
    ['product-copy', 'Comfortable collars and leads.', 16], ['trust-copy', 'Loved by dogs and their people.', 16],
    ['footer-copy', 'Thoughtful essentials for every walk.', 14],
  ] as const;
  for (const [id, text, fontSize] of copy) {
    document.nodes[id] = {
      ...createNodeBase(id, id), kind: 'text', text,
      textStyle: { fontSize: { kind: 'literal', value: fontSize, unit: 'px' }, weight: fontSize >= 24 ? 700 : 400 },
    } satisfies TextNode;
  }
  document.nodes['hero-art'] = {
    ...createNodeBase('hero-art', 'Puppy illustration'), kind: 'vector',
    pathData: 'M 5 40 C 20 10 30 10 40 35 L 55 20 L 75 35 L 90 55 L 70 75 L 35 80 Z',
    viewBox: [0, 0, 100, 100],
  } satisfies VectorNode;
  document.nodes['hero-art']!.layout.width = { kind: 'fixed', value: { kind: 'literal', value: 100, unit: 'px' } };
  document.nodes['hero-art']!.layout.height = { kind: 'fill' };
  return document;
}

function request(document: DesignDocument, prompt = 'Build a simple puppy shop page', selectedNodeIds: string[] = []) {
  return buildContext(document, 'qa-run', prompt, selectedNodeIds, ['node.create'], 'page_1');
}

describe('page composition structural checks', () => {
  it('accepts full-width composed store structure with distinct text styles and authored vector content', () => {
    const document = compositionDocument();
    expect(assessPageComposition(document, request(createDocument('Puppy shop')))).toEqual([]);
  });

  it('reports every structural gap in a tiny text-only store skeleton', () => {
    const document = createDocument('Tiny puppy shop');
    document.nodes.card = { ...createNodeBase('card', 'Card'), kind: 'frame', childIds: ['label'] };
    document.nodes.label = { ...createNodeBase('label', 'Label'), kind: 'text', text: 'Puppy shop', textStyle: {} };
    document.pages.page_1!.rootNodeIds = ['card'];

    expect(assessPageComposition(document, request(createDocument('Tiny puppy shop'))).map(issue => issue.code)).toEqual([
      'quality.page-width', 'quality.structure', 'quality.content', 'quality.typography', 'quality.visual-content',
    ]);
  });

  it('does not expand an explicit minimal component into a page-completeness requirement', () => {
    const document = createDocument('Button');
    expect(assessPageComposition(document, request(document, 'Create a minimal button component'))).toEqual([]);
  });

  it('does not apply page-wide completeness checks to a selected-subtree edit', () => {
    const document = createDocument('Selected edit');
    document.nodes.label = { ...createNodeBase('label', 'Label'), kind: 'text', text: 'Old', textStyle: {} };
    document.pages.page_1!.rootNodeIds = ['label'];
    expect(assessPageComposition(document, request(document, 'Change the selected label', ['label']))).toEqual([]);
  });

  it('respects explicit text-only intent while retaining the other full-page checks', () => {
    const document = compositionDocument();
    delete document.nodes['hero-art'];
    document.nodes.hero!.childIds = ['heading', 'intro'];
    expect(assessPageComposition(document, request(createDocument('Puppy shop'), 'Build a text-only puppy shop page')).map(issue => issue.code)).toEqual([]);
  });

  it('ignores hidden content when counting visible page composition', () => {
    const document = compositionDocument();
    for (const id of ['navigation', 'hero', 'catalog', 'footer', 'brand', 'shop-link', 'heading', 'intro', 'hero-art', 'catalog-title', 'product-copy', 'trust-copy', 'footer-copy']) {
      document.nodes[id]!.visible = false;
    }
    const issues = assessPageComposition(document, request(createDocument('Hidden puppy shop'))).map(issue => issue.code);
    expect(issues).toContain('quality.content');
    expect(issues).toContain('quality.visual-content');
  });

  it('detects a reversed mobile layout when a vertical correction only activates at tablet width', () => {
    const document = compositionDocument();
    const hero = document.nodes.hero!;
    hero.layout.mode = 'horizontal';
    hero.responsive = [{
      id: 'stack-at-tablet', breakpointTokenId: 'breakpoint.tablet', priority: 0,
      overrides: { layout: { mode: 'vertical' } },
    }];

    expect(resolveResponsiveLayout(document, hero, 375).layout.mode).toBe('horizontal');
    expect(resolveResponsiveLayout(document, hero, 1280).layout.mode).toBe('vertical');
    expect(assessPageComposition(document, request(createDocument('Puppy shop'))).map(issue => issue.code)).toContain('quality.mobile-layout');
  });

  it('accepts a vertical mobile base with a horizontal desktop override', () => {
    const document = compositionDocument();
    const hero = document.nodes.hero!;
    hero.layout.mode = 'vertical';
    hero.responsive = [{
      id: 'desktop-columns', breakpointTokenId: 'breakpoint.desktop', priority: 0,
      overrides: { layout: { mode: 'horizontal' } },
    }];

    expect(resolveResponsiveLayout(document, hero, 375).layout.mode).toBe('vertical');
    expect(resolveResponsiveLayout(document, hero, 1280).layout.mode).toBe('horizontal');
    expect(assessPageComposition(document, request(createDocument('Puppy shop')))).toEqual([]);
  });

  it.each([
    ['fixed width and fixed height', 'fixed', 'fixed'],
    ['fixed width and fill height', 'fixed', 'fill'],
    ['fill width and fixed height', 'fill', 'fixed'],
    ['fill width and fill height', 'fill', 'fill'],
  ] as const)('accepts a visible native vector with %s', (_description, width, height) => {
    const document = compositionDocument();
    const vector = document.nodes['hero-art']!;
    vector.layout.width = width === 'fixed' ? { kind: 'fixed', value: { kind: 'literal', value: 240, unit: 'px' } } : { kind: 'fill' };
    vector.layout.height = height === 'fixed' ? { kind: 'fixed', value: { kind: 'literal', value: 180, unit: 'px' } } : { kind: 'fill' };

    expect(assessPageComposition(document, request(createDocument('Puppy shop'))).map(issue => issue.code)).not.toContain('quality.vector-bounds');
  });

  it.each([
    ['width', { width: { kind: 'hug' } }],
    ['height', { height: { kind: 'hug' } }],
  ] as const)('rejects a visible native vector with hug %s at mobile or desktop', (_axis, override) => {
    const document = compositionDocument();
    const vector = document.nodes['hero-art']!;
    vector.layout = { ...vector.layout, ...override };

    expect(assessPageComposition(document, request(createDocument('Puppy shop'))).map(issue => issue.code)).toContain('quality.vector-bounds');
  });

  it('rejects an unconstrained vector axis introduced by a desktop responsive override', () => {
    const document = compositionDocument();
    const vector = document.nodes['hero-art']!;
    vector.responsive = [{
      id: 'desktop-unbounded-art', breakpointTokenId: 'breakpoint.desktop', priority: 0,
      overrides: { layout: { width: { kind: 'hug' } } },
    }];

    expect(resolveResponsiveLayout(document, vector, 375).layout.width.kind).toBe('fixed');
    expect(resolveResponsiveLayout(document, vector, 1440).layout.width.kind).toBe('hug');
    expect(assessPageComposition(document, request(createDocument('Puppy shop'))).map(issue => issue.code)).toContain('quality.vector-bounds');
  });

  it('does not flag a vector hidden at desktop when its desktop sizing is unbounded', () => {
    const document = compositionDocument();
    const vector = document.nodes['hero-art']!;
    vector.layout.width = { kind: 'fixed', value: { kind: 'literal', value: 100, unit: 'px' } };
    vector.layout.height = { kind: 'fill' };
    vector.responsive = [{
      id: 'hide-art-on-desktop', breakpointTokenId: 'breakpoint.desktop', priority: 0,
      overrides: { visible: false, layout: { width: { kind: 'hug' } } },
    }];

    expect(resolveResponsiveLayout(document, vector, 375).visible).toBe(true);
    expect(resolveResponsiveLayout(document, vector, 1440).visible).toBe(false);
    expect(assessPageComposition(document, request(createDocument('Puppy shop'))).map(issue => issue.code)).not.toContain('quality.vector-bounds');
  });

  it('exempts unbounded vectors from page checks for component requests and scoped edits', () => {
    const document = compositionDocument();
    const vector = document.nodes['hero-art']!;
    vector.layout.width = { kind: 'hug' };
    vector.layout.height = { kind: 'hug' };

    expect(assessPageComposition(document, request(createDocument('Puppy shop'), 'Create a minimal illustration component')).map(issue => issue.code)).not.toContain('quality.vector-bounds');
    expect(assessPageComposition(document, request(document, 'Update the selected illustration', ['hero-art'])).map(issue => issue.code)).not.toContain('quality.vector-bounds');
  });
});
