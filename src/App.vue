<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onErrorCaptured, onMounted, ref, watch } from 'vue';
import { DEFAULT_OPERATION_CAPABILITIES, createNodeBase } from './domain/defaults';
import type {
  DesignDocument,
  DesignNode,
  Layout,
  NodeId,
  Operation,
  OperationBatch,
  PropertyMutation,
  SemanticStyle,
} from './domain/types';
import CanvasNode from './ui/components/CanvasNode.vue';
import InspectorPanel from './ui/components/InspectorPanel.vue';
import ProviderConnections from './ui/components/ProviderConnections.vue';
import ProjectExplorer from './ui/components/ProjectExplorer.vue';
import type { ProviderSelection } from './domain/providers';
import LayerTreeNode from './ui/components/LayerTreeNode.vue';
import {
  getCommittedRevision,
  localApi,
  LocalApiError,
  type AgentRunRecord,
  type CapabilitiesResponse,
  type ExportResponse,
  type RunResponse,
} from './ui/services/local-api';
import { pageNodeIds } from './ui/rendering';

const project = ref<Awaited<ReturnType<typeof localApi.getProject>>['project']>(null);
const capabilities = ref<CapabilitiesResponse | null>(null);
const currentPageId = ref('');
const selectedNodeIds = ref<NodeId[]>([]);
const prompt = ref('');
const providerSelection = ref<ProviderSelection | null>(null);
const providerEnabled = ref(false);
const loading = ref(true);
const connectionError = ref('');
const actionError = ref('');
const notice = ref('');
const activeRun = ref<AgentRunRecord | null>(null);
const runStarting = ref(false);
const runEvents = ref<RunResponse['events']>([]);
const exportResult = ref<ExportResponse | null>(null);
const exportBusy = ref(false);
const snapshotLabel = ref('');
const viewportWidth = ref(1440);
const viewportHeight = ref(900);
const zoom = ref(0.72);
const panMode = ref(false);
const scrollArea = ref<HTMLElement | null>(null);
const mutationTail = ref<Promise<void>>(Promise.resolve());
const acknowledgedRuns = new Set<string>();
const acknowledgingRuns = new Set<string>();
let pollEpoch = 0;
let disposed = false;
let canvasObserver: ResizeObserver | undefined;
let autoFit = true;
let renderFailure = '';
onErrorCaptured(() => {
  renderFailure = 'A canvas component failed while rendering the committed design.';
  actionError.value = renderFailure;
  return false;
});

const documentModel = computed<DesignDocument | null>(() => project.value?.document ?? null);
const page = computed(() => {
  const model = documentModel.value;
  return model && currentPageId.value ? model.pages[currentPageId.value] ?? null : null;
});
const pageIds = computed(() => documentModel.value?.pageOrder ?? []);
const pageScope = computed(() => page.value && documentModel.value ? pageNodeIds(documentModel.value, page.value.id) : new Set<NodeId>());
const selectedNodes = computed(() => selectedNodeIds.value.map((id) => documentModel.value?.nodes[id]).filter((node): node is DesignNode => node !== undefined));
const selectedNode = computed(() => selectedNodes.value.length === 1 ? selectedNodes.value[0] ?? null : null);
const undoEntries = computed(() => project.value?.history.undoableEntries ?? []);
const historyCursor = computed(() => project.value?.history.cursor ?? 0);
const canUndo = computed(() => historyCursor.value > 0 && !editingLocked.value);
const canRedo = computed(() => historyCursor.value < undoEntries.value.length && !editingLocked.value);
const operationTypes = computed(() => capabilities.value?.operationTypes ?? []);
const nodeKinds = computed(() => capabilities.value?.nodeKinds ?? []);
const canCreate = computed(() => operationTypes.value.includes('node.create'));
const canExport = computed(() => (target: 'native' | 'vue' | 'figma') => capabilities.value?.exportTargets.includes(target) ?? false);
const runBusy = computed(() => activeRun.value !== null && !['SUCCEEDED', 'FAILED', 'CANCELLED', 'ROLLED_BACK'].includes(activeRun.value.state));
const editingLocked = computed(() => !!activeRun.value && ['APPLYING', 'RENDERING', 'QA'].includes(activeRun.value.state));
const currentRunRevision = computed(() => activeRun.value?.committedRevision ?? getCommittedRevision(runEvents.value));
const runPhaseLabel = computed(() => activeRun.value ? stateLabel(activeRun.value.state) : '');
const canvasShellStyle = computed(() => ({ width: `${viewportWidth.value * zoom.value}px`, height: `${viewportHeight.value * zoom.value}px` }));
const canvasTransformStyle = computed(() => ({
  width: `${viewportWidth.value}px`,
  height: `${viewportHeight.value}px`,
  transform: `scale(${zoom.value})`,
}));
const rootNodeIds = computed(() => page.value?.rootNodeIds ?? []);
const pageName = computed(() => page.value?.name ?? 'No page');

function stateLabel(state: string): string {
  const labels: Record<string, string> = {
    QUEUED: 'Queued', PLANNING: 'Planning', RUNNING: 'Generating',
    VALIDATING_OPERATIONS: 'Validating changes', APPLYING: 'Applying changes',
    RENDERING: 'Rendering committed revision', QA: 'Checking design',
    SUCCEEDED: 'Design saved', FAILED: 'Run failed', CANCELLED: 'Cancelled', ROLLED_BACK: 'Changes discarded',
  };
  return labels[state] ?? state;
}
function eventLabel(event: RunResponse['events'][number]): string {
  if (event.type === 'state') return stateLabel(event.state);
  if (event.type === 'progress') return event.message;
  if (event.type === 'operation-proposed') return `Proposed ${event.operationType}`;
  if (event.type === 'diagnostic') return event.diagnostic.message;
  return event.outcome === 'committed' ? `Revision ${event.revision ?? 'committed'}` : `Operations ${event.outcome}`;
}
function setProject(next: Awaited<ReturnType<typeof localApi.getProject>>['project']) {
  const previousId = documentModel.value?.id;
  project.value = next;
  const nextDocument = next?.document;
  if (!nextDocument) {
    currentPageId.value = '';
    selectedNodeIds.value = [];
    return;
  }
  if (previousId !== nextDocument.id || !nextDocument.pages[currentPageId.value]) {
    currentPageId.value = nextDocument.pageOrder[0] ?? '';
    selectedNodeIds.value = [];
  } else {
    selectedNodeIds.value = selectedNodeIds.value.filter((id) => pageScope.value.has(id) && nextDocument.nodes[id] !== undefined);
  }
}
async function refreshProject() {
  const result = await localApi.getProject();
  setProject(result.project);
  return result.project;
}
async function initialize() {
  loading.value = true;
  connectionError.value = '';
  const [capsResult, projectResult] = await Promise.allSettled([localApi.getCapabilities(), localApi.getProject()]);
  if (disposed) return;
  if (capsResult.status === 'fulfilled') capabilities.value = capsResult.value;
  else connectionError.value = friendlyError(capsResult.reason);
  if (projectResult.status === 'fulfilled') setProject(projectResult.value.project);
  else connectionError.value = friendlyError(projectResult.reason);
  if (projectResult.status === 'fulfilled') await refreshRunForProject(projectResult.value.project);
  loading.value = false;
}
async function refreshRunForProject(selected: Awaited<ReturnType<typeof localApi.getProject>>['project']) {
  activeRun.value = null;
  runEvents.value = [];
  if (!selected) return;
  try {
    const latest = (await localApi.listRuns()).runs.find((run) => run.documentId === selected.document.id);
    if (disposed || project.value?.document.id !== selected.document.id || !latest) return;
    activeRun.value = latest;
    if (!terminalStates.has(latest.state)) void pollRun(latest.id);
    else showRunOutcome(latest);
  } catch (error) { actionError.value = friendlyError(error); }
}
async function onProjectOpened(next: Awaited<ReturnType<typeof localApi.getProject>>['project']) {
  pollEpoch += 1;
  selectedNodeIds.value = [];
  currentPageId.value = next?.document.pageOrder[0] ?? '';
  exportResult.value = null;
  snapshotLabel.value = '';
  clearMessages();
  setProject(next);
  await refreshRunForProject(next);
  notice.value = next ? `Opened “${next.document.name}”.` : 'Project opened.';
}
async function onProjectDeleted(current: Awaited<ReturnType<typeof localApi.getProject>>['project']) {
  const previousId = project.value?.document.id;
  if (previousId && previousId === current?.document.id) {
    await refreshRunForProject(current);
    return;
  }
  if (!current) pollEpoch += 1;
  selectedNodeIds.value = [];
  currentPageId.value = current?.document.pageOrder[0] ?? '';
  exportResult.value = null;
  snapshotLabel.value = '';
  setProject(current);
  await refreshRunForProject(current);
  notice.value = current ? 'Project removed from the library.' : 'Project removed. Create or open a project to continue.';
}
function friendlyError(error: unknown): string {
  if (error instanceof LocalApiError) return error.message;
  return 'The request could not be completed.';
}
function clearMessages() {
  actionError.value = '';
  notice.value = '';
}
function selectPage(id: string) {
  currentPageId.value = id;
  selectedNodeIds.value = [];
}
function selectNode(id: NodeId, additive: boolean) {
  if (!pageScope.value.has(id) || editingLocked.value) return;
  if (!additive) {
    selectedNodeIds.value = [id];
  } else if (selectedNodeIds.value.includes(id)) {
    selectedNodeIds.value = selectedNodeIds.value.filter((selected) => selected !== id);
  } else {
    selectedNodeIds.value = [...selectedNodeIds.value, id];
  }
}

async function ensureProject(name = 'New design') {
  if (project.value) return project.value;
  const result = await localApi.createProject(name);
  setProject(result.project);
  return result.project;
}
function enqueueOperation(operation: Operation) {
  mutationTail.value = mutationTail.value.catch(() => {}).then(async () => {
    clearMessages();
    try {
      const current = project.value ?? await ensureProject();
      const batch: OperationBatch = {
        id: crypto.randomUUID(),
        documentId: current.document.id,
        expectedRevision: current.document.revision,
        source: 'inspector' === operationSource.value ? 'inspector' : operationSource.value,
        capabilitySet: capabilities.value?.operationTypes ?? [...DEFAULT_OPERATION_CAPABILITIES],
        operations: [operation],
      };
      const response = await localApi.applyOperations(batch);
      setProject(response.project);
      if (response.result.status === 'rejected') {
        actionError.value = response.result.diagnostics.map((diagnostic) => diagnostic.message).join(' ');
      } else {
        notice.value = `Saved as revision ${response.project.document.revision}.`;
      }
    } catch (error) {
      actionError.value = friendlyError(error);
      if (error instanceof LocalApiError && error.status === 409) await refreshProject().catch(() => {});
    }
  });
  return mutationTail.value;
}
const operationSource = ref<'inspector' | 'toolbar' | 'keyboard'>('inspector');
function onProperty(nodeId: NodeId, change: PropertyMutation) {
  operationSource.value = 'inspector';
  void enqueueOperation({ type: 'property.set', nodeId, change });
}
function onLayout(nodeId: NodeId, value: Layout) {
  operationSource.value = 'inspector';
  void enqueueOperation({ type: 'layout.set', nodeId, value });
}
function onStyle(nodeId: NodeId, value: SemanticStyle) {
  operationSource.value = 'inspector';
  void enqueueOperation({ type: 'style.set', nodeId, value });
}
function toggleVisibility(nodeId: NodeId, visible: boolean) {
  operationSource.value = 'inspector';
  void enqueueOperation({ type: 'property.set', nodeId, change: { property: 'visible', value: visible } });
}
function defaultLayoutWidth(value: number) {
  return { kind: 'fixed' as const, value: { kind: 'literal' as const, value, unit: 'px' as const } };
}
async function addNode(kind: 'frame' | 'text') {
  clearMessages();
  if (!canCreate.value || !nodeKinds.value.includes(kind) || editingLocked.value) return;
  try {
    const current = await ensureProject();
    const model = current.document;
    const activePage = model.pages[currentPageId.value] ?? model.pages[model.pageOrder[0] ?? ''];
    if (!activePage) throw new Error('This project has no active page.');
    const selectedParent = selectedNode.value;
    const parent = selectedParent && ['frame', 'group'].includes(selectedParent.kind) ? selectedParent : null;
    const nodeId = crypto.randomUUID();
    const nodeBase = createNodeBase(nodeId, kind === 'frame' ? 'Frame' : 'Text');
    const node: DesignNode = kind === 'frame'
      ? {
          ...nodeBase,
          kind: 'frame',
          layout: { ...nodeBase.layout, width: defaultLayoutWidth(720), height: defaultLayoutWidth(480), padding: { top: { kind: 'literal', value: 24, unit: 'px' }, right: { kind: 'literal', value: 24, unit: 'px' }, bottom: { kind: 'literal', value: 24, unit: 'px' }, left: { kind: 'literal', value: 24, unit: 'px' } } },
          style: { fill: { kind: 'literal', value: '#ffffff' }, radius: { kind: 'literal', value: 10, unit: 'px' } },
        }
      : { ...nodeBase, kind: 'text', text: 'Double-click to edit content', textStyle: { fontSize: { kind: 'literal', value: 16, unit: 'px' }, weight: 400, lineHeight: 1.5 } };
    operationSource.value = 'toolbar';
    const batch: OperationBatch = {
      id: crypto.randomUUID(), documentId: model.id, expectedRevision: model.revision,
      source: 'toolbar', capabilitySet: capabilities.value?.operationTypes ?? [...DEFAULT_OPERATION_CAPABILITIES],
      operations: [{ type: 'node.create', node, pageId: activePage.id, ...(parent ? { parentId: parent.id, index: parent.childIds.length } : { index: activePage.rootNodeIds.length }) }],
    };
    const response = await localApi.applyOperations(batch);
    setProject(response.project);
    if (response.result.status === 'committed') {
      selectedNodeIds.value = [nodeId];
      notice.value = `${kind === 'frame' ? 'Frame' : 'Text'} added.`;
    } else actionError.value = response.result.diagnostics.map((diagnostic) => diagnostic.message).join(' ');
  } catch (error) {
    actionError.value = friendlyError(error);
  }
}
async function deleteSelection() {
  if (!selectedNodeIds.value.length || !operationTypes.value.includes('node.delete') || editingLocked.value) return;
  const operations: Operation[] = selectedNodeIds.value.map((nodeId) => ({ type: 'node.delete', nodeId, mode: 'subtree' }));
  operationSource.value = 'keyboard';
  for (const operation of operations) await enqueueOperation(operation);
  selectedNodeIds.value = [];
}
function onGlobalKey(event: KeyboardEvent) {
  const target = event.target as HTMLElement | null;
  if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
  if (event.key === 'Delete' || event.key === 'Backspace') {
    if (selectedNodeIds.value.length && operationTypes.value.includes('node.delete')) {
      event.preventDefault();
      void deleteSelection();
    }
  } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
    event.preventDefault();
    void changeHistory(event.shiftKey ? 'redo' : 'undo');
  }
}
async function changeHistory(action: 'undo' | 'redo') {
  if (!project.value || editingLocked.value) return;
  clearMessages();
  try {
    const result = await localApi.history(action, project.value.document.revision);
    setProject(result.project);
    selectedNodeIds.value = [];
    notice.value = action === 'undo' ? 'Edit undone.' : 'Edit redone.';
  } catch (error) { actionError.value = friendlyError(error); }
}
async function saveSnapshot() {
  if (!project.value || !snapshotLabel.value.trim() || editingLocked.value) return;
  clearMessages();
  try {
    const result = await localApi.createSnapshot({ label: snapshotLabel.value.trim(), expectedRevision: project.value.document.revision });
    setProject(result.project);
    snapshotLabel.value = '';
    notice.value = 'Snapshot saved.';
  } catch (error) { actionError.value = friendlyError(error); }
}
async function restoreSnapshot(id: string) {
  if (!project.value || editingLocked.value) return;
  clearMessages();
  try {
    const result = await localApi.restoreSnapshot(id, project.value.document.revision);
    setProject(result.project);
    selectedNodeIds.value = [];
    notice.value = result.project
      ? `Restored as revision ${result.project.document.revision}.`
      : 'Snapshot restored, but the project response did not include the document.';
  } catch (error) { actionError.value = friendlyError(error); }
}
async function submitPrompt(request = prompt.value) {
  const cleanPrompt = request.trim();
  if (!cleanPrompt || runBusy.value || runStarting.value || loading.value || (providerEnabled.value && !providerSelection.value)) return;
  clearMessages();
  runStarting.value = true;
  try {
    let current = project.value;
    if (!current) current = await ensureProject('New design');
    const response = await localApi.startRun({
      prompt: cleanPrompt,
      ...(providerSelection.value ? { providerSelection: { ...providerSelection.value } } : {}),
      selectedNodeIds: [...selectedNodeIds.value],
      expectedRevision: current.document.revision,
      ...(currentPageId.value ? { pageId: currentPageId.value } : {}),
    });
    prompt.value = '';
    acknowledgedRuns.delete(response.runId);
    activeRun.value = {
      id: response.runId,
      documentId: current.document.id,
      baseRevision: current.document.revision,
      userRequest: cleanPrompt,
      selectedNodeIds: [...selectedNodeIds.value],
      resolvedContext: [],
      operationCapabilities: capabilities.value?.operationTypes ?? [],
      state: 'QUEUED',
      startedAt: new Date().toISOString(),
      validationResults: [],
      qaResults: [],
    };
    runEvents.value = [];
    void pollRun(response.runId);
  } catch (error) { actionError.value = friendlyError(error); }
  finally { runStarting.value = false; }
}
const terminalStates = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED', 'ROLLED_BACK']);
function showRunOutcome(run: AgentRunRecord, events: RunResponse['events'] = []) {
  if (run.state === 'SUCCEEDED') notice.value = `Design saved at revision ${run.committedRevision ?? getCommittedRevision(events) ?? 'current'}.`;
  else if (run.state === 'CANCELLED') notice.value = 'Generation cancelled. The saved design remains available.';
  else if (run.state === 'FAILED') actionError.value = run.qaResults.map(item => item.message).filter(Boolean).join(' ') || run.validationResults.map(item => item.message).filter(Boolean).join(' ') || 'The design run failed. The last committed document is still available.';
}

const wait = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));
async function acknowledgeRendered(run: AgentRunRecord, events: RunResponse['events']) {
  const revision = run.committedRevision ?? getCommittedRevision(events);
  if (revision === undefined || acknowledgedRuns.has(run.id) || acknowledgingRuns.has(run.id)) return;
  acknowledgingRuns.add(run.id);
  try {
    renderFailure = '';
    const refreshed = await refreshProject();
    await nextTick();
    const renderedRevision = refreshed?.document.revision;
    if (renderedRevision === revision && !renderFailure) {
      await localApi.acknowledgeRendered(run.id, { revision, success: true });
    } else {
      await localApi.acknowledgeRendered(run.id, {
        revision,
        success: false,
        message: renderFailure || `The project advanced to revision ${renderedRevision ?? 'unavailable'} before revision ${revision} could be rendered.`,
      });
    }
    acknowledgedRuns.add(run.id);
  } catch (error) {
    actionError.value = `The committed revision ${revision} could not be confirmed by the renderer: ${friendlyError(error)}`;
  } finally {
    acknowledgingRuns.delete(run.id);
  }
}
async function pollRun(runId: string) {
  if (disposed) return;
  const epoch = ++pollEpoch;
  const current = () => !disposed && epoch === pollEpoch && activeRun.value?.id === runId;
  for (let attempt = 0; attempt < 1800 && current(); attempt += 1) {
    try {
      const response = await localApi.getRun(runId);
      if (!current()) return;
      activeRun.value = response.run;
      runEvents.value = response.events;
      if (response.run.state === 'RENDERING') await acknowledgeRendered(response.run, response.events);
      if (!current()) return;
      if (terminalStates.has(response.run.state)) {
        showRunOutcome(response.run, response.events);
        return;
      }
    } catch (error) {
      if (!current()) return;
      actionError.value = `Run status is temporarily unavailable: ${friendlyError(error)}`;
    }
    await wait(850);
  }
  if (current()) actionError.value = 'Run monitoring paused after an extended wait. Reload to recover the latest saved status; generation will not be restarted automatically.';
}
async function cancelRun() {
  if (!activeRun.value || !runBusy.value || ['APPLYING', 'RENDERING', 'QA'].includes(activeRun.value.state)) return;
  try {
    const runId = activeRun.value.id;
    const response = await localApi.cancelRun(runId);
    if (disposed || activeRun.value?.id !== runId) return;
    activeRun.value = response.run;
    if (terminalStates.has(response.run.state)) {
      pollEpoch += 1;
      notice.value = response.run.state === 'CANCELLED' ? 'Generation cancelled. The saved design remains available.' : 'The run had already finished; its saved result remains available.';
    } else {
      notice.value = 'The design had already committed. Rendering and quality checks are continuing.';
      void pollRun(runId);
    }
  } catch (error) { actionError.value = friendlyError(error); }
}
async function exportTarget(target: 'native' | 'vue' | 'figma') {
  if (!capabilities.value?.exportTargets.includes(target)) return;
  exportBusy.value = true;
  exportResult.value = null;
  clearMessages();
  try {
    const result = await localApi.exportDocument(target);
    exportResult.value = result;
    if (result.status === 'failed' || result.artifacts.length === 0) throw new LocalApiError(result.diagnostics.map(item => item.message).join(' ') || `${target.toUpperCase()} export failed without producing an artifact.`, 200, 'export.failed', result.diagnostics);
    for (const artifact of result.artifacts) {
      const bytes = artifact.encoding === 'base64' ? Uint8Array.from(atob(artifact.contents), (character) => character.charCodeAt(0)) : artifact.contents;
      const blob = new Blob([bytes], { type: artifact.mimeType });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = artifact.name;
      anchor.click();
      URL.revokeObjectURL(url);
    }
    notice.value = target === 'figma' ? 'Figma plugin bundle downloaded. Follow its README to add your Figma plugin ID, then import and run it. Fidelity limits are included.' : result.status === 'succeeded' ? `${target.toUpperCase()} export ready.` : `${target.toUpperCase()} export finished with reported fidelity limits.`;
  } catch (error) { actionError.value = friendlyError(error); }
  finally { exportBusy.value = false; }
}
function chooseViewport(width: number, height: number) {
  viewportWidth.value = width;
  viewportHeight.value = height;
  autoFit = true;
  void nextTick(fitCanvas);
}
function zoomBy(delta: number) { autoFit = false; zoom.value = Math.min(1.5, Math.max(0.25, Math.round((zoom.value + delta) * 100) / 100)); }
function fitCanvas() {
  const area = scrollArea.value;
  if (!area || area.clientWidth <= 88 || area.clientHeight <= 88) return;
  autoFit = true;
  zoom.value = Math.min(1, (area.clientWidth - 88) / viewportWidth.value, (area.clientHeight - 88) / viewportHeight.value);
  area.scrollTop = 0;
  area.scrollLeft = 0;
}
function beginPan(event: PointerEvent) {
  if (!panMode.value || !scrollArea.value || (event.target as HTMLElement).closest('.canvas-node')) return;
  const target = scrollArea.value;
  const startX = event.clientX + target.scrollLeft;
  const startY = event.clientY + target.scrollTop;
  const move = (next: PointerEvent) => {
    target.scrollLeft = startX - next.clientX;
    target.scrollTop = startY - next.clientY;
  };
  const end = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', end);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', end, { once: true });
}
function retryRun() {
  const previous = activeRun.value?.userRequest;
  if (previous) void submitPrompt(previous);
}

onMounted(() => {
  void initialize();
  if (typeof ResizeObserver !== 'undefined' && scrollArea.value) {
    canvasObserver = new ResizeObserver(() => { if (autoFit) fitCanvas(); });
    canvasObserver.observe(scrollArea.value);
    fitCanvas();
  }
  window.addEventListener('keydown', onGlobalKey);
});
onBeforeUnmount(() => {
  canvasObserver?.disconnect();
  disposed = true;
  pollEpoch += 1;
  window.removeEventListener('keydown', onGlobalKey);
});
watch(() => documentModel.value?.id, (id) => {
  if (id) {
    currentPageId.value = documentModel.value?.pageOrder[0] ?? '';
    selectedNodeIds.value = [];
  }
});
</script>

<template>
  <main
    class="studio"
    aria-label="Pudly workspace"
  >
    <header class="topbar">
      <div class="brand-lockup">
        <div
          class="brand-mark"
          aria-hidden="true"
        >
          P
        </div>
        <div class="brand-name">
          Pudly
        </div>
        <span class="brand-divider" />
        <span class="workspace-name">{{ documentModel?.name ?? 'Untitled project' }}</span>
      </div>
      <div class="topbar__center">
        <div
          class="viewport-switcher"
          role="group"
          aria-label="Responsive preview size"
        >
          <button
            :class="{ active: viewportWidth === 1440 }"
            type="button"
            aria-label="Desktop preview"
            @click="chooseViewport(1440, 900)"
          >
            ▭ <span>Desktop</span>
          </button>
          <button
            :class="{ active: viewportWidth === 768 }"
            type="button"
            aria-label="Tablet preview"
            @click="chooseViewport(768, 1024)"
          >
            ▯ <span>Tablet</span>
          </button>
          <button
            :class="{ active: viewportWidth === 375 }"
            type="button"
            aria-label="Mobile preview"
            @click="chooseViewport(375, 812)"
          >
            ▯ <span>Mobile</span>
          </button>
          <span class="viewport-size">{{ viewportWidth }} × {{ viewportHeight }}</span>
        </div>
      </div>
      <div class="topbar__actions">
        <ProjectExplorer
          :current-project-id="documentModel?.id ?? null"
          :lifecycle-locked="loading || runStarting || editingLocked || runBusy"
          @opened="onProjectOpened"
          @deleted="onProjectDeleted"
        />
        <div
          v-if="canExport('native') || canExport('vue') || canExport('figma')"
          class="export-menu"
          aria-label="Export design"
        >
          <span>Export</span>
          <button
            v-if="canExport('figma')"
            type="button"
            :disabled="exportBusy || !documentModel"
            @click="exportTarget('figma')"
          >
            Figma plugin
          </button>
          <button
            v-if="canExport('native')"
            type="button"
            :disabled="exportBusy || !documentModel"
            @click="exportTarget('native')"
          >
            Native
          </button>
          <button
            v-if="canExport('vue')"
            type="button"
            :disabled="exportBusy || !documentModel"
            @click="exportTarget('vue')"
          >
            Vue
          </button>
        </div>
        <span
          class="connection-dot"
          :class="{ 'is-loading': loading, 'is-error': !!connectionError }"
          :title="connectionError || 'Connected to local design service'"
        />
      </div>
    </header>

    <div
      v-if="connectionError"
      class="connection-banner"
      role="alert"
    >
      <span>{{ connectionError }}</span><button
        type="button"
        @click="initialize"
      >
        Retry connection
      </button>
    </div>
    <div
      v-if="actionError"
      class="message-banner is-error"
      role="alert"
    >
      <span>{{ actionError }}</span><button
        type="button"
        aria-label="Dismiss error"
        @click="actionError = ''"
      >
        ×
      </button>
    </div>
    <div
      v-else-if="notice"
      class="message-banner"
      role="status"
    >
      <span>{{ notice }}</span><button
        type="button"
        aria-label="Dismiss message"
        @click="notice = ''"
      >
        ×
      </button>
    </div>

    <div class="workarea">
      <aside
        class="left-rail"
        aria-label="Pages and layers"
      >
        <section class="side-section page-section">
          <div class="section-title">
            <h2>Pages</h2><span>{{ pageIds.length }}</span>
          </div>
          <div
            v-if="pageIds.length"
            class="page-list"
          >
            <button
              v-for="id in pageIds"
              :key="id"
              type="button"
              class="page-row"
              :class="{ active: id === currentPageId }"
              @click="selectPage(id)"
            >
              <span
                class="page-icon"
                aria-hidden="true"
              >▤</span><span>{{ documentModel?.pages[id]?.name }}</span>
            </button>
          </div>
          <div
            v-else
            class="side-empty"
          >
            Create a project to add pages.
          </div>
        </section>
        <section class="side-section layers-section">
          <div class="section-title">
            <h2>Layers</h2><span>{{ page?.rootNodeIds.length ?? 0 }}</span>
          </div>
          <div
            v-if="documentModel && page"
            class="layer-tree-scroll"
          >
            <ul
              class="layer-tree"
              role="tree"
              aria-label="Page layers"
            >
              <LayerTreeNode
                v-for="id in page.rootNodeIds"
                :key="id"
                :document="documentModel"
                :node-id="id"
                :selected-node-ids="new Set(selectedNodeIds)"
                :depth="0"
                @select="selectNode"
                @toggle-visibility="toggleVisibility"
              />
            </ul>
            <div
              v-if="!page.rootNodeIds.length"
              class="side-empty"
            >
              Your layers will appear here.
            </div>
          </div>
          <div
            v-else
            class="side-empty"
          >
            No layers yet.
          </div>
        </section>
        <section
          v-if="activeRun"
          class="run-sidebar-section"
        >
          <div class="section-title">
            <h2>Current run</h2><span :class="['run-dot', `state-${activeRun.state.toLowerCase()}`]" />
          </div>
          <div class="run-sidebar__request">
            {{ activeRun.userRequest }}
          </div>
          <div class="run-sidebar__state">
            {{ runPhaseLabel }}
          </div>
          <details class="context-details">
            <summary>Run context</summary>
            <p>Base revision {{ activeRun.baseRevision }} · {{ activeRun.selectedNodeIds.length }} selected</p>
            <ul>
              <li
                v-for="(item, index) in activeRun.resolvedContext"
                :key="`${item.scope}-${index}`"
              >
                {{ item.scope }}<span v-if="item.includedNodeIds?.length"> · {{ item.includedNodeIds.length }} nodes</span>
                <span v-if="item.sourceId"> · {{ item.sourceId }}</span>
              </li>
            </ul>
            <details v-if="activeRun.documentFragment">
              <summary>Exact context sent to the provider</summary>
              <pre class="context-json">{{ JSON.stringify({ document: activeRun.documentFragment, designSystem: activeRun.designSystemContext, operationCapabilities: activeRun.operationCapabilities }, null, 2) }}</pre>
            </details>
          </details>
          <details class="context-details">
            <summary>Run events · {{ runEvents.length }}</summary>
            <ol class="event-list">
              <li
                v-for="(event, index) in runEvents.slice(-8)"
                :key="`${event.type}-${index}`"
              >
                {{ eventLabel(event) }}
              </li>
            </ol>
          </details>
          <button
            v-if="runBusy && !editingLocked"
            class="text-button"
            type="button"
            @click="cancelRun"
          >
            Cancel run
          </button>
          <button
            v-if="activeRun.state === 'FAILED' || activeRun.state === 'CANCELLED'"
            class="text-button"
            type="button"
            @click="retryRun"
          >
            Retry with fresh context
          </button>
        </section>
      </aside>

      <section
        class="editor-center"
        aria-label="Design canvas"
      >
        <div class="canvas-toolbar">
          <div class="canvas-toolbar__left">
            <span class="current-page-label">{{ pageName }}</span>
            <span
              v-if="selectedNodeIds.length"
              class="selection-count"
            >{{ selectedNodeIds.length }} selected</span>
          </div>
          <div class="canvas-toolbar__middle">
            <button
              type="button"
              :disabled="!canCreate || !nodeKinds.includes('frame') || editingLocked"
              @click="addNode('frame')"
            >
              <span aria-hidden="true">▣</span> Frame
            </button>
            <button
              type="button"
              :disabled="!canCreate || !nodeKinds.includes('text') || editingLocked"
              @click="addNode('text')"
            >
              <span aria-hidden="true">T</span> Text
            </button>
            <button
              type="button"
              class="danger-tool"
              :disabled="!selectedNodeIds.length || !operationTypes.includes('node.delete') || editingLocked"
              aria-label="Delete selection"
              @click="deleteSelection"
            >
              ⌫
            </button>
          </div>
          <div class="canvas-toolbar__right">
            <button
              type="button"
              :class="{ active: panMode }"
              aria-label="Pan canvas"
              :aria-pressed="panMode"
              @click="panMode = !panMode"
            >
              ✋
            </button>
            <button
              type="button"
              aria-label="Zoom out"
              @click="zoomBy(-0.1)"
            >
              −
            </button>
            <button
              type="button"
              class="zoom-label"
              @click="fitCanvas"
            >
              {{ Math.round(zoom * 100) }}%
            </button>
            <button
              type="button"
              aria-label="Zoom in"
              @click="zoomBy(0.1)"
            >
              +
            </button>
          </div>
        </div>
        <div
          ref="scrollArea"
          class="canvas-scroll"
          :class="{ 'is-pan-mode': panMode }"
          @pointerdown="beginPan"
        >
          <div
            v-if="loading"
            class="canvas-state"
          >
            <div class="state-spinner" /><p>Opening your workspace…</p>
          </div>
          <div
            v-else-if="!documentModel"
            class="canvas-state canvas-state--empty"
          >
            <div
              class="empty-illustration"
              aria-hidden="true"
            >
              <div class="empty-illustration__frame">
                <span /><span /><span />
              </div><div class="empty-illustration__spark">
                ✦
              </div>
            </div>
            <p class="canvas-state__eyebrow">
              A design engine, ready for your idea
            </p>
            <h1>Start with a prompt</h1>
            <p>Describe an interface and Pudly will turn the request into an editable design document.</p>
            <button
              type="button"
              class="primary-button"
              @click="ensureProject('New design')"
            >
              Create a blank project
            </button>
          </div>
          <div
            v-else-if="!page"
            class="canvas-state"
          >
            <p>This project has no active page.</p>
          </div>
          <div
            v-else
            class="canvas-shell"
            :style="canvasShellStyle"
          >
            <div
              class="page-artboard"
              :style="canvasTransformStyle"
              :aria-label="`${page.name} design canvas`"
            >
              <div
                v-if="!rootNodeIds.length"
                class="artboard-empty"
              >
                <div
                  class="artboard-empty__icon"
                  aria-hidden="true"
                >
                  ✦
                </div>
                <p>No design elements on this page</p>
                <span>Add a frame or describe what you want below.</span>
              </div>
              <CanvasNode
                v-for="id in rootNodeIds"
                :key="id"
                :document="documentModel"
                :node-id="id"
                :viewport-width="viewportWidth"
                :selected-node-ids="new Set(selectedNodeIds)"
                :parent-layout="null"
                @select="selectNode"
              />
            </div>
          </div>
        </div>
      </section>

      <InspectorPanel
        v-if="documentModel"
        :document="documentModel"
        :node-id="selectedNode?.id ?? null"
        @property="onProperty"
        @layout="onLayout"
        @style="onStyle"
      />
      <aside
        v-else
        class="inspector inspector--placeholder"
        aria-label="Inspector"
      >
        <div><h2>Inspector</h2><p>Properties appear when you select a design element.</p></div>
      </aside>
    </div>

    <section
      class="prompt-dock"
      aria-label="Design prompt"
    >
      <details class="provider-menu">
        <summary>Model &amp; connection · {{ providerSelection ? `${providerSelection.modelId} · ${providerSelection.effort}` : 'Choose and verify' }}</summary>
        <div class="provider-popover">
          <ProviderConnections
            :disabled="runBusy"
            @selection="providerSelection = $event"
            @configured="providerEnabled = $event"
          />
        </div>
      </details>
      <div class="prompt-dock__context">
        <span
          class="prompt-spark"
          aria-hidden="true"
        >✦</span>
        <span>{{ selectedNodeIds.length ? `${selectedNodeIds.length} layer${selectedNodeIds.length === 1 ? '' : 's'} selected` : documentModel ? `Editing ${documentModel.name}` : 'New design' }}</span>
        <span
          v-if="documentModel"
          class="revision-pill"
        >v{{ documentModel.revision }}</span>
      </div>
      <form
        class="prompt-form"
        @submit.prevent="submitPrompt()"
      >
        <label
          class="visually-hidden"
          for="design-prompt"
        >Describe a design or edit</label>
        <textarea
          id="design-prompt"
          v-model="prompt"
          rows="1"
          :disabled="loading || runBusy || runStarting"
          placeholder="Describe what you want to design or change…"
          @keydown.meta.enter.prevent="submitPrompt()"
          @keydown.ctrl.enter.prevent="submitPrompt()"
        />
        <button
          class="prompt-submit"
          type="submit"
          :disabled="!prompt.trim() || runBusy || runStarting || loading || (providerEnabled && !providerSelection)"
          :aria-label="runBusy ? runPhaseLabel : 'Generate design'"
        >
          <span
            v-if="runBusy"
            class="button-spinner"
          /><span
            v-else
            aria-hidden="true"
          >↑</span>
        </button>
      </form>
      <div class="prompt-dock__footer">
        <span
          v-if="activeRun"
          class="run-status-line"
          :class="`state-${activeRun.state.toLowerCase()}`"
        ><span class="run-dot" />{{ runPhaseLabel }}<span v-if="currentRunRevision !== undefined"> · revision {{ currentRunRevision }}</span></span>
        <span
          v-else
          class="prompt-hint"
        >Enter to send <kbd>⌘</kbd><kbd>↵</kbd></span>
        <div class="history-controls">
          <button
            type="button"
            :disabled="!canUndo"
            aria-label="Undo"
            title="Undo (⌘Z)"
            @click="changeHistory('undo')"
          >
            ↶
          </button>
          <button
            type="button"
            :disabled="!canRedo"
            aria-label="Redo"
            title="Redo (⌘⇧Z)"
            @click="changeHistory('redo')"
          >
            ↷
          </button>
          <details class="history-menu">
            <summary aria-label="Snapshots">
              ◷ <span>History</span>
            </summary>
            <div class="history-popover">
              <form
                class="snapshot-form"
                @submit.prevent="saveSnapshot"
              >
                <label for="snapshot-label">Save a snapshot</label>
                <div>
                  <input
                    id="snapshot-label"
                    v-model="snapshotLabel"
                    placeholder="Milestone name"
                  ><button
                    type="submit"
                    :disabled="!snapshotLabel.trim() || !documentModel"
                  >
                    Save
                  </button>
                </div>
              </form>
              <div
                v-if="project?.history.snapshots.length"
                class="snapshot-list"
              >
                <div
                  v-for="snapshot in project.history.snapshots.slice().reverse()"
                  :key="snapshot.id"
                  class="snapshot-row"
                >
                  <span><strong>{{ snapshot.label }}</strong><small>Revision {{ snapshot.revision }}</small></span>
                  <button
                    type="button"
                    :disabled="editingLocked"
                    @click="restoreSnapshot(snapshot.id)"
                  >
                    Restore
                  </button>
                </div>
              </div>
              <p
                v-else
                class="snapshot-empty"
              >
                Saved snapshots will appear here.
              </p>
            </div>
          </details>
        </div>
      </div>
    </section>

    <div
      v-if="exportResult"
      class="export-result"
      role="status"
    >
      <strong>{{ exportResult.target.toUpperCase() }} export · {{ exportResult.status }}</strong>
      <span>{{ exportResult.fidelity.filter((item) => item.status !== 'preserved').length }} feature limits · {{ exportResult.diagnostics.length }} diagnostics</span>
      <button
        type="button"
        aria-label="Close export summary"
        @click="exportResult = null"
      >
        ×
      </button>
    </div>
  </main>
</template>

<style scoped>
.studio { height: 100dvh; min-height: 0; min-width: 900px; display: flex; flex-direction: column; background: var(--chrome); }
.topbar { height: 52px; flex: 0 0 52px; display: grid; grid-template-columns: minmax(260px, 1fr) auto minmax(220px, 1fr); align-items: center; padding: 0 17px; border-bottom: 1px solid var(--chrome-border); background: #191b21; }
.brand-lockup, .topbar__center, .topbar__actions, .viewport-switcher, .export-menu { display: flex; align-items: center; }
.brand-lockup { min-width: 0; gap: 9px; }
.brand-mark { display: grid; width: 25px; height: 25px; place-items: center; color: #fff; font-size: 12px; font-weight: 750; border-radius: 7px; background: linear-gradient(135deg, #9b86ff, #6265e9); }
.brand-name { font-size: 13px; font-weight: 650; white-space: nowrap; }.brand-name span { color: #aaacb6; font-weight: 450; }
.brand-divider { height: 17px; margin: 0 3px; border-left: 1px solid #3a3c45; }
.workspace-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #aeb1ba; font-size: 12px; max-width: 180px; }
.viewport-switcher { gap: 2px; height: 32px; padding: 3px; border: 1px solid #30323b; border-radius: 7px; background: #202229; }
.viewport-switcher button, .canvas-toolbar button { display: flex; align-items: center; justify-content: center; gap: 6px; border: 0; border-radius: 5px; padding: 6px 9px; color: #a7abb5; background: transparent; cursor: pointer; font-size: 11px; }
.viewport-switcher button.active, .canvas-toolbar button.active { color: #f0efff; background: #37384e; }
.viewport-size { margin-left: 8px; padding-left: 10px; border-left: 1px solid #3a3c45; color: #858995; font: 10px ui-monospace, monospace; white-space: nowrap; }
.topbar__actions { justify-content: flex-end; gap: 14px; }
.export-menu { gap: 5px; color: #8f939e; font-size: 11px; }
.export-menu button { border: 1px solid #373943; background: #23252d; padding: 5px 8px; border-radius: 5px; color: #d4d6de; font-size: 10px; cursor: pointer; }
.export-menu button:disabled { opacity: .5; cursor: not-allowed; }
.connection-dot, .run-dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: #59c79a; }
.connection-dot.is-loading { background: #e2ba69; animation: pulse 1s infinite; }.connection-dot.is-error { background: #e27979; }
.connection-banner, .message-banner { flex: 0 0 auto; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 8px 18px; color: #f2d7a0; background: #30291e; border-bottom: 1px solid #57452a; font-size: 12px; }
.connection-banner button, .message-banner button { border: 0; background: transparent; color: inherit; cursor: pointer; }
.message-banner { color: #c8c5ff; background: #29283f; border-color: #444167; }.message-banner.is-error { color: #ffc1c1; background: #3b252b; border-color: #654047; }
.workarea { display: flex; min-height: 0; flex: 1 1 0; overflow: hidden; }
.left-rail { min-height: 0; width: 228px; flex: 0 0 228px; display: flex; flex-direction: column; overflow: hidden; background: #1b1d24; border-right: 1px solid var(--chrome-border); }
.side-section { padding: 14px 10px 9px; border-bottom: 1px solid #2c2e36; }.page-section { flex: 0 0 auto; max-height: 36%; overflow: auto; }.layers-section { flex: 1; min-height: 0; overflow: hidden; display: flex; flex-direction: column; }
.section-title { display: flex; align-items: center; justify-content: space-between; padding: 0 5px 8px; color: #9ca0ac; }.section-title h2 { margin: 0; color: #b8bbc4; font-size: 10px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }.section-title > span { color: #777c89; font: 10px ui-monospace, monospace; }
.page-list { display: grid; gap: 2px; }.page-row { width: 100%; display: flex; align-items: center; gap: 8px; border: 0; border-radius: 5px; padding: 7px 9px; text-align: left; background: transparent; color: #aeb2bd; cursor: pointer; font-size: 12px; }.page-row:hover { background: #282a32; }.page-row.active { color: #f0efff; background: #34354a; }.page-icon { color: #a2a4ff; font-size: 12px; }
.side-empty { padding: 10px 7px; color: #777c88; font-size: 11px; line-height: 1.5; }.layer-tree-scroll { min-height: 0; flex: 1; overflow: auto; }.layer-tree { list-style: none; margin: 0; padding: 0; }
.run-sidebar-section { flex: 0 1 38%; min-height: 0; max-height: 38%; overflow: auto; overscroll-behavior: contain; padding: 13px 13px 16px; background: #191b22; border-top: 1px solid #30323b; }.run-sidebar-section .section-title { padding: 0 0 9px; }.run-sidebar__request { overflow-wrap: anywhere; color: #b7bac3; font-size: 11px; line-height: 1.5; }.run-sidebar__state { margin-top: 7px; color: #a5a4ff; font-size: 11px; }.context-details { margin-top: 11px; color: #9b9eaa; font-size: 10px; }.context-details summary { cursor: pointer; color: #b8bac4; }.context-details p { line-height: 1.5; }.context-details ul { margin: 4px 0; padding-left: 16px; }.event-list { margin: 6px 0 0; padding-left: 16px; max-height: 90px; overflow: auto; line-height: 1.5; }.text-button { display: block; border: 0; padding: 5px 0 0; color: #a8a5ff; background: transparent; font-size: 10px; cursor: pointer; }
.editor-center { min-width: 0; min-height: 0; flex: 1; display: flex; flex-direction: column; background: #25272f; }
.canvas-toolbar { height: 42px; flex: 0 0 42px; display: flex; align-items: center; justify-content: space-between; padding: 0 11px; border-bottom: 1px solid #33353e; background: #202229; }.canvas-toolbar__left, .canvas-toolbar__middle, .canvas-toolbar__right { display: flex; align-items: center; gap: 4px; }.canvas-toolbar__middle { position: absolute; left: 50%; transform: translateX(-50%); }.canvas-toolbar button { height: 28px; padding: 0 9px; border: 1px solid transparent; }.canvas-toolbar button:hover:not(:disabled) { color: #f1f0ff; background: #2e303a; }.canvas-toolbar button:disabled { opacity: .4; cursor: not-allowed; }.canvas-toolbar .danger-tool { color: #b58d8d; font-size: 14px; }.current-page-label { color: #babdc6; font-size: 11px; }.selection-count { padding-left: 8px; border-left: 1px solid #42444e; color: #a6a5ff; font-size: 10px; }.canvas-toolbar__right { gap: 1px; }.canvas-toolbar .zoom-label { min-width: 45px; font: 10px ui-monospace, monospace; color: #9ca0aa; }
.canvas-scroll { min-height: 0; flex: 1; overflow: auto; display: flex; align-items: safe center; justify-content: safe center; padding: 44px; background-color: #25272f; background-image: radial-gradient(#3b3d47 0.8px, transparent 0.8px); background-size: 17px 17px; }.canvas-scroll.is-pan-mode { cursor: grab; }.canvas-scroll.is-pan-mode:active { cursor: grabbing; }.canvas-shell { flex: 0 0 auto; position: relative; }.page-artboard { box-sizing: border-box; transform-origin: top left; position: relative; overflow: auto; display: flex; align-items: flex-start; justify-content: flex-start; padding: 0; gap: 0; background: #f4f5f7; color: #25272f; border-radius: 3px; box-shadow: 0 18px 50px rgb(0 0 0 / 34%), 0 0 0 1px rgb(255 255 255 / 10%); }
.canvas-state { flex: 1; min-height: 300px; display: flex; align-items: center; justify-content: center; flex-direction: column; color: #a2a6b1; text-align: center; }.canvas-state p { font-size: 12px; }.canvas-state--empty { max-width: 390px; margin: auto; }.canvas-state__eyebrow { margin: 18px 0 0; color: #a8a6ff; font-size: 10px!important; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }.canvas-state h1 { margin: 8px 0; color: #ececf2; font-size: 23px; font-weight: 550; letter-spacing: -.02em; }.canvas-state--empty > p:not(.canvas-state__eyebrow) { line-height: 1.6; color: #969aa6; }
.primary-button { margin-top: 13px; padding: 8px 12px; border: 1px solid #6967db; border-radius: 6px; background: #5b5ac0; color: white; font-size: 11px; cursor: pointer; }.primary-button:hover { background: #6a68d5; }.empty-illustration { position: relative; width: 92px; height: 72px; }.empty-illustration__frame { position: absolute; inset: 8px 13px 2px 3px; display: grid; gap: 5px; padding: 9px; border: 1px solid #686b84; border-radius: 8px; background: linear-gradient(135deg, #313340, #252630); transform: rotate(-7deg); }.empty-illustration__frame span { height: 6px; border-radius: 5px; background: #575968; }.empty-illustration__frame span:first-child { width: 60%; background: #8381e6; }.empty-illustration__frame span:nth-child(2) { width: 84%; }.empty-illustration__spark { position: absolute; right: 3px; top: 0; color: #c3a6ff; font-size: 22px; }.artboard-empty { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; color: #9ba0ab; text-align: center; pointer-events: none; }.artboard-empty__icon { font-size: 20px; color: #a3a0ff; }.artboard-empty p { margin: 8px 0 4px; font-size: 12px; }.artboard-empty span { font-size: 10px; color: #a9adb6; }
.inspector--placeholder { width: 272px; flex: 0 0 272px; display: grid; place-items: center; background: #1b1d24; border-left: 1px solid var(--chrome-border); text-align: center; padding: 22px; }.inspector--placeholder h2 { margin: 0; font-size: 14px; }.inspector--placeholder p { color: #8e939f; font-size: 11px; line-height: 1.5; }
.provider-menu { position: relative; max-width: 740px; margin: 0 auto 7px; font-size: 11px; color: #cbc8ff; }
.provider-menu > summary { cursor: pointer; padding: 5px 0; }
.provider-popover { position: absolute; bottom: 30px; left: 0; right: 0; z-index: 40; max-height: min(70dvh, 650px); overflow: auto; border: 1px solid #4b4c60; border-radius: 8px; background: #20222a; box-shadow: 0 12px 36px #0008; padding: 12px; }
.prompt-dock { flex: 0 0 auto; border-top: 1px solid #33353e; background: #1b1d24; padding: 10px max(16px, calc((100vw - 780px) / 2)) 9px; }.prompt-dock__context { display: flex; align-items: center; gap: 7px; margin: 0 auto 7px; max-width: 740px; color: #8f939e; font-size: 10px; }.prompt-spark { color: #aaa7ff; }.revision-pill { margin-left: auto; padding: 2px 6px; border: 1px solid #363842; border-radius: 4px; color: #a7a9b3; font: 9px ui-monospace, monospace; }.prompt-form { display: flex; align-items: center; gap: 9px; margin: 0 auto; max-width: 740px; padding: 8px 8px 8px 13px; border: 1px solid #444650; border-radius: 9px; background: #25272f; box-shadow: 0 3px 14px rgb(0 0 0 / 12%); }.prompt-form:focus-within { border-color: #7271d6; box-shadow: 0 0 0 2px rgb(114 113 214 / 12%); }.prompt-form textarea { resize: none; flex: 1; min-height: 25px; max-height: 100px; border: 0; outline: none; color: #e4e5eb; background: transparent; font-size: 12px; line-height: 1.5; }.prompt-form textarea::placeholder { color: #777c88; }.prompt-form textarea:disabled { opacity: .55; }.prompt-submit { width: 29px; height: 29px; display: grid; place-items: center; border: 0; border-radius: 7px; background: #7372dc; color: white; cursor: pointer; font-size: 17px; }.prompt-submit:disabled { color: #777b87; background: #383a44; cursor: not-allowed; }.prompt-dock__footer { display: flex; align-items: center; justify-content: space-between; max-width: 740px; margin: 7px auto 0; min-height: 23px; }.prompt-hint { color: #727783; font-size: 9px; }.prompt-hint kbd { margin-left: 4px; padding: 2px 4px; border: 1px solid #41434d; border-radius: 3px; background: #272932; color: #a2a5b0; font: 9px ui-monospace, monospace; }.history-controls { display: flex; align-items: center; gap: 2px; }.history-controls > button, .history-menu summary { display: flex; align-items: center; justify-content: center; gap: 4px; width: 27px; height: 25px; border: 0; border-radius: 5px; background: transparent; color: #a5a8b2; cursor: pointer; font-size: 14px; list-style: none; }.history-controls > button:hover:not(:disabled), .history-menu summary:hover { background: #2d2f38; color: white; }.history-controls > button:disabled { opacity: .3; cursor: not-allowed; }.history-menu { position: relative; }.history-menu summary { width: auto; padding: 0 7px; font-size: 11px; }.history-menu summary::-webkit-details-marker { display: none; }.history-popover { position: absolute; z-index: 20; right: 0; bottom: 31px; width: 270px; max-height: 330px; overflow: auto; padding: 13px; border: 1px solid #41434e; border-radius: 8px; background: #23252d; box-shadow: 0 12px 40px rgb(0 0 0 / 42%); }.snapshot-form label { display: block; color: #c3c5ce; font-size: 10px; margin-bottom: 7px; }.snapshot-form > div { display: flex; gap: 6px; }.snapshot-form input { min-width: 0; flex: 1; padding: 6px 7px; border: 1px solid #40434c; border-radius: 4px; color: #eee; background: #1c1e25; font-size: 10px; }.snapshot-form button, .snapshot-row button { border: 1px solid #5554a6; border-radius: 4px; padding: 5px 8px; color: #d8d7ff; background: #39385f; font-size: 10px; cursor: pointer; }.snapshot-form button:disabled { opacity: .4; }.snapshot-list { display: grid; gap: 7px; margin-top: 12px; }.snapshot-row { display: flex; align-items: center; justify-content: space-between; gap: 6px; padding-top: 7px; border-top: 1px solid #353741; }.snapshot-row span { display: grid; gap: 3px; min-width: 0; }.snapshot-row strong { overflow: hidden; text-overflow: ellipsis; color: #d3d5dd; font-size: 10px; font-weight: 500; }.snapshot-row small, .snapshot-empty { color: #868b97; font-size: 9px; }.snapshot-row button { flex: 0 0 auto; }.snapshot-empty { margin: 12px 0 0; }
.run-status-line { display: flex; align-items: center; gap: 6px; color: #b1afff; font-size: 10px; }.run-status-line.state-failed { color: #f0a2a2; }.run-status-line.state-succeeded { color: #86d3ac; }.run-status-line .run-dot { width: 6px; height: 6px; background: #a4a1ff; animation: pulse 1s infinite; }.run-status-line.state-failed .run-dot { background: #e57979; animation: none; }.run-status-line.state-succeeded .run-dot { background: #5ac68f; animation: none; }.button-spinner, .state-spinner { border: 2px solid rgb(255 255 255 / 28%); border-top-color: white; border-radius: 50%; animation: spin .8s linear infinite; }.button-spinner { width: 13px; height: 13px; }.state-spinner { width: 22px; height: 22px; border-color: #41434e; border-top-color: #9795ff; }.export-result { position: fixed; z-index: 30; right: 16px; top: 62px; display: grid; gap: 3px; min-width: 225px; padding: 11px 32px 11px 12px; border: 1px solid #4b4b6f; border-radius: 7px; background: #28283c; color: #e6e4ff; font-size: 10px; box-shadow: 0 8px 30px rgb(0 0 0 / 35%); }.export-result span { color: #aaaab9; }.export-result button { position: absolute; right: 5px; top: 4px; border: 0; background: transparent; color: #aeb0bc; cursor: pointer; }.visually-hidden { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
@keyframes spin { to { transform: rotate(360deg); } }@keyframes pulse { 50% { opacity: .35; } }
@media (max-width: 1150px) { .left-rail { min-height: 0; width: 198px; flex-basis: 198px; }.inspector { width: 248px; flex-basis: 248px; }.viewport-switcher button span { display: none; } }
</style>
