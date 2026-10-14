<script setup lang="ts">
import { computed, ref } from 'vue';
import type { DesignDocument, NodeId } from '../../domain/types';

const props = defineProps<{
  document: DesignDocument;
  nodeId: NodeId;
  selectedNodeIds: ReadonlySet<NodeId>;
  depth: number;
}>();
const emit = defineEmits<{
  select: [nodeId: NodeId, additive: boolean];
  toggleVisibility: [nodeId: NodeId, visible: boolean];
}>();
const node = computed(() => props.document.nodes[props.nodeId]);
const expanded = ref(true);
const selected = computed(() => props.selectedNodeIds.has(props.nodeId));
const hasChildren = computed(() => !!node.value && node.value.childIds.length > 0);
function select(event: MouseEvent) {
  emit('select', props.nodeId, event.shiftKey || event.metaKey || event.ctrlKey);
}
</script>

<template>
  <li
    v-if="node"
    class="layer-tree__item"
    role="treeitem"
    :aria-selected="selected"
  >
    <div
      class="layer-tree__row"
      :class="{ 'is-selected': selected }"
      :style="{ '--depth': depth }"
    >
      <button
        v-if="hasChildren"
        class="layer-tree__disclose"
        type="button"
        :aria-label="`${expanded ? 'Collapse' : 'Expand'} ${node.name}`"
        :aria-expanded="expanded"
        @click="expanded = !expanded"
      >
        {{ expanded ? '⌄' : '›' }}
      </button>
      <span
        v-else
        class="layer-tree__disclose-spacer"
      />
      <button
        class="layer-tree__select"
        type="button"
        @click="select"
      >
        <span
          class="layer-tree__kind"
          aria-hidden="true"
        >{{ { frame: '▣', group: '▧', text: 'T', image: '▧', icon: '◇', vector: '⌁', 'component-instance': '▤' }[node.kind] }}</span>
        <span class="layer-tree__name">{{ node.name }}</span>
      </button>
      <button
        class="layer-tree__visibility"
        type="button"
        :aria-label="`${node.visible ? 'Hide' : 'Show'} ${node.name}`"
        :aria-pressed="node.visible"
        @click="emit('toggleVisibility', node.id, !node.visible)"
      >
        {{ node.visible ? '◉' : '○' }}
      </button>
    </div>
    <ul
      v-if="hasChildren && expanded"
      class="layer-tree__children"
      role="group"
    >
      <LayerTreeNode
        v-for="childId in node.childIds"
        :key="childId"
        :document="document"
        :node-id="childId"
        :selected-node-ids="selectedNodeIds"
        :depth="depth + 1"
        @select="(id, additive) => emit('select', id, additive)"
        @toggle-visibility="(id, visible) => emit('toggleVisibility', id, visible)"
      />
    </ul>
  </li>
</template>

<style scoped>
.layer-tree__item { list-style: none; }
.layer-tree__row {
  height: 32px;
  display: flex;
  align-items: center;
  gap: 4px;
  padding-left: calc(var(--depth) * 14px);
  border-radius: 5px;
  color: #c6c9d2;
}
.layer-tree__row:hover { background: #282b34; }
.layer-tree__row.is-selected { color: #fff; background: #33364a; }
.layer-tree__disclose,
.layer-tree__disclose-spacer,
.layer-tree__visibility {
  flex: 0 0 22px;
  width: 22px;
  height: 24px;
  display: grid;
  place-items: center;
  color: #8e93a1;
  border: 0;
  background: transparent;
}
.layer-tree__disclose { cursor: pointer; }
.layer-tree__select {
  min-width: 0;
  flex: 1;
  display: flex;
  align-items: center;
  gap: 8px;
  text-align: left;
  color: inherit;
  border: 0;
  padding: 0;
  background: transparent;
  cursor: pointer;
}
.layer-tree__kind { width: 16px; text-align: center; color: #a2a6b2; font-size: 12px; }
.layer-tree__name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.layer-tree__visibility { cursor: pointer; opacity: 0; }
.layer-tree__row:hover .layer-tree__visibility,
.layer-tree__visibility:focus-visible { opacity: 1; }
.layer-tree__children { margin: 0; padding: 0; }
</style>
