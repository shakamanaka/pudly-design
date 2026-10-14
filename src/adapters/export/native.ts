import { validateDocument } from '../../domain/index';
import type { DesignDocument, DesignExporter, ExportResult, FidelityEntry } from '../../domain/index';

export class NativeExporter implements DesignExporter {
  async export(document: DesignDocument): Promise<ExportResult> {
    const parsed = validateDocument(document);
    if (!parsed.ok) return { target: 'native', status: 'failed', artifacts: [], fidelity: [], diagnostics: parsed.diagnostics };
    const fidelity: FidelityEntry[] = Object.keys(document).map(feature => ({ feature, status: 'preserved', severity: 'info' }));
    for (const node of Object.values(document.nodes)) {
      for (const field of Object.keys(node)) fidelity.push({ nodeId: node.id, feature: field, status: 'preserved', severity: 'info' });
    }
    for (const token of Object.values(document.tokens)) fidelity.push({ feature: `token:${token.id}:${token.category}`, status: 'preserved', severity: 'info' });
    for (const component of Object.values(document.components)) {
      for (const field of Object.keys(component)) fidelity.push({ feature: `component:${component.id}:${field}`, status: 'preserved', severity: 'info' });
    }
    return {
      target: 'native', status: 'succeeded', diagnostics: [],
      artifacts: [{ name: 'design.codex.json', mimeType: 'application/json', encoding: 'utf8', contents: JSON.stringify(parsed.value, null, 2) }],
      fidelity,
    };
  }
}
