import {
  DATAVERSE,
  OFFICE365_USERS,
  SHAREPOINT,
  connectorName,
  listOperation,
  singleReadOperation,
} from '../connectors.ts';
import { descendants, enclosingLoops, isConcurrentLoop, singleRowSource } from '../parser.ts';
import { hasUnreadableReferences } from '../expressions.ts';
import type { ActionNode, FlowTree } from '../types.ts';
import { DOCS, actionTarget, isIo, plural, q, type Rule, type RuleMatch } from './rule.ts';

/** True when the outermost loop around an action runs its items in parallel. */
export function runsInParallel(tree: FlowTree, node: ActionNode): boolean {
  const loops = enclosingLoops(tree, node);
  const outermost = loops[loops.length - 1];
  return outermost !== undefined && isConcurrentLoop(outermost);
}

/**
 * True when an action's inputs change from one loop item to the next: they use the loop item,
 * the output of another action inside the loop, or a variable written inside the loop.
 */
export function dependsOnIteration(tree: FlowTree, node: ActionNode): boolean {
  const loops = enclosingLoops(tree, node);
  const outermost = loops[loops.length - 1];
  if (!outermost) return false;
  if (node.usesItem || node.loopItemRefs.length > 0) return true;
  // If some references can't be read or point nowhere, don't claim the inputs are the same on every item.
  if (hasUnreadableReferences(node.inputs)) return true;
  if (node.references.some((name) => !tree.byName.has(name))) return true;
  const inside = descendants(outermost);
  const insideNames = new Set(inside.map((n) => n.name));
  if (node.references.some((name) => insideNames.has(name))) return true;
  const written = new Set(inside.filter((n) => n.kind === 'variable-write').map((n) => n.variable));
  return node.variableRefs.some((name) => written.has(name));
}

function names(nodes: ActionNode[], max = 3): string {
  const shown = nodes.slice(0, max).map((n) => q(n.name));
  return nodes.length > max
    ? `${shown.join(', ')} and ${nodes.length - max} more`
    : shown.join(', ');
}

export const SPD01: Rule = {
  id: 'SPD01',
  category: 'speed',
  severity: 'high',
  confidence: 0.8,
  usesRunData: true,
  title: 'Loop runs one item at a time',
  why: 'Apply to each runs its items one after another unless concurrency is turned on. Every connector or HTTP call in the loop waits for the previous item to finish, so the loop takes roughly items × call time.',
  fix: "Open the loop's Settings, turn on Concurrency control and set the degree of parallelism (start around 10–20; the maximum is 50). Only do this when items don't depend on each other and the target system can handle parallel calls. Concurrency only applies to the outermost loop.",
  example: {
    before: 'Apply to each  (concurrency off)\n  └ Update a row      1,000 items × 300 ms ≈ 5 min',
    after:
      'Apply to each  (concurrency 20)\n  └ Update a row      ≈ 15 s\n\n"runtimeConfiguration": { "concurrency": { "repetitions": 20 } }',
  },
  docs: [DOCS.parallel, DOCS.limits],
  check({ tree }) {
    const matches: RuleMatch[] = [];
    for (const loop of tree.all) {
      if (loop.kind !== 'foreach' || isConcurrentLoop(loop)) continue;
      // Concurrency only takes effect on the outermost loop.
      if (enclosingLoops(tree, loop).length > 0) continue;
      // A loop over a single row is SPD10's problem, not a speed-up opportunity.
      if (singleRowSource(tree, loop)) continue;
      const inner = descendants(loop);
      const calls = inner.filter(isIo);
      if (calls.length === 0) continue;
      const writes = inner.filter((n) => n.kind === 'variable-write');
      const setToOne = loop.settings.concurrency === 1 || loop.settings.sequential === true;
      matches.push({
        target: actionTarget(loop),
        message: `${q(loop.name)} runs its items one at a time${setToOne ? ' (concurrency is set to 1)' : ''}, and every item waits for ${plural(calls.length, 'call')}: ${names(calls)}.`,
        confidence: writes.length > 0 || setToOne ? 0.6 : 0.8,
        ...(writes.length > 0
          ? {
              blockedBy: ['SPD02'],
              fix: `First replace the variable writes inside this loop (${names(writes)}; see SPD02): with concurrency on they would give wrong results. Then turn on Concurrency control in the loop's Settings.`,
            }
          : {}),
      });
    }
    return matches;
  },
};

const VARIABLE_FIX: Record<string, string> = {
  appendtoarrayvariable:
    "Build the array in one action: a Select on the loop's source (map each item to the value), with a Filter array first if only some items belong. Use union() to merge with values you already have.",
  appendtostringvariable:
    "Build the text in one action: a Select on the loop's source that maps each item to its text, then join(body('Select'), ', ').",
  incrementvariable:
    "Count in one action: a Filter array on the loop's source, then length(body('Filter_array')).",
  decrementvariable:
    "Count in one action: a Filter array on the loop's source, then length(body('Filter_array')).",
  setvariable:
    'Keep per-item values in a Compose inside the loop (each item gets its own). If you need one result across all items, work it out after the loop with Select or Filter array.',
};

export const SPD02: Rule = {
  id: 'SPD02',
  category: 'speed',
  severity: 'medium',
  confidence: 0.7,
  title: 'Variable written inside a loop',
  why: 'Each variable write is an extra action for every item, and variables force the loop to run one item at a time (in a parallel loop they give wrong results). Data operations build the same result in a single action.',
  fix: 'Build arrays with Select (or Filter array + Select) on the loop\'s source instead of "Append to array variable", join text with join(), count with length(). Keep per-item values in a Compose inside the loop.',
  example: {
    before:
      "Apply to each  outputs('List_rows')?['body/value']\n  └ Append to array variable  Emails = item()?['emailaddress1']",
    after:
      "Select  From: outputs('List_rows')?['body/value']\n        Map:  item()?['emailaddress1']\n→ one action, no loop",
  },
  docs: [DOCS.dataOperations, DOCS.parallel],
  check({ tree }) {
    // One finding per loop, listing the writes a data operation could replace.
    const byLoop = new Map<ActionNode, ActionNode[]>();
    for (const node of tree.all) {
      if (node.kind !== 'variable-write') continue;
      const loops = enclosingLoops(tree, node);
      const loop = loops[0];
      // In a parallel loop this is a race condition, reported by REL01.
      if (!loop || runsInParallel(tree, node)) continue;
      // A value that comes from a call made in the loop can't be built with Select.
      const outermost = loops[loops.length - 1] ?? loop;
      const loopCalls = new Set(
        descendants(outermost)
          .filter(isIo)
          .map((n) => n.name),
      );
      if (node.references.some((name) => loopCalls.has(name))) continue;
      byLoop.set(loop, [...(byLoop.get(loop) ?? []), node]);
    }
    return [...byLoop].map(([loop, writes]): RuleMatch => {
      const variables = [...new Set(writes.map((w) => `"${w.variable ?? w.name}"`))];
      const types = new Set(writes.map((w) => w.type.toLowerCase()));
      const fix = types.size === 1 ? VARIABLE_FIX[[...types][0] ?? ''] : undefined;
      return {
        target: actionTarget(loop),
        message: `${q(loop.name)} writes ${variables.length === 1 ? 'variable' : 'variables'} ${variables.join(', ')} on every item (${names(writes)}).`,
        ...(fix ? { fix } : {}),
      };
    });
  },
};

const PER_ITEM_READ_FIX: Record<string, string> = {
  [DATAVERSE]:
    'Before the loop, get every row you need with one List rows (Filter rows on the IDs you need, or Expand Query on the first query to bring related rows along). Inside the loop, pick the row with Filter array, which runs in memory with no connector call.',
  [SHAREPOINT]:
    'Before the loop, get the items once with Get items (Filter Query and Top Count). Inside the loop, pick the item with Filter array, which runs in memory with no connector call.',
  [OFFICE365_USERS]:
    'Look up each distinct user only once: collect the distinct emails with Select and union(), look those up, or read the fields from the source data if they are already there.',
};

export const SPD03: Rule = {
  id: 'SPD03',
  category: 'speed',
  severity: 'high',
  confidence: 0.85,
  usesRunData: true,
  title: 'Data read one item at a time inside a loop',
  why: 'Reading one record per item, or running a query per item, makes one call for every item: slow, and every call counts toward request limits and throttling.',
  fix: 'Read all the data you need once, before the loop: one list query with a filter (or $expand to bring related rows), then pick the matching record inside the loop with Filter array.',
  example: {
    before:
      "Apply to each  orders\n  └ Get a row  Accounts, ID: items('Apply_to_each')?['_customerid_value']\n→ one Dataverse call per order",
    after:
      "List rows  Accounts  Select columns: accountid,name  Filter rows: <the accounts you need>\nApply to each  orders\n  └ Filter array  accountid = items('Apply_to_each')?['_customerid_value']\n→ one Dataverse call in total",
  },
  docs: [DOCS.relevantData, DOCS.listRows, DOCS.understandLimits],
  check({ tree }) {
    const matches: RuleMatch[] = [];
    for (const node of tree.all) {
      if (node.kind !== 'connector' && node.kind !== 'http') continue;
      const loop = enclosingLoops(tree, node)[0];
      if (!loop) continue;
      const perItem = dependsOnIteration(tree, node);
      const single = singleReadOperation(node.connector, node.operationId);
      const list = listOperation(node.connector, node.operationId);
      const what = `${q(node.name)} (${connectorName(node.connector)} ${single ?? list?.label ?? ''})`;
      const fix = node.connector ? PER_ITEM_READ_FIX[node.connector] : undefined;
      const common = { target: actionTarget(node), ...(fix ? { fix } : {}) };
      if ((single || list) && !perItem) {
        matches.push({
          target: actionTarget(node),
          message: `${what} runs the same query for every item of ${q(loop.name)}: nothing in it changes from one item to the next.`,
          fix: 'Run the query once, before the loop, and use its result inside the loop. Keep it inside only if the loop itself changes the data it reads.',
          confidence: 0.6,
        });
      } else if (single) {
        matches.push({
          ...common,
          message: `${what} runs once for every item of ${q(loop.name)}.`,
          confidence: 0.9,
        });
      } else if (list) {
        matches.push({
          ...common,
          message: `${what} runs a separate query for every item of ${q(loop.name)} (N+1 queries).`,
        });
      } else if (perItem && (node.method ?? (node.kind === 'http' ? 'get' : '')) === 'get') {
        matches.push({
          ...common,
          message: `${q(node.name)} makes a GET request for every item of ${q(loop.name)}. If the API can return many records in one call, use that before the loop instead.`,
          severity: 'medium',
          confidence: 0.5,
        });
      }
    }
    return matches;
  },
};

export const SPD04: Rule = {
  id: 'SPD04',
  category: 'speed',
  severity: 'medium',
  confidence: 0.6,
  title: 'Loop inside a loop',
  why: 'Inner loops always run one item at a time, and everything inside them runs outer items × inner items times. Nested loops are often the biggest source of actions and run time in a flow.',
  fix: 'Flatten the data first so one loop (or none) does the work: Select or xpath() to turn nested arrays into one list, or $expand / one query for all child rows. If both levels are needed, keep the heavy work in the outer loop, which can run in parallel.',
  example: {
    before:
      'Apply to each  orders            (100 items)\n  └ Apply to each  order lines   (10 each)\n       └ Compose             → 1,000 actions, one at a time',
    after:
      'List rows  order lines  (one query for all the orders)\nSelect     map each line  → 2 actions',
  },
  docs: [DOCS.dataOperations, DOCS.parallel],
  check({ tree }) {
    const matches: RuleMatch[] = [];
    for (const loop of tree.all) {
      if (loop.kind !== 'foreach') continue;
      const outer = enclosingLoops(tree, loop)[0];
      if (!outer) continue;
      const inner = descendants(loop);
      if (inner.length === 0) continue;
      matches.push({
        target: actionTarget(loop),
        message: `${q(loop.name)} is inside ${q(outer.name)}. It always runs one item at a time, and its ${plural(inner.length, 'action')} ${inner.length === 1 ? 'runs' : 'run'} for every outer item × inner item.`,
        severity: inner.some(isIo) ? 'medium' : 'low',
      });
    }
    return matches;
  },
};

export const SPD07: Rule = {
  id: 'SPD07',
  category: 'speed',
  severity: 'high',
  confidence: 0.8,
  usesRunData: true,
  title: 'Child flow called inside a loop',
  why: 'Each child flow call starts a whole new flow run and waits for its response. Calling it once per item multiplies the run time and the actions counted.',
  fix: 'Pass the whole array to the child flow in one call and let it process the batch, or bring the logic into this flow with data operations.',
  example: {
    before: 'Apply to each  (500 items)\n  └ Run a Child Flow   → 500 child runs',
    after: "Run a Child Flow  Items: outputs('List_rows')?['body/value']   → 1 child run",
  },
  docs: [DOCS.childFlows, DOCS.limits],
  check({ tree }) {
    const matches: RuleMatch[] = [];
    for (const node of tree.all) {
      if (node.kind !== 'child-flow') continue;
      const loop = enclosingLoops(tree, node)[0];
      if (!loop) continue;
      matches.push({
        target: actionTarget(node),
        message: `${q(node.name)} starts a child flow run for every item of ${q(loop.name)}.`,
      });
    }
    return matches;
  },
};

export const SPD08: Rule = {
  id: 'SPD08',
  category: 'speed',
  severity: 'medium',
  confidence: 0.7,
  title: 'Polling with Do until and Delay',
  why: 'A Do until loop with a Delay keeps the run alive and spends actions on every check, often for nothing.',
  fix: 'Wait for the event instead: a trigger on the thing you are waiting for, an approval or webhook action, or at least a longer delay with explicit loop limits.',
  example: {
    before:
      "Do until  status = 'Done'\n  ├ Get a row\n  └ Delay 1 minute        → up to 60 checks per run",
    after: 'Separate flow: When a row is modified  (Select columns: status)',
  },
  docs: [DOCS.triggers, DOCS.antiPatterns],
  check({ tree }) {
    const matches: RuleMatch[] = [];
    for (const loop of tree.all) {
      if (loop.kind !== 'until') continue;
      const wait = descendants(loop).find((n) => n.kind === 'wait');
      if (!wait) continue;
      matches.push({
        target: actionTarget(loop),
        message: `${q(loop.name)} polls: it waits with ${q(wait.name)} and checks again until its condition is met.`,
      });
    }
    return matches;
  },
};

export const SPD10: Rule = {
  id: 'SPD10',
  category: 'speed',
  severity: 'low',
  confidence: 0.9,
  title: 'Loop over a single row',
  why: 'The query returns at most one row, but the designer wrapped the next steps in Apply to each. The loop adds actions and makes the steps inside harder to reference.',
  fix: "Remove the loop and read the row with first(), for example first(outputs('List_rows')?['body/value'])?['name'].",
  example: {
    before: 'List rows  (Row count 1)\nApply to each\n  └ Update a row',
    after:
      "List rows  (Row count 1)\nUpdate a row  ID: first(outputs('List_rows')?['body/value'])?['accountid']",
  },
  docs: [DOCS.antiPatterns],
  check({ tree }) {
    const matches: RuleMatch[] = [];
    for (const loop of tree.all) {
      if (loop.kind !== 'foreach') continue;
      const source = singleRowSource(tree, loop);
      if (!source) continue;
      matches.push({
        target: actionTarget(loop),
        message: `${q(loop.name)} loops over ${q(source.name)}, which returns at most one row (Row count 1).`,
      });
    }
    return matches;
  },
};

export const SPEED_RULES: Rule[] = [SPD01, SPD02, SPD03, SPD04, SPD07, SPD08, SPD10];
