<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { DesignDocument, Layout, NodeId, PropertyMutation, PropertyValue, SemanticStyle, Sizing } from '../../domain/types';
import { resolveColor, resolveMeasure } from '../rendering';

const props = defineProps<{ document: DesignDocument; nodeId: NodeId | null }>();
const emit = defineEmits<{
  property: [nodeId: NodeId, change: PropertyMutation];
  layout: [nodeId: NodeId, value: Layout];
  style: [nodeId: NodeId, value: SemanticStyle];
}>();
const node = computed(() => (props.nodeId ? props.document.nodes[props.nodeId] ?? null : null));
const fieldError = ref('');
watch(() => props.nodeId, () => { fieldError.value = ''; });
const component = computed(() => node.value?.kind === 'component-instance' ? props.document.components[node.value.componentId] : undefined);
function propertyValue(key: string): PropertyValue | undefined {
  const instance = node.value;
  if (instance?.kind !== 'component-instance') return undefined;
  if (Object.hasOwn(instance.propertyOverrides, key)) return instance.propertyOverrides[key];
  const overrides = component.value?.variants[instance.variantId]?.propertyOverrides;
  return overrides && Object.hasOwn(overrides, key) ? overrides[key] : component.value?.properties[key]?.defaultValue;
}
function updateComponentProperty(key: string, value: PropertyValue) {
  if (node.value?.kind === 'component-instance') updateProperty({ property: 'propertyOverrides', value: { ...node.value.propertyOverrides, [key]: value } });
}
function updateVariant(event: Event) {
  const input = event.target as HTMLInputElement;
  const instance = node.value;
  if (instance?.kind !== 'component-instance') return;
  updateProperty({ property: 'variantId', value: input.value });
  input.value = instance.variantId;
}
const fill = computed(() => {
  const value = node.value?.style.fill;
  const color = resolveColor(props.document, value, '#ffffff');
  return /^#[\da-f]{6}$/i.test(color) ? color : '#ffffff';
});
function pixel(sizing: Sizing): number | '' {
  if (sizing.kind !== 'fixed') return '';
  return resolveMeasure(props.document, sizing.value);
}
function updateProperty(change: PropertyMutation) {
  fieldError.value = '';
  if (node.value) emit('property', node.value.id, change);
}
function updateLayout(patch: Partial<Layout>) {
  fieldError.value = '';
  if (node.value) emit('layout', node.value.id, { ...node.value.layout, ...patch });
}
function updateSizing(axis: 'width' | 'height', mode: string, raw: string | number) {
  if (!node.value) return;
  const current = node.value.layout[axis];
  let sizing: Sizing;
  if (mode === 'fixed') {
    const value = Number(raw);
    if (raw === '' || !Number.isFinite(value) || value < 0) { fieldError.value = 'Enter a non-negative dimension in pixels, or choose Hug or Fill.'; return; }
    sizing = { kind: 'fixed', value: { kind: 'literal', value, unit: 'px' } };
  } else if (mode === 'fill') {
    sizing = { kind: 'fill', ...(current.kind !== 'fixed' && current.min ? { min: current.min } : {}), ...(current.kind !== 'fixed' && current.max ? { max: current.max } : {}) };
  } else {
    sizing = { kind: 'hug', ...(current.kind !== 'fixed' && current.min ? { min: current.min } : {}), ...(current.kind !== 'fixed' && current.max ? { max: current.max } : {}) };
  }
  updateLayout({ [axis]: sizing });
}
function updateMeasure(key: 'gap' | 'paddingTop' | 'paddingRight' | 'paddingBottom' | 'paddingLeft', raw: string | number) {
  if (!node.value) return;
  const value = Number(raw);
  if (raw === '' || !Number.isFinite(value) || value < 0) { fieldError.value = 'Spacing must be a non-negative number of pixels.'; return; }
  const measure = { kind: 'literal' as const, value, unit: 'px' as const };
  if (key === 'gap') updateLayout({ gap: measure });
  else {
    const side = key.slice('padding'.length).toLowerCase() as 'top' | 'right' | 'bottom' | 'left';
    updateLayout({ padding: { ...node.value.layout.padding, [side]: measure } });
  }
}
function updateFill(value: string) {
  if (!node.value) return;
  if (!/^#[\da-f]{6}$/i.test(value)) { fieldError.value = 'Enter a six-digit hexadecimal color.'; return; }
  fieldError.value = '';
  const fillStyle = { kind: 'literal' as const, value: value as `#${string}` };
  emit('style', node.value.id, { ...node.value.style, fill: fillStyle });
}
function updateRadius(event: Event) {
  const selected = node.value;
  if (!selected?.style.radius) return;
  const value = Number((event.target as HTMLInputElement).value);
  if (!Number.isFinite(value) || value < 0) { fieldError.value = 'Radius must be a non-negative number of pixels.'; return; }
  fieldError.value = '';
  emit('style', selected.id, { ...selected.style, radius: { kind: 'literal', value, unit: 'px' } });
}
</script>

<template>
  <aside
    class="inspector"
    aria-label="Inspector"
  >
    <template v-if="node">
      <p
        v-if="fieldError"
        role="alert"
      >
        {{ fieldError }}
      </p>
      <div class="inspector__heading">
        <div>
          <div class="inspector__eyebrow">
            {{ node.kind.replace('-', ' ') }}
          </div>
          <h2>Properties</h2>
        </div>
        <span
          class="inspector__id"
          :title="node.id"
        >{{ node.id.slice(0, 8) }}</span>
      </div>
      <label class="inspector__field">
        <span>Name</span>
        <input
          :value="node.name"
          aria-label="Name"
          @change="updateProperty({ property: 'name', value: ($event.target as HTMLInputElement).value })"
        >
      </label>
      <label
        v-if="node.kind === 'text'"
        class="inspector__field"
      >
        <span>Content</span>
        <textarea
          :value="node.text"
          aria-label="Text content"
          rows="3"
          @change="updateProperty({ property: 'text', value: ($event.target as HTMLTextAreaElement).value })"
        />
      </label>

      <section
        v-if="node.kind === 'component-instance' && component"
        class="inspector__section"
        aria-label="Component properties"
      >
        <h3>Component</h3>
        <label class="inspector__field">
          <span>Variant</span>
          <input
            :value="node.variantId"
            aria-label="Component variant"
            @change="updateVariant"
          >
        </label>
        <label
          v-for="(definition, key) in component.properties"
          :key="key"
          class="inspector__field"
        >
          <span>{{ key }}</span>
          <input
            v-if="definition.type === 'string' || definition.type === 'number'"
            :type="definition.type === 'number' ? 'number' : 'text'"
            :value="propertyValue(String(key))"
            :aria-label="`Component property ${key}`"
            @change="updateComponentProperty(String(key), definition.type === 'number' ? Number(($event.target as HTMLInputElement).value) : ($event.target as HTMLInputElement).value)"
          >
          <input
            v-else-if="definition.type === 'boolean'"
            type="checkbox"
            :checked="propertyValue(String(key)) === true"
            :aria-label="`Component property ${key}`"
            @change="updateComponentProperty(String(key), ($event.target as HTMLInputElement).checked)"
          >
          <select
            v-else
            :value="typeof propertyValue(String(key)) === 'object' ? (propertyValue(String(key)) as { tokenId: string }).tokenId : ''"
            :aria-label="`Component property ${key}`"
            @change="updateComponentProperty(String(key), { kind: 'token', tokenId: ($event.target as HTMLSelectElement).value })"
          >
            <option value="">Choose token</option>
            <option
              v-for="token in Object.values(document.tokens).filter(token => !definition.constraints?.tokenCategory || token.category === definition.constraints.tokenCategory)"
              :key="token.id"
              :value="token.id"
            >{{ token.name }}</option>
          </select>
        </label>
      </section>

      <section
        class="inspector__section"
        aria-labelledby="layout-heading"
      >
        <h3 id="layout-heading">
          Layout
        </h3>
        <label class="inspector__field">
          <span>Direction</span>
          <select
            :value="node.layout.mode"
            aria-label="Layout direction"
            @change="updateLayout({ mode: ($event.target as HTMLSelectElement).value as Layout['mode'] })"
          >
            <option value="horizontal">Horizontal</option>
            <option value="vertical">Vertical</option>
            <option value="free">Free</option>
          </select>
        </label>
        <div class="inspector__pair">
          <label class="inspector__field">
            <span>Width</span>
            <select
              :value="node.layout.width.kind"
              aria-label="Width sizing"
              @change="updateSizing('width', ($event.target as HTMLSelectElement).value, pixel(node.layout.width))"
            >
              <option value="fixed">Fixed</option><option value="fill">Fill</option><option value="hug">Hug</option>
            </select>
          </label>
          <label class="inspector__field">
            <span>Height</span>
            <select
              :value="node.layout.height.kind"
              aria-label="Height sizing"
              @change="updateSizing('height', ($event.target as HTMLSelectElement).value, pixel(node.layout.height))"
            >
              <option value="fixed">Fixed</option><option value="fill">Fill</option><option value="hug">Hug</option>
            </select>
          </label>
        </div>
        <div class="inspector__pair">
          <label
            v-if="node.layout.width.kind === 'fixed'"
            class="inspector__field"
          >
            <span>Width · px</span>
            <input
              type="number"
              min="0"
              step="1"
              :value="pixel(node.layout.width)"
              aria-label="Width in pixels"
              @change="updateSizing('width', 'fixed', ($event.target as HTMLInputElement).value)"
            >
          </label>
          <label
            v-if="node.layout.height.kind === 'fixed'"
            class="inspector__field"
          >
            <span>Height · px</span>
            <input
              type="number"
              min="0"
              step="1"
              :value="pixel(node.layout.height)"
              aria-label="Height in pixels"
              @change="updateSizing('height', 'fixed', ($event.target as HTMLInputElement).value)"
            >
          </label>
        </div>
        <label class="inspector__field">
          <span>Gap · px</span>
          <input
            type="number"
            min="0"
            step="1"
            :value="resolveMeasure(document, node.layout.gap)"
            aria-label="Gap in pixels"
            @change="updateMeasure('gap', ($event.target as HTMLInputElement).value)"
          >
        </label>
        <div class="inspector__pair inspector__padding">
          <label
            v-for="side in ['top', 'right', 'bottom', 'left'] as const"
            :key="side"
            class="inspector__field"
          >
            <span>{{ side[0]?.toUpperCase() }} · px</span>
            <input
              type="number"
              min="0"
              step="1"
              :value="resolveMeasure(document, node.layout.padding[side])"
              :aria-label="`Padding ${side} in pixels`"
              @change="updateMeasure((`padding${side[0]?.toUpperCase()}${side.slice(1)}` as 'paddingTop' | 'paddingRight' | 'paddingBottom' | 'paddingLeft'), ($event.target as HTMLInputElement).value)"
            >
          </label>
        </div>
        <label class="inspector__field">
          <span>Align</span>
          <select
            :value="node.layout.align"
            aria-label="Align"
            @change="updateLayout({ align: ($event.target as HTMLSelectElement).value as Layout['align'] })"
          >
            <option value="start">Start</option><option value="center">Center</option><option value="end">End</option><option value="stretch">Stretch</option>
          </select>
        </label>
        <label class="inspector__field">
          <span>Justify</span>
          <select
            :value="node.layout.justify"
            aria-label="Justify"
            @change="updateLayout({ justify: ($event.target as HTMLSelectElement).value as Layout['justify'] })"
          >
            <option value="start">Start</option><option value="center">Center</option><option value="end">End</option><option value="space-between">Space between</option>
          </select>
        </label>
      </section>

      <section
        class="inspector__section"
        aria-labelledby="style-heading"
      >
        <h3 id="style-heading">
          Appearance
        </h3>
        <label class="inspector__field inspector__color">
          <span>Fill</span>
          <input
            type="color"
            :value="fill"
            aria-label="Fill color"
            @change="updateFill(($event.target as HTMLInputElement).value)"
          >
        </label>
        <label
          v-if="node.style.radius"
          class="inspector__field"
        >
          <span>Corner radius · px</span>
          <input
            type="number"
            min="0"
            step="1"
            :value="resolveMeasure(document, node.style.radius)"
            aria-label="Corner radius in pixels"
            @change="updateRadius"
          >
        </label>
      </section>

      <section
        v-if="node.kind === 'text'"
        class="inspector__section"
        aria-labelledby="type-heading"
      >
        <h3 id="type-heading">
          Typography
        </h3>
        <div class="inspector__read-only">
          {{ node.textStyle.typographyTokenId ?? `${node.textStyle.fontSize?.kind === 'literal' ? `${node.textStyle.fontSize.value}px` : 'Token-based'} · weight ${node.textStyle.weight ?? 'default'}` }}
        </div>
        <p class="inspector__hint">
          Typography editing is unavailable until its operation type is supported.
        </p>
      </section>
    </template>
    <div
      v-else
      class="inspector__empty"
    >
      <span
        class="inspector__empty-icon"
        aria-hidden="true"
      >◌</span>
      <h2>Nothing selected</h2>
      <p>Select a layer on the canvas to edit its semantic properties.</p>
    </div>
  </aside>
</template>

<style scoped>
.inspector {
  width: 272px;
  flex: 0 0 272px;
  height: 100%;
  overflow: auto;
  background: #1b1d24;
  border-left: 1px solid #30323b;
  color: #e1e3e9;
  padding: 16px 15px 28px;
  box-sizing: border-box;
}
.inspector__heading { display: flex; justify-content: space-between; align-items: start; margin-bottom: 18px; }
.inspector__eyebrow { color: #a8a6ff; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .09em; }
.inspector h2 { font-size: 14px; margin: 4px 0 0; font-weight: 600; }
.inspector__id { color: #838894; font: 10px ui-monospace, monospace; margin-top: 3px; }
.inspector__section { border-top: 1px solid #30323b; margin-top: 18px; padding-top: 14px; }
.inspector__section h3 { color: #aeb2bd; font-size: 11px; font-weight: 650; letter-spacing: .06em; text-transform: uppercase; margin: 0 0 12px; }
.inspector__field { display: grid; gap: 6px; margin-bottom: 11px; color: #aeb2bd; font-size: 11px; }
.inspector input:not([type=color]), .inspector select, .inspector textarea {
  width: 100%; min-width: 0; box-sizing: border-box; border: 1px solid #383b45; border-radius: 5px;
  padding: 7px 8px; color: #e8e9ed; background: #23252d; font: inherit; font-size: 12px; outline: none;
}
.inspector input:focus, .inspector select:focus, .inspector textarea:focus { border-color: #8383ff; box-shadow: 0 0 0 2px rgb(131 131 255 / 16%); }
.inspector__pair { display: grid; grid-template-columns: 1fr 1fr; gap: 9px; }
.inspector__padding { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.inspector__color { grid-template-columns: 1fr auto; align-items: center; }
.inspector__color input { width: 42px; height: 28px; border: 1px solid #383b45; border-radius: 5px; background: #23252d; padding: 3px; }
.inspector__read-only { border: 1px solid #333640; background: #22242b; border-radius: 5px; color: #c6c9d2; padding: 8px; font-size: 11px; }
.inspector__hint { color: #858a97; font-size: 10px; line-height: 1.5; margin: 7px 0 0; }
.inspector__empty { height: 100%; display: flex; flex-direction: column; justify-content: center; align-items: center; text-align: center; color: #9da1ac; padding: 0 14px; }
.inspector__empty h2 { color: #dddfe5; }
.inspector__empty p { font-size: 12px; line-height: 1.5; }
.inspector__empty-icon { font-size: 30px; color: #777b88; }
</style>
