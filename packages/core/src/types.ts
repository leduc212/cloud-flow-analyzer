export type Category = 'speed' | 'resources' | 'reliability' | 'maintainability';
export type Severity = 'high' | 'medium' | 'low';

/** Normalised action kind, so rules don't have to know every raw `type` spelling. */
export type ActionKind =
  | 'foreach'
  | 'until'
  | 'condition'
  | 'switch'
  | 'scope'
  | 'connector'
  | 'http'
  | 'child-flow'
  | 'variable-init'
  | 'variable-write'
  | 'data'
  | 'wait'
  | 'terminate'
  | 'response'
  | 'other';

export type TriggerKind = 'recurrence' | 'request' | 'dataverse' | 'connector' | 'other';

export interface ActionSettings {
  /** `runtimeConfiguration.concurrency.repetitions` (loops only). */
  concurrency?: number;
  /** `operationOptions` contains `Sequential`. */
  sequential?: boolean;
  retryPolicy?: unknown;
  /** `runtimeConfiguration.paginationPolicy.minimumItemCount`. */
  paginationMinItems?: number;
  /** `limit` of an Until loop. */
  limit?: { count?: number; timeout?: string };
  secure?: boolean;
}

export interface ActionNode {
  /** Action key in the definition, e.g. `Get_a_row`. Unique within a flow. */
  name: string;
  /** Raw `type`, e.g. `OpenApiConnection`. */
  type: string;
  kind: ActionKind;
  /** Names from the top level down to this action, e.g. `["Try", "Apply_to_each", "Get_a_row"]`. */
  path: string[];
  parentName?: string;
  /** Which branch of the parent holds this action: `actions`, `else`, `case:<name>` or `default`. */
  branch?: string;
  runAfter: Record<string, string[]>;
  inputs: unknown;
  raw: Record<string, unknown>;
  connector?: string;
  operationId?: string;
  /** HTTP method of `Http` and `ApiConnection` actions, lower case. */
  method?: string;
  /** Connector parameters (`inputs.parameters`, plus `inputs.queries` for older `ApiConnection` actions). */
  parameters: Record<string, unknown>;
  settings: ActionSettings;
  children: ActionNode[];
  /** 1 = top level. */
  depth: number;
  /** Action names this action reads from (`body('X')`, `outputs('X')`…). */
  references: string[];
  /** Loops whose current item this action uses via `items('Loop')`. */
  loopItemRefs: string[];
  /** Uses `item()` (the current item of the nearest loop). */
  usesItem: boolean;
  /** Variables this action reads (`variables('x')`). */
  variableRefs: string[];
  /** Target variable of a variable write. */
  variable?: string;
  /** Variables declared by an `InitializeVariable` action. */
  declares?: string[];
  description?: string;
}

export interface TriggerNode {
  name: string;
  type: string;
  kind: TriggerKind;
  connector?: string;
  operationId?: string;
  parameters: Record<string, unknown>;
  /** Trigger condition expressions. */
  conditions: string[];
  /** `runtimeConfiguration.concurrency.runs`. */
  concurrency?: number;
  recurrence?: { frequency?: string; interval?: number };
  splitOn?: string;
  raw: Record<string, unknown>;
}

export interface FlowTree {
  displayName?: string;
  triggers: TriggerNode[];
  /** Top-level actions in run order. */
  actions: ActionNode[];
  /** Every action, depth first, in run order. */
  all: ActionNode[];
  byName: Map<string, ActionNode>;
  actionCount: number;
  maxDepth: number;
  connectionReferences: Record<string, unknown>;
  /** Shapes the parser didn't understand. Never fatal. */
  warnings: string[];
}

export interface FindingTarget {
  kind: 'flow' | 'trigger' | 'action';
  name?: string;
  path: string[];
}

export interface FindingEvidence {
  timeSharePct?: number;
  iterationsP50?: number;
  retries429?: number;
  requestsPerDay?: number;
}

export interface Finding {
  ruleId: string;
  category: Category;
  severity: Severity;
  /** 0..1 — how sure the rule is that this is a real problem. */
  confidence: number;
  target: FindingTarget;
  message: string;
  /** Overrides the rule's default fix text when a more specific one applies. */
  fix?: string;
  /** Rules whose findings should be fixed first (e.g. SPD01 is blocked by SPD02). */
  blockedBy?: string[];
  evidence?: FindingEvidence;
}
