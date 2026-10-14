#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const manifest = JSON.parse(readFileSync(join(root, 'tooling/project-explorer-mutation/mutants.json'), 'utf8'));
if (typeof manifest.baselineTest !== 'string' || !Array.isArray(manifest.mutants) || !manifest.mutants.length) {
  throw new Error('Project explorer mutation manifest must define a baseline and source mutants.');
}

const modules = realpathSync(join(root, 'node_modules'));
const outputDirectory = resolve(root, manifest.reportDirectory ?? '.codex-design/project-explorer-mutation');
mkdirSync(outputDirectory, { recursive: true });
const runId = new Date().toISOString().replaceAll(':', '-');
const reportPath = join(outputDirectory, `mutation-report-${runId}.json`);
const temporaryRoot = mkdtempSync(join(tmpdir(), 'codex-design-project-explorer-mutation-'));
const timeoutMs = manifest.timeoutMs ?? 60_000;
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(?:API[_-]?KEY|TOKEN|SECRET|CREDENTIAL|AUTHORIZATION)/i.test(key)));
env.NODE_ENV = 'test';

function copyProject(destination) {
  cpSync(root, destination, { recursive: true, filter: source => {
    const path = relative(root, source);
    if (!path) return true;
    const first = path.split(/[\\/]/, 1)[0];
    return !['.git', '.codex', '.codex-design', 'node_modules', 'playwright-report', 'test-results', 'coverage', 'dist'].includes(first)
      && !/^\.env(?:\.|$)/.test(first)
      && !path.endsWith('.log');
  } });
  symlinkSync(modules, join(destination, 'node_modules'), 'dir');
}

function runTest(cwd, testPath, testName) {
  const args = [join(modules, 'vitest/vitest.mjs'), 'run', testPath];
  if (testName) args.push('-t', testName);
  const result = spawnSync(process.execPath, args, {
    cwd, env, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024,
  });
  return { exitCode: result.status, timedOut: result.error?.code === 'ETIMEDOUT', output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

function applyMutant(projectRoot, mutant) {
  const source = resolve(projectRoot, mutant.file);
  if (!source.startsWith(`${projectRoot}/`) || !existsSync(source)) throw new Error(`Invalid mutant source path: ${mutant.file}`);
  const before = readFileSync(source, 'utf8');
  const count = before.split(mutant.from).length - 1;
  if (count !== 1) throw new Error(`${mutant.id}: expected one exact source match, found ${count}.`);
  const after = before.replace(mutant.from, mutant.to);
  writeFileSync(source, after);
  if (readFileSync(source, 'utf8') === before) throw new Error(`${mutant.id}: source patch was not applied.`);
}

function excerpt(output, mutant) {
  const lines = output.split('\n');
  const selected = new Set();
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index]?.includes(mutant.testName) || lines[index]?.includes('AssertionError')) {
      for (let neighbor = Math.max(0, index - 1); neighbor <= Math.min(lines.length - 1, index + 3); neighbor += 1) selected.add(neighbor);
    }
  }
  return [...selected].sort((a, b) => a - b).map(index => lines[index]).join('\n').slice(0, 2500);
}

const report = { runId, node: process.version, baselineTest: manifest.baselineTest, baseline: null, mutants: [], accepted: false };
try {
  const baselineRoot = join(temporaryRoot, 'baseline');
  mkdirSync(baselineRoot, { recursive: true });
  copyProject(baselineRoot);
  const baseline = runTest(baselineRoot, manifest.baselineTest);
  report.baseline = { status: baseline.exitCode === 0 ? 'passed' : baseline.timedOut ? 'timeout' : 'failed', outputExcerpt: baseline.output.slice(-2500) };
  if (baseline.exitCode !== 0) throw new Error(`Project explorer QA baseline failed; see ${reportPath}`);

  for (const mutant of manifest.mutants) {
    const mutantRoot = join(temporaryRoot, mutant.id.replace(/[^a-zA-Z0-9_-]/g, '_'));
    mkdirSync(mutantRoot, { recursive: true });
    copyProject(mutantRoot);
    applyMutant(mutantRoot, mutant);
    const result = runTest(mutantRoot, manifest.baselineTest, mutant.testName);
    const namedFailure = result.output.includes(mutant.testName);
    const killed = result.exitCode !== 0 && !result.timedOut && namedFailure;
    report.mutants.push({ id: mutant.id, source: mutant.file, testName: mutant.testName, status: killed ? 'killed' : result.timedOut ? 'timeout' : result.exitCode === 0 ? 'survived' : 'failed-unconfirmed', sourcePatchApplied: true, outputExcerpt: excerpt(result.output, mutant) });
  }
  report.accepted = report.mutants.every(mutant => mutant.status === 'killed');
} finally {
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  rmSync(temporaryRoot, { recursive: true, force: true });
}

console.log(`Project explorer mutation report: ${reportPath}`);
console.log(`Baseline: ${report.baseline?.status ?? 'failed'}; mutants: ${report.mutants.map(({ id, status }) => `${id}=${status}`).join(', ')}`);
if (!report.accepted) process.exitCode = 1;
