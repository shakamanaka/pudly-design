<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { PersistedProjectEnvelope } from '../../domain/types';
import CanvasNode from './CanvasNode.vue';
import { localApi, type ProjectSummary } from '../services/local-api';

const props = defineProps<{
  currentProjectId: string | null;
  lifecycleLocked: boolean;
}>();
const emit = defineEmits<{
  opened: [project: PersistedProjectEnvelope];
  deleted: [project: PersistedProjectEnvelope | null];
}>();

type ViewMode = 'grid' | 'list';
const storageKey = 'codex-design.project-explorer.view';
const viewMode = ref<ViewMode>(readSavedView());
const isOpen = ref(false);
const projects = ref<ProjectSummary[]>([]);
const loading = ref(false);
const busyId = ref('');
const error = ref('');
const success = ref('');
const newName = ref('');
const creating = ref(false);
const confirmingId = ref('');
const trigger = ref<HTMLButtonElement | null>(null);
const closeButton = ref<HTMLButtonElement | null>(null);
const dialog = ref<HTMLElement | null>(null);
const previews = ref<Record<string, import('../../domain/types').DesignDocument | null>>({});
const previewErrors = ref<Record<string, string>>({});
const previewLoading = ref(new Set<string>());
const observer = ref<IntersectionObserver | null>(null);
const resizeObserver = ref<ResizeObserver | null>(null);
const observedCards = new Map<string, Element>();
const previewScales = ref<Record<string, number>>({});
const previewQueue: string[] = [];
let activePreviewRequests = 0;
let previewEpoch = 0;

const mutationBlocked = computed(() => props.lifecycleLocked || loading.value || creating.value || busyId.value !== '');
const orderedProjects = computed(() => projects.value);

function readSavedView(): ViewMode {
  try {
    return localStorage.getItem(storageKey) === 'list' ? 'list' : 'grid';
  } catch {
    return 'grid';
  }
}
function setView(mode: ViewMode) {
  viewMode.value = mode;
  try { localStorage.setItem(storageKey, mode); } catch { /* View preference is optional. */ }
}
function dateLabel(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? 'Saved time unavailable' : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}
function clearMessages() {
  error.value = '';
  success.value = '';
}
function messageFor(errorValue: unknown): string {
  return errorValue instanceof Error ? errorValue.message : 'The project library request could not be completed.';
}
async function loadProjects() {
  loading.value = true;
  error.value = '';
  resetPreviewState();
  try {
    projects.value = (await localApi.listProjects()).projects;
  } catch (cause) {
    error.value = messageFor(cause);
  } finally {
    loading.value = false;
  }
}
async function showExplorer() {
  isOpen.value = true;
  clearMessages();
  await loadProjects();
  if (!isOpen.value) return;
  await nextTick();
  closeButton.value?.focus();
  if (viewMode.value === 'grid') loadVisibleFallbacks();
}
function hideExplorer() {
  if (!isOpen.value) return;
  isOpen.value = false;
  previewEpoch += 1;
  previewQueue.length = 0;
  previewLoading.value = new Set();
  confirmingId.value = '';
  nextTick(() => trigger.value?.focus());
}
async function createNamedProject() {
  const name = newName.value.trim();
  if (!name || mutationBlocked.value) return;
  clearMessages();
  creating.value = true;
  try {
    const result = await localApi.createProject(name);
    newName.value = '';
    hideExplorer();
    emit('opened', result.project);
  } catch (cause) {
    error.value = messageFor(cause);
  } finally {
    creating.value = false;
  }
}
async function openProject(item: ProjectSummary) {
  if (item.status !== 'available' || mutationBlocked.value) return;
  clearMessages();
  busyId.value = item.id;
  try {
    const result = await localApi.openProject(item.id);
    hideExplorer();
    emit('opened', result.project);
  } catch (cause) {
    error.value = messageFor(cause);
  } finally {
    busyId.value = '';
  }
}
async function removeProject(item: ProjectSummary) {
  if (mutationBlocked.value || confirmingId.value !== item.id) return;
  clearMessages();
  busyId.value = item.id;
  try {
    const result = await localApi.deleteProject(item.id);
    projects.value = projects.value.filter((project) => project.id !== item.id);
    confirmingId.value = '';
    delete previews.value[item.id];
    emit('deleted', result.project);
    success.value = `“${item.name}” was moved to the local trash.`;
  } catch (cause) {
    error.value = `Could not remove “${item.name}”: ${messageFor(cause)}`;
  } finally {
    busyId.value = '';
  }
}
function enqueuePreview(id: string) {
  if (!isOpen.value || previews.value[id] !== undefined || previewLoading.value.has(id) || previewQueue.includes(id)) return;
  previewQueue.push(id);
  pumpPreviewQueue();
}
function pumpPreviewQueue() {
  while (isOpen.value && activePreviewRequests < 3 && previewQueue.length) {
    const id = previewQueue.shift();
    if (!id) continue;
    const requestEpoch = previewEpoch;
    activePreviewRequests += 1;
    previewLoading.value = new Set(previewLoading.value).add(id);
    void localApi.getProjectPreview(id).then((result) => {
      if (requestEpoch === previewEpoch && isOpen.value) previews.value = { ...previews.value, [id]: result.document };
    }).catch((cause: unknown) => {
      if (requestEpoch === previewEpoch && isOpen.value) previewErrors.value = { ...previewErrors.value, [id]: messageFor(cause) };
    }).finally(() => {
      activePreviewRequests -= 1;
      if (requestEpoch === previewEpoch) {
        const next = new Set(previewLoading.value);
        next.delete(id);
        previewLoading.value = next;
      }
      pumpPreviewQueue();
    });
  }
}
function resetPreviewState() {
  previewEpoch += 1;
  previewQueue.length = 0;
  previews.value = {};
  previewErrors.value = {};
  previewLoading.value = new Set();
}
function observeCard(element: Element | null, id: string) {
  const previous = observedCards.get(id);
  if (previous && previous !== element) {
    observer.value?.unobserve(previous);
    resizeObserver.value?.unobserve(previous);
  }
  if (!element) {
    observedCards.delete(id);
    return;
  }
  observedCards.set(id, element);
  if (observer.value) observer.value.observe(element);
  if (resizeObserver.value) resizeObserver.value.observe(element);
  else measurePreviewCard(id, element);
}
function setPreviewScale(id: string, width: number) {
  if (!Number.isFinite(width) || width <= 0) return;
  const scale = width / 1440;
  if (Math.abs((previewScales.value[id] ?? 0) - scale) < 0.001) return;
  previewScales.value = { ...previewScales.value, [id]: scale };
}
function measurePreviewCard(id: string, element: Element) {
  setPreviewScale(id, element.getBoundingClientRect().width);
}
function onPreviewResize(entries: ResizeObserverEntry[]) {
  for (const entry of entries) {
    for (const [id, element] of observedCards) {
      if (entry.target === element) setPreviewScale(id, entry.contentRect.width);
    }
  }
}
function measureObservedCards() {
  for (const [id, element] of observedCards) measurePreviewCard(id, element);
}
function loadVisibleFallbacks() {
  if (typeof IntersectionObserver !== 'undefined') return;
  for (const item of orderedProjects.value.slice(0, 4)) {
    if (item.status === 'available') enqueuePreview(item.id);
  }
}
function handleDialogKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault();
    hideExplorer();
    return;
  }
  if (event.key !== 'Tab' || !dialog.value) return;
  const focusable = Array.from(dialog.value.querySelectorAll<HTMLElement>(
    'button:not(:disabled), input:not(:disabled), [href], [tabindex]:not([tabindex="-1"])',
  )).filter((element) => !element.hasAttribute('hidden') && !element.closest('[inert], [aria-hidden="true"]'));
  if (!focusable.length) {
    event.preventDefault();
    dialog.value.focus();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && (document.activeElement === first || !dialog.value.contains(document.activeElement))) {
    event.preventDefault();
    last?.focus();
  } else if (!event.shiftKey && (document.activeElement === last || !dialog.value.contains(document.activeElement))) {
    event.preventDefault();
    first?.focus();
  }
}
function documentFor(item: ProjectSummary) {
  return previews.value[item.id] ?? null;
}
function documentHasNodes(item: ProjectSummary) {
  const document = documentFor(item);
  const firstPageId = document?.pageOrder[0];
  return !!firstPageId && (document?.pages[firstPageId]?.rootNodeIds.length ?? 0) > 0;
}

watch(isOpen, (open) => {
  observer.value?.disconnect();
  observer.value = null;
  observedCards.clear();
  previewQueue.length = 0;
  if (!open) return;
  nextTick(() => {
    if (typeof IntersectionObserver === 'undefined') {
      loadVisibleFallbacks();
      return;
    }
    observer.value = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        for (const [id, element] of observedCards) {
          if (element === entry.target) enqueuePreview(id);
        }
      }
    }, { root: dialog.value?.querySelector('.project-explorer__scroll') ?? null, rootMargin: '120px' });
    for (const [id, element] of observedCards) {
      if (orderedProjects.value.find((item) => item.id === id)?.status === 'available') observer.value.observe(element);
    }
  });
});
watch(viewMode, (mode) => { if (mode === 'grid' && isOpen.value) nextTick(loadVisibleFallbacks); });
onBeforeUnmount(() => {
  previewEpoch += 1;
  previewQueue.length = 0;
  observer.value?.disconnect();
  resizeObserver.value?.disconnect();
  window.removeEventListener('resize', measureObservedCards);
});
onMounted(() => {
  if (typeof ResizeObserver !== 'undefined') resizeObserver.value = new ResizeObserver(onPreviewResize);
  window.addEventListener('resize', measureObservedCards, { passive: true });
});
</script>

<template>
  <button
    ref="trigger"
    class="project-explorer-trigger"
    type="button"
    aria-haspopup="dialog"
    :aria-expanded="isOpen"
    @click="showExplorer"
  >
    <span aria-hidden="true">▦</span>
    <span>Projects</span>
  </button>

  <Teleport to="body">
    <div
      v-if="isOpen"
      class="project-explorer-backdrop"
      @mousedown.self="hideExplorer"
    >
      <section
        ref="dialog"
        class="project-explorer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-explorer-title"
        tabindex="-1"
        @keydown="handleDialogKeydown"
      >
        <header class="project-explorer__header">
          <div>
            <p class="project-explorer__eyebrow">
              Local library
            </p>
            <h1 id="project-explorer-title">
              Your projects
            </h1>
            <p class="project-explorer__subtitle">
              Saved designs stay on this device.
            </p>
          </div>
          <button
            ref="closeButton"
            class="project-explorer__close"
            type="button"
            aria-label="Close project explorer"
            @click="hideExplorer"
          >
            ×
          </button>
        </header>

        <form
          class="project-explorer__create"
          @submit.prevent="createNamedProject"
        >
          <label for="new-project-name">Create a project</label>
          <div class="project-explorer__create-row">
            <input
              id="new-project-name"
              v-model="newName"
              maxlength="120"
              placeholder="Name your design"
              :disabled="mutationBlocked"
              required
            >
            <button
              type="submit"
              :disabled="mutationBlocked || !newName.trim()"
            >
              {{ creating ? 'Creating…' : 'Create project' }}
            </button>
          </div>
          <p
            v-if="lifecycleLocked"
            class="project-explorer__locked"
            role="status"
          >
            Project changes are paused while the current design run finishes.
          </p>
        </form>

        <div class="project-explorer__controls">
          <p>{{ projects.length }} {{ projects.length === 1 ? 'project' : 'projects' }}</p>
          <div
            class="project-explorer__view-switch"
            role="group"
            aria-label="Project display"
          >
            <button
              type="button"
              :aria-pressed="viewMode === 'grid'"
              @click="setView('grid')"
            >
              Grid
            </button>
            <button
              type="button"
              :aria-pressed="viewMode === 'list'"
              @click="setView('list')"
            >
              List
            </button>
          </div>
        </div>

        <div class="project-explorer__scroll">
          <p
            v-if="error"
            class="project-explorer__message is-error"
            role="alert"
          >
            {{ error }}
          </p>
          <p
            v-else-if="success"
            class="project-explorer__message"
            role="status"
          >
            {{ success }}
          </p>
          <div
            v-if="loading"
            class="project-explorer__loading"
            role="status"
          >
            Loading saved projects…
          </div>
          <div
            v-else-if="!projects.length"
            class="project-explorer__empty"
          >
            <span aria-hidden="true">✦</span>
            <h2>No saved projects yet</h2>
            <p>Create a named project to keep your design work together.</p>
          </div>
          <ul
            v-else
            class="project-explorer__items"
            :class="`is-${viewMode}`"
            aria-label="Saved projects"
          >
            <li
              v-for="item in orderedProjects"
              :key="item.id"
              class="project-card"
              :class="{ 'is-current': item.id === currentProjectId, 'is-unavailable': item.status === 'unavailable' }"
            >
              <div
                v-if="viewMode === 'grid'"
                :ref="(element) => observeCard(element as Element | null, item.id)"
                class="project-card__preview-wrap"
              >
                <div
                  v-if="item.status === 'unavailable'"
                  class="project-card__preview-state"
                >
                  <span aria-hidden="true">!</span><strong>Unavailable</strong><small>{{ item.diagnostic || 'This saved project could not be opened.' }}</small>
                </div>
                <div
                  v-else-if="previewLoading.has(item.id)"
                  class="project-card__preview-state"
                  role="status"
                >
                  Loading saved preview…
                </div>
                <div
                  v-else-if="previewErrors[item.id]"
                  class="project-card__preview-state"
                >
                  <strong>Preview unavailable</strong><small>{{ previewErrors[item.id] }}</small>
                </div>
                <div
                  v-else-if="documentFor(item) && !documentHasNodes(item)"
                  class="project-card__preview-state"
                >
                  <strong>Empty design</strong><small>The first page has no design elements yet.</small>
                </div>
                <div
                  v-else-if="documentFor(item)"
                  class="project-card__preview-frame"
                  inert
                  aria-hidden="true"
                >
                  <div
                    class="project-card__artboard"
                    :style="{ '--preview-scale': previewScales[item.id] ?? 0.18 }"
                  >
                    <CanvasNode
                      v-for="nodeId in documentFor(item)?.pages[documentFor(item)?.pageOrder[0] ?? '']?.rootNodeIds ?? []"
                      :key="nodeId"
                      :document="documentFor(item)!"
                      :node-id="nodeId"
                      :viewport-width="1440"
                      :selected-node-ids="new Set()"
                      :parent-layout="null"
                    />
                  </div>
                </div>
                <div
                  v-else
                  class="project-card__preview-state"
                  role="status"
                >
                  Saved design preview loads when this card is visible.
                </div>
              </div>

              <div class="project-card__body">
                <div class="project-card__heading">
                  <h2>{{ item.name }}</h2>
                  <span
                    v-if="item.id === currentProjectId"
                    class="project-card__current"
                  >Current</span>
                  <span
                    v-else-if="item.status === 'unavailable'"
                    class="project-card__badge"
                  >Unavailable</span>
                </div>
                <p class="project-card__meta">
                  Saved {{ dateLabel(item.updatedAt) }}<span aria-hidden="true"> · </span>Revision {{ item.revision }}<span aria-hidden="true"> · </span>{{ item.nodeCount }} {{ item.nodeCount === 1 ? 'node' : 'nodes' }}
                </p>
                <p
                  v-if="item.status === 'unavailable' && viewMode === 'list'"
                  class="project-card__diagnostic"
                >
                  {{ item.diagnostic || 'This saved project could not be opened.' }}
                </p>
                <div
                  v-if="confirmingId === item.id"
                  class="project-card__confirm"
                  role="group"
                  :aria-label="`Confirm removal of ${item.name}`"
                >
                  <p>Move <strong>{{ item.name }}</strong> to local trash?</p>
                  <button
                    type="button"
                    class="is-danger"
                    :disabled="mutationBlocked"
                    @click="removeProject(item)"
                  >
                    Remove project
                  </button>
                  <button
                    type="button"
                    :disabled="busyId === item.id"
                    @click="confirmingId = ''"
                  >
                    Cancel
                  </button>
                </div>
                <div
                  v-else
                  class="project-card__actions"
                >
                  <button
                    type="button"
                    class="is-open"
                    :disabled="item.status !== 'available' || mutationBlocked || item.id === currentProjectId"
                    @click="openProject(item)"
                  >
                    {{ busyId === item.id ? 'Opening…' : item.id === currentProjectId ? 'Open' : 'Open project' }}
                  </button>
                  <button
                    type="button"
                    class="is-remove"
                    :disabled="mutationBlocked"
                    @click="confirmingId = item.id"
                  >
                    Remove
                  </button>
                </div>
              </div>
            </li>
          </ul>
        </div>
        <footer class="project-explorer__footer">
          <span>Previews show saved first-page content. They never run a model.</span>
          <button
            type="button"
            @click="hideExplorer"
          >
            Done
          </button>
        </footer>
      </section>
    </div>
  </Teleport>
</template>

<style>
.project-explorer-trigger { display: inline-flex; align-items: center; gap: 7px; padding: 6px 9px; border: 1px solid #373943; border-radius: 6px; color: #d8d9e0; background: #23252d; cursor: pointer; font-size: 11px; white-space: nowrap; }
.project-explorer-trigger:hover { background: #30323c; }
.project-explorer-backdrop { position: fixed; z-index: 1000; inset: 0; display: grid; place-items: center; padding: 20px; background: rgb(5 6 12 / 68%); }
.project-explorer { width: min(980px, 100%); max-height: min(800px, calc(100dvh - 40px)); display: flex; flex-direction: column; overflow: hidden; border: 1px solid #3c3f4b; border-radius: 16px; color: #e7e8ef; background: #1c1e26; box-shadow: 0 28px 100px rgb(0 0 0 / 48%); outline: none; }
.project-explorer__header { display: flex; align-items: flex-start; justify-content: space-between; padding: 23px 26px 17px; border-bottom: 1px solid #30323c; }
.project-explorer__eyebrow { margin: 0 0 5px; color: #a7a4ff; font-size: 10px; font-weight: 750; letter-spacing: .12em; text-transform: uppercase; }
.project-explorer__header h1 { margin: 0; color: #f3f3f7; font-size: 22px; font-weight: 600; letter-spacing: -.03em; }
.project-explorer__subtitle { margin: 6px 0 0; color: #9599a6; font-size: 12px; }
.project-explorer__close { width: 34px; height: 34px; display: grid; place-items: center; border: 1px solid #3a3c46; border-radius: 8px; color: #c8cad3; background: #252730; cursor: pointer; font-size: 23px; line-height: 1; }
.project-explorer__create { padding: 16px 26px; border-bottom: 1px solid #30323c; }
.project-explorer__create label { display: block; margin-bottom: 7px; color: #c7c9d1; font-size: 11px; font-weight: 650; }
.project-explorer__create-row { display: flex; gap: 8px; }
.project-explorer__create input { min-width: 0; flex: 1; padding: 10px 12px; border: 1px solid #3b3e4b; border-radius: 7px; color: #f0f0f4; background: #15171d; font-size: 12px; }
.project-explorer__create input::placeholder { color: #777b87; }
.project-explorer__create-row button, .project-explorer__footer > button { padding: 9px 13px; border: 1px solid #7471e7; border-radius: 7px; color: #fff; background: #5553b5; cursor: pointer; font-size: 11px; font-weight: 650; white-space: nowrap; }
.project-explorer button:disabled { opacity: .45; cursor: not-allowed; }
.project-explorer__locked { margin: 8px 0 0; color: #d9bd82; font-size: 11px; }
.project-explorer__controls { display: flex; align-items: center; justify-content: space-between; padding: 12px 26px; }
.project-explorer__controls > p { margin: 0; color: #969aa7; font-size: 11px; }
.project-explorer__view-switch { display: flex; gap: 3px; padding: 3px; border: 1px solid #373944; border-radius: 8px; background: #16181e; }
.project-explorer__view-switch button { min-width: 55px; padding: 5px 8px; border: 0; border-radius: 5px; color: #a8abb6; background: transparent; cursor: pointer; font-size: 10px; }
.project-explorer__view-switch button[aria-pressed="true"] { color: #f1f0ff; background: #3a3a55; }
.project-explorer__scroll { min-height: 180px; flex: 1; overflow: auto; overscroll-behavior: contain; padding: 0 26px 20px; }
.project-explorer__items { list-style: none; margin: 0; padding: 0; }
.project-explorer__items.is-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(245px, 1fr)); gap: 14px; }
.project-card { min-width: 0; overflow: hidden; border: 1px solid #353843; border-radius: 11px; background: #23252e; }
.project-card.is-current { border-color: #7471d6; box-shadow: 0 0 0 1px rgb(116 113 214 / 18%); }
.project-card.is-unavailable { border-style: dashed; }
.project-card__preview-wrap { position: relative; width: 100%; aspect-ratio: 16 / 10; overflow: hidden; border-bottom: 1px solid #383b46; background: #2a2c36; }
.project-card__preview-frame { position: absolute; inset: 0; overflow: hidden; background: #f4f5f7; }
.project-card__artboard { position: absolute; top: 0; left: 0; width: 1440px; height: 900px; overflow: hidden; display: flex; align-items: flex-start; justify-content: flex-start; padding: 0; background: #f4f5f7; color: #25272f; transform: scale(var(--preview-scale, .18)); transform-origin: top left; pointer-events: none; }
.project-card__preview-state { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; flex-direction: column; gap: 6px; padding: 16px; color: #b7bac6; text-align: center; font-size: 11px; }
.project-card__preview-state > span { display: grid; width: 26px; height: 26px; place-items: center; border-radius: 50%; color: #ffcc94; background: #494033; font-weight: 700; }
.project-card__preview-state small { max-width: 260px; color: #969aa6; font-size: 10px; line-height: 1.4; }
.project-card__body { min-width: 0; padding: 13px; }
.project-card__heading { display: flex; align-items: center; gap: 8px; min-width: 0; }
.project-card__heading h2 { min-width: 0; overflow: hidden; margin: 0; color: #e7e8ef; font-size: 13px; font-weight: 640; text-overflow: ellipsis; white-space: nowrap; }
.project-card__current, .project-card__badge { flex: 0 0 auto; padding: 3px 6px; border-radius: 999px; color: #c4c2ff; background: #37364f; font-size: 9px; }
.project-card__badge { color: #e3c18e; background: #413a2e; }
.project-card__meta { margin: 6px 0 0; overflow-wrap: anywhere; color: #999daa; font-size: 10px; line-height: 1.5; }
.project-card__actions { display: flex; gap: 7px; margin-top: 12px; }
.project-card__actions button, .project-card__confirm button { padding: 6px 9px; border: 1px solid #41444f; border-radius: 6px; color: #c5c7d0; background: #2a2c35; cursor: pointer; font-size: 10px; }
.project-card__actions .is-open { border-color: #5e5caf; color: #e4e2ff; background: #393858; }
.project-card__actions .is-remove, .project-card__confirm .is-danger { margin-left: auto; border-color: #644149; color: #ffc4cb; background: #3b292e; }
.project-card__confirm { margin-top: 12px; padding-top: 10px; border-top: 1px solid #40424b; }
.project-card__confirm p { margin: 0 0 9px; color: #c9cad2; font-size: 10px; line-height: 1.5; }
.project-card__diagnostic { margin: 8px 0 0; color: #d8bd8d; font-size: 10px; line-height: 1.5; }
.project-explorer__empty, .project-explorer__loading { min-height: 220px; display: flex; align-items: center; justify-content: center; flex-direction: column; color: #9da1ae; text-align: center; }
.project-explorer__empty > span { color: #a4a0ff; font-size: 22px; }
.project-explorer__empty h2 { margin: 9px 0 3px; color: #e1e2e9; font-size: 15px; font-weight: 600; }
.project-explorer__empty p { max-width: 310px; margin: 4px 0; font-size: 11px; line-height: 1.5; }
.project-explorer__message { margin: 0 0 12px; padding: 9px 11px; border: 1px solid #484875; border-radius: 7px; color: #ceccff; background: #29293f; font-size: 11px; }
.project-explorer__message.is-error { border-color: #654047; color: #ffc1c1; background: #3b252b; }
.project-explorer__footer { display: flex; align-items: center; justify-content: space-between; gap: 18px; padding: 13px 26px; border-top: 1px solid #30323c; color: #838794; font-size: 10px; }
.project-explorer__footer > button { padding: 7px 12px; }
.project-explorer__items.is-list { display: grid; gap: 8px; }
.project-explorer__items.is-list .project-card { display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 12px 13px; }
.project-explorer__items.is-list .project-card__body { flex: 1; padding: 0; }
.project-explorer__items.is-list .project-card__actions { flex: 0 0 auto; margin-top: 0; }
.project-explorer__items.is-list .project-card__confirm { flex-wrap: wrap; }
@media (max-width: 620px) {
  .project-explorer-backdrop { padding: 8px; }
  .project-explorer { max-height: calc(100dvh - 16px); border-radius: 12px; }
  .project-explorer__header, .project-explorer__create { padding-left: 16px; padding-right: 16px; }
  .project-explorer__controls { padding-left: 16px; padding-right: 16px; }
  .project-explorer__scroll { padding-left: 16px; padding-right: 16px; }
  .project-explorer__footer { align-items: flex-start; padding: 12px 16px; }
  .project-explorer__items.is-grid { grid-template-columns: minmax(0, 1fr); }
  .project-explorer__items.is-list .project-card { align-items: flex-start; flex-direction: column; }
  .project-explorer__items.is-list .project-card__actions { width: 100%; }
}
</style>
