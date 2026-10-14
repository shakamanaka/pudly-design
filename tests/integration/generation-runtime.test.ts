import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalAgentRunStore } from '../../src/adapters/persistence/local-run-store';
import { ProjectService, type ProjectPersistence } from '../../src/application/project-service';
import { CodingAgentError } from '../../src/domain/agent-error';
import type { AgentRunStore, CodingAgent, CodingAgentResponse, PersistedProjectEnvelope, RunEvent } from '../../src/domain/types';

class MemoryPersistence implements ProjectPersistence {
  saved: PersistedProjectEnvelope | null = null;
  async loadCurrent() { return structuredClone(this.saved); }
  async load() { return structuredClone(this.saved); }
  async select() {}
  async saveAtomically(envelope: PersistedProjectEnvelope, expectedRevision: number) {
    const current = this.saved?.document.revision ?? 0;
    if (current !== expectedRevision) throw new Error('revision conflict');
    this.saved = structuredClone(envelope);
    return { savedRevision: envelope.document.revision };
  }
}

class ErrorAgent implements CodingAgent {
  async *execute(): AsyncIterable<RunEvent | { type: 'response'; response: CodingAgentResponse }> {
    yield { type: 'response', response: { operations: [] } };
    throw new CodingAgentError('agent.timeout', 'Generation took longer than the configured time limit. Try generating a smaller section; your saved design is preserved.');
  }
  async cancel() {}
  async getStatus(runId: string) { return { runId, state: 'FAILED' as const }; }
}

const directories: string[] = [];
async function waitForTerminal(service: ProjectService, runId: string) {
  const end = Date.now() + 3_000;
  while (!['FAILED', 'CANCELLED', 'ROLLED_BACK', 'SUCCEEDED'].includes(service.getRun(runId).run.state) && Date.now() < end) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return service.getRun(runId).run;
}

afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

describe('generation runtime application lifecycle', () => {
  it('persists typed agent errors and preserves their actionable diagnostics after reopening', async () => {
    const persistence = new MemoryPersistence();
    const directory = await mkdtemp(join(tmpdir(), 'codex-design-run-records-'));
    directories.push(directory);
    const store: AgentRunStore = new LocalAgentRunStore(directory);
    const service = await ProjectService.open(persistence, new ErrorAgent(), store);
    const project = await service.createProject('Generation runtime');
    const { runId } = await service.startRun('Build the screen', [], project.document.revision);
    const record = await waitForTerminal(service, runId);

    expect(record.state).toBe('FAILED');
    expect(record.validationResults).toContainEqual(expect.objectContaining({ code: 'agent.timeout', message: expect.stringContaining('smaller section') }));
    expect(service.getRun(runId).events.filter(event => event.type === 'diagnostic' && event.diagnostic.code === 'agent.timeout')).toHaveLength(1);

    const reopened = await ProjectService.open(persistence, new ErrorAgent(), store);
    expect(reopened.listRuns()).toContainEqual(expect.objectContaining({ id: runId, state: 'FAILED', validationResults: expect.arrayContaining([expect.objectContaining({ code: 'agent.timeout' })]) }));
    expect(reopened.getProject()?.document.revision).toBe(project.document.revision);
  });

  it('validates the trusted bounded timeout override', async () => {
    const { generationTimeoutFromEnvironment } = await import('../../server/index');
    expect(generationTimeoutFromEnvironment(undefined)).toBe(300_000);
    expect(generationTimeoutFromEnvironment('30000')).toBe(30_000);
    expect(generationTimeoutFromEnvironment('600000')).toBe(600_000);
    expect(() => generationTimeoutFromEnvironment('29999')).toThrow(/30000 through 600000/);
    expect(() => generationTimeoutFromEnvironment('infinite')).toThrow(/integer/);
  });
});
