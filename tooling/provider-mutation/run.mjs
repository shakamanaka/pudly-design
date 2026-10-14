#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { log } from 'node:console';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const manifestPath = join(repoRoot, 'tooling/provider-mutation/mutants.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
if (!Array.isArray(manifest.tests) || manifest.tests.length === 0) {
  throw new Error('Mutation manifest must name at least one baseline test path.');
}
if (!Array.isArray(manifest.mutants) || manifest.mutants.length === 0) {
  throw new Error('Mutation manifest must contain at least one real source mutant.');
}

const nodeModulesPath = realpathSync(join(repoRoot, 'node_modules'));
const outputRoot = resolve(repoRoot, manifest.reportDirectory ?? '.codex-design/provider-mutation');
mkdirSync(outputRoot, { recursive: true });
const runId = new Date().toISOString().replaceAll(':', '-');
const reportPath = join(outputRoot, `mutation-report-${runId}.json`);
const tempRoot = mkdtempSync(join(tmpdir(), 'codex-design-provider-mutation-'));
const testCommand = [
  join(nodeModulesPath, 'vitest/vitest.mjs'),
  'run',
  ...manifest.tests,
];
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !/(?:API[_-]?KEY|TOKEN|SECRET|CREDENTIAL|AUTHORIZATION)/i.test(key)),
);
env.NODE_ENV = 'test';
const timeoutMs = manifest.timeoutMs ?? 120_000;

function copyProject(destination) {
  cpSync(repoRoot, destination, {
    recursive: true,
    filter: (source) => {
      const rel = relative(repoRoot, source);
      if (!rel) return true;
      const first = rel.split(/[\\/]/, 1)[0];
      return !['.git', '.codex', '.codex-design', 'node_modules', 'playwright-report', 'test-results', 'coverage', 'dist'].includes(first)
        && !/^\.env(?:\.|$)/.test(first)
        && !rel.endsWith('.log');
    },
  });
  symlinkSync(nodeModulesPath, join(destination, 'node_modules'), 'dir');
}

function runTests(cwd, testPath) {
  const args = [...testCommand.slice(0, 2), ...(testPath ? [testPath] : manifest.tests)];
  const result = spawnSync(process.execPath, args, {
    cwd,
    env,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 10 * 1024 * 1024,
  });
  return {
    exitCode: result.status,
    signal: result.signal,
    timedOut: Boolean(result.error?.code === 'ETIMEDOUT'),
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  };
}

function redact(value) {
  let safe = value;
  for (const sentinel of manifest.redactions ?? []) {
    if (sentinel) safe = safe.replaceAll(sentinel, '[REDACTED TEST SENTINEL]');
  }
  return safe;
}

function applyMutant(projectRoot, mutant) {
  const path = resolve(projectRoot, mutant.file);
  if (!path.startsWith(`${projectRoot}/`) || !existsSync(path)) {
    throw new Error(`Mutant ${mutant.id} has an invalid source path: ${mutant.file}`);
  }
  const before = readFileSync(path, 'utf8');
  const occurrences = before.split(mutant.from).length - 1;
  if (occurrences !== 1) {
    throw new Error(`Mutant ${mutant.id} patch must match exactly once; found ${occurrences}.`);
  }
  writeFileSync(path, before.replace(mutant.from, mutant.to));
  const after = readFileSync(path, 'utf8');
  if (after === before || !after.includes(mutant.to)) {
    throw new Error(`Mutant ${mutant.id} source patch was not applied.`);
  }
}

function excerpt(output, mutant) {
  const safe = redact(output);
  const lines = safe.split('\n');
  const needles = [mutant.testName, mutant.expectedFailure, 'FAIL', 'AssertionError'].filter(Boolean);
  const relevant = new Set();
  for (let i = 0; i < lines.length; i += 1) {
    if (needles.some((needle) => lines[i].includes(needle))) {
      for (let j = Math.max(0, i - 1); j <= Math.min(lines.length - 1, i + 3); j += 1) relevant.add(j);
    }
  }
  return [...relevant].sort((a, b) => a - b).map((index) => lines[index]).join('\n').slice(0, 4000);
}

const report = {
  runId,
  node: process.version,
  vitest: JSON.parse(readFileSync(join(nodeModulesPath, 'vitest/package.json'), 'utf8')).version,
  testPaths: manifest.tests,
  timeoutMs,
  baseline: null,
  mutants: [],
  accepted: false,
};

try {
  const baselineRoot = join(tempRoot, 'baseline');
  mkdirSync(baselineRoot, { recursive: true });
  copyProject(baselineRoot);
  const baseline = runTests(baselineRoot);
  report.baseline = {
    status: baseline.exitCode === 0 ? 'passed' : baseline.timedOut ? 'timeout' : 'failed',
    outputExcerpt: redact(baseline.output).slice(-4000),
  };
  if (baseline.exitCode !== 0) {
    throw new Error(`Baseline tests did not pass in disposable copy; see ${reportPath}`);
  }

  for (const mutant of manifest.mutants) {
    const mutantRoot = join(tempRoot, mutant.id.replace(/[^a-zA-Z0-9_-]/g, '_'));
    mkdirSync(mutantRoot, { recursive: true });
    copyProject(mutantRoot);
    applyMutant(mutantRoot, mutant);
    const result = runTests(mutantRoot, mutant.testPath);
    const namedFailure = result.output.includes(mutant.testName ?? '');
    const expectedFailure = result.output.includes(mutant.expectedFailure ?? '');
    const killed = result.exitCode !== 0 && !result.timedOut && namedFailure && expectedFailure;
    report.mutants.push({
      id: mutant.id,
      area: mutant.area,
      source: mutant.file,
      testPath: mutant.testPath,
      testName: mutant.testName,
      status: killed ? 'killed' : result.timedOut ? 'timeout' : result.exitCode === 0 ? 'survived' : 'failed-unconfirmed',
      sourcePatchApplied: true,
      outputExcerpt: excerpt(result.output, mutant),
    });
  }

  report.accepted = report.mutants.every((mutant) => mutant.status === 'killed');
} finally {
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  rmSync(tempRoot, { recursive: true, force: true });
}

log(`Provider mutation report: ${reportPath}`);
log(`Baseline: ${report.baseline.status}; mutants: ${report.mutants.map(({ id, status }) => `${id}=${status}`).join(', ')}`);
if (!report.accepted) process.exitCode = 1;
