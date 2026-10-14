import { Buffer } from 'node:buffer';
import { strFromU8, unzipSync } from 'fflate';
import { expect, test } from 'vitest';
import { BundledExporter } from '../../src/adapters/export/bundle';
import { VueExporter } from '../../src/adapters/export/vue';
import { createDocument, createNodeBase } from '../../src/domain';
import type { DesignExporter, ExportResult } from '../../src/domain';

function constantExporter(result: ExportResult): DesignExporter {
  return { export: async () => result };
}

test('Vue ZIP preserves runnable paths and includes source graph plus fidelity report', async () => {
  const document = createDocument('Bundle sample');
  document.nodes.title = {
    ...createNodeBase('title', 'Title'),
    kind: 'text',
    text: 'Portable text',
    textStyle: {},
  };
  document.pages.page_1!.rootNodeIds.push('title');
  const result = await new BundledExporter(new VueExporter(), 'pudly-vue.zip').export(document);

  expect(result.target).toBe('vue');
  expect(result.status).toBe('succeeded');
  expect(result.artifacts).toHaveLength(1);
  expect(result.artifacts[0]).toMatchObject({ name: 'pudly-vue.zip', mimeType: 'application/zip', encoding: 'base64' });

  const archive = unzipSync(Buffer.from(result.artifacts[0]!.contents, 'base64'));
  expect(Object.keys(archive)).toEqual(expect.arrayContaining([
    'package.json', 'index.html', 'vite.config.js', 'src/main.ts', 'src/App.vue',
    'src/DesignNode.vue', 'src/design-rendering.ts', 'src/style.css',
    'src/design-document.json', 'src/design-tree.json', 'fidelity-report.json',
  ]));
  expect(JSON.parse(strFromU8(archive['src/design-document.json']!))).toMatchObject({ name: 'Bundle sample' });
  expect(JSON.parse(strFromU8(archive['src/design-tree.json']!))[0].roots[0].text).toBe('Portable text');
  const report = JSON.parse(strFromU8(archive['fidelity-report.json']!)) as { status: string; fidelity: Array<{ status: string }> };
  expect(report.status).toBe('succeeded');
  expect(report.fidelity.every((entry) => entry.status === 'preserved')).toBe(true);
});

test('ZIP wrapper preserves a partial result and rejects unsafe or ambiguous artifact paths', async () => {
  const partial: ExportResult = {
    target: 'vue',
    status: 'partial',
    artifacts: [{ name: 'src/Design.vue', mimeType: 'text/x-vue', encoding: 'utf8', contents: '<template />' }],
    fidelity: [{ feature: 'image asset', status: 'degraded', fallback: 'Placeholder shown.', severity: 'warning' }],
    diagnostics: [{ code: 'export.loss', message: 'An image asset is unavailable.', severity: 'warning' }],
  };
  const result = await new BundledExporter(constantExporter(partial), 'partial.zip').export(createDocument('Partial'));
  expect(result.status).toBe('partial');
  expect(result.diagnostics).toEqual(partial.diagnostics);
  const archive = unzipSync(Buffer.from(result.artifacts[0]!.contents, 'base64'));
  expect(JSON.parse(strFromU8(archive['fidelity-report.json']!))).toMatchObject({ status: 'partial', diagnostics: partial.diagnostics });

  for (const name of ['../escape.txt', '/absolute.txt', 'C:/drive.txt', 'src\\escape.txt', 'src/../escape.txt', 'bad\0name']) {
    const unsafe = { ...partial, artifacts: [{ ...partial.artifacts[0]!, name }] };
    const rejected = await new BundledExporter(constantExporter(unsafe), 'invalid.zip').export(createDocument('Invalid path'));
    expect(rejected).toMatchObject({ status: 'failed', artifacts: [] });
    expect(rejected.diagnostics.at(-1)?.code).toBe('export.archive.path');
  }

  const duplicate: ExportResult = {
    ...partial,
    artifacts: [
      { ...partial.artifacts[0]!, name: 'src/View.vue' },
      { ...partial.artifacts[0]!, name: 'SRC/view.vue' },
    ],
  };
  const duplicateResult = await new BundledExporter(constantExporter(duplicate), 'duplicate.zip').export(createDocument('Duplicate path'));
  expect(duplicateResult.diagnostics.at(-1)?.code).toBe('export.archive.duplicate');

  const prototypeKey: ExportResult = {
    ...partial,
    artifacts: [{ ...partial.artifacts[0]!, name: '__proto__', contents: 'ordinary file data' }],
  };
  const prototypeResult = await new BundledExporter(constantExporter(prototypeKey), 'prototype.zip').export(createDocument('Prototype key'));
  expect(prototypeResult).toMatchObject({ status: 'failed', artifacts: [] });
  expect(prototypeResult.diagnostics.at(-1)?.code).toBe('export.archive.path');

  const malformedEncoding: ExportResult = {
    ...partial,
    artifacts: [{ ...partial.artifacts[0]!, encoding: 'base64', contents: 'not valid base64!' }],
  };
  const malformedResult = await new BundledExporter(constantExporter(malformedEncoding), 'malformed.zip').export(createDocument('Malformed artifact'));
  expect(malformedResult).toMatchObject({ status: 'failed', artifacts: [] });
  expect(malformedResult.diagnostics.at(-1)?.code).toBe('export.archive.encoding');
});

test('ZIP wrapper does not manufacture a bundle when the inner exporter fails', async () => {
  const failed: ExportResult = {
    target: 'vue', status: 'failed', artifacts: [], fidelity: [],
    diagnostics: [{ code: 'document.version', message: 'Unsupported schema.', severity: 'error' }],
  };
  const result = await new BundledExporter(constantExporter(failed), 'failed.zip').export(createDocument('Failed'));
  expect(result).toEqual(failed);
});
