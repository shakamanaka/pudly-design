import type { DesignDocument, PersistedProjectEnvelope } from '../domain/index';

export type ProjectSummary = {
  id: string;
  name: string;
  revision: number;
  updatedAt: string;
  nodeCount: number;
  status: 'available' | 'unavailable';
  diagnostic?: string;
};

export type ProjectLibrary = {
  listProjects(): Promise<ProjectSummary[]>;
  previewProject(id: string): Promise<DesignDocument>;
  openProject(id: string): Promise<PersistedProjectEnvelope>;
  removeProject(id: string): Promise<PersistedProjectEnvelope | null>;
};
