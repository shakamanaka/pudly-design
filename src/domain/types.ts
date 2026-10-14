import type { ProviderRunSelectionMetadata } from './providers.js';
export type DocumentId = string;
export type PageId = string;
export type NodeId = string;
export type ComponentId = string;
export type TokenId = string;
export type BatchId = string;
export type Revision = number;

export type Page = { id: PageId; name: string; rootNodeIds: NodeId[] };
export type DesignDocument = {
  schemaVersion: number;
  id: DocumentId;
  name: string;
  revision: Revision;
  pageOrder: PageId[];
  pages: Record<PageId, Page>;
  nodes: Record<NodeId, DesignNode>;
  tokens: Record<TokenId, DesignToken>;
  components: Record<ComponentId, ComponentDefinition>;
  metadata: Record<string, string | number | boolean | null>;
};

export type TokenReference = { kind: 'token'; tokenId: TokenId };
export type Measure = { kind: 'literal'; value: number; unit: 'px' } | TokenReference;
export type Sizing =
  | { kind: 'fixed'; value: Measure }
  | { kind: 'fill'; min?: Measure; max?: Measure }
  | { kind: 'hug'; min?: Measure; max?: Measure };
export type ConstraintSet = {
  left?: Measure;
  right?: Measure;
  top?: Measure;
  bottom?: Measure;
  centerX?: boolean;
  centerY?: boolean;
};
export type Layout = {
  mode: 'horizontal' | 'vertical' | 'free';
  position?: { x: number; y: number };
  width: Sizing;
  height: Sizing;
  align: 'start' | 'center' | 'end' | 'stretch';
  justify: 'start' | 'center' | 'end' | 'space-between';
  gap: Measure;
  padding: { top: Measure; right: Measure; bottom: Measure; left: Measure };
};
export type ColorValue = { kind: 'literal'; value: `#${string}` } | TokenReference;
export type SemanticStyle = {
  fill?: ColorValue;
  textColor?: ColorValue;
  radius?: Measure;
  opacity?: number;
  shadowTokenId?: TokenId;
};
export type TextStyle = {
  typographyTokenId?: TokenId;
  fontSize?: Measure;
  weight?: number;
  lineHeight?: number;
  align?: 'start' | 'center' | 'end';
};
export type NodeBase = {
  id: NodeId;
  name: string;
  childIds: NodeId[];
  visible: boolean;
  layout: Layout;
  constraints: ConstraintSet;
  style: SemanticStyle;
  responsive: ResponsiveRule[];
};
export type FrameNode = NodeBase & { kind: 'frame' };
export type GroupNode = NodeBase & { kind: 'group' };
export type TextNode = NodeBase & { kind: 'text'; text: string; textStyle: TextStyle };
export type ImageNode = NodeBase & { kind: 'image'; assetId: string; fit: 'cover' | 'contain' | 'fill' };
export type IconNode = NodeBase & { kind: 'icon'; libraryId: string; iconName: string };
export type VectorNode = NodeBase & {
  kind: 'vector';
  pathData: string;
  viewBox: [number, number, number, number];
};
export type ComponentInstanceNode = NodeBase & {
  kind: 'component-instance';
  componentId: ComponentId;
  variantId: string;
  propertyOverrides: Record<string, PropertyValue>;
  nodeOverrides: Record<string, Partial<InstanceNodeOverride>>;
  slotChildren: Record<string, NodeId[]>;
};
export type DesignNode =
  | FrameNode
  | GroupNode
  | TextNode
  | ImageNode
  | IconNode
  | VectorNode
  | ComponentInstanceNode;

export type TemplateBase = {
  templateNodeId: string;
  name: string;
  childTemplateNodeIds: string[];
  visible: boolean;
  layout: Layout;
  constraints: ConstraintSet;
  style: SemanticStyle;
  responsive: ResponsiveRule[];
};
export type TemplateNode =
  | (TemplateBase & { kind: 'frame' | 'group' })
  | (TemplateBase & { kind: 'text'; text: string; textStyle: TextStyle })
  | (TemplateBase & { kind: 'image'; assetId: string; fit: 'cover' | 'contain' | 'fill' })
  | (TemplateBase & { kind: 'icon'; libraryId: string; iconName: string })
  | (TemplateBase & {
      kind: 'vector';
      pathData: string;
      viewBox: [number, number, number, number];
    });
export type InstanceNodeOverride = {
  text?: string;
  visible?: boolean;
  style?: Partial<SemanticStyle>;
  textStyle?: Partial<TextStyle>;
};
export type PropertyValue = string | number | boolean | TokenReference;
export type PropertyDefinition = {
  type: 'string' | 'number' | 'boolean' | 'token';
  required: boolean;
  defaultValue?: PropertyValue;
  binding?: { templateNodeId: string; property: 'text' | 'visible' };
  constraints?: {
    min?: number;
    max?: number;
    enum?: PropertyValue[];
    tokenCategory?: DesignToken['category'];
  };
};
export type VariantDefinition = {
  id: string;
  name: string;
  propertyOverrides: Record<string, PropertyValue>;
  nodeOverrides: Record<string, Partial<InstanceNodeOverride>>;
};
export type ComponentSlot = {
  id: string;
  name: string;
  templateAnchorNodeId: string;
  allowedKinds: Array<'frame' | 'group' | 'text' | 'image' | 'icon' | 'vector'>;
  minItems: number;
  maxItems?: number;
};
export type ComponentDefinition = {
  id: ComponentId;
  name: string;
  rootTemplateNodeId: string;
  templateNodes: Record<string, TemplateNode>;
  properties: Record<string, PropertyDefinition>;
  variants: Record<string, VariantDefinition>;
  slots: Record<string, ComponentSlot>;
};

export type DesignToken =
  | { id: TokenId; name: string; category: 'color'; value: { hex: `#${string}`; alpha?: number } }
  | {
      id: TokenId;
      name: string;
      category: 'typography';
      value: {
        fontFamily: string;
        fontSizePx: number;
        weight: number;
        lineHeight: number;
        letterSpacingPx?: number;
      };
    }
  | {
      id: TokenId;
      name: string;
      category: 'spacing' | 'radius' | 'breakpoint';
      value: { valuePx: number };
    }
  | {
      id: TokenId;
      name: string;
      category: 'shadow';
      value: { xPx: number; yPx: number; blurPx: number; spreadPx: number; color: ColorValue };
    }
  | {
      id: TokenId;
      name: string;
      category: 'motion';
      value: {
        durationMs: number;
        easing: 'linear' | 'ease' | 'ease-in' | 'ease-out' | 'ease-in-out';
      };
    }
  | { id: TokenId; name: string; category: 'z-index'; value: { order: number } };
export type ResponsiveRule = {
  id: string;
  breakpointTokenId: TokenId;
  priority: number;
  overrides: { layout?: Partial<Layout>; visible?: boolean };
};

export type OperationSource = 'agent' | 'inspector' | 'toolbar' | 'keyboard' | 'system';
export type OperationType =
  | 'node.create'
  | 'node.delete'
  | 'node.move'
  | 'property.set'
  | 'layout.set'
  | 'style.set';
export type PropertyMutation =
  | { property: 'name'; value: string }
  | { property: 'text'; value: string }
  | { property: 'visible'; value: boolean }
  | { property: 'variantId'; value: string }
  | { property: 'propertyOverrides'; value: Record<string, PropertyValue> };
export type Operation =
  | { type: 'node.create'; node: DesignNode; parentId?: NodeId; pageId: PageId; index: number }
  | { type: 'node.delete'; nodeId: NodeId; mode: 'subtree' | 'reject-if-children' }
  | { type: 'node.move'; nodeId: NodeId; parentId?: NodeId; pageId: PageId; index: number }
  | { type: 'property.set'; nodeId: NodeId; change: PropertyMutation }
  | { type: 'layout.set'; nodeId: NodeId; value: Layout }
  | { type: 'style.set'; nodeId: NodeId; value: SemanticStyle };
export type OperationBatch = {
  id: BatchId;
  documentId: DocumentId;
  expectedRevision: Revision;
  source: OperationSource;
  actorId?: string;
  runId?: string;
  capabilitySet: string[];
  operations: Operation[];
};
export type Diagnostic = {
  code: string;
  message: string;
  severity: 'error' | 'warning' | 'info';
  operationIndex?: number;
  targetId?: string;
  path?: string;
  details?: Record<string, string | number | boolean | null>;
};
export type ValidationResult<T> =
  | { ok: true; value: T; diagnostics: Diagnostic[] }
  | { ok: false; diagnostics: Diagnostic[] };
export type ApplyResult =
  | {
      status: 'committed';
      batchId: BatchId;
      beforeRevision: Revision;
      revision: Revision;
      document: DesignDocument;
      diagnostics: Diagnostic[];
      inverseOperations: Operation[];
    }
  | {
      status: 'rejected';
      batchId: BatchId;
      revision: Revision;
      diagnostics: [Diagnostic, ...Diagnostic[]];
    };
export type OperationScope = {
  allowedNodeIds?: readonly NodeId[];
  allowedPageIds?: readonly PageId[];
  allowedOperationTypes?: readonly OperationType[];
  policy?: DesignSystemPolicy;
};
export type DesignSystemRule = 'literal-color' | 'literal-spacing' | 'minimum-spacing' | 'detached-instance';
export type PolicySeverity = 'off' | 'info' | 'warning' | 'error';
export type DesignSystemPolicy = { rules: Record<DesignSystemRule, PolicySeverity>; minimumSpacingPx: number };
export type HistoryEntry = {
  batchId: BatchId;
  beforeRevision: Revision;
  afterRevision: Revision;
  operations: Operation[];
  inverseOperations: Operation[];
  source: OperationSource;
  timestamp: string;
  runId?: string;
};
export type SnapshotRecord = {
  id: string;
  revision: Revision;
  label: string;
  timestamp: string;
  document: DesignDocument;
};
export type HistoryTransition = {
  id: string;
  kind: 'commit' | 'undo' | 'redo' | 'restore';
  fromRevision: Revision;
  toRevision: Revision;
  batchId?: BatchId;
  entryId?: string;
  timestamp: string;
};
export type HistoryState = {
  undoableEntries: HistoryEntry[];
  cursor: number;
  auditTransitions: HistoryTransition[];
  snapshots: SnapshotRecord[];
};
export type PersistedProjectEnvelope = {
  formatVersion: number;
  document: DesignDocument;
  history: HistoryState;
  appliedBatchIds: BatchId[];
  integrityHash: string;
};

export type DesignDocumentFragment = {
  documentId: DocumentId;
  revision: Revision;
  page?: Page;
  nodes: Record<NodeId, DesignNode>;
  tokens: Record<TokenId, DesignToken>;
  components: Record<ComponentId, ComponentDefinition>;
};
export type RunState =
  | 'QUEUED'
  | 'PLANNING'
  | 'RUNNING'
  | 'VALIDATING_OPERATIONS'
  | 'APPLYING'
  | 'RENDERING'
  | 'QA'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'CANCELLED'
  | 'ROLLED_BACK';
export type RunEvent =
  | { type: 'state'; runId: string; state: RunState; at: string }
  | { type: 'progress'; runId: string; phase: RunState; message: string }
  | { type: 'operation-proposed'; runId: string; index: number; operationType: string }
  | { type: 'diagnostic'; runId: string; diagnostic: Diagnostic }
  | {
      type: 'result';
      runId: string;
      revision?: Revision;
      outcome: 'committed' | 'rejected' | 'rolled-back';
    };

export type CodingAgentRequest = {
  runId: string;
  documentId: DocumentId;
  baseRevision: Revision;
  prompt: string;
  selectedNodeIds: NodeId[];
  documentFragment: DesignDocumentFragment;
  resolvedContext: ContextReference[];
  operationCapabilities: string[];
  designSystemContext?: { policy: DesignSystemPolicy; catalog: Record<string, { semanticRole: string; description: string; usageRules: string[] }> };
};
export type CodingAgentResponse = { operations: Operation[]; summary?: string };
export type AgentStatus = { runId: string; state: RunState; startedAt?: string; finishedAt?: string };
export type AgentRunRecord = {
  providerSelection?: ProviderRunSelectionMetadata;
  id: string;
  documentId: DocumentId;
  baseRevision: Revision;
  committedRevision?: Revision;
  operations?: Operation[];
  userRequest: string;
  selectedNodeIds: NodeId[];
  resolvedContext: ContextReference[];
  operationCapabilities: string[];
  state: RunState;
  startedAt: string;
  finishedAt?: string;
  batchId?: BatchId;
  validationResults: Diagnostic[];
  snapshotBefore?: string;
  snapshotAfter?: string;
  qaResults: Diagnostic[];
  designSystemContext?: CodingAgentRequest['designSystemContext'];
  documentFragment?: DesignDocumentFragment;
};
export interface AgentRunStore {
  loadAll(): Promise<AgentRunRecord[]>;
  save(record: AgentRunRecord): Promise<void>;
}
export type ContextReference = {
  scope:
    | 'global'
    | 'product'
    | 'project'
    | 'design-system'
    | 'page'
    | 'frame'
    | 'component'
    | 'selection';
  sourceId?: string;
  includedNodeIds?: NodeId[];
};
export type ExportArtifact = {
  name: string;
  mimeType: string;
  encoding: 'utf8' | 'base64';
  contents: string;
};
export type FidelityEntry = {
  nodeId?: NodeId;
  feature: string;
  status: 'preserved' | 'degraded' | 'omitted';
  fallback?: string;
  severity: 'info' | 'warning' | 'error';
};
export type ExportResult = {
  target: 'native' | 'vue' | 'figma';
  status: 'succeeded' | 'partial' | 'failed';
  artifacts: ExportArtifact[];
  fidelity: FidelityEntry[];
  diagnostics: Diagnostic[];
};
export interface CodingAgent {
  execute(
    request: CodingAgentRequest,
    signal: AbortSignal,
  ): AsyncIterable<RunEvent | { type: 'response'; response: CodingAgentResponse }>;
  cancel(runId: string): Promise<void>;
  getStatus(runId: string): Promise<AgentStatus>;
}
export interface DesignPersistence {
  load(documentId: DocumentId): Promise<PersistedProjectEnvelope | null>;
  saveAtomically(
    envelope: PersistedProjectEnvelope,
    expectedRevision: Revision,
  ): Promise<{ savedRevision: Revision }>;
}
export interface DesignExporter {
  export(document: DesignDocument): Promise<ExportResult>;
}
export type TokenValuePx = { value: number; category: string };
export type MeasureResolution = { ok: true; value: number } | { ok: false; diagnostic: Diagnostic };
export type ResolvedColor = { hex: string; alpha: number };
export type ResolvedComponentSlot = { anchorTemplateNodeId: string; children: DesignNode[] };
export type ResolvedComponentInstance = { definition: ComponentDefinition; properties: Record<string, unknown>; nodes: Record<string, unknown>; slots: Record<string, ResolvedComponentSlot> };
export type NodeLocation = { pageId: PageId; parentId?: NodeId; index: number; slotId?: string };
