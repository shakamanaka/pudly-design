<script setup lang="ts">
import { computed } from 'vue';
import type { DesignDocument, Layout, NodeId } from '../../domain/types';
import { nodeStyle, parentLayoutFor, resolveComponent, resolveNode } from '../rendering';
import TemplateCanvasNode from './TemplateCanvasNode.vue';

const props = defineProps<{
  document: DesignDocument;
  nodeId: NodeId;
  viewportWidth: number;
  selectedNodeIds: ReadonlySet<NodeId>;
  parentLayout?: Layout | null;
}>();
const emit = defineEmits<{ select: [nodeId: NodeId, additive: boolean] }>();
const resolved = computed(() => resolveNode(props.document, props.nodeId, props.viewportWidth));
const selected = computed(() => props.selectedNodeIds.has(props.nodeId));
const style = computed(() => {
  if (!resolved.value) return {};
  const result = nodeStyle(
    props.document,
    resolved.value,
    props.parentLayout === undefined ? parentLayoutFor(props.document, props.nodeId) : props.parentLayout,
  );
  if (resolved.value.node.kind === 'component-instance') {
    result.display = 'block';
    result.padding = '0';
    result.gap = '0';
    result.backgroundColor = 'transparent';
    result.boxShadow = 'none';
  }
  return result;
});
const node = computed(() => resolved.value?.node ?? null);
const accessibleName = computed(() => node.value?.kind === 'text' && node.value.text.trim() ? node.value.text : `${node.value?.kind}: ${node.value?.name}`);
const accessibleDescription = computed(() => node.value?.kind === 'text' && node.value.text.trim() ? `text: ${node.value.name}` : undefined);
const resolvedComponent = computed(() => node.value?.kind === 'component-instance' ? resolveComponent(props.document, node.value) : null);
function select(event: MouseEvent | KeyboardEvent) {
  const id = node.value?.id;
  if (id) emit('select', id, event instanceof MouseEvent && (event.shiftKey || event.metaKey || event.ctrlKey));
}
</script>

<template>
  <article
    v-if="resolved?.visible && node"
    class="canvas-node"
    :class="[`is-${node.kind}`, { 'is-selected': selected, 'is-empty': ['frame', 'group'].includes(node.kind) && node.childIds.length === 0 }]"
    :data-node-id="node.id"
    :data-node-kind="node.kind"
    :aria-label="accessibleName"
    :aria-description="accessibleDescription"
    :aria-pressed="selected"
    role="button"
    tabindex="0"
    :style="style"
    @click.stop="select"
    @keydown.enter.stop.prevent="select"
    @keydown.space.stop.prevent="select"
  >
    <template v-if="node.kind === 'frame' || node.kind === 'group'">
      <span
        v-if="node.childIds.length === 0 && selected"
        aria-hidden="true"
        class="canvas-node__empty"
      >{{ node.name }}</span>
      <CanvasNode
        v-for="childId in node.childIds"
        :key="childId"
        :document="document"
        :node-id="childId"
        :viewport-width="viewportWidth"
        :selected-node-ids="selectedNodeIds"
        :parent-layout="resolved.layout"
        @select="(id, additive) => emit('select', id, additive)"
      />
    </template>
    <template v-else-if="node.kind === 'text'">
      <span class="canvas-node__text">{{ node.text }}</span>
    </template>
    <template v-else-if="node.kind === 'image'">
      <div
        class="canvas-node__media"
        role="img"
        :aria-label="node.name"
      >
        <span
          class="canvas-node__media-icon"
          aria-hidden="true"
        >▧</span>
        <span>{{ node.name || 'Image asset' }}</span>
      </div>
    </template>
    <template v-else-if="node.kind === 'icon'">
      <div
        class="canvas-node__icon"
        :aria-label="`${node.libraryId}: ${node.iconName}`"
        role="img"
      >
        <span aria-hidden="true">◇</span>
        <small>{{ node.iconName }}</small>
      </div>
    </template>
    <template v-else-if="node.kind === 'vector'">
      <svg
        class="canvas-node__vector"
        :viewBox="node.viewBox.join(' ')"
        aria-hidden="true"
      >
        <path
          :d="node.pathData"
          fill="currentColor"
        />
      </svg>
    </template>
    <template v-else-if="node.kind === 'component-instance'">
      <TemplateCanvasNode
        v-if="resolvedComponent"
        :document="document"
        :instance="node"
        :resolved-component="resolvedComponent"
        :template-node-id="resolvedComponent.definition.rootTemplateNodeId"
        :viewport-width="viewportWidth"
        :selected-node-ids="selectedNodeIds"
        :parent-layout="resolved.layout"
        @select="(id, additive) => emit('select', id, additive)"
      />
      <span
        v-else
        class="canvas-node__missing-component"
      >Unresolved component</span>
    </template>
  </article>
</template>

<style scoped>
.canvas-node {
  min-width: 0;
  max-width: 100%;
  outline: none;
  cursor: default;
  transition: box-shadow 100ms ease, outline-color 100ms ease;
}
.canvas-node.is-frame,
.canvas-node.is-group,
.canvas-node.is-component-instance {
  flex-shrink: 0;
}
.canvas-node:hover {
  outline: 1px solid rgb(111 116 255 / 65%);
  outline-offset: 1px;
}
.canvas-node.is-selected {
  outline: 2px solid #7777ff;
  outline-offset: 2px;
  z-index: 2;
}
.canvas-node__empty {
  display: block;
  color: #8b91a0;
  font-size: 12px;
  padding: 8px;
}
.canvas-node__text {
  display: block;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.canvas-node__media,
.canvas-node__icon {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  width: 100%;
  height: 100%;
  min-height: 40px;
  color: #747985;
  background: linear-gradient(135deg, #eceef2, #f8f9fb);
  font-size: 12px;
}
.canvas-node__media-icon,
.canvas-node__icon > span,
.canvas-node__component-label > span:first-child {
  font-size: 20px;
  color: #9096a3;
}
.canvas-node__icon {
  flex-direction: column;
}
.canvas-node__vector {
  display: block;
  width: 100%;
  height: 100%;
}
.canvas-node__missing-component {
  display: block;
  min-width: 100px;
  min-height: 42px;
  padding: 8px;
  color: #9a3341;
  background: #fff0f2;
  font-size: 11px;
}
</style>
