<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import {
  PROVIDER_AUTH_SOURCES,
  PROVIDER_EFFORTS,
  credentialRequired,
  type ProviderAuthSource,
  type ProviderConnectionInput,
  type ProviderConnectionView,
  type ProviderCatalog,
  type ProviderEffort,
  type ProviderId,
  type ProviderSelection,
} from '../../domain/providers';
import { LocalApiError, localApi } from '../services/local-api';

const props = defineProps<{ disabled?: boolean }>();
const emit = defineEmits<{
  selection: [selection: ProviderSelection | null];
  configured: [configured: boolean];
}>();

const providerLabels: Record<ProviderId, string> = {
  codex: 'Codex CLI',
  claude: 'Claude Code',
  minimax: 'MiniMax',
};
const authLabels: Record<ProviderAuthSource, string> = {
  chatgpt: 'This device’s current ChatGPT CLI account',
  'openai-api-key': 'OpenAI API key',
  'claude-subscription': 'This device’s current Claude Code account',
  'anthropic-api-key': 'Anthropic API key',
  'minimax-api-key': 'MiniMax API key',
  'minimax-token-plan': 'MiniMax token plan',
};
const effortLabels: Record<ProviderEffort, string> = {
  none: 'None', minimal: 'Minimal', ultra: 'Ultra', default: 'Default', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max',
};

const connections = ref<ProviderConnectionView[]>([]);
const catalogs = ref<ProviderCatalog[]>([]);
const cleanupPending = ref(false);
const loading = ref(true);
const saving = ref(false);
const verifying = ref(false);
const error = ref('');
const notice = ref('');
const selectedConnectionId = ref('');
const selectedProvider = ref<ProviderId>('codex');
const selectedAuthSource = ref<ProviderAuthSource>('chatgpt');
const label = ref('');
const credential = ref('');
const modelId = ref('');
const manualModelOpen = ref(false);
const effort = ref<ProviderEffort>('low');

const selectedConnection = computed(() => connections.value.find(connection => connection.id === selectedConnectionId.value) ?? null);
const providerSources = computed(() => PROVIDER_AUTH_SOURCES[selectedProvider.value]);
const models = computed(() => {
  if (!selectedConnection.value) return [];
  const connectionModels = selectedConnection.value.capabilities.models;
  return connectionModels.length > 0
    ? connectionModels
    : catalogs.value.find(catalog => catalog.providerId === selectedConnection.value?.providerId)?.models ?? [];
});
const selectedModel = computed(() => models.value.find(model => model.id === modelId.value) ?? null);
const allowedEfforts = computed<readonly ProviderEffort[]>(() => {
  if (selectedModel.value) return selectedModel.value.supportedEfforts;
  const provider = selectedConnection.value?.providerId ?? selectedProvider.value;
  return provider === 'minimax' ? ['default'] : provider === 'claude' ? ['default', 'low', 'medium', 'high', 'xhigh', 'max'] as ProviderEffort[] : PROVIDER_EFFORTS;
});
const modelVerified = computed(() => selectedConnection.value?.verificationStatus === 'verified'
  && selectedConnection.value.capabilities.models.find(model => model.id === modelId.value)?.availability === 'available'
  && selectedConnection.value.lastVerifiedSelection?.modelId === modelId.value
  && selectedConnection.value.lastVerifiedSelection?.effort === effort.value);
const effortVerified = computed(() => modelVerified.value && allowedEfforts.value.includes(effort.value));
const canSelect = computed(() => effortVerified.value);
const needsCredential = computed(() => credentialRequired(selectedAuthSource.value));

function chooseModel(value: string): void {
  if (value === '__custom__') {
    modelId.value = '';
    manualModelOpen.value = true;
  } else {
    modelId.value = value;
    manualModelOpen.value = false;
  }
}

function safeMessage(cause: unknown, sensitiveValue = ''): string {
  const message = cause instanceof Error ? cause.message : 'The connection request failed. Please try again.';
  return sensitiveValue ? message.replaceAll(sensitiveValue, '[redacted]') : message;
}

function clearSelection(): void {
  emit('selection', null);
}

function updateSelection(): void {
  if (!canSelect.value || !selectedConnection.value) {
    clearSelection();
    return;
  }
  emit('selection', { connectionId: selectedConnection.value.id, modelId: modelId.value, effort: effort.value });
}

async function reloadConnections(preferId?: string): Promise<void> {
  const previousConnectionId = selectedConnectionId.value;
  const previousModelId = modelId.value;
  const previousEffort = effort.value;
  const result = await localApi.listConnections();
  connections.value = result.connections;
  cleanupPending.value = result.cleanupPending === true;
  const preferred = preferId && connections.value.some(connection => connection.id === preferId)
    ? preferId
    : selectedConnectionId.value && connections.value.some(connection => connection.id === selectedConnectionId.value)
      ? selectedConnectionId.value
      : connections.value.find(connection => connection.providerId === 'codex' && connection.authSource === 'chatgpt')?.id
        ?? connections.value[0]?.id
        ?? '';
  selectedConnectionId.value = preferred;
  if (preferred) {
    const active = connections.value.find(connection => connection.id === preferred)!;
    const priorModel = active.capabilities.models.find(model => model.id === previousModelId);
    const verified = active.verificationStatus === 'verified' ? active.lastVerifiedSelection : undefined;
    const verifiedModel = verified && active.capabilities.models.find(model => model.id === verified.modelId);
    if (preferred === previousConnectionId && priorModel?.supportedEfforts.includes(previousEffort)) {
      modelId.value = previousModelId;
      effort.value = previousEffort;
    } else if (verified && verifiedModel && verifiedModel.supportedEfforts.includes(verified.effort)) {
      modelId.value = verified.modelId;
      effort.value = verified.effort;
    } else {
      const defaultModel = active.capabilities.models.find(model => model.id === 'sol' || model.id.endsWith('-sol'))
        ?? active.capabilities.models[0];
      modelId.value = defaultModel?.id ?? '';
      effort.value = defaultModel?.supportedEfforts.includes('low')
        ? 'low'
        : defaultModel?.supportedEfforts[0] ?? 'default';
    }
  } else {
    modelId.value = '';
  }
  updateSelection();
}

async function initialize(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const [, providerResult] = await Promise.all([reloadConnections(), localApi.getProviderCatalog()]);
    catalogs.value = providerResult.providers;
    emit('configured', true);
  } catch (cause) {
    emit('configured', !(cause instanceof LocalApiError && cause.status === 404));
    error.value = safeMessage(cause);
  } finally {
    loading.value = false;
  }
}

async function refreshModels(): Promise<void> {
  loading.value = true;
  error.value = '';
  try { await reloadConnections(selectedConnectionId.value); notice.value = 'Model catalog refreshed. Newly selected model and effort pairs still need verification.'; }
  catch (cause) { error.value = safeMessage(cause); }
  finally { loading.value = false; }
}

function changeProvider(value: string): void {
  selectedProvider.value = value as ProviderId;
  selectedAuthSource.value = PROVIDER_AUTH_SOURCES[selectedProvider.value][0]!;
  clearFormError();
}

function chooseConnection(value: string): void {
  const connection = connections.value.find(item => item.id === value);
  if (!connection) return;
  selectedConnectionId.value = connection.id;
  selectedProvider.value = connection.providerId;
  selectedAuthSource.value = connection.authSource;
  const verified = connection.verificationStatus === 'verified' ? connection.lastVerifiedSelection : undefined;
  const verifiedModel = verified && connection.capabilities.models.find(model => model.id === verified.modelId);
  const preferred = verified && verifiedModel && verifiedModel.supportedEfforts.includes(verified.effort)
    ? verifiedModel
    : connection.capabilities.models.find(model => model.id === 'sol' || model.id.endsWith('-sol')) ?? connection.capabilities.models[0];
  modelId.value = preferred?.id ?? '';
  effort.value = verified && verifiedModel?.id === preferred?.id
    ? verified.effort
    : preferred?.supportedEfforts.includes('low') ? 'low' : preferred?.supportedEfforts[0] ?? 'default';
}

function clearFormError(): void {
  error.value = '';
  notice.value = '';
}

async function createConnection(): Promise<void> {
  clearFormError();
  const cleanLabel = label.value.trim();
  if (!cleanLabel) { error.value = 'Enter a name for this connection.'; return; }
  if (needsCredential.value && !credential.value) { error.value = 'Enter the credential for this connection.'; return; }
  saving.value = true;
  const submittedCredential = credential.value;
  try {
    const input: ProviderConnectionInput = {
      providerId: selectedProvider.value,
      authSource: selectedAuthSource.value,
      label: cleanLabel,
      ...(submittedCredential ? { credential: submittedCredential } : {}),
    };
    const result = await localApi.createConnection(input);
    label.value = '';
    await reloadConnections(result.connection.id);
    notice.value = 'Connection saved. Verify it to check current access and model availability.';
  } catch (cause) {
    error.value = safeMessage(cause, submittedCredential);
  } finally {
    credential.value = '';
    saving.value = false;
  }
}

async function saveConnection(): Promise<void> {
  if (!selectedConnection.value) return;
  clearFormError();
  if (!label.value.trim() && !credential.value) { error.value = 'Enter a connection name or a replacement credential.'; return; }
  saving.value = true;
  const submittedCredential = credential.value;
  const connectionId = selectedConnection.value.id;
  try {
    await localApi.updateConnection(connectionId, {
      ...(label.value.trim() ? { label: label.value.trim() } : {}),
      ...(submittedCredential ? { credential: submittedCredential } : {}),
    });
    if (submittedCredential) {
      selectedConnectionId.value = '';
      modelId.value = '';
      clearSelection();
    }
    await reloadConnections(connectionId);
    label.value = '';
    notice.value = submittedCredential ? 'Connection updated. Verify it again before using it.' : 'Connection name updated.';
  } catch (cause) {
    error.value = safeMessage(cause, submittedCredential);
  } finally {
    credential.value = '';
    saving.value = false;
  }
}

async function removeConnection(): Promise<void> {
  if (!selectedConnection.value) return;
  clearFormError();
  saving.value = true;
  try {
    const removedId = selectedConnection.value.id;
    await localApi.deleteConnection(removedId);
    selectedConnectionId.value = '';
    clearSelection();
    await reloadConnections();
    notice.value = 'Connection removed.';
  } catch (cause) {
    error.value = safeMessage(cause);
  } finally {
    saving.value = false;
  }
}

async function verifyConnection(): Promise<void> {
  const connection = selectedConnection.value;
  if (!connection || !modelId.value || !allowedEfforts.value.includes(effort.value)) {
    error.value = 'Choose a known model and supported effort before verifying this connection.';
    clearSelection();
    return;
  }
  clearFormError();
  verifying.value = true;
  clearSelection();
  try {
    const result = await localApi.verifyConnection(connection.id, { modelId: modelId.value, effort: effort.value });
    connections.value = connections.value.map(item => item.id === result.connection.id ? result.connection : item);
    notice.value = result.connection.verificationStatus === 'verified'
      ? 'Connection verified for the selected model and effort.'
      : 'The connection could not verify the selected model and effort.';
    updateSelection();
  } catch (cause) {
    error.value = safeMessage(cause);
    // Verification persists its failure state on the server. Reflect it while
    // retaining the original error and independent local-session evidence.
    try { await reloadConnections(connection.id); } catch { /* Keep the verification error visible. */ }
  } finally {
    verifying.value = false;
  }
}

watch([selectedConnectionId, modelId, effort], () => {
  if (selectedModel.value && !allowedEfforts.value.includes(effort.value)) {
    const preferred = selectedModel.value.defaultEffort;
    effort.value = preferred && allowedEfforts.value.includes(preferred) ? preferred : allowedEfforts.value[0] ?? 'default';
  }
  if (selectedConnection.value && selectedConnection.value.providerId !== selectedProvider.value) {
    selectedProvider.value = selectedConnection.value.providerId;
    selectedAuthSource.value = selectedConnection.value.authSource;
  }
  updateSelection();
});
watch(() => props.disabled, updateSelection);
onMounted(initialize);
</script>

<template>
  <section
    class="provider-panel"
    aria-label="AI connection"
  >
    <div class="provider-panel__heading">
      <div>
        <p class="provider-panel__eyebrow">
          Generation
        </p>
        <h2>AI connection</h2>
      </div>
      <span
        v-if="loading"
        class="provider-panel__loading"
      >Loading</span>
    </div>

    <p
      v-if="cleanupPending"
      class="provider-panel__message"
      role="status"
    >
      Obsolete credential cleanup is pending. Reopen the application to retry cleanup. Existing run selections remain protected.
    </p>
    <p
      v-if="error"
      class="provider-panel__message is-error"
      role="alert"
    >
      {{ error }}
    </p>
    <p
      v-else-if="notice"
      class="provider-panel__message"
      role="status"
    >
      {{ notice }}
    </p>

    <label class="provider-panel__field">
      <span>Provider</span>
      <select
        :value="selectedConnection ? selectedConnection.id : selectedProvider"
        aria-label="Provider connection"
        :disabled="props.disabled || loading"
        @change="(event) => { const value = (event.target as HTMLSelectElement).value; if (connections.some(item => item.id === value)) chooseConnection(value); else { selectedConnectionId = ''; changeProvider(value); } }"
      >
        <option
          v-for="connection in connections"
          :key="connection.id"
          :value="connection.id"
        >{{ providerLabels[connection.providerId] }} · {{ connection.label }}</option>
        <option
          disabled
          value=""
        >──────────</option>
        <option
          v-for="provider in (['codex', 'claude', 'minimax'] as ProviderId[])"
          :key="provider"
          :value="provider"
        >Add {{ providerLabels[provider] }} connection…</option>
      </select>
    </label>

    <template v-if="selectedConnection">
      <div class="provider-panel__connection-row">
        <span>{{ authLabels[selectedConnection.authSource] }}</span>
        <span
          class="provider-panel__status"
          :class="`status-${selectedConnection.verificationStatus}`"
        >{{ selectedConnection.verificationStatus === 'verified' ? 'Verified' : selectedConnection.verificationStatus === 'failed' ? 'Verification failed' : 'Unknown' }}</span>
      </div>
      <p
        v-if="selectedConnection.authSource === 'claude-subscription'"
        class="provider-panel__hint"
        aria-label="Claude session status"
      >
        {{ selectedConnection.localSession?.status === 'authenticated' ? 'Claude session recognized. Verify the selected model and effort to check inference access.' : selectedConnection.localSession?.status === 'unauthenticated' ? 'Claude is signed out on this device. Run claude auth login --claudeai, then refresh models.' : 'Claude session status could not be checked. Refresh models to try again.' }}
      </p>
      <p
        v-if="selectedConnection.verificationStatus === 'failed' && selectedConnection.lastFailure === 'quota'"
        class="provider-panel__hint"
      >
        Quota unavailable. No other provider will be selected automatically.
      </p>
      <label class="provider-panel__field">
        <span>Model</span>
        <select
          :value="models.some(model => model.id === modelId) ? modelId : '__custom__'"
          aria-label="Model picker"
          :disabled="props.disabled"
          @change="chooseModel(($event.target as HTMLSelectElement).value)"
        >
          <option
            v-for="model in models"
            :key="model.id"
            :value="model.id"
          >
            {{ model.label }}{{ model.hidden ? ' (hidden)' : '' }}
          </option>
          <option value="__custom__">
            Enter a custom model ID…
          </option>
        </select>
      </label>
      <button
        type="button"
        :disabled="props.disabled || loading || saving || verifying"
        @click="refreshModels"
      >
        Refresh models
      </button>
      <p
        v-if="selectedConnection.capabilities.catalogStatus !== 'known'"
        class="provider-panel__hint"
      >
        The catalog is partial. You can enter a custom model ID and test it explicitly.
      </p>
      <details
        :open="manualModelOpen"
        class="provider-panel__manage"
      >
        <summary>Custom model ID</summary>
        <label class="provider-panel__field">
          <span>Model ID</span>
          <input
            v-model.trim="modelId"
            aria-label="Model"
            placeholder="Enter an exact model ID"
            :disabled="props.disabled"
          >
        </label>
      </details>
      <label class="provider-panel__field">
        <span>Effort</span>
        <select
          v-model="effort"
          aria-label="Model effort"
          :disabled="props.disabled"
        >
          <option
            v-for="value in allowedEfforts"
            :key="value"
            :value="value"
          >{{ effortLabels[value] }}</option>
        </select>
      </label>
      <p
        class="provider-panel__hint"
        :class="{ 'is-ready': effortVerified }"
        role="status"
      >
        {{ effortVerified ? 'This model and effort are verified for this connection.' : !selectedModel ? 'This model and candidate effort are unknown until you test this connection.' : selectedModel.availability === 'unavailable' ? 'This model is unavailable for this connection.' : 'Availability is unknown. Verify this connection before generating.' }}
      </p>
      <div class="provider-panel__actions">
        <button
          type="button"
          aria-label="Test connection"
          :disabled="props.disabled || saving || verifying || !modelId || !allowedEfforts.includes(effort)"
          @click="verifyConnection"
        >
          {{ verifying ? 'Checking…' : 'Test connection' }}
        </button>
      </div>
      <details class="provider-panel__manage">
        <summary>Manage connection</summary>
        <label class="provider-panel__field">
          <span>Rename</span>
          <input
            v-model="label"
            aria-label="Connection name"
            :placeholder="selectedConnection.label"
            :disabled="props.disabled || saving"
          >
        </label>
        <label class="provider-panel__field">
          <span>Replace credential</span>
          <input
            v-model="credential"
            type="password"
            autocomplete="new-password"
            aria-label="Replacement credential"
            :disabled="props.disabled || saving"
            placeholder="Enter new credential"
          >
        </label>
        <div class="provider-panel__actions">
          <button
            type="button"
            aria-label="Save changes"
            :disabled="props.disabled || saving || (!label.trim() && !credential)"
            @click="saveConnection"
          >
            {{ saving ? 'Saving…' : 'Save changes' }}
          </button>
          <button
            type="button"
            class="is-danger"
            :disabled="props.disabled || saving"
            @click="removeConnection"
          >
            Remove
          </button>
        </div>
      </details>
    </template>

    <template v-else>
      <label class="provider-panel__field">
        <span>Authentication source</span>
        <select
          v-model="selectedAuthSource"
          aria-label="Authentication source"
          :disabled="props.disabled || saving"
        >
          <option
            v-for="source in providerSources"
            :key="source"
            :value="source"
          >{{ authLabels[source] }}</option>
        </select>
      </label>
      <label class="provider-panel__field">
        <span>Connection name</span>
        <input
          v-model="label"
          aria-label="New connection name"
          autocomplete="off"
          :disabled="props.disabled || saving"
          placeholder="e.g. Work account"
        >
      </label>
      <label
        v-if="needsCredential"
        class="provider-panel__field"
      >
        <span>{{ authLabels[selectedAuthSource] }}</span>
        <input
          v-model="credential"
          type="password"
          autocomplete="new-password"
          aria-label="Credential"
          :disabled="props.disabled || saving"
          placeholder="Stored securely by the local service"
        >
      </label>
      <p
        v-else
        class="provider-panel__hint"
      >
        The local provider session will be checked only when you test this connection.
      </p>
      <div class="provider-panel__actions">
        <button
          type="button"
          aria-label="Add connection"
          :disabled="props.disabled || saving || !label.trim() || (needsCredential && !credential)"
          @click="createConnection"
        >
          {{ saving ? 'Saving…' : 'Add connection' }}
        </button>
      </div>
    </template>
  </section>
</template>

<style scoped>
.provider-panel { min-width: 0; padding: 14px 13px 16px; border-bottom: 1px solid #30323b; background: #1b1d24; color: #e1e3e9; }
.provider-panel__heading { display: flex; align-items: start; justify-content: space-between; margin-bottom: 13px; }
.provider-panel__eyebrow { margin: 0 0 4px; color: #a8a6ff; font-size: 9px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
.provider-panel h2 { margin: 0; font-size: 13px; font-weight: 600; }
.provider-panel__loading, .provider-panel__connection-row, .provider-panel__status { color: #9296a3; font-size: 10px; }
.provider-panel__field { display: grid; gap: 5px; margin: 0 0 10px; color: #aeb2bd; font-size: 10px; }
.provider-panel input, .provider-panel select { width: 100%; min-width: 0; border: 1px solid #383b45; border-radius: 5px; padding: 7px 8px; color: #e8e9ed; background: #23252d; font: inherit; font-size: 11px; }
.provider-panel input:focus, .provider-panel select:focus { outline: 2px solid rgb(131 131 255 / 40%); border-color: #8383ff; }
.provider-panel input:disabled, .provider-panel select:disabled, .provider-panel button:disabled { opacity: .55; cursor: not-allowed; }
.provider-panel__connection-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 0 0 11px; }
.provider-panel__status { padding: 3px 6px; border: 1px solid #41434c; border-radius: 99px; }
.status-verified { color: #93d6ad; border-color: #315940; }.status-failed { color: #efaaaa; border-color: #684047; }
.provider-panel__hint { margin: 0 0 10px; color: #858a97; font-size: 9px; line-height: 1.5; }.provider-panel__hint.is-ready { color: #93d6ad; }
.provider-panel__actions { display: flex; gap: 6px; margin: 8px 0 0; }
.provider-panel__actions button { flex: 1; min-width: 0; border: 1px solid #4c4d66; border-radius: 5px; padding: 6px 7px; color: #dedcff; background: #303047; font: inherit; font-size: 10px; cursor: pointer; }
.provider-panel__actions button:hover:not(:disabled) { background: #3a3a59; }.provider-panel__actions button.is-danger { color: #e3a6a6; border-color: #5e3d43; background: #34272c; }
.provider-panel__manage { margin-top: 12px; padding-top: 10px; border-top: 1px solid #30323b; color: #aeb2bd; font-size: 10px; }.provider-panel__manage summary { cursor: pointer; color: #c7c8d2; }
.provider-panel__message { margin: 0 0 10px; color: #9fcdad; font-size: 10px; line-height: 1.4; }.provider-panel__message.is-error { color: #f0aaaa; }
</style>
