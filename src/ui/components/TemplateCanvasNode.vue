<script setup lang="ts" name="TemplateCanvasNode">
import { computed } from 'vue';
import type { ComponentInstanceNode, DesignDocument, Layout, NodeId, ResolvedComponentInstance } from '../../domain/types';
import { nodeStyle, resolveTemplateNode } from '../rendering';
import CanvasNode from './CanvasNode.vue';

const props = defineProps<{
  document: DesignDocument;
  instance: ComponentInstanceNode;
  resolvedComponent: ResolvedComponentInstance;
  templateNodeId: string;
  viewportWidth: number;
  selectedNodeIds: ReadonlySet<NodeId>;
  parentLayout: Layout | null;
}>();
const emit = defineEmits<{ select: [nodeId: NodeId, additive: boolean] }>();

const resolved = computed(() => resolveTemplateNode(
  props.document,
  props.instance,
  props.resolvedComponent,
  props.templateNodeId,
  props.viewportWidth,
));
const node = computed(() => resolved.value?.node ?? null);
const style = computed(() => {
  if (!resolved.value) return {};
  const result = nodeStyle(props.document, resolved.value, props.parentLayout);
  if (props.templateNodeId === props.resolvedComponent.definition.rootTemplateNodeId) {
    result.position = 'relative';
    result.left = undefined;
    result.top = undefined;
    result.transform = undefined;
    if (props.parentLayout?.width.kind !== 'hug') result.width = '100%';
    if (props.parentLayout?.height.kind !== 'hug') result.height = '100%';
  }
  return result;
});
const childTemplateIds = computed(() => node.value && ['frame', 'group'].includes(node.value.kind) ? node.value.childIds : []);
const slotsAtAnchor = computed(() => Object.values(props.resolvedComponent.definition.slots)
  .filter((slot) => slot.templateAnchorNodeId === props.templateNodeId));

function selectSlotChild(id: NodeId, additive: boolean) {
  emit('select', id, additive);
}
</script>

<template>
  <article
    v-if="resolved?.visible && node"
    class="canvas-template-node"
    :class="[`is-${node.kind}`, { 'is-empty': ['frame', 'group'].includes(node.kind) && childTemplateIds.length === 0 }]"
    :data-render-id="`${instance.id}::${templateNodeId}`"
    :data-instance-id="instance.id"
    :data-template-node-id="templateNodeId"
    :data-node-kind="node.kind"
    :style="style"
  >
    <template v-if="node.kind === 'frame' || node.kind === 'group'">
      <span
        v-if="childTemplateIds.length === 0"
        class="canvas-node__empty"
      >{{ node.name }}</span>
      <TemplateCanvasNode
        v-for="childId in childTemplateIds"
        :key="childId"
        :document="document"
        :instance="instance"
        :resolved-component="resolvedComponent"
        :template-node-id="childId"
        :viewport-width="viewportWidth"
        :selected-node-ids="selectedNodeIds"
        :parent-layout="resolved.layout"
        @select="selectSlotChild"
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

    <template
      v-for="slot in slotsAtAnchor"
      :key="slot.id"
    >
      <CanvasNode
        v-for="childId in instance.slotChildren[slot.id] ?? []"
        :key="childId"
        :document="document"
        :node-id="childId"
        :viewport-width="viewportWidth"
        :selected-node-ids="selectedNodeIds"
        :parent-layout="resolved.layout"
        @select="selectSlotChild"
      />
    </template>
  </article>
</template>

<style scoped>
.canvas-template-node {
  box-sizing: border-box;
  min-width: 0;
  max-width: 100%;
}
.canvas-template-node.is-frame,
.canvas-template-node.is-group {
  flex-shrink: 0;
}
.canvas-template-node.is-empty {
  outline: 1px dashed rgb(130 136 148 / 40%);
}
.canvas-template-node .canvas-node__empty {
  display: block;
  color: #8b91a0;
  font-size: 12px;
  padding: 8px;
}
.canvas-template-node .canvas-node__text {
  display: block;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.canvas-template-node .canvas-node__media,
.canvas-template-node .canvas-node__icon {
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
.canvas-template-node .canvas-node__media-icon,
.canvas-template-node .canvas-node__icon > span {
  font-size: 20px;
  color: #9096a3;
}
.canvas-template-node .canvas-node__icon {
  flex-direction: column;
}
.canvas-template-node .canvas-node__vector {
  display: block;
  width: 100%;
  height: 100%;
}
</style>
