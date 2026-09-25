import { analyseFlow } from '../src/analyse.ts';
import type { Finding } from '../src/types.ts';

type Actions = Record<string, unknown>;
type RunAfter = Record<string, string[]>;

const MANUAL = { manual: { type: 'Request', kind: 'Button', inputs: { schema: {} } } };

export function flow(actions: Actions, triggers: Actions = MANUAL) {
  return { triggers, actions };
}

function connector(api: string, operationId: string, parameters: Actions, runAfter: RunAfter) {
  return {
    runAfter,
    type: 'OpenApiConnection',
    inputs: {
      host: {
        apiId: `/providers/Microsoft.PowerApps/apis/${api}`,
        connectionName: api,
        operationId,
      },
      parameters,
    },
  };
}

export const dataverse = (operationId: string, parameters: Actions = {}, runAfter: RunAfter = {}) =>
  connector('shared_commondataserviceforapps', operationId, parameters, runAfter);

export const sharepoint = (
  operationId: string,
  parameters: Actions = {},
  runAfter: RunAfter = {},
) => connector('shared_sharepointonline', operationId, parameters, runAfter);

export const outlook = (runAfter: RunAfter = {}) =>
  connector('shared_office365', 'SendEmailV2', { 'emailMessage/To': 'x@example.com' }, runAfter);

export function foreach(
  source: string,
  actions: Actions,
  options: { concurrency?: number; runAfter?: RunAfter } = {},
) {
  return {
    foreach: source,
    actions,
    runAfter: options.runAfter ?? {},
    type: 'Foreach',
    ...(options.concurrency !== undefined
      ? { runtimeConfiguration: { concurrency: { repetitions: options.concurrency } } }
      : {}),
  };
}

export function until(actions: Actions, limit?: { count?: number; timeout?: string }) {
  return {
    actions,
    expression: "@equals(variables('done'), true)",
    ...(limit ? { limit } : {}),
    runAfter: {},
    type: 'Until',
  };
}

export const scope = (actions: Actions, runAfter: RunAfter = {}) => ({
  actions,
  runAfter,
  type: 'Scope',
});

export const condition = (
  actions: Actions,
  elseActions: Actions = {},
  runAfter: RunAfter = {},
) => ({
  actions,
  else: { actions: elseActions },
  expression: { and: [{ equals: ["@triggerBody()?['status']", 'Approved'] }] },
  runAfter,
  type: 'If',
});

export const variable = (type: string, name: string, value: unknown, runAfter: RunAfter = {}) => ({
  runAfter,
  type,
  inputs: { name, value },
});

export const compose = (value: unknown, runAfter: RunAfter = {}) => ({
  runAfter,
  type: 'Compose',
  inputs: value,
});

export const http = (method: string, uri: string, runAfter: RunAfter = {}) => ({
  runAfter,
  type: 'Http',
  inputs: { method, uri },
});

export const childFlow = (body: unknown, runAfter: RunAfter = {}) => ({
  runAfter,
  type: 'Workflow',
  inputs: { host: { workflowReferenceName: '00000000-0000-4000-8000-000000000001' }, body },
});

export const wait = (runAfter: RunAfter = {}) => ({
  runAfter,
  type: 'Wait',
  inputs: { interval: { count: 1, unit: 'Minute' } },
});

/** Findings of one rule for a flow. */
export function findings(input: unknown, ruleId: string): Finding[] {
  return analyseFlow(input).findings.filter((f) => f.ruleId === ruleId);
}

/** Sorted, de-duplicated rule IDs found in a flow. */
export function ruleIds(input: unknown): string[] {
  return [...new Set(analyseFlow(input).findings.map((f) => f.ruleId))].sort();
}

/** `count` trivial actions chained one after another. */
export function chain(count: number, prefix = 'Compose'): Actions {
  const actions: Actions = {};
  for (let i = 1; i <= count; i++) {
    actions[`${prefix}_${i}`] = compose(i, i > 1 ? { [`${prefix}_${i - 1}`]: ['Succeeded'] } : {});
  }
  return actions;
}
