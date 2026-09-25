import { descendants, enclosingLoops, isConcurrentLoop } from '../parser.ts';
import type { ActionNode } from '../types.ts';
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
    if (tree.maxDepth >= MAX_DEPTH - 1) {
      const deepest = tree.all.find((n) => n.depth === tree.maxDepth);
      if (deepest) {
        matches.push({
          target: actionTarget(deepest),
          message: `${q(deepest.name)} is nested ${tree.maxDepth} levels deep; the limit is ${MAX_DEPTH}.`,
        });
      }
    }
    return matches;
  },
};

export const RELIABILITY_RULES: Rule[] = [REL01, REL02, REL04, REL05];
