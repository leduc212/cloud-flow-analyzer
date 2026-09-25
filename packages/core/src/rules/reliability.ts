import {
  DATAVERSE,
  DATAVERSE_UPDATES,
  DATAVERSE_UPDATE_MESSAGES,
  DEFAULT_PAGE_SIZE,
  SHAREPOINT,
  SHAREPOINT_UPDATE,
  SHAREPOINT_UPDATE_TRIGGERS,
  connectorName,
  listOperation,
} from '../connectors.ts';
import { asNumber, asObject, asString, hasValue, isObject } from '../definition.ts';
import { collectStrings } from '../expressions.ts';
import {
  ancestors,
  descendants,
  enclosingLoops,
  isConcurrentLoop,
  ownExpressions,
} from '../parser.ts';
import type { ActionNode, FlowTree, TriggerNode } from '../types.ts';
import { DOCS, FLOW_TARGET, actionTarget, plural, q, type Rule, type RuleMatch } from './rule.ts';

export const REL01: Rule = {
  id: 'REL01',
  category: 'reliability',
  severity: 'high',
  confidence: 0.95,
  title: 'Parallel loop writes to variables',
  why: 'Variables are shared by all items of a loop. When the loop runs items in parallel, Set variable in one item overwrites the value another item is still using, so results are wrong in ways that are hard to spot. Appends and increments are safe but happen in random order.',
  fix: 'Replace the variable writes with data operations (Select, Filter array, a Compose inside the loop), or turn concurrency off for this loop.',
  example: {
    before: 'Apply to each  (concurrency 20)\n  └ Increment variable  Count',
    after: "Filter array  (the items to count)\nCompose  length(body('Filter_array'))",
  },
  docs: [DOCS.parallel, DOCS.dataOperations],
  check({ tree }) {
    const matches: RuleMatch[] = [];
    for (const loop of tree.all) {
      // Concurrency only takes effect on the outermost loop.
      if (loop.kind !== 'foreach' || !isConcurrentLoop(loop)) continue;
      if (enclosingLoops(tree, loop).length > 0) continue;
      const writes = descendants(loop).filter((n) => n.kind === 'variable-write');
      if (writes.length === 0) continue;
      const list = (nodes: ActionNode[]) => {
        const variables = [...new Set(nodes.map((n) => `"${n.variable ?? n.name}"`))];
        return `${variables.length === 1 ? 'variable' : 'variables'} ${variables.join(', ')}`;
      };
      const parallel = `${q(loop.name)} runs up to ${loop.settings.concurrency} items in parallel`;
      // Set variable is a real race. Appends and increments are applied one at a time, but in
      // no particular order.
      const sets = writes.filter((n) => n.type.toLowerCase() === 'setvariable');
      if (sets.length > 0) {
        matches.push({
          target: actionTarget(loop),
          message: `${parallel} and sets ${list(sets)} inside. Parallel items overwrite each other's values.`,
        });
      } else {
        matches.push({
          target: actionTarget(loop),
          message: `${parallel} and appends to ${list(writes)}. Nothing is lost, but the order of the values is random.`,
          severity: 'low',
          confidence: 0.6,
          fix: 'If the order matters, sort the result after the loop (sort() on a key) or turn concurrency off. Otherwise no change is needed.',
        });
      }
    }
    return matches;
  },
};

const FAILURE_STATUS = /^(failed|timedout)$/i;

function handlesFailure(node: ActionNode): boolean {
  return Object.values(node.runAfter).some((statuses) =>
    statuses.some((s) => FAILURE_STATUS.test(s)),
  );
}

export const REL02: Rule = {
  id: 'REL02',
  category: 'reliability',
  severity: 'medium',
  confidence: 0.7,
  title: 'No error handling',
  why: 'When an action fails, the run just stops. No one is told, and half-finished work is left behind.',
  fix: 'Use the Try / Catch / Finally pattern: put the main steps in a Try scope, add a Catch scope set to run after Try has failed or timed out (log, notify, clean up), and a Finally scope for steps that must always run.',
  example: {
    before: 'Step 1 → Step 2 → Step 3',
    after:
      'Scope Try      Step 1 → Step 2 → Step 3\nScope Catch    run after Try: has failed, has timed out\nScope Finally  run after Catch: all outcomes',
  },
  docs: [DOCS.errorHandling],
  check({ tree }) {
    if (tree.actionCount < 5 || tree.all.some(handlesFailure)) return [];
    return [
      {
        target: FLOW_TARGET,
        message: `None of the ${plural(tree.actionCount, 'action')} runs after a failure, so an error stops the flow with no notification or clean-up.`,
      },
    ];
  },
};

export const REL04: Rule = {
  id: 'REL04',
  category: 'reliability',
  severity: 'low',
  confidence: 0.6,
  title: 'Do until with default limits',
  why: 'A Do until stops after 60 iterations or 1 hour by default, even if its exit condition is still false. The flow then carries on as if the loop had finished.',
  fix: 'Set Count and Timeout on purpose, and after the loop check that the exit condition is really true (otherwise fail the run with Terminate).',
  example: {
    before: 'Do until  (Count 60, Timeout PT1H)',
    after:
      'Do until  (Count 20, Timeout PT10M)\nCondition  exit condition met?\n  └ No: Terminate  (Failed)',
  },
  docs: [DOCS.limits, DOCS.loops],
  check({ tree }) {
    const matches: RuleMatch[] = [];
    for (const loop of tree.all) {
      if (loop.kind !== 'until') continue;
      const { count, timeout } = loop.settings.limit ?? {};
      if (count === undefined && timeout === undefined) {
        matches.push({
          target: actionTarget(loop),
          message: `${q(loop.name)} has no Count or Timeout, so the defaults apply (60 iterations, 1 hour).`,
        });
      } else if (count === 60 && (timeout ?? 'PT1H').toUpperCase() === 'PT1H') {
        matches.push({
          target: actionTarget(loop),
          message: `${q(loop.name)} uses the default limits (60 iterations, 1 hour).`,
          confidence: 0.5,
        });
      }
    }
    return matches;
  },
};

export const MAX_ACTIONS = 500;
export const MAX_DEPTH = 8;

export const REL05: Rule = {
  id: 'REL05',
  category: 'reliability',
  severity: 'medium',
  confidence: 0.9,
  title: 'Close to platform limits',
  why: `A flow can hold at most ${MAX_ACTIONS} actions and ${MAX_DEPTH} levels of nesting. Near those limits it is hard to change, and one more step can make it impossible to save.`,
  fix: 'Move self-contained parts into child flows, and flatten deep nesting (for example, end early with Terminate instead of putting conditions inside conditions).',
  docs: [DOCS.limits, DOCS.childFlows],
  check({ tree }) {
    const matches: RuleMatch[] = [];
    if (tree.actionCount >= 400) {
      matches.push({
        target: FLOW_TARGET,
        message: `The flow has ${plural(tree.actionCount, 'action')}; the limit is ${MAX_ACTIONS}.`,
      });
    }
    // The limit counts levels of nesting below the top level (real flows reach depth 9 here).
    const nesting = tree.maxDepth - 1;
    if (nesting >= MAX_DEPTH - 1) {
      const deepest = tree.all.find((n) => n.depth === tree.maxDepth);
      if (deepest) {
        matches.push({
          target: actionTarget(deepest),
          message: `${q(deepest.name)} is nested ${nesting} levels deep; the limit is ${MAX_DEPTH}.`,
        });
      }
    }
    return matches;
  },
};

export const REL03: Rule = {
  id: 'REL03',
  category: 'reliability',
  severity: 'low',
  confidence: 0.6,
  title: 'Retries turned off',
  why: 'By default a connector or HTTP call that is throttled (429) or hits a temporary server error (5xx) is retried up to 4 times with increasing waits. With the retry policy set to None, one temporary error fails the step.',
  fix: "Set the retry policy back to Default (or Exponential interval) in the step's Settings. Keep None only when repeating the call is unsafe, and then handle the failure explicitly.",
  example: {
    before: 'HTTP  Retry policy: None',
    after: 'HTTP  Retry policy: Default  (up to 4 retries, exponential)',
  },
  docs: [DOCS.errorHandling, DOCS.limits],
  check({ tree }) {
    const matches: RuleMatch[] = [];
    for (const node of tree.all) {
      const policy = node.settings.retryPolicy;
      if (!isObject(policy) || asString(policy.type)?.toLowerCase() !== 'none') continue;
      matches.push({
        target: actionTarget(node),
        message: `${q(node.name)} has retries turned off, so one throttled or temporary error fails the step.`,
      });
    }
    return matches;
  },
};

/** `contacts` (trigger logical name) matches `contacts`, `contactses` or `accounties` (entity set names). */
function sameTable(logicalName: string, entityName: string): boolean {
  const table = logicalName.toLowerCase();
  const target = entityName.toLowerCase();
  return (
    target === table ||
    target === `${table}s` ||
    target === `${table}es` ||
    (table.endsWith('y') && target === `${table.slice(0, -1)}ies`)
  );
}

function listParam(value: unknown): string[] {
  return (asString(value) ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

const TRIGGER_REF = /\btrigger(?:Outputs|Body)\(\)/;

/** Update steps that change the rows or items the trigger watches, and how sure we are. */
function selfUpdates(
  tree: FlowTree,
  trigger: TriggerNode,
): { node: ActionNode; confidence: number }[] {
  // A trigger condition is the recommended guard; we can't evaluate it, so trust it.
  if (trigger.conditions.length > 0) return [];
  const updates: { node: ActionNode; confidence: number }[] = [];
  if (trigger.kind === 'dataverse') {
    const message = asNumber(trigger.parameters['subscriptionRequest/message']);
    if (message === undefined || !DATAVERSE_UPDATE_MESSAGES.has(message)) return [];
    const table = asString(trigger.parameters['subscriptionRequest/entityname']);
    if (!table) return [];
    const watched = listParam(trigger.parameters['subscriptionRequest/filteringattributes']);
    const filtered = hasValue(trigger.parameters['subscriptionRequest/filterexpression']);
    for (const node of tree.all) {
      if (node.connector !== DATAVERSE || !DATAVERSE_UPDATES.has(node.operationId ?? '')) continue;
      const entity = asString(node.parameters.entityName);
      if (!entity || !sameTable(table, entity)) continue;
      const changed = Object.keys(node.parameters)
        .filter((key) => key.startsWith('item/'))
        .map((key) => key.slice('item/'.length).toLowerCase());
      // Filtering columns guard the loop when the update changes none of them.
      if (watched.length > 0 && !changed.some((c) => watched.includes(c))) continue;
      const sameRow = collectStrings(node.parameters.recordId).some((t) => TRIGGER_REF.test(t));
      updates.push({ node, confidence: filtered ? 0.5 : sameRow ? 0.8 : 0.6 });
    }
  } else if (
    trigger.connector === SHAREPOINT &&
    SHAREPOINT_UPDATE_TRIGGERS.has(trigger.operationId ?? '')
  ) {
    const site = asString(trigger.parameters.dataset);
    const list = asString(trigger.parameters.table);
    if (!site || !list) return [];
    for (const node of tree.all) {
      if (node.connector !== SHAREPOINT || node.operationId !== SHAREPOINT_UPDATE) continue;
      if (node.parameters.dataset !== site || node.parameters.table !== list) continue;
      updates.push({ node, confidence: 0.8 });
    }
  }
  return updates;
}

export const REL07: Rule = {
  id: 'REL07',
  category: 'reliability',
  severity: 'high',
  confidence: 0.8,
  title: 'Flow can trigger itself',
  why: 'The flow runs when a row or item is modified, and then modifies the same table or list. Each update can start a new run, which updates again: an infinite loop that burns through request limits and can get the flow throttled or turned off.',
  fix: "Add a trigger condition that is false once the flow has done its work (for example, run only when the status isn't already the value the flow sets). For Dataverse, you can also set Select columns on the trigger to columns this step doesn't change.",
  example: {
    before:
      'When a row is modified  Table: Orders\nUpdate a row  Orders, ID: triggerOutputs()…  Status: Processed',
    after:
      "When a row is modified  Table: Orders  Select columns: amount\n  Trigger condition: @not(equals(triggerOutputs()?['body/status'], 'Processed'))",
  },
  docs: [DOCS.antiPatterns, DOCS.dataverseTrigger],
  check({ tree }) {
    const matches: RuleMatch[] = [];
    for (const trigger of tree.triggers) {
      for (const { node, confidence } of selfUpdates(tree, trigger)) {
        const what = trigger.kind === 'dataverse' ? 'rows of the table' : 'items of the list';
        matches.push({
          target: actionTarget(node),
          message: `${q(node.name)} updates ${what} that triggers this flow, and the trigger has no condition or column filter that skips this change: each run can start the next one.`,
          confidence,
        });
      }
    }
    return matches;
  },
};

const FAILURE_ONLY = (node: ActionNode): boolean => {
  const statuses = Object.values(node.runAfter).flat();
  return (
    statuses.some((s) => FAILURE_STATUS.test(s)) && !statuses.some((s) => /^succeeded$/i.test(s))
  );
};

/** The actions in the same branch as `node` that run after it, directly or not. */
function runsAfter(tree: FlowTree, node: ActionNode): ActionNode[] {
  const parent = node.parentName !== undefined ? tree.byName.get(node.parentName) : undefined;
  const siblings = (parent ? parent.children : tree.actions).filter(
    (n) => n.branch === node.branch,
  );
  const after = new Set([node.name]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const sibling of siblings) {
      if (after.has(sibling.name)) continue;
      if (Object.keys(sibling.runAfter).some((dep) => after.has(dep))) {
        after.add(sibling.name);
        grew = true;
      }
    }
  }
  return siblings.filter((n) => n.name !== node.name && after.has(n.name));
}

/** Terminate that ends the run as Failed or Cancelled, or a Response back to the caller. */
function reportsFailure(node: ActionNode): boolean {
  if (node.kind === 'response') return true;
  if (node.kind !== 'terminate') return false;
  const status = asString(asObject(node.inputs).runStatus)?.toLowerCase();
  return status === 'failed' || status === 'cancelled';
}

export const REL08: Rule = {
  id: 'REL08',
  category: 'reliability',
  severity: 'medium',
  confidence: 0.5,
  title: 'Failed runs show as Succeeded',
  why: "When a Catch step handles an error and the flow then ends normally, the run is marked Succeeded. Run history, failure alerts and anyone monitoring the flow won't see that it failed.",
  fix: 'End the error path with Terminate, Status: Failed (with the error message), so the run shows as failed. Child flows can instead return the error with a Response.',
  example: {
    before: 'Scope Catch  (run after Try failed)\n  └ Send an email',
    after:
      "Scope Catch  (run after Try failed)\n  ├ Send an email\n  └ Terminate  Status: Failed  Message: result('Try')…",
  },
  docs: [DOCS.errorHandling],
  check({ tree }) {
    // Flows called over HTTP or as child flows report failures through their Response.
    const request = tree.triggers.some((t) => t.kind === 'request');
    if (request && tree.all.some((n) => n.kind === 'response')) return [];
    const silent = tree.all.filter((handler) => {
      if (!FAILURE_ONLY(handler)) return false;
      // Handling each item's error and carrying on is usually on purpose.
      if (ancestors(tree, handler).some((a) => a.kind === 'foreach' || a.kind === 'until')) {
        return false;
      }
      const path = [handler, ...runsAfter(tree, handler)];
      return !path.some((n) => reportsFailure(n) || descendants(n).some(reportsFailure));
    });
    const first = silent[0];
    if (!first) return [];
    const others =
      silent.length > 1 ? ` (and ${plural(silent.length - 1, 'other error path')})` : '';
    return [
      {
        target: actionTarget(first),
        message: `${q(first.name)} handles a failure${others}, but nothing after it ends the run as Failed, so failed runs show as Succeeded.`,
      },
    ];
  },
};

/** `body('X')…[0]` and `outputs('X')…?[0]`: the first item of an action's output. */
const FIRST_ITEM =
  /\b(?:body|outputs)\(\s*'((?:[^']|'')+)'\s*\)((?:\??\[\s*'[^']*'\s*\])*)(\?)?\[\s*0\s*\]/g;
const EMPTY_CHECK = /\b(?:empty|length)\(/;

/** True when an action's output (at `path`) is a list of records. */
function isList(tree: FlowTree, name: string, path: string): boolean {
  const source = tree.byName.get(name);
  if (!source) return false;
  if (listOperation(source.connector, source.operationId)) return true;
  if (['query', 'select'].includes(source.type.toLowerCase())) return true;
  return /\[\s*'(?:body\/)?value'\s*\]\s*$/.test(path);
}

export const REL09: Rule = {
  id: 'REL09',
  category: 'reliability',
  severity: 'medium',
  confidence: 0.6,
  title: 'First item read without checking the list',
  why: 'A query can return no rows. Reading its first item with [0] then has nothing to read: the step fails, or later steps carry on with an empty value. This often only shows up in production, on the day the data is missing.',
  fix: "Use first() and handle the empty case: if(empty(outputs('List_rows')?['body/value']), <fallback>, first(outputs('List_rows')?['body/value'])?['name']). Or check length() in a Condition before the steps that need the row.",
  example: {
    before: "outputs('List_rows')?['body/value']?[0]?['name']",
    after:
      "Condition  length(outputs('List_rows')?['body/value']) is greater than 0\n  └ Yes: first(outputs('List_rows')?['body/value'])?['name']",
  },
  docs: [DOCS.expressions, DOCS.errorHandling],
  check({ tree }) {
    const bySource = new Map<string, { nodes: ActionNode[]; unguarded: boolean }>();
    for (const node of tree.all) {
      const guards = new Set(
        ancestors(tree, node)
          .filter((a) => a.kind === 'condition' || a.kind === 'switch')
          .flatMap((a) => a.references),
      );
      for (const text of collectStrings(ownExpressions(node.kind, node.raw))) {
        if (!text.includes('[') || EMPTY_CHECK.test(text)) continue;
        for (const [, rawName = '', path = '', safe] of text.matchAll(FIRST_ITEM)) {
          const name = rawName.replace(/''/g, "'");
          if (guards.has(name) || !isList(tree, name, path)) continue;
          const entry = bySource.get(name) ?? { nodes: [], unguarded: false };
          if (!entry.nodes.includes(node)) entry.nodes.push(node);
          if (!safe) entry.unguarded = true;
          bySource.set(name, entry);
        }
      }
    }
    return [...bySource].map(([source, { nodes, unguarded }]): RuleMatch => {
      const [first] = nodes as [ActionNode];
      const where =
        nodes.length === 1
          ? q(first.name)
          : `${plural(nodes.length, 'step')} (${nodes
              .slice(0, 3)
              .map((n) => q(n.name))
              .join(', ')}${nodes.length > 3 ? '…' : ''})`;
      return {
        target: actionTarget(first),
        message: `${where} ${nodes.length === 1 ? 'reads' : 'read'} the first item of ${q(source)} with [0] without checking that it returned anything.`,
        confidence: unguarded ? 0.6 : 0.5,
      };
    });
  },
};

const PAGE_FIX: Record<string, string> = {
  [SHAREPOINT]:
    "Set Top Count to the number of items you need (up to 5,000), or turn on Pagination in the step's Settings with a threshold above the list size. On lists over 5,000 items, filtered queries also need Pagination, or they can return nothing.",
  [DATAVERSE]:
    "Turn on Pagination in the step's Settings with a threshold above the number of rows you expect, or narrow the query with Filter rows so it stays well under 5,000.",
};

export const REL10: Rule = {
  id: 'REL10',
  category: 'reliability',
  severity: 'medium',
  confidence: 0.7,
  title: 'List query silently stops at its default page',
  why: 'Without a row limit or pagination, a list query returns only its first page: 100 items for SharePoint Get items, 256 rows for Excel, 5,000 rows for Dataverse. The rest are left out with no error, so the flow quietly skips data as the list grows.',
  fix: "Set Top Count / Row count to what you need, or turn on Pagination in the step's Settings with a threshold above the number of items you expect.",
  example: {
    before: 'Get items  List: Orders\n→ first 100 items only',
    after:
      'Get items  List: Orders  Top Count: 5000\n(or Settings → Pagination on, threshold 20,000)',
  },
  docs: [DOCS.sharePointGetItems, DOCS.listRows],
  check({ tree }) {
    const matches: RuleMatch[] = [];
    for (const node of tree.all) {
      const page = node.connector
        ? DEFAULT_PAGE_SIZE[node.connector]?.[node.operationId ?? '']
        : undefined;
      const op = listOperation(node.connector, node.operationId);
      if (!page || !op || node.settings.paginationMinItems !== undefined) continue;
      if (op.topParams.some((key) => hasValue(node.parameters[key]))) continue;
      const filtered = op.filterParams.some((key) => hasValue(node.parameters[key]));
      let confidence = filtered ? 0.5 : 0.7;
      if (node.connector === DATAVERSE) {
        // 5,000 rows is plenty for most queries: only flag lists the flow loops over.
        if (hasValue(node.parameters.fetchXml)) continue;
        const looped = tree.all.some(
          (n) => n.kind === 'foreach' && n.references.includes(node.name),
        );
        if (!looped) continue;
        confidence = filtered ? 0.3 : 0.4;
      }
      const fix = node.connector ? PAGE_FIX[node.connector] : undefined;
      matches.push({
        target: actionTarget(node),
        message: `${q(node.name)} (${connectorName(node.connector)} ${op.label}) returns at most ${page.toLocaleString('en-US')} ${node.connector === SHAREPOINT ? 'items' : 'rows'}: no row limit or pagination is set, so anything beyond that is silently left out.`,
        confidence,
        ...(fix ? { fix } : {}),
      });
    }
    return matches;
  },
};

export const RELIABILITY_RULES: Rule[] = [
  REL01,
  REL02,
  REL03,
  REL04,
  REL05,
  REL07,
  REL08,
  REL09,
  REL10,
];
