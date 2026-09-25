import { singleRowSource } from './parser.ts';
import type { ActionNode, FlowTree } from './types.ts';

export interface EstimateOptions {
  /** Iterations assumed for an Apply to each without measured data. */
  foreachIterations?: number;
  /** Iterations assumed for a Do until without measured data. */
  untilIterations?: number;
  /** Measured median iterations per loop name (from run data). */
  iterations?: Record<string, number>;
}

export interface ActionEstimate {
  /** Actions executed in one run, including the trigger. */
  total: number;
  /** True when at least one loop used an assumed iteration count. */
  assumed: boolean;
}

export const DEFAULT_FOREACH_ITERATIONS = 50;
export const DEFAULT_UNTIL_ITERATIONS = 10;

/**
 * Estimates how many actions one run executes. Conditions and switches count their largest
 * branch; loops multiply their contents by the measured or assumed iteration count.
 */
export function estimateActionsPerRun(
  tree: FlowTree,
  options: EstimateOptions = {},
): ActionEstimate {
  let assumed = false;

  const iterationsOf = (loop: ActionNode): number => {
    const measured = options.iterations?.[loop.name];
    if (measured !== undefined) return measured;
    if (loop.kind === 'foreach' && singleRowSource(tree, loop)) return 1;
    assumed = true;
    return loop.kind === 'until'
      ? (options.untilIterations ?? DEFAULT_UNTIL_ITERATIONS)
      : (options.foreachIterations ?? DEFAULT_FOREACH_ITERATIONS);
  };

  const countList = (nodes: ActionNode[]): number =>
    nodes.reduce((sum, n) => sum + countNode(n), 0);

  const largestBranch = (node: ActionNode): number => {
    const branches = new Map<string, ActionNode[]>();
    for (const child of node.children) {
      const key = child.branch ?? 'actions';
      branches.set(key, [...(branches.get(key) ?? []), child]);
    }
    return Math.max(0, ...[...branches.values()].map(countList));
  };

  const countNode = (node: ActionNode): number => {
    switch (node.kind) {
      case 'foreach':
      case 'until':
        return 1 + iterationsOf(node) * countList(node.children);
      case 'condition':
      case 'switch':
        return 1 + largestBranch(node);
      default:
        return 1 + countList(node.children);
    }
  };

  const total = tree.triggers.length + countList(tree.actions);
  return { total: Math.round(total), assumed };
}
