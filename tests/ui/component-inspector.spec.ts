import { mount } from '@vue/test-utils';
import { defineComponent, h, ref, shallowRef } from 'vue';
import { describe, expect, it } from 'vitest';
import InspectorPanel from '../../src/ui/components/InspectorPanel.vue';
import { applyBatch, createDocument, createNodeBase } from '../../src/domain';
import type { ComponentInstanceNode, DesignDocument, Operation, PropertyMutation } from '../../src/domain/types';

function componentDocument(): DesignDocument {
  const document = createDocument('Component inspector');
  const instance: ComponentInstanceNode = {
    ...createNodeBase('button-instance', 'Action'), kind: 'component-instance', componentId: 'button', variantId: 'primary',
    propertyOverrides: { label: 'Continue' }, nodeOverrides: {}, slotChildren: {},
  };
  document.nodes[instance.id] = instance;
  document.pages.page_1!.rootNodeIds.push(instance.id);
  return document;
}

describe('component instance inspector feedback', () => {
  it('shows actionable spacing validation without submitting a silent invalid edit', async () => {
    const document = componentDocument();
    const before = structuredClone(document);
    const wrapper = mount(InspectorPanel, { props: { document, nodeId: 'button-instance' } });
    await wrapper.get('input[aria-label="Gap in pixels"]').setValue('-1');
    expect(wrapper.get('[role="alert"]').text()).toContain('non-negative');
    expect(wrapper.emitted('layout')).toBeUndefined();
    expect(document).toEqual(before);
    await wrapper.get('input[aria-label="Gap in pixels"]').setValue('8');
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    expect(wrapper.emitted('layout')).toHaveLength(1);
  });
  it('shows parent rejection feedback and retains the last committed variant', async () => {
    const Harness = defineComponent({
      setup() {
        const document = shallowRef(componentDocument());
        const error = ref('');
        let sequence = 0;
        function onProperty(nodeId: string, change: PropertyMutation) {
          const operation: Operation = { type: 'property.set', nodeId, change };
          const result = applyBatch(document.value, {
            id: `inspector-${++sequence}`, documentId: document.value.id, expectedRevision: document.value.revision,
            source: 'inspector', capabilitySet: ['property.set'], operations: [operation],
          }, []);
          if (result.status === 'rejected') error.value = result.diagnostics.map(issue => issue.message).join(' ');
          else { document.value = result.document; error.value = ''; }
        }
        return () => h('div', [
          h(InspectorPanel, { document: document.value, nodeId: 'button-instance', onProperty }),
          error.value ? h('output', { role: 'alert' }, error.value) : null,
          h('output', { 'data-test': 'committed-variant' }, document.value.nodes['button-instance']?.kind === 'component-instance' ? document.value.nodes['button-instance'].variantId : ''),
        ]);
      },
    });
    const wrapper = mount(Harness);
    const variant = wrapper.get('[aria-label="Component variant"]');
    await variant.setValue('not-a-variant');

    expect(wrapper.get('[role="alert"]').text()).toContain('variant');
    expect(wrapper.get('[data-test="committed-variant"]').text()).toBe('primary');
    expect((wrapper.get('[aria-label="Component variant"]').element as HTMLInputElement).value).toBe('primary');
  });
});
