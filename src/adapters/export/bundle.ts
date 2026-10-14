import { Buffer } from 'node:buffer';
import { strToU8, zipSync } from 'fflate';
import type { DesignExporter, ExportArtifact, ExportResult } from '../../domain/index';

function validRelativePath(name: string): boolean {
  if (!name || name.includes('\0') || name.includes('\\') || name.startsWith('/') || /^[A-Za-z]:/.test(name)) return false;
  const segments = name.split('/');
  return segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..' && !['__proto__', 'prototype', 'constructor'].includes(segment.toLowerCase()));
}

function archiveFailure(result: ExportResult, code: string, message: string): ExportResult {
  return {
    target: result.target,
    status: 'failed',
    artifacts: [],
    fidelity: result.fidelity,
    diagnostics: [...result.diagnostics, { code, message, severity: 'error' }],
  };
}

function fileBytes(artifact: ExportArtifact): Uint8Array {
  if (artifact.encoding !== 'base64') return strToU8(artifact.contents);
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(artifact.contents)) {
    throw new Error('Artifact contents are not valid base64.');
  }
  const decoded = Buffer.from(artifact.contents, 'base64');
  if (decoded.toString('base64') !== artifact.contents) throw new Error('Artifact contents are not canonical base64.');
  return new Uint8Array(decoded);
}

/**
 * Packages an adapter's relative-path artifacts as one browser-downloadable ZIP.
 * The inner exporter remains responsible for semantic mapping and fidelity.
 */
export class BundledExporter implements DesignExporter {
  constructor(private readonly inner: DesignExporter, private readonly archiveName: string) {}

  async export(document: Parameters<DesignExporter['export']>[0]): Promise<ExportResult> {
    const result = await this.inner.export(document);
    if (result.status === 'failed' || result.artifacts.length === 0) return result;
    if (result.status === 'succeeded' && result.fidelity.some((entry) => entry.status !== 'preserved')) {
      return archiveFailure(result, 'export.archive.status', 'The inner exporter reported success while its fidelity report contains degraded or omitted features.');
    }
    if (!validRelativePath(this.archiveName) || this.archiveName.includes('/')) {
      return archiveFailure(result, 'export.archive.name', 'The archive name must be a plain relative file name.');
    }

    const files = Object.create(null) as Record<string, Uint8Array>;
    const occupiedPaths = new Set<string>();
    for (const artifact of result.artifacts) {
      if (!validRelativePath(artifact.name)) {
        return archiveFailure(result, 'export.archive.path', `The artifact path is unsafe: ${JSON.stringify(artifact.name)}.`);
      }
      const portableKey = artifact.name.toLowerCase();
      if (occupiedPaths.has(portableKey)) {
        return archiveFailure(result, 'export.archive.duplicate', `The artifact path is duplicated: ${JSON.stringify(artifact.name)}.`);
      }
      occupiedPaths.add(portableKey);
      try {
        files[artifact.name] = fileBytes(artifact);
      } catch (error) {
        return archiveFailure(result, 'export.archive.encoding', error instanceof Error ? error.message : 'An artifact has an invalid encoding.');
      }
    }
    if (occupiedPaths.has('fidelity-report.json')) {
      return archiveFailure(result, 'export.archive.reserved', 'An input artifact uses the reserved fidelity-report.json path.');
    }

    const report = {
      target: result.target,
      status: result.status,
      diagnostics: result.diagnostics,
      fidelity: result.fidelity,
      artifacts: result.artifacts.map(({ name, mimeType, encoding }) => ({ name, mimeType, encoding })),
    };
    files['fidelity-report.json'] = strToU8(`${JSON.stringify(report, null, 2)}\n`);

    try {
      const archive = zipSync(files, { level: 6 });
      return {
        target: result.target,
        status: result.status,
        artifacts: [{ name: this.archiveName, mimeType: 'application/zip', encoding: 'base64', contents: Buffer.from(archive).toString('base64') }],
        fidelity: result.fidelity,
        diagnostics: result.diagnostics,
      };
    } catch (error) {
      return archiveFailure(result, 'export.archive.write', error instanceof Error ? `Could not package export artifacts: ${error.message}` : 'Could not package export artifacts.');
    }
  }
}
