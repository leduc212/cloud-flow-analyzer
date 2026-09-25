import { DATAVERSE, DATAVERSE_TRIGGER, listOperation, resolveConnector } from './connectors.ts';
import { asNumber, asObject, asString, isObject, readFlow, type JsonObject } from './definition.ts';
import { scanReferences } from './expressions.ts';
import type {
  ActionKind,
  ActionNode,
  ActionSettings,
  FlowTree,
  TriggerKind,
  TriggerNode,
} from './types.ts';

const KIND_BY_TYPE: Record<string, ActionKind> = {
  foreach: 'foreach',
  until: 'until',
  if: 'condition',
  switch: 'switch',
  scope: 'scope',
  openapiconnection: 'connector',
  apiconnection: 'connector',
  openapiconnectionwebhook: 'connector',
  apiconnectionwebhook: 'connector',
  http: 'http',
  httpwebhook: 'http',
  workflow: 'child-flow',
  initializevariable: 'variable-init',
  setvariable: 'variable-write',
  appendtoarrayvariable: 'variable-write',
  appendtostringvariable: 'variable-write',
  incrementvariable: 'variable-write',
  decrementvariable: 'variable-write',
  compose: 'data',
  query: 'data',
  select: 'data',
  table: 'data',
  join: 'data',
  parsejson: 'data',
  wait: 'wait',
  terminate: 'terminate',
  response: 'response',
};

interface ParseContext {
  references: Record<string, unknown>;
  all: ActionNode[];
  warnings: string[];
}

interface Position {
  parentPath: string[];
  parentName?: string;
  branch?: string;
  depth: number;
}

/**
 * Orders actions by their `runAfter` dependencies (the order they run in), falling back to the
 * JSON order for actions that can't be placed.
 */
export function orderByRunAfter(entries: [string, JsonObject][]): [string, JsonObject][] {
  const names = new Set(entries.map(([name]) => name));
  const placed = new Set<string>();
  const ordered: [string, JsonObject][] = [];
  let remaining = entries;
  while (remaining.length > 0) {
    const ready = remaining.filter(([, raw]) =>
      Object.keys(asObject(raw.runAfter)).every((dep) => placed.has(dep) || !names.has(dep)),
    );
    // A cycle or a broken reference: keep the JSON order for the rest.
    const next = ready.length > 0 ? ready : remaining;
    for (const entry of next) {
      ordered.push(entry);
      placed.add(entry[0]);
    }
    remaining = remaining.filter(([name]) => !placed.has(name));
  }
  return ordered;
}

function readSettings(raw: JsonObject, inputs: JsonObject): ActionSettings {
  const runtime = asObject(raw.runtimeConfiguration);
  const settings: ActionSettings = {};
  const concurrency = asNumber(asObject(runtime.concurrency).repetitions);
  if (concurrency !== undefined) settings.concurrency = concurrency;
  const options = asString(raw.operationOptions);
  if (options && /sequential/i.test(options)) settings.sequential = true;
  if (inputs.retryPolicy !== undefined) settings.retryPolicy = inputs.retryPolicy;
  const pagination = asNumber(asObject(runtime.paginationPolicy).minimumItemCount);
  if (pagination !== undefined) settings.paginationMinItems = pagination;
  if (isObject(raw.limit)) {
    const count = asNumber(raw.limit.count);
    const timeout = asString(raw.limit.timeout);
    settings.limit = {
      ...(count !== undefined ? { count } : {}),
      ...(timeout !== undefined ? { timeout } : {}),
    };
  }
  if (runtime.secureData !== undefined) {
    settings.secure = true;
    Object.assign(settings, secureParts(runtime.secureData));
  }
  return settings;
}

/** Which parts `runtimeConfiguration.secureData.properties` hides: `inputs`, `outputs`. */
function secureParts(secureData: unknown): { secureInputs?: boolean; secureOutputs?: boolean } {
  const properties = asObject(secureData).properties;
  const list = Array.isArray(properties) ? properties.map((p) => String(p).toLowerCase()) : [];
  return {
    ...(list.includes('inputs') ? { secureInputs: true } : {}),
    ...(list.includes('outputs') ? { secureOutputs: true } : {}),
  };
}

/** The part of an action that holds its own expressions (not its children's). */
export function ownExpressions(kind: ActionKind, raw: JsonObject): unknown {
  switch (kind) {
    case 'foreach':
      return raw.foreach;
    case 'until':
    case 'condition':
    case 'switch':
      return raw.expression;
    case 'scope':
      return undefined;
    default:
      return raw.inputs;
  }
}

function childGroups(kind: ActionKind, raw: JsonObject): [string, JsonObject][] {
  switch (kind) {
    case 'foreach':
    case 'until':
    case 'scope':
      return [['actions', asObject(raw.actions)]];
    case 'condition':
      return [
        ['actions', asObject(raw.actions)],
        ['else', asObject(asObject(raw.else).actions)],
      ];
    case 'switch': {
      const groups: [string, JsonObject][] = Object.entries(asObject(raw.cases)).map(
        ([caseName, value]) => [`case:${caseName}`, asObject(asObject(value).actions)],
      );
      groups.push(['default', asObject(asObject(raw.default).actions)]);
      return groups;
    }
    default:
      return [];
  }
}

function parseAction(name: string, raw: JsonObject, at: Position, ctx: ParseContext): ActionNode {
  const type = asString(raw.type) ?? '';
  // An empty object is what parseActions passes for a non-object action; it already warned.
  if (!type && Object.keys(raw).length > 0) ctx.warnings.push(`Action "${name}" has no type.`);
  const kind = KIND_BY_TYPE[type.toLowerCase()] ?? 'other';
  const inputs = asObject(raw.inputs);
  const host = inputs.host;
  const refs = scanReferences(ownExpressions(kind, raw));
  const path = [...at.parentPath, name];

  const node: ActionNode = {
    name,
    type,
    kind,
    path,
    ...(at.parentName !== undefined ? { parentName: at.parentName } : {}),
    ...(at.branch !== undefined ? { branch: at.branch } : {}),
    runAfter: readRunAfter(raw.runAfter),
    inputs: raw.inputs,
    raw,
    parameters: {
      ...asObject(inputs.queries),
      ...asObject(inputs.parameters),
    },
    settings: readSettings(raw, inputs),
    children: [],
    depth: at.depth,
    references: refs.actions,
    loopItemRefs: refs.loopItems,
    usesItem: refs.usesItem,
    variableRefs: refs.variables,
  };

  if (kind === 'connector') {
    const connector = resolveConnector(host, ctx.references);
    if (connector) node.connector = connector;
    const operationId = asString(asObject(host).operationId);
    if (operationId) node.operationId = operationId;
  }
  const method = asString(inputs.method);
  if (method) node.method = method.toLowerCase();
  if (kind === 'variable-write') {
    const variable = asString(inputs.name);
    if (variable) node.variable = variable;
  }
  if (kind === 'variable-init' && Array.isArray(inputs.variables)) {
    node.declares = inputs.variables
      .map((v) => asString(asObject(v).name))
      .filter((v): v is string => v !== undefined);
  }
  const description = asString(raw.description);
  if (description) node.description = description;

  ctx.all.push(node);
  for (const [branch, actions] of childGroups(kind, raw)) {
    node.children.push(
      ...parseActions(
        actions,
        { parentPath: path, parentName: name, branch, depth: at.depth + 1 },
        ctx,
      ),
    );
  }
  return node;
}

function parseActions(actions: JsonObject, at: Position, ctx: ParseContext): ActionNode[] {
  const entries = Object.entries(actions).map(([name, raw]): [string, JsonObject] => {
    if (!isObject(raw)) ctx.warnings.push(`Action "${name}" is not an object.`);
    return [name, asObject(raw)];
  });
  return orderByRunAfter(entries).map(([name, raw]) => parseAction(name, raw, at, ctx));
}

function readRunAfter(value: unknown): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const [name, statuses] of Object.entries(asObject(value))) {
    result[name] = Array.isArray(statuses)
      ? statuses.filter((s): s is string => typeof s === 'string')
      : [];
  }
  return result;
}

function triggerKind(
  type: string,
  connector: string | undefined,
  operationId?: string,
): TriggerKind {
  const lower = type.toLowerCase();
  if (lower === 'recurrence') return 'recurrence';
  if (lower === 'request') return 'request';
  if (connector === DATAVERSE && operationId === DATAVERSE_TRIGGER) return 'dataverse';
  if (lower.includes('connection')) return 'connector';
  return 'other';
}

function parseTrigger(name: string, value: unknown, ctx: ParseContext): TriggerNode {
  const raw = asObject(value);
  const type = asString(raw.type) ?? '';
  const inputs = asObject(raw.inputs);
  const connector = resolveConnector(inputs.host, ctx.references);
  const operationId = asString(asObject(inputs.host).operationId);
  const conditions = Array.isArray(raw.conditions)
    ? raw.conditions
        .map((c) => asString(asObject(c).expression))
        .filter((c): c is string => c !== undefined)
    : [];
  const node: TriggerNode = {
    name,
    type,
    kind: triggerKind(type, connector, operationId),
    parameters: asObject(inputs.parameters),
    conditions,
    raw,
  };
  if (connector) node.connector = connector;
  if (operationId) node.operationId = operationId;
  const runs = asNumber(asObject(asObject(raw.runtimeConfiguration).concurrency).runs);
  if (runs !== undefined) node.concurrency = runs;
  if (isObject(raw.recurrence)) {
    const frequency = asString(raw.recurrence.frequency);
    const interval = asNumber(raw.recurrence.interval);
    node.recurrence = {
      ...(frequency !== undefined ? { frequency } : {}),
      ...(interval !== undefined ? { interval } : {}),
    };
  }
  const splitOn = asString(raw.splitOn);
  if (splitOn) node.splitOn = splitOn;
  const requestKind = asString(raw.kind);
  if (requestKind) node.requestKind = requestKind;
  const runtime = asObject(raw.runtimeConfiguration);
  if (runtime.secureData !== undefined) Object.assign(node, secureParts(runtime.secureData));
  return node;
}

/** Parses any supported flow input (see `readFlow`) into an action tree. */
export function parseFlow(input: unknown): FlowTree {
  const flow = readFlow(input);
  const ctx: ParseContext = { references: flow.connectionReferences, all: [], warnings: [] };
  const triggers = Object.entries(asObject(flow.definition.triggers)).map(([name, raw]) =>
    parseTrigger(name, raw, ctx),
  );
  const actions = parseActions(
    asObject(flow.definition.actions),
    { parentPath: [], depth: 1 },
    ctx,
  );
  const byName = new Map(ctx.all.map((node) => [node.name, node]));
  return {
    ...(flow.displayName !== undefined ? { displayName: flow.displayName } : {}),
    triggers,
    actions,
    all: ctx.all,
    byName,
    actionCount: ctx.all.length,
    maxDepth: ctx.all.reduce((max, node) => Math.max(max, node.depth), 0),
    connectionReferences: flow.connectionReferences,
    warnings: ctx.warnings,
  };
}

/** Parent first, up to the top level. */
export function ancestors(tree: FlowTree, node: ActionNode): ActionNode[] {
  const result: ActionNode[] = [];
  let current = node.parentName !== undefined ? tree.byName.get(node.parentName) : undefined;
  while (current) {
    result.push(current);
    current = current.parentName !== undefined ? tree.byName.get(current.parentName) : undefined;
  }
  return result;
}

/** All actions inside a container, depth first. */
export function descendants(node: ActionNode): ActionNode[] {
  const result: ActionNode[] = [];
  const visit = (children: ActionNode[]) => {
    for (const child of children) {
      result.push(child);
      visit(child.children);
    }
  };
  visit(node.children);
  return result;
}

/** The Apply to each loops around an action, innermost first. */
export function enclosingLoops(tree: FlowTree, node: ActionNode): ActionNode[] {
  return ancestors(tree, node).filter((a) => a.kind === 'foreach');
}

export function isConcurrentLoop(loop: ActionNode): boolean {
  return !loop.settings.sequential && (loop.settings.concurrency ?? 1) > 1;
}

/** Designer-style label: `Get_a_row` → `Get a row`. */
export function label(name: string): string {
  return name.replace(/_/g, ' ');
}

/** The list query a loop iterates over, when that query returns at most one row (`$top` = 1). */
export function singleRowSource(tree: FlowTree, loop: ActionNode): ActionNode | undefined {
  for (const ref of loop.references) {
    const source = tree.byName.get(ref);
    if (
      source &&
      listOperation(source.connector, source.operationId) &&
      asNumber(source.parameters.$top) === 1
    ) {
      return source;
    }
  }
  return undefined;
}
