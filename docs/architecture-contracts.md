# Codex Design shared contracts

Status: independently reviewed walking-skeleton implementation contract for `design-engine-foundation`. This file freezes the cross-module shapes described by the OpenSpec change. It is normative for the walking skeleton; add later operation capabilities only through explicit negotiation. It does not assert that any interface or capability is implemented.

## Identity, document and ownership

IDs are opaque, stable, case-sensitive strings. Producers MUST NOT derive identity from labels, order, array index, renderer output, or timestamps. The document `revision` starts at 0 for a new document and increments exactly once per successfully committed operation batch or restore. Failed batches do not change it.

Ownership and component template trees are bounded to 64 levels from their actual roots regardless of object-map insertion order. Cycle/depth validation uses iterative traversal so hostile semantic graph depth cannot exhaust the JavaScript call stack.

Dictionary references resolve only own entries, never inherited JavaScript properties. Opaque node/page references in bounded JSON bodies may contain punctuation or Unicode; URL run/snapshot IDs retain their separate route constraints. Runtime parsing rejects non-JSON values, non-finite numbers, malformed operation changes and non-scalar document metadata.

```ts
type Brand<T, Name extends string> = T & { readonly __brand: Name };
type DocumentId = Brand<string, "DocumentId">;
type PageId = Brand<string, "PageId">;
type NodeId = Brand<string, "NodeId">;
type ComponentId = Brand<string, "ComponentId">;
type TokenId = Brand<string, "TokenId">;
type BatchId = Brand<string, "BatchId">;
type Revision = number; // non-negative safe integer

type DesignDocument = {
  schemaVersion: number; // positive integer
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
type Page = { id: PageId; name: string; rootNodeIds: NodeId[] };

type DesignNode =
  | FrameNode | GroupNode | TextNode | ImageNode | IconNode
  | VectorNode | ComponentInstanceNode;
type NodeBase = {
  id: NodeId;
  name: string;
  childIds: NodeId[]; // only frame/group may own ordinary children
  visible: boolean;
  layout: Layout;
  constraints: ConstraintSet;
  style: SemanticStyle;
  responsive: ResponsiveRule[];
};
type FrameNode = NodeBase & { kind: "frame" };
type GroupNode = NodeBase & { kind: "group" };
type TextNode = NodeBase & { kind: "text"; text: string; textStyle: TextStyle };
type ImageNode = NodeBase & { kind: "image"; assetId: string; fit: "cover" | "contain" | "fill" };
type IconNode = NodeBase & { kind: "icon"; libraryId: string; iconName: string };
type VectorNode = NodeBase & { kind: "vector"; pathData: string; viewBox: [number, number, number, number] };
type ComponentInstanceNode = NodeBase & {
  kind: "component-instance";
  componentId: ComponentId;
  variantId: string;
  propertyOverrides: Record<string, PropertyValue>;
  nodeOverrides: Record<string, Partial<InstanceNodeOverride>>;
  slotChildren: Record<string, NodeId[]>;
};
type ComponentDefinition = {
  id: ComponentId;
  name: string;
  rootTemplateNodeId: string;
  templateNodes: Record<string, TemplateNode>;
  properties: Record<string, PropertyDefinition>;
  variants: Record<string, VariantDefinition>;
  slots: Record<string, ComponentSlot>;
};
type TemplateBase = {
  templateNodeId: string;
  name: string;
  childTemplateNodeIds: string[];
  visible: boolean;
  layout: Layout;
  constraints: ConstraintSet;
  style: SemanticStyle;
  responsive: ResponsiveRule[];
};
type TemplateNode =
  | (TemplateBase & { kind: "frame" | "group" })
  | (TemplateBase & { kind: "text"; text: string; textStyle: TextStyle })
  | (TemplateBase & { kind: "image"; assetId: string; fit: "cover" | "contain" | "fill" })
  | (TemplateBase & { kind: "icon"; libraryId: string; iconName: string })
  | (TemplateBase & { kind: "vector"; pathData: string; viewBox: [number, number, number, number] });
type InstanceNodeOverride = { text?: string; visible?: boolean; style?: Partial<SemanticStyle>; textStyle?: Partial<TextStyle> };
type PropertyValue = string | number | boolean | TokenReference;
type PropertyDefinition = {
  type: "string" | "number" | "boolean" | "token";
  required: boolean;
  defaultValue?: PropertyValue;
  binding?: { templateNodeId: string; property: "text" | "visible" };
  constraints?: { min?: number; max?: number; enum?: PropertyValue[]; tokenCategory?: DesignToken["category"] };
};
type VariantDefinition = { id: string; name: string; propertyOverrides: Record<string, PropertyValue>; nodeOverrides: Record<string, Partial<InstanceNodeOverride>> };
type ComponentSlot = { id: string; name: string; templateAnchorNodeId: string; allowedKinds: Array<"frame" | "group" | "text" | "image" | "icon" | "vector">; minItems: number; maxItems?: number };
```

Ownership invariant: each document node is referenced exactly once, either by exactly one page's `rootNodeIds`, by exactly one frame/group's `childIds`, or by exactly one component-instance slot; all references resolve; no cycles exist; leaf node kinds have empty `childIds`; component instances have empty `childIds` and own only nodes listed under a declared slot in `slotChildren`. Component templates are definition-owned trees in a separate namespace and are not document nodes. Expanded render identities are ephemeral mappings (instance NodeId + templateNodeId), never persisted as editable document node IDs. Instance overrides may address only declared component properties or existing template nodes/properties. Component definitions cannot recursively instantiate components in this foundation contract; adding nested component definitions requires a later contract revision. Effective component property precedence is instance override, then selected variant override, then definition default; a required property missing all three sources is invalid. A property binding targets one existing template node and applies its resolved value to the declared target field; string properties bind only to text, boolean properties only to visibility, and numeric/token properties are not directly bound in this version. Each slot declares a template anchor; instance-owned slot children render at that anchor and are not part of the definition template graph. Deleting a frame/group with descendants MUST specify subtree deletion or reject-if-children; subtree deletion removes the entire owned subtree atomically and rejects if it contains a referenced node that cannot be deleted (for example, a root required by an active component definition). Deleting a component definition referenced by instances MUST be rejected until instances are detached or deleted.

Limits are configurable per application profile, with these initial acceptance ceilings: 10,000 document nodes, ownership depth 64, 500 operations per batch, 5 MiB serialized document, 1 MiB operation batch. Implementations MUST reject beyond-limit inputs before expensive recursive processing and MUST expose a specific limit diagnostic. These are guardrails, not promises that every device can render the ceiling smoothly.

## Semantic values

Measures are explicit tagged unions; a renderer resolves tokens and translates them to pixels/CSS. Numeric values MUST be finite; literal values MUST be non-negative where used for dimensions, gap, padding, radius, and spacing.

```ts
type TokenReference = { kind: "token"; tokenId: TokenId };
type Measure =
  | { kind: "literal"; value: number; unit: "px" }
  | { kind: "token"; tokenId: TokenId };
type Sizing =
  | { kind: "fixed"; value: Measure }
  | { kind: "fill"; min?: Measure; max?: Measure }
  | { kind: "hug"; min?: Measure; max?: Measure };
type Layout = {
  mode: "horizontal" | "vertical" | "free";
  position?: { x: number; y: number }; // node position in free-layout parent; logical px
  width: Sizing;
  height: Sizing;
  align: "start" | "center" | "end" | "stretch";
  justify: "start" | "center" | "end" | "space-between";
  gap: Measure;
  padding: { top: Measure; right: Measure; bottom: Measure; left: Measure };
};
type ColorValue = { kind: "literal"; value: `#${string}` } | TokenReference;
type SemanticStyle = {
  fill?: ColorValue;
  textColor?: ColorValue;
  radius?: Measure;
  opacity?: number; // 0..1
  shadowTokenId?: TokenId;
};
type TextStyle = {
  typographyTokenId?: TokenId;
  fontSize?: Measure;
  weight?: number;
  lineHeight?: number;
  align?: "start" | "center" | "end";
};
type DesignToken =
  | { id: TokenId; name: string; category: "color"; value: { hex: `#${string}`; alpha?: number } }
  | { id: TokenId; name: string; category: "typography"; value: { fontFamily: string; fontSizePx: number; weight: number; lineHeight: number; letterSpacingPx?: number } }
  | { id: TokenId; name: string; category: "spacing" | "radius" | "breakpoint"; value: { valuePx: number } }
  | { id: TokenId; name: string; category: "shadow"; value: { xPx: number; yPx: number; blurPx: number; spreadPx: number; color: ColorValue } }
  | { id: TokenId; name: string; category: "motion"; value: { durationMs: number; easing: "linear" | "ease" | "ease-in" | "ease-out" | "ease-in-out" } }
  | { id: TokenId; name: string; category: "z-index"; value: { order: number } };
type ResponsiveRule = {
  id: string;
  breakpointTokenId: TokenId;
  priority: number;
  overrides: {
    layout?: Partial<Layout>;
    visible?: boolean;
  };
};
```

A referenced token MUST exist and match the consuming category/type: dimensions/gap/padding use spacing, corner radius uses radius, font sizing/typography uses typography, shadows use shadow, responsive thresholds use breakpoint, motion values use motion, and z-order uses z-index. Color values use color tokens only. Color token alpha and style opacity are finite values in [0,1]; typography weight is 1..1000, lineHeight is positive, spacing/radius/breakpoint/shadow dimensions and motion duration are finite non-negative values, and z-index is a safe integer. A node whose owning parent uses free layout MUST include finite logical-pixel `position`, independently of its own child-arrangement mode. Children of horizontal/vertical parents MUST omit position and nonempty anchor constraints. Page roots may specify a position on the canvas. A free-layout container need not itself have a free-layout parent. Fixed sizing resolves to its declared measure; fill uses available parent space, respecting min/max; hug uses intrinsic content/child extent plus padding, respecting min/max. Fill inside an indefinite hug axis is invalid unless an explicit finite max bounds that axis. Constraints are edge offsets in logical pixels and may not contain opposing anchors with an invalid negative extent. A bound component property type MUST match the target (string→text, boolean→visible); the same target field cannot also be overridden directly by a variant or instance. Property precedence is default < variant property override < instance property override; the resolved value is applied to the binding after node-level template/variant/instance overrides. All literal geometric measures use CSS-independent logical pixels (`px`) in this version; percentages and viewport units are unsupported. Two rules with the same breakpoint and priority that set overlapping properties are invalid. Breakpoints are numeric minimum canvas widths in logical pixels. For a canvas width W, eligible rules have breakpoint <= W; apply in increasing breakpoint order, then increasing priority order, with later rules overriding only explicitly specified fields. Equal breakpoint+priority ties are invalid at document validation. No matching rule means base property values apply. Free-layout anchors are represented by typed `ConstraintSet`; no ad hoc CSS strings are accepted as constraints. Component slots MUST be declared in the definition; supplied slot children must satisfy allowedKinds/min/max and remain instance-owned content, not template node overrides.

## Operations, transaction and diagnostics

Placement rules: absent parentId inserts into the referenced page's rootNodeIds; present parentId inserts into that frame/group's childIds and pageId MUST match the owning page of that parent. Index is a zero-based insertion position in [0, destination.length], measured after removing the moved node from its former owner. Moving into self or an owned descendant is rejected. Slot placement is unavailable in the initial operation subset.

Operation `target` IDs MUST resolve in the target document and be within caller/run scope. Value payloads are typed per operation, never JSON path assignments. The planned union is fixed below; only negotiated operations may execute. The walking skeleton advertises create/delete/move node and set property/layout/style. Other variants remain unavailable until implemented and validated.

```ts
type OperationSource = "agent" | "inspector" | "toolbar" | "keyboard" | "system";
type PropertyMutation =
  | { property: "name"; value: string }
  | { property: "text"; value: string }
  | { property: "visible"; value: boolean }
  | { property: "variantId"; value: string }
  | { property: "propertyOverrides"; value: Record<string, PropertyValue> };
type Operation =
  | { type: "node.create"; node: DesignNode; parentId?: NodeId; pageId: PageId; index: number } // new node childIds MUST be empty; compose graph with subsequent ops
  | { type: "node.delete"; nodeId: NodeId; mode: "subtree" | "reject-if-children" }
  | { type: "node.move"; nodeId: NodeId; parentId?: NodeId; pageId: PageId; index: number }
  | { type: "node.duplicate"; nodeId: NodeId; parentId?: NodeId; pageId: PageId; index: number }
  | { type: "property.set"; nodeId: NodeId; change: PropertyMutation }
  | { type: "layout.set"; nodeId: NodeId; value: Layout }
  | { type: "style.set"; nodeId: NodeId; value: SemanticStyle }
  | { type: "token.set"; tokenId: TokenId; value: DesignToken }
  | { type: "constraint.set"; nodeId: NodeId; value: ConstraintSet }
  | { type: "nodes.group"; nodeIds: NodeId[]; group: GroupNode; parentId?: NodeId; pageId: PageId; index: number }
  | { type: "nodes.ungroup"; nodeId: NodeId }
  | { type: "page.create"; page: Page; index: number }
  | { type: "page.delete"; pageId: PageId }
  | { type: "page.rename"; pageId: PageId; name: string }
  | { type: "component.create"; definition: ComponentDefinition }
  | { type: "component.instance.create"; node: ComponentInstanceNode; pageId: PageId; parentId?: NodeId; index: number }
  | { type: "component.instance.detach"; nodeId: NodeId }
  | { type: "component.variant.create"; componentId: ComponentId; variant: VariantDefinition }
  | { type: "component.variant.set"; nodeId: NodeId; variantId: string };
type ConstraintSet = { left?: Measure; right?: Measure; top?: Measure; bottom?: Measure; centerX?: boolean; centerY?: boolean };
type OperationBatch = {
  id: BatchId;
  documentId: DocumentId;
  expectedRevision: Revision;
  source: OperationSource;
  actorId?: string;
  runId?: string;
  capabilitySet: string[];
  operations: Operation[];
};
type Diagnostic = {
  code: string;
  message: string;
  severity: "error" | "warning" | "info";
  operationIndex?: number;
  targetId?: string;
  path?: string;
  details?: Record<string, string | number | boolean | null>;
};
type ApplyResult =
  | { status: "committed"; batchId: BatchId; beforeRevision: Revision; revision: Revision; diagnostics: Diagnostic[]; inverseOperations: Operation[] }
  | { status: "rejected"; batchId: BatchId; revision: Revision; diagnostics: [Diagnostic, ...Diagnostic[]] };
type PersistedProjectEnvelope = { formatVersion: number; document: DesignDocument; history: HistoryState; appliedBatchIds: BatchId[]; integrityHash: string };
type HistoryState = { undoableEntries: HistoryEntry[]; cursor: number; auditTransitions: HistoryTransition[]; snapshots: SnapshotRecord[] };
type HistoryTransition = { id: string; kind: "commit" | "undo" | "redo" | "restore"; fromRevision: Revision; toRevision: Revision; batchId?: BatchId; entryId?: string; timestamp: string };
type HistoryEntry = { batchId: BatchId; beforeRevision: Revision; afterRevision: Revision; operations: Operation[]; inverseOperations: Operation[]; source: OperationSource; timestamp: string };
type SnapshotRecord = { id: string; revision: Revision; label: string; timestamp: string; document: DesignDocument };
```

A batch applies to a detached draft in input order. Runtime shape, authorization, negotiated capability, individual operation preconditions, final document invariants, and configured design-system blocking policy are checked before commit. Commit swaps one validated project envelope containing the document, history entry, cursor, and applied-batch ledger; the envelope is durably committed atomically before success is reported. The ledger survives reopen and prevents replay after process restart. Each durable undo, redo, or restore is also recorded as a history transition with a strictly increasing revision; undo/redo never reuse earlier revision numbers. Undo moves the cursor backward in `undoableEntries`; redo moves it forward; neither operation is represented as another undoable edit. Both append to the separate, append-only `auditTransitions` ledger. Every original edit is retained in that ledger, and a new successful edit after undo truncates only the redoable branch in `undoableEntries`, while the discarded branch remains auditable. Restore appends a new transition based on the named snapshot and retains earlier history. If atomic envelope save fails, neither in-memory visible state nor durable state advances. If any check fails, result is `rejected`, revision is unchanged, and no operation is visible. Reuse of an already committed batch ID returns `batch.duplicate` and does not reapply. Expected-revision mismatch returns `revision.conflict`. Diagnostics are stable machine-readable codes plus human-readable messages; array index is zero-based. Unknown object fields are rejected at every external serialization boundary; no forward-compatible unknown-field preservation is implied. Operation values are immutable snapshots after submission, and operation envelopes are never mutated during apply/history. Warning/info do not block unless configured policy explicitly says otherwise. Delete behavior is explicit as defined in Identity, document and ownership. A single process-wide transaction sequencer per document establishes a linearization order for concurrent commits; only one batch for a given expected revision can commit.

## Agent lifecycle and event contract

```ts
type RunState = "QUEUED" | "PLANNING" | "RUNNING" | "VALIDATING_OPERATIONS" | "APPLYING" | "RENDERING" | "QA" | "SUCCEEDED" | "FAILED" | "CANCELLED" | "ROLLED_BACK";
type RunEvent =
  | { type: "state"; runId: string; state: RunState; at: string }
  | { type: "progress"; runId: string; phase: RunState; message: string }
  | { type: "operation-proposed"; runId: string; index: number; operationType: string }
  | { type: "diagnostic"; runId: string; diagnostic: Diagnostic }
  | { type: "result"; runId: string; revision?: Revision; outcome: "committed" | "rejected" | "rolled-back" };
type AgentRunRecord = {
  id: string;
  documentId: DocumentId;
  baseRevision: Revision;
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
};
type ContextReference = { scope: "global" | "product" | "project" | "design-system" | "page" | "frame" | "component" | "selection"; sourceId?: string; includedNodeIds?: NodeId[] };
```

Allowed transitions: QUEUED→PLANNING|CANCELLED|FAILED; PLANNING→RUNNING|CANCELLED|FAILED; RUNNING→VALIDATING_OPERATIONS|CANCELLED|FAILED; VALIDATING_OPERATIONS→APPLYING|CANCELLED|FAILED; APPLYING→RENDERING|ROLLED_BACK|FAILED; RENDERING→QA|FAILED; QA→SUCCEEDED|FAILED. SUCCEEDED, FAILED, CANCELLED, ROLLED_BACK are terminal. Before commit linearization, cancellation discards the isolated draft and ends CANCELLED or ROLLED_BACK when a draft had been prepared; it guarantees no document mutation. After commit linearization, cancellation cannot undo or relabel that commit: the run proceeds through RENDERING and QA; it ends SUCCEEDED only if both pass, otherwise FAILED with committed revision recorded. Renderer or QA failure preserves the identifiable committed state and never triggers hidden rollback. Any later user-requested compensation is a new explicit transaction with a new revision and history entry; it does not change the original run outcome.

Every run captures `baseRevision` when context is assembled. If the document revision differs before apply, the generated batch is rejected as `revision.conflict`; it MUST NOT be silently rebased or have context regenerated implicitly. The user may explicitly resubmit against fresh context. The local process adapter MUST use executable plus argument array with shell disabled, isolated working directory, prompt via stdin or equivalent data input, read-only execution policy, output/time limits, and cancellation termination. Prompt, output, and design content MUST not be interpolated into a shell command. Browser clients never receive credentials or direct filesystem/process access.

## Adapter ports and export result

Run persistence uses a separate `AgentRunStore` port (`loadAll(): Promise<AgentRunRecord[]>`, `save(record: AgentRunRecord): Promise<void>`). Records are validated/versioned and bounded in its local adapter. The document/history/ledger durability boundary is unchanged. On startup, reconcile interrupted runs with persisted history `runId`/batch linkage; report FAILED/interrupted with any committed revision retained and never implicitly rerun. Terminal success is published only after the corresponding run record is saved. Default-system policy and catalog context must be retained as run context data; external paths/credentials are excluded.

```ts
type DesignDocumentFragment = { documentId: DocumentId; revision: Revision; page?: Page; nodes: Record<NodeId, DesignNode>; tokens: Record<TokenId, DesignToken>; components: Record<ComponentId, ComponentDefinition> };
type CodingAgentRequest = {
  runId: string; documentId: DocumentId; baseRevision: Revision;
  prompt: string; selectedNodeIds: NodeId[];
  documentFragment: DesignDocumentFragment; resolvedContext: ContextReference[];
  operationCapabilities: string[];
};
type CodingAgentResponse = { operations: Operation[]; summary?: string };
type AgentStatus = { runId: string; state: RunState; startedAt?: string; finishedAt?: string };
interface CodingAgent {
  execute(request: CodingAgentRequest, signal: AbortSignal): AsyncIterable<RunEvent | { type: "response"; response: CodingAgentResponse }>;
  cancel(runId: string): Promise<void>;
  getStatus(runId: string): Promise<AgentStatus>;
}
interface DesignPersistence {
  load(documentId: DocumentId): Promise<PersistedProjectEnvelope | null>;
  saveAtomically(envelope: PersistedProjectEnvelope, expectedRevision: Revision): Promise<{ savedRevision: Revision }>;
}
type ExportArtifact = { name: string; mimeType: string; encoding: "utf8" | "base64"; contents: string };
type FidelityEntry = { nodeId?: NodeId; feature: string; status: "preserved" | "degraded" | "omitted"; fallback?: string; severity: "info" | "warning" | "error" };
type ExportResult = { target: "native" | "vue" | "figma"; status: "succeeded" | "partial" | "failed"; artifacts: ExportArtifact[]; fidelity: FidelityEntry[]; diagnostics: Diagnostic[] };
interface DesignExporter {
  export(document: DesignDocument): Promise<ExportResult>;
}
```

`CodingAgent.execute` returns proposed operations as untrusted data; the application validates and applies them separately. `DesignPersistence.saveAtomically` is the transaction durability boundary and MUST reject a mismatched expected revision. The application service serializes per-document batches, builds the complete next envelope, persists atomically, then publishes the new in-memory state. Export artifacts carry their MIME type and content; all features encountered must appear in fidelity.

## Test traceability

### Design-system policy extension

`DesignSystemPolicy` contains rules keyed by `literal-color`, `literal-spacing`, `minimum-spacing`, and `detached-instance`, each with severity `off | info | warning | error`, plus finite nonnegative `minimumSpacingPx`. `OperationScope.policy` optionally supplies the profile; absent profiles use default warnings for literal colors/spacing/detached provenance and disable minimum-spacing. Blocking policy diagnostics reject the entire draft; warnings/info are retained in commit diagnostics and run QA. Structural validity remains mandatory independently of policy. Reserved metadata `detached:<nodeId> = true` records explicit detached provenance for future detach operations; no detach capability is currently advertised. Component catalog documentation is framework-neutral context, separate from frozen component payloads.

The table below records the original planned test names. Verified current locations and scenario evidence are maintained in [scenario-traceability.md](scenario-traceability.md); use that document for implementation verification.

| OpenSpec contract / scenario | Planned test path and name | Evidence expected |
| --- | --- | --- |
| `design-document`: valid semantic document and stable graph | `tests/domain/document.test.ts` — `loadsSemanticDocumentWithoutRendererState` | Parsed types, stable IDs, ownership graph |
| `design-document`: cyclic graph rejected | `tests/domain/document.test.ts` — `rejectsOwnershipCycleWithoutReplacingCurrentDocument` | Diagnostic code and unchanged prior value |
| `design-document`: newer unsupported schema preserved | `tests/domain/migration.test.ts` — `rejectsUnknownNewerVersionWithoutWrite` | Original serialized bytes unchanged |
| `design-operations`: later invalid op aborts batch | `tests/domain/transactions.test.ts` — `rejectsInvalidMiddleOperationAtomically` | Before/after structural equality and same revision |
| `design-operations`: stale batch and duplicate ID | `tests/domain/transactions.test.ts` — `rejectsStaleAndDuplicateBatches` | Conflict/duplicate codes, no double apply |
| `design-operations`: caller alias mutation | `tests/domain/transactions.test.ts` — `detachesSubmittedOperationValues` | Committed graph remains immutable |
| `canvas-selection-inspector`: semantic render and stable selection | `tests/ui/canvas.spec.ts` — `rendersDocumentAndSelectsStableNodeId` | Visible canvas plus selected NodeId assertion |
| `canvas-selection-inspector`: inspector invalid value | `tests/ui/inspector.spec.ts` — `invalidEditKeepsCommittedValue` | Rejected operation and unchanged document |
| `agent-runtime`: unsafe prompt is data | `tests/adapters/codex-adapter.test.ts` — `passesShellMetacharactersAsStdinData` | Spawn arguments, shell false, stdin captured |
| `agent-runtime`: exact lifecycle and cancellation after commit | `tests/application/run-lifecycle.test.ts` — `continuesQaAfterPostCommitCancellation` | Event order, committed revision, terminal outcome |
| `agent-runtime`: user edit during generation | `tests/application/agent-transaction.test.ts` — `rejectsResponseWhenBaseRevisionChanged` | No implicit rebase, current revision unchanged by stale response |
| `agent-runtime`: unauthorized output | `tests/application/agent-transaction.test.ts` — `rejectsOutOfScopeOperationAtomically` | Scope diagnostic and unchanged document |
| `design-system`: unknown variant / strict token policy | `tests/domain/design-system.test.ts` — `rejectsUnknownVariantAndBlockingLiteralColor` | Deterministic codes and no commit |
| `design-system`: required binding and slot resolution | `tests/domain/components.test.ts` — `resolvesPropertyPrecedenceAndAnchoredSlots` | Instance > variant > default, compatible binding, slot ownership/cardinality |
| `history-persistence`: restore creates revision | `tests/domain/history.test.ts` — `restoresSnapshotAsNewAuditedRevision` | New revision and preserved later history |
| `history-persistence`: interrupted save and ledger reopen | `tests/adapters/persistence.test.ts` — `retainsLastValidEnvelopeOnSaveFailure` / `restoresBatchLedgerAfterReopen` | Previous document/history/ledger load atomically; replay is rejected |
| `history-persistence`: undo/redo monotonic revisions | `tests/domain/history.test.ts` — `undoRedoAdvanceRevisionAndNewEditClearsRedo` | Revision increases on each transition, audit retains transitions/discarded edits, redo branch truncates |
| `export-architecture`: report target loss | `tests/export/export-contract.test.ts` — `reportsUnsupportedResponsiveRule` | Explicit warning/fallback and no full-fidelity claim |
| `export-architecture`: native round trip | `tests/export/native-export.test.ts` — `roundTripsSupportedDocumentLosslessly` | Semantic equality and empty loss list |
| `export-architecture`: Figma unavailable | `tests/adapters/figma-export.test.ts` — `failsWithoutClaimingFileCreated` | Actionable failure, no created-file result |
| `product-mvp`: real prompt-to-render skeleton | `tests/e2e/walking-skeleton.spec.ts` — `createsEditableCanvasFromRealCodexRun` | Real adapter, committed operations, rendered nodes |
| `product-mvp`: mock does not satisfy live gate | `tests/e2e/milestone-gates.test.ts` — `doesNotAcceptMockOnlyAgentEvidence` | Incomplete status when integration evidence absent |

The `ExportResult` and `FidelityEntry` declarations above are canonical. Every encountered feature MUST have a fidelity entry. `preserved` means semantics round trip for that feature; `degraded` means a fallback changes some semantics and MUST name that fallback; `omitted` means it is absent and MUST be severity warning or error. Overall status is `succeeded` only when no feature is degraded/omitted and all required artifacts exist; otherwise `partial` if any artifact exists, or `failed` if none exists. Native export is lossless for all supported schema features; unsupported schema features fail explicitly.

The final file locations and framework syntax may change with repository setup, but requirement-to-test traceability and the stated evidence may not be dropped.

Component inspector mutations use the existing `property.set` envelope: `variantId` replaces an instance variant string and `propertyOverrides` atomically replaces its typed property override map. Both are instance-only, validated against the definition on the isolated draft, and record exact previous values for undo. Invalid variants, missing required values, unknown properties and incompatible scalar values reject the entire batch.

Run requests may provide an active `pageId`. The context assembler validates that it exists and owns all selected nodes; an unselected request includes only that page. Omission uses the selected nodes' owning page, or the first page for existing callers. Selected descendants include an inspectable owning frame reference without granting edits outside their authorized subtree. Saved run metadata retains this exact request context; reopening never starts a new agent execution.

An unselected agent request grants edits only to the included active-page subtree and permits new roots only on that page. A selected request grants the selected subtree and in-scope new children, with no page-root placement grant. Context references to the project or owning frame do not widen this operation authorization.

Agent creation is limited to the renderer's advertised kinds: frame, group, text, vector and component-instance. A vector proposal uses bounded pathData containing only SVG path commands and a finite positive viewBox; arbitrary SVG markup, URL attributes and embedded payloads are rejected before compilation. Semantic vector fill paints the SVG path while the vector wrapper remains transparent. Vue preserves path geometry and fill; Figma imports SVG geometry inside a wrapper frame and reports degraded vector-node semantics. Unsupported creation kinds must fail before commit rather than produce a false ready state using a placeholder.

Component instance placement and sizing belong to the instance. Its resolved template root fills fixed/fill instance axes and determines intrinsic size for hug axes; the selectable instance and visible root share bounds. The wrapper adds no padding or gap. Root template layout supplies internal direction/padding/gap, while instance semantic style overrides resolved root style.

Corrupt generation metadata must not hide a valid authoritative project. Reopen may expose the saved design for direct editing/history while generation and run discovery fail with a recovery diagnostic until metadata is repaired. Metadata recovery must not rewrite corrupt files or rerun Codex.

Canvas text selection controls name their nonblank visible text; layer kind/name are supplementary description. Blank text retains the layer-based name. Accessible naming never changes stable node IDs or creates document mutations.

Structural traversal budgets count visited and queued value entries together. Leave markers used for cycle detection do not count as values; descendants are rejected before scheduling work that would exceed the structural limit.

The editor treats failed export results and zero-artifact results as failures even if HTTP transport succeeded; it exposes adapter diagnostics and does not announce a successful download.

Figma template fidelity describes definition semantics: instance-resolved ordinary layers are degraded because reusable definitions and their editable mappings are not retained; definitions without instances on the exported page are omitted from target layers. Retention in native source JSON alone is not target preservation.

## Generation recovery correction — 2026-10-06

The Codex response boundary uses capability-filtered typed operation objects, not JSON strings containing operations. Its closed schema and runtime decoder reject unknown fields including top-level node.position; placement belongs to layout.position. Any deterministic lowering applies only documented defaults and explicit nullable option omission; it must not repair guessed semantics or bypass native validation/scope/revision rules.

Generation has a bounded 300-second default. Trusted local server configuration CODEX_DESIGN_GENERATION_TIMEOUT_MS accepts integer milliseconds from 30000 through 600000; invalid configuration fails startup rather than silently widening limits. Shorter explicit adapter options remain available for deterministic tests. Pure typed CodingAgentError values preserve safe code/message/diagnostics through application failure and durable records; process stderr/credentials are never exposed to the browser. Cancellation remains terminal before commit and cannot undo an already committed revision.

UI run polling is scoped by run ID and a local polling generation. Cancellation terminal responses invalidate earlier in-flight responses; an older run cannot replace current state/events/notices. Unmount invalidates polling permanently. Post-commit cancellation continues renderer/QA monitoring.

Editor viewport: flex descendants may shrink within the viewport. Canvas, layers, run details and inspector retain independent scrolling; undersized windows retain a page overflow fallback. Empty shape names are selected editor hints, never unselected design content.

Generation CLI explicitly selects gpt-6.1-sol with model_reasoning_effort="low"; user configuration remains ignored for isolation.

Canvas Fit computes scale from actual scroll viewport bounds in both axes, reacts to resize, and resets canvas scroll. Manual zoom exits automatic fit. Run panel owns a bounded scroll region including full prompt and context; its content cannot enlarge the workspace.

Short viewports shrink workspace panels instead of enforcing a 620px root height; prompt dock remains inside the visible viewport.

The editor page artboard maps the selected canvas viewport directly to its semantic page roots: it adds no layout padding or inter-root gap. Overflowing page content remains reachable by scrolling within the artboard on both axes, including tall hug-sized roots in the mobile viewport. Fit continues to measure the canvas scroll viewport and the selected semantic viewport dimensions.

## Provider connections — 2026-10-08
Manual provider routing is backend-owned. With provider service enabled, each run requires an exact verified connection/model/effort selection before queueing. The request snapshots selection before asynchronous work; the managed run pins its resolved adapter for execution and cancellation. No failure launches a different connection, model, or billing source. Legacy service instances without a provider registry retain their existing adapter and reject explicit provider selection.
Provider metadata is optional version1 in historical run records and strict parsed. Credentials and private secret references do not enter DesignDocument, operation prompts, API responses or run history. SecretStore is backend-only; initial file fallback uses owner-only files/directories, not encryption or OS keychain. Catalog lists known candidates separately from proven account access; verification is exact to model and effort. Missing quota data is unknown.

Provider review corrections (2026-10-08): a local subscription connection refers to its provider CLI's current account, not an isolated login identity. Only one local subscription source per provider may be created; changing the CLI login requires verification again. Claude runs use a disposable working directory and supported instruction/config isolation without copying subscription credentials. Verification timeout is a timeout even when an aborted adapter returns no response. Secret cleanup failures retain a durable backend-only cleanup reference for retry and an actionable safe diagnostic; no credential or secret reference is returned to the browser. Owner-only file storage remains an explicitly documented plaintext fallback.

Provider registry recovery is fail-closed for generation without preventing editor/project recovery. Malformed connection data remains preserved; connection endpoints report a safe recovery error and never select the legacy/default adapter as a fallback.

Codex model discovery uses bounded read-only app-server model/list for the active local CLI account. Model discovery is not inference verification. Catalog completeness/source, hidden status, default effort and per-model ordered efforts remain distinct from exact verified connection tuples. API-key connections never inherit the local ChatGPT catalog. Discovery failures expose partial/unknown status; no design, credential or global configuration mutation occurs.

### Claude local identity and catalog discovery
Claude subscription subprocesses preserve safe OS identity (USER/LOGNAME) needed to recognize the device login, while dropping ambient provider keys and executable customizations. Bounded read-only authentication/catalog discovery exposes only sanitized session state and advertised model metadata, never account email, organization, tokens or raw provider envelopes. Session recognition is independent from exact inference verification. Failed verification must not be labeled as proof of session/model unavailability. Subscription catalog/session evidence does not propagate to API-key connections. No discovery prompt or automatic billing fallback is permitted.

### Page composition review
The authorized user prompt expresses design intent; external document strings remain untrusted executable instructions. All provider adapters share scope-aware composition guidance. Full-page proposals undergo structural composition checks on a validated revision-aware candidate before persistence. A single repair uses the same pinned provider/model with an internal attempt ID; incomplete drafts do not mutate document/history, and cancellation/stale revisions remain authoritative. Component/minimal/scoped edits do not receive unrelated page expansion. Native vector creation must preserve validated semantic pathData/viewBox and existing renderer/export fidelity boundaries. Composition checks are objective completeness checks, not aesthetic certification. Real recorded browser visual acceptance remains required.

Default full-page generation has a 600-second per-attempt limit; non-page work retains 300 seconds and explicit caller deadlines remain authoritative. The single repair limit still applies, and no route/account changes are automatic.

Claude's schema-required internal StructuredOutput response channel is permitted while filesystem, network, command and MCP execution remain disabled. Exhausted structured-output retries are classified as invalid response with safe actionable text, never raw tool arguments or provider error prose.

Claude NDJSON metadata and assistant events are not design mutations. Exactly one final typed success result with schema-validated structured_output is required; malformed lines, duplicate/missing results and final error results reject. Partial tool arguments and human-readable result prose never authorize operations.

## Project explorer
Local discovery exposes safe summaries (id,name,revision,updatedAt,nodeCount,status), never history or provider secrets. Preview reads only a validated saved DesignDocument and does not infer or mutate. Opening selects an existing validated envelope without generation and preserves history. Lifecycle changes are serialized and rejected during nonterminal runs. Removal moves saved envelope to owner-only local .trash and clears active pointer if necessary; historical run records remain audit data. Unsafe IDs/symlink entries are rejected, damaged projects do not hide healthy ones, and failures must not publish a different current design. API contracts are documented in openspec/changes/project-explorer/design.md.

Full-page composition review requires explicit fixed or fill native vector bounds at mobile and desktop sizes; unconstrained hug SVG axes can inherit browser intrinsic dimensions and overflow illustration panels. Shared guidance explains layered paths in a bounded free-layout frame with explicit local placement. Scoped/minimal requests retain their existing semantics. This review rejects ambiguous full-page candidates before persistence, without rewriting model geometry or moving nodes implicitly.

Canvas semantic radius measures resolve against radius-category tokens, matching the Vue exporter; they must not fall back to spacing-category resolution. Literal radii remain literal.

Full-page composition review checks supported opaque hex authored-text foreground/background combinations against4.5:1normal/3:1large contrast, following nearest opaque authored ancestor fill and default white artboard; unsupported alpha/complex backgrounds remain inconclusive, not aesthetic certification. At768px image-led horizontal rows with long hug copy receive tablet stacking or fill-bounds guidance. It never changes semantic styles implicitly. Store/shop shared briefs explicitly call for meaningful product/catalog content.
