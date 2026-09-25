import {
  ancestors,
  docLabel,
  getRule,
  label,
  type ActionNode,
  type FindingEvidence,
  type FindingTarget,
  type FlowAnalysis,
  type FlowTree,
  type RunSampleMode,
} from '@cfa/core';
import type { FlowRef } from './flow-url.ts';

/** One step on the way to a finding's target: its kind and which branch of its parent holds it. */
export interface PathStep {
  name: string;
  /** Action kind (`scope`, `foreach`, `condition`, `switch`…) or `trigger`. */
  kind: string;
  /** `actions` / `else` (Condition), `case:<name>` / `default` (Switch), `actions` elsewhere. */
  branch?: string;
}

/** One finding, with the rule's texts, ready for the in-page pane. Plain data only. */
export interface PaneFinding {
  ruleId: string;
  title: string;
  category: string;
  severity: 'high' | 'medium' | 'low';
  confidence: number;
  target: FindingTarget;
  /** Designer-style name of the target, e.g. "Get a row", or "Whole flow". */
  targetLabel: string;
  /** The target's path with kinds and branches, to open collapsed branches in the designer. */
  steps: PathStep[];
  message: string;
  why: string;
  fix: string;
  example?: { before: string; after: string };
  /** Microsoft docs, with readable titles. */
  docs: { url: string; title: string }[];
  /** The rule's page on the project site. */
  ruleUrl: string;
  blockedBy?: string[];
  /** What recent runs measured (time share, loop items), when runs were analysed. */
  evidence?: FindingEvidence;
}

/** An action shown in the runs summary, with what the pane needs to reveal it. */
export interface PaneRunTarget {
  target: FindingTarget;
  targetLabel: string;
  steps: PathStep[];
}

export const SITE_URL = 'https://leduc212.github.io/cloud-flow-analyzer/';

/** A rule's section on the rules page of the project site. */
export function ruleDocsUrl(ruleId: string): string {
  return `${SITE_URL}rules.html#${ruleId}`;
}

/** What the worker read about the runs, besides the samples themselves. */
export interface RunsFetched {
  mode: RunSampleMode;
  listed: number;
  picked: number;
  fromCache: number;
  cancelled: boolean;
  runsPerDay?: number;
  dailyRequestLimit?: number;
}

export interface PaneRuns {
  mode: RunSampleMode;
  /** Finished runs analysed. */
  sampled: number;
  /** Runs listed (finished or not). */
  listed: number;
  /** Finished runs picked to be read (more than `sampled` when the user stopped early). */
  picked: number;
  cancelled: boolean;
  fromCache: number;
  runsPerDay?: number;
  /** Requests per run, counted from the runs. */
  actionsPerRun?: { mean: number; p50: number };
  dailyRequestLimit?: number;
  statuses: Record<string, number>;
  durationP50Ms: number;
  durationP95Ms: number;
  /** Where the time goes: the busiest actions and loops. */
  slowest: (PaneRunTarget & {
    /** Share of the run time; only for actions outside loops (and loops themselves). */
    timeSharePct?: number;
    busyP50Ms: number;
    /** Executions per run for actions inside loops. */
    executionsPerRun?: number;
  })[];
  loops: (PaneRunTarget & {
    iterationsP50: number;
    iterationsMax: number;
    truncated: boolean;
    nested: boolean;
  })[];
  failures: (PaneRunTarget & { failed: number; throttled: number })[];
}

export interface PaneResult {
  ref: FlowRef;
  displayName: string;
  grade: string;
  overall: number;
  categories: { speed: number; resources: number; reliability: number; security: number };
  actionCount: number;
  estimate: { total: number; assumed: boolean };
  findings: PaneFinding[];
  /** Trigger and action names in designer order (top to bottom), to find actions off-screen. */
  order: string[];
  warnings: string[];
  analysedAt: string;
  runs?: PaneRuns;
  /** Why the runs couldn't be read, when the user asked for them. */
  runsError?: string;
  /** The daily request limit the user set, if any. */
  dailyRequestLimit?: number;
}

function steps(tree: FlowTree, path: string[]): PathStep[] {
  return path.map((name): PathStep => {
    const node = tree.byName.get(name);
    if (!node) return { name, kind: 'trigger' };
    return { name, kind: node.kind, ...(node.branch ? { branch: node.branch } : {}) };
  });
}

function runTarget(tree: FlowTree, node: ActionNode): PaneRunTarget {
  return {
    target: { kind: 'action', name: node.name, path: node.path },
    targetLabel: label(node.name),
    steps: steps(tree, node.path),
  };
}

const CONTAINERS = new Set(['scope', 'condition', 'switch']);
const isLoop = (node: ActionNode) => node.kind === 'foreach' || node.kind === 'until';

/** The runs summary shown in the pane: time, loop sizes, failures. */
export function buildPaneRuns(analysis: FlowAnalysis, fetched: RunsFetched): PaneRuns | undefined {
  const { tree, runStats } = analysis;
  if (!runStats) return undefined;
  const nodes = tree.all;
  const slowest = nodes
    .filter((n) => !CONTAINERS.has(n.kind))
    .flatMap((node) => {
      const stats = runStats.actions.get(node.name);
      if (!stats || stats.runs === 0 || stats.busyP50Ms === 0) return [];
      const inLoop = ancestors(tree, node).some(isLoop);
      return [
        {
          ...runTarget(tree, node),
          ...(stats.timeSharePct !== undefined ? { timeSharePct: stats.timeSharePct } : {}),
          busyP50Ms: stats.busyP50Ms,
          ...(inLoop ? { executionsPerRun: Math.round(stats.executions / stats.runs) } : {}),
        },
      ];
    })
    .sort((a, b) => b.busyP50Ms - a.busyP50Ms)
    .slice(0, 6);
  const loops = nodes.filter(isLoop).flatMap((node) => {
    const stats = runStats.loops.get(node.name);
    if (!stats) return [];
    return [
      {
        ...runTarget(tree, node),
        iterationsP50: stats.iterationsP50,
        iterationsMax: stats.iterationsMax,
        truncated: stats.truncated,
        nested: ancestors(tree, node).some(isLoop),
      },
    ];
  });
  const failures = nodes
    .flatMap((node) => {
      const stats = runStats.actions.get(node.name);
      if (!stats || (stats.failed === 0 && stats.throttled === 0)) return [];
      return [{ ...runTarget(tree, node), failed: stats.failed, throttled: stats.throttled }];
    })
    // Scopes fail when something inside them fails: show the action that failed.
    .filter((f) => !CONTAINERS.has(tree.byName.get(f.target.name ?? '')?.kind ?? ''))
    .sort((a, b) => b.failed + b.throttled - (a.failed + a.throttled))
    .slice(0, 5);
  const perRun = runStats.actionsPerRun;
  return {
    mode: fetched.mode,
    sampled: runStats.sampled,
    listed: fetched.listed,
    picked: fetched.picked,
    cancelled: fetched.cancelled,
    fromCache: fetched.fromCache,
    ...(fetched.runsPerDay !== undefined ? { runsPerDay: fetched.runsPerDay } : {}),
    ...(perRun ? { actionsPerRun: { mean: perRun.mean, p50: perRun.p50 } } : {}),
    ...(fetched.dailyRequestLimit !== undefined
      ? { dailyRequestLimit: fetched.dailyRequestLimit }
      : {}),
    statuses: runStats.statuses,
    durationP50Ms: runStats.durationP50Ms,
    durationP95Ms: runStats.durationP95Ms,
    slowest,
    loops,
    failures,
  };
}

export function buildPaneResult(
  ref: FlowRef,
  analysis: FlowAnalysis,
  now = new Date(),
  runs?: RunsFetched | { error: string; dailyRequestLimit?: number },
): PaneResult {
  const paneRuns = runs && 'listed' in runs ? buildPaneRuns(analysis, runs) : undefined;
  const { tree, score, estimate, findings, warnings } = analysis;
  return {
    ref,
    displayName: tree.displayName ?? 'This flow',
    grade: score.grade,
    overall: score.overall,
    categories: {
      speed: score.categories.speed.score,
      resources: score.categories.resources.score,
      reliability: score.categories.reliability.score,
      security: score.categories.security.score,
    },
    actionCount: tree.actionCount,
    estimate,
    findings: findings.map((finding): PaneFinding => {
      const rule = getRule(finding.ruleId);
      return {
        ruleId: finding.ruleId,
        title: rule?.title ?? finding.ruleId,
        category: finding.category,
        severity: finding.severity,
        confidence: finding.confidence,
        target: finding.target,
        targetLabel: finding.target.name ? label(finding.target.name) : 'Whole flow',
        steps: steps(tree, finding.target.path),
        message: finding.message,
        why: rule?.why ?? '',
        fix: finding.fix ?? rule?.fix ?? '',
        ...(rule?.example ? { example: rule.example } : {}),
        docs: (rule?.docs ?? []).map((url) => ({ url, title: docLabel(url) })),
        ruleUrl: ruleDocsUrl(finding.ruleId),
        ...(finding.blockedBy ? { blockedBy: finding.blockedBy } : {}),
        ...(finding.evidence ? { evidence: finding.evidence } : {}),
      };
    }),
    order: [...tree.triggers.map((t) => t.name), ...tree.all.map((n) => n.name)],
    warnings,
    analysedAt: now.toISOString(),
    ...(paneRuns ? { runs: paneRuns } : {}),
    ...(runs && 'error' in runs ? { runsError: runs.error } : {}),
    ...(runs?.dailyRequestLimit !== undefined ? { dailyRequestLimit: runs.dailyRequestLimit } : {}),
  };
}
