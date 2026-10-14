import { assessPageComposition } from './design-quality';
import type { ProviderConnectionService, ProviderSelection } from '../domain/providers';
import { randomUUID } from 'node:crypto';
import {
  applyBatch, createDocument, DEFAULT_OPERATION_CAPABILITIES, parseBatch, validateDocument, validateDesignSystem, DEFAULT_DESIGN_SYSTEM_POLICY,
} from '../domain/index';
import { CodingAgentError } from '../domain/agent-error';
import type {
  AgentRunRecord, AgentRunStore, ApplyResult, CodingAgent, DesignDocument, DesignExporter, DesignPersistence, Diagnostic,
  ExportResult, PersistedProjectEnvelope, RunEvent, RunState, SnapshotRecord,
} from '../domain/index';
import { sealEnvelope } from './integrity';
import { buildContext, collectSubtree } from './context';
import type { ProjectLibrary, ProjectSummary } from './project-library';

export interface ProjectPersistence extends DesignPersistence {
  loadCurrent(): Promise<PersistedProjectEnvelope | null>;
  select(id: string): Promise<void>;
  listProjects?(): Promise<ProjectSummary[]>;
  previewProject?(id: string): Promise<DesignDocument>;
  removeProject?(id: string): Promise<void>;
}
export class ApplicationError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'ApplicationError'; }
}
type ManagedRun = { agent?: CodingAgent; record: AgentRunRecord; events: RunEvent[]; abort: AbortController; renderTimer?: ReturnType<typeof setTimeout>; activeAttemptId?: string; stateSequence?: Promise<void> };
const terminal = new Set<RunState>(['SUCCEEDED', 'FAILED', 'CANCELLED', 'ROLLED_BACK']);
const renderedCreationKinds = new Set<string>(['frame', 'group', 'text', 'component-instance', 'vector']);
const timestamp = (): string => new Date().toISOString();
const diagnostic = (code: string, message: string): Diagnostic => ({ code, message, severity: 'error' });

class MemoryRunStore implements AgentRunStore {
  private readonly records = new Map<string, AgentRunRecord>();
  async loadAll(): Promise<AgentRunRecord[]> { return [...this.records.values()].map(record => structuredClone(record)); }
  async save(record: AgentRunRecord): Promise<void> { this.records.set(record.id, structuredClone(record)); }
}

export class ProjectService implements ProjectLibrary {
  private current: PersistedProjectEnvelope | null = null;
  private recoveryError: ApplicationError | null = null;
  private runRecoveryError: ApplicationError | null = null;
  private sequence: Promise<void> = Promise.resolve();
  private readonly runs = new Map<string, ManagedRun>();
  private readonly exporters = new Map<ExportResult['target'], DesignExporter>();

  private constructor(private readonly persistence: ProjectPersistence, private readonly agent: CodingAgent, private readonly runStore: AgentRunStore, private readonly providers?: ProviderConnectionService) {}

  static async open(persistence: ProjectPersistence, agent: CodingAgent, runStore: AgentRunStore = new MemoryRunStore(), providers?: ProviderConnectionService): Promise<ProjectService> {
    const service = new ProjectService(persistence, agent, runStore, providers);
    try { service.current = await persistence.loadCurrent(); }
    catch { service.recoveryError = new ApplicationError('project.recovery', 'The saved project could not be reopened. Its file was preserved. Create a new project to continue, or repair the original saved file.'); }
    try {
      for (const record of await runStore.loadAll()) {
        if (!terminal.has(record.state)) {
          const project = service.current?.document.id === record.documentId ? service.current : null;
          const entry = project?.history.undoableEntries.find(item => item.runId === record.id || item.batchId === record.batchId);
          const transition = record.batchId ? project?.history.auditTransitions.find(item => item.kind === 'commit' && item.batchId === record.batchId) : undefined;
          const committedRevision = record.committedRevision ?? entry?.afterRevision ?? transition?.toRevision;
          record.state = 'FAILED';
          record.finishedAt = timestamp();
          const issue = diagnostic('run.interrupted', 'This generation was interrupted by an application restart. It will not be rerun.');
          record.validationResults.push(issue);
          if (committedRevision !== undefined) record.committedRevision = committedRevision;
          await runStore.save(record);
        }
        service.runs.set(record.id, { record: structuredClone(record), events: [], abort: new AbortController() });
      }
    } catch (error) {
      service.runRecoveryError = new ApplicationError('run.recovery', `Saved generation records could not be recovered. The saved design can still be edited; generation is disabled until the records are repaired. Record files were preserved.${error instanceof Error ? ` ${error.message}` : ''}`);
    }
    return service;
  }

  getProject(): PersistedProjectEnvelope | null {
    if (this.recoveryError) throw this.recoveryError;
    return structuredClone(this.current);
  }
  getCapabilities(): { operationTypes: string[]; exportTargets: ExportResult['target'][]; nodeKinds: string[] } {
    return { operationTypes: [...DEFAULT_OPERATION_CAPABILITIES], exportTargets: [...this.exporters.keys()], nodeKinds: [...renderedCreationKinds] };
  }
  registerExporter(target: ExportResult['target'], exporter: DesignExporter): void { this.exporters.set(target, exporter); }

  async listProjects(): Promise<ProjectSummary[]> {
    if (!this.persistence.listProjects) throw new ApplicationError('project.library_unavailable', 'Project discovery is unavailable for this persistence adapter.');
    return this.persistence.listProjects();
  }

  async previewProject(id: string): Promise<DesignDocument> {
    if (!this.persistence.previewProject) throw new ApplicationError('project.library_unavailable', 'Project previews are unavailable for this persistence adapter.');
    return this.persistence.previewProject(id);
  }

  async openProject(id: string): Promise<PersistedProjectEnvelope> {
    return this.serial(async () => {
      this.assertNoActiveRun();
      const project = await this.persistence.load(id);
      if (!project) throw new ApplicationError('project.missing', 'The saved project could not be found.');
      await this.persistence.select(id);
      this.current = structuredClone(project);
      this.recoveryError = null;
      return structuredClone(project);
    });
  }

  async removeProject(id: string): Promise<PersistedProjectEnvelope | null> {
    if (!this.persistence.removeProject) throw new ApplicationError('project.library_unavailable', 'Project removal is unavailable for this persistence adapter.');
    return this.serial(async () => {
      this.assertNoActiveRun();
      const removesCurrent = this.current?.document.id === id;
      await this.persistence.removeProject!(id);
      if (removesCurrent) {
        this.current = null;
        this.recoveryError = null;
      }
      return structuredClone(this.current);
    });
  }

  async createProject(name: string): Promise<PersistedProjectEnvelope> {
    if (typeof name !== 'string' || !name.trim() || name.length > 120) throw new ApplicationError('project.name', 'Enter a project name of 1–120 characters.');
    return this.serial(async () => {
      if ([...this.runs.values()].some(run => !terminal.has(run.record.state))) throw new ApplicationError('run.busy', 'Finish or cancel the current generation before creating a project.');
      const next = sealEnvelope({ formatVersion: 1, document: createDocument(name.trim(), randomUUID(), randomUUID()), history: { undoableEntries: [], cursor: 0, auditTransitions: [], snapshots: [] }, appliedBatchIds: [], integrityHash: '' });
      await this.persistence.saveAtomically(next, 0);
      await this.persistence.select(next.document.id);
      this.current = next;
      this.recoveryError = null;
      return structuredClone(next);
    });
  }

  async apply(input: unknown): Promise<{ result: ApplyResult; project: PersistedProjectEnvelope }> {
    // Capture validated JSON data before awaiting the sequencer, so a caller
    // cannot alter a queued batch while an earlier save is pending.
    const parsed = parseBatch(input);
    const captured = parsed.ok ? structuredClone(parsed.value) : undefined;
    return this.serial(async () => {
      if (captured) return this.commit(captured);
      const current = this.requireProject();
      return {
        result: { status: 'rejected', batchId: 'invalid', revision: current.document.revision, diagnostics: [parsed.diagnostics[0] ?? diagnostic('batch.invalid', 'Invalid operation batch.'), ...parsed.diagnostics.slice(1)] },
        project: structuredClone(current),
      };
    });
  }

  private async commit(input: unknown, allowedNodeIds?: readonly string[], allowedPageIds?: readonly string[]): Promise<{ result: ApplyResult; project: PersistedProjectEnvelope }> {
    const current = this.requireProject();
    const parsed = parseBatch(input);
    if (!parsed.ok) return { result: { status: 'rejected', batchId: 'invalid', revision: current.document.revision, diagnostics: [parsed.diagnostics[0] ?? diagnostic('batch.invalid', 'Invalid operation batch.'), ...parsed.diagnostics.slice(1)] }, project: structuredClone(current) };
    const batch = parsed.value;
    const result = applyBatch(current.document, batch, current.appliedBatchIds, allowedNodeIds ? { allowedNodeIds, ...(allowedPageIds ? { allowedPageIds } : {}) } : undefined);
    if (result.status === 'rejected') return { result, project: structuredClone(current) };
    const next = structuredClone(current);
    next.document = result.document;
    const time = timestamp();
    next.history.undoableEntries = next.history.undoableEntries.slice(0, next.history.cursor);
    next.history.undoableEntries.push({ batchId: batch.id, beforeRevision: current.document.revision, afterRevision: result.revision, operations: structuredClone(batch.operations), inverseOperations: result.inverseOperations, source: batch.source, timestamp: time, ...(batch.runId ? { runId: batch.runId } : {}) });
    next.history.cursor = next.history.undoableEntries.length;
    next.history.auditTransitions.push({ id: randomUUID(), kind: 'commit', fromRevision: current.document.revision, toRevision: result.revision, batchId: batch.id, timestamp: time });
    next.history.snapshots.push(this.autoSnapshot(`before-${batch.id}`, current, time), this.autoSnapshot(`after-${batch.id}`, next, time));
    next.appliedBatchIds.push(batch.id);
    await this.publish(next, current.document.revision);
    return { result: structuredClone(result), project: structuredClone(this.requireProject()) };
  }

  async undo(expectedRevision: number): Promise<PersistedProjectEnvelope> { return this.historyMove('undo', expectedRevision); }
  async redo(expectedRevision: number): Promise<PersistedProjectEnvelope> { return this.historyMove('redo', expectedRevision); }

  private async historyMove(kind: 'undo' | 'redo', expectedRevision: number): Promise<PersistedProjectEnvelope> {
    return this.serial(async () => {
      const current = this.atRevision(expectedRevision);
      const cursor = current.history.cursor;
      const entry = current.history.undoableEntries[kind === 'undo' ? cursor - 1 : cursor];
      if (!entry) throw new ApplicationError('history.empty', `Nothing to ${kind}.`);
      const saved = current.history.snapshots.find(snapshot => snapshot.id === `${kind === 'undo' ? 'before' : 'after'}-${entry.batchId}`);
      if (!saved) throw new ApplicationError('history.missing', 'Recovery snapshot is missing. The current design was preserved.');
      const next = structuredClone(current);
      next.document = structuredClone(saved.document);
      next.document.revision = current.document.revision + 1;
      next.history.cursor += kind === 'undo' ? -1 : 1;
      next.history.auditTransitions.push({ id: randomUUID(), kind, fromRevision: current.document.revision, toRevision: next.document.revision, entryId: entry.batchId, timestamp: timestamp() });
      await this.publish(next, current.document.revision);
      return structuredClone(this.requireProject());
    });
  }

  async snapshot(label: string, expectedRevision: number): Promise<PersistedProjectEnvelope> {
    if (typeof label !== 'string' || !label.trim() || label.length > 120) throw new ApplicationError('snapshot.label', 'Enter a snapshot name of 1–120 characters.');
    return this.serial(async () => {
      const current = this.atRevision(expectedRevision);
      const next = structuredClone(current);
      next.history.snapshots.push({ id: randomUUID(), label: label.trim(), revision: current.document.revision, timestamp: timestamp(), document: structuredClone(current.document) });
      await this.publish(next, expectedRevision);
      return structuredClone(this.requireProject());
    });
  }

  async restore(id: string, expectedRevision: number): Promise<PersistedProjectEnvelope> {
    return this.serial(async () => {
      const current = this.atRevision(expectedRevision);
      const saved = current.history.snapshots.find(snapshot => snapshot.id === id);
      if (!saved) throw new ApplicationError('snapshot.missing', 'Snapshot was not found.');
      const next = structuredClone(current);
      next.document = structuredClone(saved.document);
      next.document.revision = current.document.revision + 1;
      const batchId = randomUUID();
      const time = timestamp();
      next.history.undoableEntries = next.history.undoableEntries.slice(0, next.history.cursor);
      next.history.undoableEntries.push({ batchId, beforeRevision: current.document.revision, afterRevision: next.document.revision, operations: [], inverseOperations: [], source: 'system', timestamp: time });
      next.history.cursor = next.history.undoableEntries.length;
      next.history.snapshots.push(this.autoSnapshot(`before-${batchId}`, current, time), this.autoSnapshot(`after-${batchId}`, next, time));
      next.history.auditTransitions.push({ id: randomUUID(), kind: 'restore', fromRevision: current.document.revision, toRevision: next.document.revision, entryId: id, timestamp: time });
      await this.publish(next, expectedRevision);
      return structuredClone(this.requireProject());
    });
  }

  async startRun(prompt: string, selectedNodeIds: string[], expectedRevision: number, pageId?: string, selection?: ProviderSelection): Promise<{ runId: string }> {
    const selectionSnapshot = selection ? structuredClone(selection) : undefined;
    if (this.runRecoveryError) throw this.runRecoveryError;
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 20000) throw new ApplicationError('prompt.invalid', 'Enter a request of 1–20,000 characters.');
    return this.serial(async () => {
      const project = this.atRevision(expectedRevision);
      if ([...this.runs.values()].some(run => !terminal.has(run.record.state))) throw new ApplicationError('run.busy', 'A generation is already in progress.');
      if (this.providers && !selectionSnapshot) throw new ApplicationError('provider.selection.required', 'Choose and verify a provider connection, model, and effort.');
      if (selectionSnapshot && !this.providers) throw new ApplicationError('provider.unavailable', 'Provider connections are unavailable on this server.');
      const resolved = selectionSnapshot && this.providers ? await this.providers.resolve(selectionSnapshot) : undefined;
      const id = randomUUID();
      const context = buildContext(project.document, id, prompt.trim(), selectedNodeIds, [...DEFAULT_OPERATION_CAPABILITIES], pageId);
      const record: AgentRunRecord = { id, documentId: project.document.id, baseRevision: project.document.revision, userRequest: prompt.trim(), selectedNodeIds: [...selectedNodeIds], resolvedContext: context.resolvedContext, operationCapabilities: context.operationCapabilities, state: 'QUEUED', startedAt: timestamp(), validationResults: [], qaResults: [], designSystemContext: structuredClone(context.designSystemContext), documentFragment: structuredClone(context.documentFragment) };
      if (resolved) record.providerSelection = structuredClone(resolved.metadata);
      const managed: ManagedRun = { agent: resolved?.agent ?? this.agent, record, events: [], abort: new AbortController() };
      await this.runStore.save(record);
      this.runs.set(id, managed);
      managed.events.push({ type: 'state', runId: id, state: 'QUEUED', at: timestamp() });
      void this.execute(managed, context).catch(error => this.fail(managed, error));
      return { runId: id };
    });
  }

  listRuns(): AgentRunRecord[] {
    if (this.runRecoveryError) throw this.runRecoveryError;
    const documentId = this.current?.document.id;
    return [...this.runs.values()]
      .filter(run => run.record.documentId === documentId)
      .map(run => structuredClone(run.record))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  getRun(id: string): { run: AgentRunRecord; events: RunEvent[] } {
    const managed = this.requireRun(id);
    return { run: structuredClone(managed.record), events: structuredClone(managed.events) };
  }

  async cancelRun(id: string): Promise<AgentRunRecord> {
    const managed = this.requireRun(id);
    if (terminal.has(managed.record.state) || managed.record.committedRevision !== undefined) return structuredClone(managed.record);
    if (managed.record.state === 'APPLYING') {
      await this.serial(async () => undefined);
      return structuredClone(managed.record);
    }
    managed.abort.abort();
    await (managed.agent ?? this.agent).cancel(managed.activeAttemptId ?? id);
    if (managed.record.committedRevision === undefined && !terminal.has(managed.record.state)) await this.state(managed, 'CANCELLED');
    return structuredClone(managed.record);
  }

  async acknowledgeRender(id: string, revision: number, success: boolean, message?: string): Promise<AgentRunRecord> {
    const managed = this.requireRun(id);
    if (managed.record.state !== 'RENDERING' || managed.record.committedRevision !== revision) throw new ApplicationError('render.conflict', 'This rendering acknowledgement does not match the committed design.');
    if (managed.renderTimer) clearTimeout(managed.renderTimer);
    if (!success) { await this.fail(managed, new ApplicationError('render.failed', message?.slice(0, 500) || 'The design committed but could not be rendered.')); return structuredClone(managed.record); }
    await this.state(managed, 'QA');
    const validation = validateDocument(this.requireProject().document);
    managed.record.qaResults = [...validation.diagnostics, ...(validation.ok ? validateDesignSystem(validation.value, DEFAULT_DESIGN_SYSTEM_POLICY) : [])];
    if (!validation.ok || managed.record.qaResults.some(issue => issue.severity === 'error') || this.requireProject().document.revision !== revision) await this.fail(managed, new ApplicationError('qa.failed', 'The rendered revision changed or did not pass design checks.'));
    else await this.state(managed, 'SUCCEEDED');
    return structuredClone(managed.record);
  }

  async export(target: ExportResult['target']): Promise<ExportResult> {
    const exporter = this.exporters.get(target);
    if (!exporter) throw new ApplicationError('export.unavailable', 'This export target has not been implemented.');
    return exporter.export(structuredClone(this.requireProject().document));
  }

  private async execute(managed: ManagedRun, request: Parameters<CodingAgent['execute']>[0]): Promise<void> {
    await this.state(managed, 'PLANNING');
    if (terminal.has(managed.record.state)) return;
    await this.state(managed, 'RUNNING');
    if (terminal.has(managed.record.state)) return;
    if (managed.abort.signal.aborted) { await this.state(managed, 'CANCELLED'); return; }
    let batch!: import('../domain/types').OperationBatch;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (managed.abort.signal.aborted || terminal.has(managed.record.state)) return;
      if (attempt > 0) await this.state(managed, 'RUNNING');
      const attemptRequest = attempt === 0 ? request : { ...request, runId: `${request.runId}-repair`, prompt: `${request.prompt}\n\nComposition repair feedback: ${managed.record.qaResults.map(issue => issue.message).join(' ')} Return a complete replacement proposal from the same original revision. The prior draft was not committed.` };
      managed.activeAttemptId = attemptRequest.runId;
      let response: unknown;
    for await (const event of (managed.agent ?? this.agent).execute(attemptRequest, managed.abort.signal)) {
      if (event.type === 'response') response = event.response;
      else if (event.type !== 'state' && event.type !== 'result') managed.events.push({ ...structuredClone(event), runId: managed.record.id });
      if (managed.abort.signal.aborted) break;
    }
    if (managed.abort.signal.aborted) { if (!terminal.has(managed.record.state)) await this.state(managed, 'CANCELLED'); return; }
    if (!response || typeof response !== 'object' || !('operations' in response)) throw new ApplicationError('agent.response', 'Codex did not return structured design operations.');
    await this.state(managed, 'VALIDATING_OPERATIONS');
    if (terminal.has(managed.record.state)) return;
    const parsed = parseBatch({ id: randomUUID(), documentId: request.documentId, expectedRevision: request.baseRevision, source: 'agent', runId: request.runId, capabilitySet: request.operationCapabilities, operations: response.operations });
    if (!parsed.ok) { managed.record.validationResults = parsed.diagnostics; throw new ApplicationError('agent.operations', parsed.diagnostics.map(item => item.message).join('; ')); }
    batch = parsed.value;
    for (const [operationIndex, operation] of batch.operations.entries()) {
      if (operation.type === 'node.create' && !renderedCreationKinds.has(operation.node.kind)) {
        const issue: Diagnostic = { code: 'agent.node-kind', message: `Creation of ${operation.node.kind} is not supported by the current canvas. Use an advertised node kind.`, severity: 'error', operationIndex, ...(typeof operation.node.id === 'string' ? { targetId: operation.node.id } : {}) };
        managed.record.validationResults = [issue];
        throw new ApplicationError(issue.code, issue.message);
      }
    }
    if (batch.operations.length === 0) throw new ApplicationError('agent.empty', 'Codex returned no edits. Retry with a more specific request.');

      const current = this.requireProject();
      const allowed = request.selectedNodeIds.length ? collectSubtree(this.atRevision(request.baseRevision).document, request.selectedNodeIds) : Object.keys(request.documentFragment.nodes);
      const allowedPages = !request.selectedNodeIds.length && request.documentFragment.page ? [request.documentFragment.page.id] : undefined;
      const candidate = applyBatch(current.document, batch, current.appliedBatchIds, { allowedNodeIds: allowed, ...(allowedPages ? { allowedPageIds: allowedPages } : {}) });
      if (candidate.status === 'rejected') { managed.record.validationResults = candidate.diagnostics; throw new ApplicationError(candidate.diagnostics[0]?.code ?? 'agent.operations', candidate.diagnostics.map(issue => issue.message).join('; ')); }
      const quality = assessPageComposition(candidate.document, request);
      managed.record.qaResults = quality;
      if (!quality.length) break;
      if (attempt === 1) throw new ApplicationError('quality.incomplete', 'The page still needs composition work after one repair. No incomplete draft was saved.');
      managed.events.push({ type: 'progress', runId: managed.record.id, phase: 'RUNNING', message: 'Review found an incomplete page. Refining composition before saving.' });
      for (const issue of quality) managed.events.push({ type: 'diagnostic', runId: managed.record.id, diagnostic: { ...issue, severity: 'warning' } });
    }
    managed.record.batchId = batch.id;
    managed.record.operations = structuredClone(batch.operations);
    await this.serial(async () => {
      if (managed.abort.signal.aborted) { await this.state(managed, 'CANCELLED'); return; }
      await this.state(managed, 'APPLYING');
      if (terminal.has(managed.record.state)) return;
      const allowed = request.selectedNodeIds.length ? collectSubtree(this.atRevision(request.baseRevision).document, request.selectedNodeIds) : Object.keys(request.documentFragment.nodes);
      const allowedPages = !request.selectedNodeIds.length && request.documentFragment.page ? [request.documentFragment.page.id] : undefined;
      const outcome = await this.commit(batch, allowed, allowedPages);
      managed.record.validationResults = outcome.result.diagnostics;
      if (outcome.result.status === 'rejected') throw new ApplicationError(outcome.result.diagnostics[0].code, outcome.result.diagnostics.map(item => item.message).join('; '));
      managed.record.committedRevision = outcome.result.revision;
      managed.record.snapshotBefore = `before-${batch.id}`;
      managed.record.snapshotAfter = `after-${batch.id}`;
      managed.events.push({ type: 'result', runId: request.runId, revision: outcome.result.revision, outcome: 'committed' });
      await this.state(managed, 'RENDERING');
      if (managed.record.state === 'RENDERING') managed.renderTimer = setTimeout(() => { void this.fail(managed, new ApplicationError('render.timeout', 'Design saved, but no rendering acknowledgement was received. Reopen the project.')); }, 30000);
      managed.renderTimer?.unref();
    });
  }

  private state(managed: ManagedRun, state: RunState): Promise<void> {
    const transition = (managed.stateSequence ?? Promise.resolve()).then(() => this.persistState(managed, state));
    managed.stateSequence = transition.then(() => undefined, () => undefined);
    return transition;
  }
  private async persistState(managed: ManagedRun, state: RunState): Promise<void> {
    if (terminal.has(managed.record.state)) return;
    const candidate = structuredClone(managed.record);
    candidate.state = state;
    if (terminal.has(state)) candidate.finishedAt = timestamp();
    try {
      await this.runStore.save(candidate);
      managed.record = candidate;
      managed.events.push({ type: 'state', runId: candidate.id, state, at: timestamp() });
    } catch (error) {
      const issue = diagnostic('run.store-save', error instanceof Error ? `Run status could not be saved: ${error.message}` : 'Run status could not be saved.');
      const failed = structuredClone(managed.record);
      failed.state = 'FAILED'; failed.finishedAt = timestamp(); failed.validationResults.push(issue);
      managed.record = failed;
      managed.events.push({ type: 'diagnostic', runId: failed.id, diagnostic: issue });
      managed.events.push({ type: 'state', runId: failed.id, state: 'FAILED', at: timestamp() });
      try { await this.runStore.save(failed); } catch { /* The in-memory state remains failed and keeps the committed revision. */ }
      if (managed.renderTimer) clearTimeout(managed.renderTimer);
    }
  }
  private async fail(managed: ManagedRun, error: unknown): Promise<void> {
    if (terminal.has(managed.record.state)) return;
    if (managed.renderTimer) clearTimeout(managed.renderTimer);
    const issues = error instanceof CodingAgentError && error.diagnostics.length
      ? error.diagnostics
      : [diagnostic(
        error instanceof CodingAgentError || error instanceof ApplicationError ? error.code : 'run.failed',
        error instanceof CodingAgentError || error instanceof ApplicationError ? error.message : 'The operation could not finish. The last saved design is available.',
      )];
    const missingIssues = issues.filter(issue => !managed.record.validationResults.some(saved => saved.code === issue.code && saved.message === issue.message));
    managed.record.validationResults.push(...structuredClone(missingIssues));
    managed.events.push(...missingIssues.map(issue => ({ type: 'diagnostic' as const, runId: managed.record.id, diagnostic: structuredClone(issue) })));
    await this.state(managed, managed.abort.signal.aborted && managed.record.committedRevision === undefined ? 'CANCELLED' : 'FAILED');
  }
  private autoSnapshot(id: string, project: PersistedProjectEnvelope, time: string): SnapshotRecord {
    return { id, label: id.startsWith('before-') ? 'Before edit' : 'After edit', revision: project.document.revision, timestamp: time, document: structuredClone(project.document) };
  }
  private requireProject(): PersistedProjectEnvelope {
    if (!this.current) throw new ApplicationError('project.missing', 'Create or open a project first.');
    return this.current;
  }
  private assertNoActiveRun(): void {
    if ([...this.runs.values()].some(run => !terminal.has(run.record.state))) throw new ApplicationError('run.busy', 'Finish or cancel the current generation before changing projects.');
  }
  private atRevision(revision: number): PersistedProjectEnvelope {
    const project = this.requireProject();
    if (!Number.isSafeInteger(revision) || revision !== project.document.revision) throw new ApplicationError('revision.conflict', 'The design changed. Refresh it and retry.');
    return project;
  }
  private requireRun(id: string): ManagedRun {
    const run = this.runs.get(id);
    if (!run) throw new ApplicationError('run.missing', 'Generation was not found.');
    return run;
  }
  private async publish(next: PersistedProjectEnvelope, expectedRevision: number): Promise<void> {
    const sealed = sealEnvelope(next);
    await this.persistence.saveAtomically(sealed, expectedRevision);
    this.current = sealed;
  }
  private serial<T>(action: () => Promise<T>): Promise<T> {
    const result = this.sequence.then(action, action);
    this.sequence = result.then(() => undefined, () => undefined);
    return result;
  }
}
