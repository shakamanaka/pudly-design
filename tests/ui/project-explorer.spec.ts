import { DOMWrapper, flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDocument, createNodeBase } from '../../src/domain/defaults';
import type { PersistedProjectEnvelope, TextNode } from '../../src/domain/types';
import ProjectExplorer from '../../src/ui/components/ProjectExplorer.vue';
import { localApi, type ProjectSummary } from '../../src/ui/services/local-api';

const timestamp = '2026-10-10T12:00:00.000Z';
function envelope(name = 'Saved design'): PersistedProjectEnvelope {
  return {
    formatVersion: 1,
    document: { ...createDocument(name, 'project-1'), revision: 2 },
    history: { undoableEntries: [], cursor: 0, auditTransitions: [], snapshots: [] },
    appliedBatchIds: [], integrityHash: 'hash',
  };
}
function summary(overrides: Partial<ProjectSummary> = {}): ProjectSummary {
  return { id: 'project-1', name: 'Saved design', revision: 2, updatedAt: timestamp, nodeCount: 3, status: 'available', ...overrides };
}
function setup(items: ProjectSummary[] = []) {
  vi.spyOn(localApi, 'listProjects').mockResolvedValue({ projects: items });
  return mount(ProjectExplorer, { props: { currentProjectId: null, lifecycleLocked: false } });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('project explorer', () => {
  it('opens an accessible library and explains when no projects have been saved', async () => {
    const wrapper = setup();
    await wrapper.get('button[aria-haspopup="dialog"]').trigger('click');
    await flushPromises();

    expect(document.body.querySelector('[role="dialog"]')?.getAttribute('aria-labelledby')).toBe('project-explorer-title');
    expect(document.body.textContent).toContain('No saved projects yet');
    expect(localApi.listProjects).toHaveBeenCalledOnce();
    wrapper.unmount();
  });

  it('creates a named project and emits its saved envelope without a generation request', async () => {
    const created = envelope('Marketing dashboard');
    const create = vi.spyOn(localApi, 'createProject').mockResolvedValue({ project: created });
    const startRun = vi.spyOn(localApi, 'startRun');
    const wrapper = setup();
    await wrapper.get('button[aria-haspopup="dialog"]').trigger('click');
    await flushPromises();
    const nameInput = new DOMWrapper(document.body.querySelector('#new-project-name') as HTMLInputElement);
    await nameInput.setValue('Marketing dashboard');
    await new DOMWrapper(document.body.querySelector('.project-explorer__create') as HTMLFormElement).trigger('submit');
    await flushPromises();

    expect(create).toHaveBeenCalledWith('Marketing dashboard');
    expect(wrapper.emitted('opened')).toEqual([[created]]);
    expect(startRun).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('opens an available saved project and leaves an unavailable project explicit', async () => {
    const saved = envelope();
    vi.spyOn(localApi, 'getProjectPreview').mockResolvedValue({ document: saved.document });
    const open = vi.spyOn(localApi, 'openProject').mockResolvedValue({ project: saved });
    const wrapper = setup([
      summary(),
      summary({ id: 'damaged', name: 'Damaged file', status: 'unavailable', diagnostic: 'Saved data failed validation.' }),
    ]);
    await wrapper.get('button[aria-haspopup="dialog"]').trigger('click');
    await flushPromises();

    expect(document.body.textContent).toContain('Unavailable');
    const cards = Array.from(document.body.querySelectorAll('.project-card'));
    expect(cards).toHaveLength(2);
    expect(cards[1]?.textContent).toContain('Saved data failed validation.');
    const openButton = cards[0]?.querySelector('button.is-open') as HTMLButtonElement;
    openButton.click();
    await flushPromises();
    expect(open).toHaveBeenCalledWith('project-1');
    expect(wrapper.emitted('opened')).toEqual([[saved]]);
    wrapper.unmount();
  });

  it('reloads saved previews each time the library is opened', async () => {
    const preview = vi.spyOn(localApi, 'getProjectPreview').mockResolvedValue({ document: envelope().document });
    const wrapper = setup([summary()]);
    await wrapper.get('button[aria-haspopup="dialog"]').trigger('click');
    await flushPromises();
    expect(preview).toHaveBeenCalledTimes(1);

    const close = new DOMWrapper(document.body.querySelector('[aria-label="Close project explorer"]') as HTMLButtonElement);
    await close.trigger('click');
    await wrapper.get('button[aria-haspopup="dialog"]').trigger('click');
    await flushPromises();
    expect(preview).toHaveBeenCalledTimes(2);
    wrapper.unmount();
  });

  it('fits the saved canvas to the measured preview width and tracks responsive card resizing', async () => {
    vi.stubGlobal('ResizeObserver', undefined);
    let previewWidth = 360;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function getRect(this: HTMLElement) {
      const width = this.classList.contains('project-card__preview-wrap') ? previewWidth : 0;
      return { x: 0, y: 0, left: 0, top: 0, right: width, bottom: 0, width, height: 0, toJSON: () => ({}) };
    });
    const previewDocument = createDocument('Responsive thumbnail', 'project-1');
    const text: TextNode = {
      ...createNodeBase('headline', 'Headline'), kind: 'text', text: 'Saved first page',
      textStyle: { fontSize: { kind: 'literal', value: 24, unit: 'px' } },
    };
    previewDocument.nodes[text.id] = text;
    previewDocument.pages.page_1?.rootNodeIds.push(text.id);
    vi.spyOn(localApi, 'getProjectPreview').mockResolvedValue({ document: previewDocument });
    const wrapper = setup([summary()]);
    await wrapper.get('button[aria-haspopup="dialog"]').trigger('click');
    await flushPromises();

    const artboard = document.body.querySelector('.project-card__artboard') as HTMLElement;
    expect(artboard.style.getPropertyValue('--preview-scale')).toBe('0.25');
    previewWidth = 720;
    window.dispatchEvent(new Event('resize'));
    await flushPromises();
    expect(artboard.style.getPropertyValue('--preview-scale')).toBe('0.5');
    wrapper.unmount();
  });

  it('requires named confirmation before removal and leaves the card when the request fails', async () => {
    vi.spyOn(localApi, 'deleteProject').mockRejectedValue(new Error('Storage is read-only.'));
    const wrapper = setup([summary()]);
    await wrapper.get('button[aria-haspopup="dialog"]').trigger('click');
    await flushPromises();

    const remove = document.body.querySelector('.project-card__actions .is-remove') as HTMLButtonElement;
    remove.click();
    await flushPromises();
    expect(document.body.textContent).toContain('Move Saved design to local trash?');
    expect(document.body.querySelector('[aria-label="Confirm removal of Saved design"]')).toBeTruthy();
    const confirm = document.body.querySelector('.project-card__confirm .is-danger') as HTMLButtonElement;
    confirm.click();
    await flushPromises();

    expect(document.body.querySelectorAll('.project-card')).toHaveLength(1);
    expect(document.body.textContent).toContain('Could not remove “Saved design”: Storage is read-only.');
    expect(wrapper.emitted('deleted')).toBeUndefined();
    wrapper.unmount();
  });

  it('blocks project lifecycle actions while the current run is active', async () => {
    const open = vi.spyOn(localApi, 'openProject');
    vi.spyOn(localApi, 'getProjectPreview').mockResolvedValue({ document: envelope().document });
    const wrapper = mount(ProjectExplorer, { props: { currentProjectId: null, lifecycleLocked: true } });
    vi.spyOn(localApi, 'listProjects').mockResolvedValue({ projects: [summary()] });
    await wrapper.get('button[aria-haspopup="dialog"]').trigger('click');
    await flushPromises();
    expect((document.body.querySelector('#new-project-name') as HTMLInputElement).disabled).toBe(true);
    expect((document.body.querySelector('.project-card__actions .is-open') as HTMLButtonElement).disabled).toBe(true);
    expect(open).not.toHaveBeenCalled();
    wrapper.unmount();
  });
});
