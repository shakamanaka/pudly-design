import type {
  DesignDocument, DesignSystemPolicy, DesignSystemRule, DesignToken, Diagnostic,
  Layout, Measure, PolicySeverity, SemanticStyle, TemplateNode,
} from './types.js';

export const DEFAULT_DESIGN_SYSTEM_POLICY: DesignSystemPolicy = {
  rules: {
    'literal-color': 'warning',
    'literal-spacing': 'warning',
    'minimum-spacing': 'off',
    'detached-instance': 'warning',
  },
  minimumSpacingPx: 8,
};

const RULES: readonly DesignSystemRule[] = ['literal-color', 'literal-spacing', 'minimum-spacing', 'detached-instance'];
const SEVERITIES: readonly PolicySeverity[] = ['off', 'info', 'warning', 'error'];

function diagnostic(rule: DesignSystemRule, severity: Exclude<PolicySeverity, 'off'>, path: string, message: string, targetId?: string): Diagnostic {
  return {
    code: `design-system.${rule}`,
    message,
    severity,
    path,
    ...(targetId === undefined ? {} : { targetId }),
  };
}

function ruleDiagnostic(
  policy: DesignSystemPolicy,
  rule: DesignSystemRule,
  path: string,
  message: string,
  targetId?: string,
): Diagnostic | undefined {
  const severity = policy.rules[rule];
  if (severity === undefined || severity === 'off') return undefined;
  return diagnostic(rule, severity, path, message, targetId);
}

function measurePx(measure: Measure, tokens: Record<string, DesignToken>): number | undefined {
  if (measure.kind === 'literal') return measure.value;
  const token = tokens[measure.tokenId];
  return token?.category === 'spacing' ? token.value.valuePx : undefined;
}

function layoutMeasures(layout: Layout, path: string): Array<{ measure: Measure; path: string; minimumChecked: boolean }> {
  const result: Array<{ measure: Measure; path: string; minimumChecked: boolean }> = [];
  result.push({ measure: layout.gap, path: `${path}.gap`, minimumChecked: true });
  for (const side of ['top', 'right', 'bottom', 'left'] as const) {
    result.push({ measure: layout.padding[side], path: `${path}.padding.${side}`, minimumChecked: true });
  }
  return result;
}

function styleDiagnostics(
  style: Partial<SemanticStyle>,
  path: string,
  nodeId: string,
  policy: DesignSystemPolicy,
  diagnostics: Diagnostic[],
): void {
  for (const field of ['fill', 'textColor'] as const) {
    if (style[field]?.kind !== 'literal') continue;
    const issue = ruleDiagnostic(policy, 'literal-color', `${path}.${field}`, 'Use a color token instead of a literal color.', nodeId);
    if (issue) diagnostics.push(issue);
  }
  if (style.radius?.kind === 'literal') {
    const issue = ruleDiagnostic(policy, 'literal-spacing', `${path}.radius`, 'Use a radius token instead of a literal radius.', nodeId);
    if (issue) diagnostics.push(issue);
  }
}

function inspectLayout(
  layout: Layout,
  path: string,
  nodeId: string,
  document: DesignDocument,
  policy: DesignSystemPolicy,
  diagnostics: Diagnostic[],
): void {
  for (const entry of layoutMeasures(layout, path)) {
    if (entry.measure.kind === 'literal') {
      const issue = ruleDiagnostic(policy, 'literal-spacing', entry.path, 'Use a spacing token instead of a literal measure.', nodeId);
      if (issue) diagnostics.push(issue);
    }
    if (entry.minimumChecked) {
      const px = measurePx(entry.measure, document.tokens);
      if (px !== undefined && px > 0 && px < policy.minimumSpacingPx) {
        const issue = ruleDiagnostic(policy, 'minimum-spacing', entry.path, `Spacing must be at least ${policy.minimumSpacingPx}px.`, nodeId);
        if (issue) diagnostics.push(issue);
      }
    }
  }
}

function inspectNode(
  node: DesignDocument['nodes'][string] | TemplateNode,
  path: string,
  nodeId: string,
  document: DesignDocument,
  policy: DesignSystemPolicy,
  diagnostics: Diagnostic[],
): void {
  inspectLayout(node.layout, `${path}.layout`, nodeId, document, policy, diagnostics);
  styleDiagnostics(node.style, `${path}.style`, nodeId, policy, diagnostics);
  for (const [index, rule] of node.responsive.entries()) {
    const override = rule.overrides.layout;
    if (!override) continue;
    const responsiveMeasures: Array<{ measure: Measure; path: string }> = [];
    if (override.gap !== undefined) responsiveMeasures.push({ measure: override.gap, path: `${path}.responsive[${index}].overrides.layout.gap` });
    for (const side of ['top', 'right', 'bottom', 'left'] as const) {
      const value = override.padding?.[side];
      if (value !== undefined) responsiveMeasures.push({ measure: value, path: `${path}.responsive[${index}].overrides.layout.padding.${side}` });
    }
    for (const entry of responsiveMeasures) {
      if (entry.measure.kind === 'literal') {
        const issue = ruleDiagnostic(policy, 'literal-spacing', entry.path, 'Use a spacing token instead of a literal measure.', nodeId);
        if (issue) diagnostics.push(issue);
      }
      const px = measurePx(entry.measure, document.tokens);
      if (px !== undefined && px > 0 && px < policy.minimumSpacingPx) {
        const issue = ruleDiagnostic(policy, 'minimum-spacing', entry.path, `Spacing must be at least ${policy.minimumSpacingPx}px.`, nodeId);
        if (issue) diagnostics.push(issue);
      }
    }
  }
}

/** Returns deterministic policy diagnostics without changing the source document. */
export function validateDesignSystem(document: DesignDocument, policy: DesignSystemPolicy): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const rule of RULES) {
    if (!SEVERITIES.includes(policy?.rules?.[rule])) {
      diagnostics.push({ code: 'design-system.policy-configuration', message: `Policy severity for ${rule} is invalid.`, severity: 'error', path: `policy.rules.${rule}` });
    }
  }
  if (typeof policy?.minimumSpacingPx !== 'number' || !Number.isFinite(policy.minimumSpacingPx) || policy.minimumSpacingPx < 0) {
    diagnostics.push({ code: 'design-system.policy-configuration', message: 'minimumSpacingPx must be a finite non-negative number.', severity: 'error', path: 'policy.minimumSpacingPx' });
  }
  if (diagnostics.length > 0) return diagnostics;

  for (const nodeId of Object.keys(document.nodes).sort()) {
    const node = document.nodes[nodeId]!;
    inspectNode(node, `nodes.${nodeId}`, nodeId, document, policy, diagnostics);
  }
  for (const componentId of Object.keys(document.components).sort()) {
    const component = document.components[componentId]!;
    for (const templateId of Object.keys(component.templateNodes).sort()) {
      const node = component.templateNodes[templateId]!;
      inspectNode(node, `components.${componentId}.templateNodes.${templateId}`, `${componentId}:${templateId}`, document, policy, diagnostics);
    }
    for (const variantId of Object.keys(component.variants).sort()) {
      const variant = component.variants[variantId]!;
      for (const templateId of Object.keys(variant.nodeOverrides).sort()) {
        const override = variant.nodeOverrides[templateId]!;
        if (override.style) styleDiagnostics(override.style, `components.${componentId}.variants.${variantId}.nodeOverrides.${templateId}.style`, `${componentId}:${templateId}`, policy, diagnostics);
      }
    }
  }
  for (const tokenId of Object.keys(document.tokens).sort()) {
    const token = document.tokens[tokenId]!;
    if (token.category !== 'shadow' || token.value.color.kind !== 'literal') continue;
    const issue = ruleDiagnostic(policy, 'literal-color', `tokens.${tokenId}.value.color`, 'Use a color token in shadow definitions instead of a literal color.', tokenId);
    if (issue) diagnostics.push(issue);
  }
  for (const nodeId of Object.keys(document.nodes).sort()) {
    const node = document.nodes[nodeId]!;
    if (node.kind !== 'component-instance') continue;
    for (const templateId of Object.keys(node.nodeOverrides).sort()) {
      const override = node.nodeOverrides[templateId]!;
      if (override.style) styleDiagnostics(override.style, `nodes.${nodeId}.nodeOverrides.${templateId}.style`, nodeId, policy, diagnostics);
    }
  }
  for (const marker of Object.keys(document.metadata).filter((key) => key.startsWith('detached:')).sort()) {
    if (document.metadata[marker] !== true) continue;
    const nodeId = marker.slice('detached:'.length);
    if (!document.nodes[nodeId]) continue;
    const issue = ruleDiagnostic(policy, 'detached-instance', `metadata.${marker}`, 'This node is marked as detached from its component definition.', nodeId);
    if (issue) diagnostics.push(issue);
  }
  return diagnostics;
}
