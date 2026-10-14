import type { ProviderCatalog, ProviderConnectionInput, ProviderConnectionUpdate, ProviderConnectionMetadata, ProviderConnectionView, ProviderSelection } from '../../domain/providers';
import type {
  ApplyResult,
  DesignDocument,
  OperationBatch,
  PersistedProjectEnvelope,
  RunEvent,
} from '../../domain/types';

export type ProjectResponse = { project: PersistedProjectEnvelope | null };
export type ProjectSummary = {
  id: string;
  name: string;
  revision: number;
  updatedAt: string;
  nodeCount: number;
  status: 'available' | 'unavailable';
  diagnostic?: string;
};
export type ProjectsResponse = { projects: ProjectSummary[] };
export type ProjectPreviewResponse = { document: DesignDocument };
export type OpenProjectResponse = { project: PersistedProjectEnvelope };
export type DeleteProjectResponse = { deleted: true; project: PersistedProjectEnvelope | null };
export type OperationResponse = { result: ApplyResult; project: PersistedProjectEnvelope };
export type CapabilitiesResponse = {
  operationTypes: string[];
  exportTargets: Array<'native' | 'vue' | 'figma'>;
  nodeKinds: string[];
};
export type AgentRunRecord = import('../../domain/types').AgentRunRecord;
export type RunResponse = { run: AgentRunRecord; events: RunEvent[] };
export type SnapshotRequest = { label: string; expectedRevision: number };
export type ExportResponse = {
  target: 'native' | 'vue' | 'figma';
  status: 'succeeded' | 'partial' | 'failed';
  artifacts: Array<{ name: string; mimeType: string; encoding: 'utf8' | 'base64'; contents: string }>;
  fidelity: Array<{ feature: string; status: 'preserved' | 'degraded' | 'omitted'; severity: 'info' | 'warning' | 'error'; fallback?: string }>;
  diagnostics: Array<{ code: string; message: string; severity: string }>;
};
export type CreateProjectResponse = ProjectResponse & { project: PersistedProjectEnvelope };

export class LocalApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly diagnostics: Array<{ code: string; message: string; severity: string }> | undefined;

  constructor(
    message: string,
    status: number,
    code?: string,
    diagnostics?: Array<{ code: string; message: string; severity: string }>,
  ) {
    super(message);
    this.name = 'LocalApiError';
    this.status = status;
    this.code = code;
    this.diagnostics = diagnostics;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...init?.headers },
    });
  } catch {
    throw new LocalApiError('The local design service could not be reached.', 0, 'network.unavailable');
  }

  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error =
      typeof body === 'object' && body !== null && 'error' in body
        ? (body as { error?: { code?: string; message?: string; diagnostics?: LocalApiError['diagnostics'] } }).error
        : undefined;
    throw new LocalApiError(
      error?.message ?? `The local design service returned HTTP ${response.status}.`,
      response.status,
      error?.code,
      error?.diagnostics,
    );
  }
  return body as T;
}

function json(body: unknown): RequestInit {
  return { method: 'POST', body: JSON.stringify(body) };
}

export const localApi = {
  listConnections: () => request<{ connections: ProviderConnectionView[]; cleanupPending?: boolean }>('/connections'),
  getProviderCatalog: () => request<{ providers: ProviderCatalog[] }>('/providers'),
  createConnection: (input: ProviderConnectionInput) => request<{ connection: ProviderConnectionMetadata }>('/connections', { method: 'POST', body: JSON.stringify(input) }),
  updateConnection: (id: string, input: ProviderConnectionUpdate) => request<{ connection: ProviderConnectionMetadata }>(`/connections/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(input) }),
  deleteConnection: (id: string) => request<{ deleted: true }>(`/connections/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  verifyConnection: (id: string, selection: Omit<ProviderSelection, 'connectionId'>) => request<{ connection: ProviderConnectionView }>(`/connections/${encodeURIComponent(id)}/verify`, { method: 'POST', body: JSON.stringify(selection) }),
  getCapabilities: () => request<CapabilitiesResponse>('/capabilities'),
  getProject: () => request<ProjectResponse>('/project'),
  listProjects: () => request<ProjectsResponse>('/projects'),
  getProjectPreview: (id: string) => request<ProjectPreviewResponse>(`/projects/${encodeURIComponent(id)}/preview`),
  openProject: (id: string) => request<OpenProjectResponse>(`/projects/${encodeURIComponent(id)}/open`, { method: 'POST', body: JSON.stringify({}) }),
  deleteProject: (id: string) => request<DeleteProjectResponse>(`/projects/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  listRuns: () => request<{ runs: AgentRunRecord[] }>('/runs'),
  createProject: (name: string) => request<CreateProjectResponse>('/project/new', json({ name })),
  applyOperations: (batch: OperationBatch) =>
    request<OperationResponse>('/operations', json({ batch })),
  startRun: (input: { prompt: string; selectedNodeIds: string[]; expectedRevision: number; pageId?: string; providerSelection?: ProviderSelection }) =>
    request<{ runId: string }>('/runs', json(input)),
  getRun: (runId: string) =>
    request<RunResponse>(`/runs/${encodeURIComponent(runId)}`),
  cancelRun: (runId: string) =>
    request<{ run: AgentRunRecord }>(`/runs/${encodeURIComponent(runId)}/cancel`, json({})),
  acknowledgeRendered: (runId: string, input: { revision: number; success: boolean; message?: string }) =>
    request<{ run: AgentRunRecord }>(`/runs/${encodeURIComponent(runId)}/rendered`, json(input)),
  history: (action: 'undo' | 'redo', expectedRevision: number) =>
    request<ProjectResponse>(`/history/${action}`, json({ expectedRevision })),
  createSnapshot: (input: SnapshotRequest) => request<ProjectResponse>('/snapshots', json(input)),
  restoreSnapshot: (snapshotId: string, expectedRevision: number) =>
    request<ProjectResponse>(`/snapshots/${encodeURIComponent(snapshotId)}/restore`, json({ expectedRevision })),
  exportDocument: (target: 'native' | 'vue' | 'figma') =>
    request<ExportResponse>('/export', json({ target })),
};

export function getCommittedRevision(events: RunEvent[]): number | undefined {
  const result = [...events].reverse().find((event) => event.type === 'result' && event.outcome === 'committed');
  return result?.type === 'result' ? result.revision : undefined;
}

export function projectDocument(project: PersistedProjectEnvelope | null): DesignDocument | null {
  return project?.document ?? null;
}
