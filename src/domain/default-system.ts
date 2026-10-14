import type {
  ComponentDefinition, DesignToken, Layout, TemplateBase, TemplateNode,
  TokenReference,
} from './types.js';

export type DefaultComponentDocumentation = {
  semanticRole: string;
  description: string;
  usageRules: string[];
};

export type DefaultDesignSystem = {
  tokens: Record<string, DesignToken>;
  components: Record<string, ComponentDefinition>;
  catalog: Record<string, DefaultComponentDocumentation>;
};

const ref = (tokenId: string): TokenReference => ({ kind: 'token', tokenId });
const measure = (tokenId: string) => ref(tokenId);
const sizing = (kind: 'hug' | 'fill'): Layout['width'] => ({ kind });
const layout = (mode: Layout['mode'], width: Layout['width'], height: Layout['height'], gapToken: string, paddingToken: string): Layout => ({
  mode,
  width,
  height,
  align: 'stretch',
  justify: 'start',
  gap: measure(gapToken),
  padding: { top: measure(paddingToken), right: measure(paddingToken), bottom: measure(paddingToken), left: measure(paddingToken) },
});
const templateBase = (templateNodeId: string, name: string, childTemplateNodeIds: string[], nodeLayout: Layout, fillToken: string, radiusToken: string): TemplateBase => ({
  templateNodeId,
  name,
  childTemplateNodeIds,
  visible: true,
  layout: nodeLayout,
  constraints: {},
  style: { fill: ref(fillToken), radius: measure(radiusToken) },
  responsive: [],
});
const textTemplate = (templateNodeId: string, name: string, text: string, typographyTokenId: string, textColorTokenId = 'color.text'): Extract<TemplateNode, { kind: 'text' }> => ({
  ...templateBase(templateNodeId, name, [], layout('horizontal', sizing('hug'), sizing('hug'), 'spacing.0', 'spacing.0'), 'color.surface', 'radius.none'),
  style: { textColor: ref(textColorTokenId) },
  kind: 'text',
  text,
  textStyle: { typographyTokenId },
});

const tokens: DesignToken[] = [
  { id: 'color.primary', name: 'Primary', category: 'color', value: { hex: '#4F46E5' } },
  { id: 'color.text', name: 'Text', category: 'color', value: { hex: '#111827' } },
  { id: 'color.surface', name: 'Surface', category: 'color', value: { hex: '#FFFFFF' } },
  { id: 'color.muted', name: 'Muted', category: 'color', value: { hex: '#6B7280' } },
  { id: 'color.border', name: 'Border', category: 'color', value: { hex: '#D1D5DB' } },
  { id: 'color.danger', name: 'Danger', category: 'color', value: { hex: '#B91C1C' } },
  { id: 'typography.title', name: 'Title', category: 'typography', value: { fontFamily: 'Inter, sans-serif', fontSizePx: 24, weight: 700, lineHeight: 1.25 } },
  { id: 'typography.body', name: 'Body', category: 'typography', value: { fontFamily: 'Inter, sans-serif', fontSizePx: 16, weight: 400, lineHeight: 1.5 } },
  { id: 'typography.label', name: 'Label', category: 'typography', value: { fontFamily: 'Inter, sans-serif', fontSizePx: 14, weight: 600, lineHeight: 1.4 } },
  ...[
    ['spacing.0', 0], ['spacing.1', 8], ['spacing.2', 16], ['spacing.3', 24],
    ['spacing.compact', 4], ['spacing.relaxed', 12], ['spacing.generous', 32], ['spacing.button-height', 40],
  ].map(([id, valuePx]) => ({ id: String(id), name: String(id).replace('spacing.', ''), category: 'spacing' as const, value: { valuePx: Number(valuePx) } })),
  ...[
    ['radius.none', 0], ['radius.sm', 4], ['radius.md', 8], ['radius.lg', 16],
  ].map(([id, valuePx]) => ({ id: String(id), name: String(id).replace('radius.', ''), category: 'radius' as const, value: { valuePx: Number(valuePx) } })),
  { id: 'shadow.card', name: 'Card shadow', category: 'shadow', value: { xPx: 0, yPx: 2, blurPx: 8, spreadPx: 0, color: { kind: 'token', tokenId: 'color.border' } } },
  { id: 'shadow.overlay', name: 'Overlay shadow', category: 'shadow', value: { xPx: 0, yPx: 8, blurPx: 24, spreadPx: 0, color: { kind: 'token', tokenId: 'color.text' } } },
  { id: 'breakpoint.tablet', name: 'Tablet', category: 'breakpoint', value: { valuePx: 768 } },
  { id: 'breakpoint.desktop', name: 'Desktop', category: 'breakpoint', value: { valuePx: 1024 } },
  { id: 'motion.fast', name: 'Fast motion', category: 'motion', value: { durationMs: 120, easing: 'ease-out' } },
  { id: 'motion.standard', name: 'Standard motion', category: 'motion', value: { durationMs: 220, easing: 'ease-in-out' } },
  { id: 'z-index.base', name: 'Base layer', category: 'z-index', value: { order: 0 } },
  { id: 'z-index.overlay', name: 'Overlay layer', category: 'z-index', value: { order: 100 } },
];

const buttonRoot = templateBase(
  'button-root', 'Button', ['button-label'],
  layout('horizontal', sizing('hug'), { kind: 'fixed', value: measure('spacing.button-height') }, 'spacing.1', 'spacing.2'),
  'color.primary', 'radius.md',
);
const button: ComponentDefinition = {
  id: 'button',
  name: 'Button',
  rootTemplateNodeId: 'button-root',
  templateNodes: {
    'button-root': { ...buttonRoot, style: { ...buttonRoot.style, fill: ref('color.primary') }, kind: 'frame' },
    'button-label': { ...textTemplate('button-label', 'Label', 'Button', 'typography.label'), style: { textColor: ref('color.surface') }, textStyle: { typographyTokenId: 'typography.label', align: 'center' } },
  },
  properties: {
    label: { type: 'string', required: true, defaultValue: 'Button', binding: { templateNodeId: 'button-label', property: 'text' } },
    size: { type: 'string', required: false, defaultValue: 'medium', constraints: { enum: ['small', 'medium', 'large'] } },
  },
  variants: {
    primary: { id: 'primary', name: 'Primary', propertyOverrides: {}, nodeOverrides: { 'button-root': { style: { fill: ref('color.primary'), radius: measure('radius.md') } }, 'button-label': { textStyle: { typographyTokenId: 'typography.label' } } } },
    secondary: { id: 'secondary', name: 'Secondary', propertyOverrides: {}, nodeOverrides: { 'button-root': { style: { fill: ref('color.surface'), radius: measure('radius.md') } }, 'button-label': { style: { textColor: ref('color.primary') } } } },
  },
  slots: {},
};

const cardRoot = templateBase(
  'card-root', 'Card', ['card-title', 'card-description'],
  layout('vertical', sizing('fill'), sizing('hug'), 'spacing.1', 'spacing.2'),
  'color.surface', 'radius.md',
);
const card: ComponentDefinition = {
  id: 'card',
  name: 'Card',
  rootTemplateNodeId: 'card-root',
  templateNodes: {
    'card-root': { ...cardRoot, style: { ...cardRoot.style, shadowTokenId: 'shadow.card' }, kind: 'frame' },
    'card-title': textTemplate('card-title', 'Title', 'Card title', 'typography.title'),
    'card-description': textTemplate('card-description', 'Description', '', 'typography.body'),
  },
  properties: {
    title: { type: 'string', required: true, defaultValue: 'Card title', binding: { templateNodeId: 'card-title', property: 'text' } },
    description: { type: 'string', required: false, defaultValue: '', binding: { templateNodeId: 'card-description', property: 'text' } },
  },
  variants: {
    standard: { id: 'standard', name: 'Standard', propertyOverrides: {}, nodeOverrides: {} },
    elevated: { id: 'elevated', name: 'Elevated', propertyOverrides: {}, nodeOverrides: { 'card-root': { style: { shadowTokenId: 'shadow.overlay' } } } },
  },
  slots: {},
};

export const DEFAULT_COMPONENT_CATALOG: Record<string, DefaultComponentDocumentation> = {
  button: {
    semanticRole: 'action',
    description: 'A compact control for a primary or secondary user action.',
    usageRules: ['Use a short, verb-led label.', 'Use one primary button for the main action in a section.', 'Choose the secondary variant for supporting actions.'],
  },
  card: {
    semanticRole: 'content-container',
    description: 'A padded surface that groups a short title and supporting content.',
    usageRules: ['Use cards to group related content.', 'Keep each card focused on one subject.', 'Use the elevated variant sparingly for raised surfaces.'],
  },
};

const DEFAULT_SYSTEM: DefaultDesignSystem = {
  tokens: Object.fromEntries(tokens.map((token) => [token.id, token])),
  components: { button, card },
  catalog: structuredClone(DEFAULT_COMPONENT_CATALOG),
};

/** Returns a detached, mutable copy for project creation and context assembly. */
export function createDefaultDesignSystem(): DefaultDesignSystem {
  return structuredClone(DEFAULT_SYSTEM);
}
