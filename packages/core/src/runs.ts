import { asNumber, asObject, asString, isObject } from './definition.ts';
import { ancestors } from './parser.ts';
import type { ActionNode, FlowTree } from './types.ts';

/** One entry of a run's action list (`…/runs/{run}/actions`). */
export interface RunActionRecord {
  name: string;
  status: string;
  code?: string;
  startTime?: string;
  endTime?: string;
}

/** One execution of an action inside a loop (`…/actions/{action}/repetitions`). */
export interface RepetitionRecord {
  /** Loop iteration indexes, outermost loop first. */
  indexes: { scope: string; index: number }[];
  status: string;
  code?: string;
  startTime?: string;
  endTime?: string;
}

/** What was fetched for one run. */
export interface RunSample {
  name: string;
  status: string;
  startTime?: string;
  endTime?: string;
  actions: RunActionRecord[];
  /** Repetitions per action name, for the loop actions that were fetched. */
  repetitions: Record<string, RepetitionRecord[]>;
  /** Actions whose repetitions were cut off at the page limit. */
  truncated?: string[];
}

function errorCode(properties: Record<string, unknown>): string | undefined {
  const error = asObject(properties.error);
  return asString(properties.code) ?? asString(error.code);
}

/** Reads a run from the Power Automate API (`properties.startTime`…). */
export function readRun(raw: unknown): Omit<RunSample, 'actions' | 'repetitions'> {
  const record = asObject(raw);
  const p = asObject(record.properties);
  const startTime = asString(p.startTime);
  const endTime = asString(p.endTime);
  return {
    name: asString(record.name) ?? '',
    status: asString(p.status) ?? 'Unknown',
    ...(startTime ? { startTime } : {}),
    ...(endTime ? { endTime } : {}),
  };
}

export function readRunAction(raw: unknown): RunActionRecord {
  const record = asObject(raw);
  const p = asObject(record.properties);
  const code = errorCode(p);
  const startTime = asString(p.startTime);
  const endTime = asString(p.endTime);
  return {
    name: asString(record.name) ?? '',
    status: asString(p.status) ?? 'Unknown',
    ...(code ? { code } : {}),
    ...(startTime ? { startTime } : {}),
    ...(endTime ? { endTime } : {}),
  };
}

export function readRepetition(raw: unknown): RepetitionRecord {
  const p = asObject(asObject(raw).properties);
  const indexes = (Array.isArray(p.repetitionIndexes) ? p.repetitionIndexes : [])
    .filter(isObject)
    .map((i) => ({ scope: asString(i.scopeName) ?? '', index: asNumber(i.itemIndex) ?? 0 }));
  const code = errorCode(p);
  const startTime = asString(p.startTime);
  const endTime = asString(p.endTime);
  return {
    indexes,
    status: asString(p.status) ?? 'Unknown',
    ...(code ? { code } : {}),
    ...(startTime ? { startTime } : {}),
    ...(endTime ? { endTime } : {}),
  };
}

export interface ActionRunStats {
  name: string;
  /** Runs in which the action ran at least once (not skipped). */
  runs: number;
  /** Executions across all runs (one per loop iteration inside loops). */
  executions: number;
  /** Duration of one execution. */
  p50Ms: number;
  p95Ms: number;
  /** Time spent in the action per run (all its executions added up), median over runs. */
  busyP50Ms: number;
  /**
   * Share of the run's duration, median over runs. Only for actions outside loops, where the
   * action's own start and end times are real; for a loop, this is the whole loop.
   */
  timeSharePct?: number;
  failed: number;
  skipped: number;
  /** Executions that failed with 429 / TooManyRequests. */
  throttled: number;
}

export interface LoopRunStats {
  name: string;
  /** Iterations per run of the loop (per outer iteration for nested loops), over all runs. */
  iterationsP50: number;
  iterationsP95: number;
  iterationsMax: number;
  /** True when some repetitions were cut off, so the counts are lower bounds. */
  truncated: boolean;
}

export interface RunStats {
  /** Finished runs analysed. */
  sampled: number;
  statuses: Record<string, number>;
  durationP50Ms: number;
  durationP95Ms: number;
  actions: Map<string, ActionRunStats>;
  loops: Map<string, LoopRunStats>;
}

const FINISHED = new Set(['succeeded', 'failed', 'cancelled', 'timedout', 'terminated']);
const THROTTLED = /^(429|TooManyRequests)$/i;

export function isFinished(status: string): boolean {
  return FINISHED.has(status.toLowerCase());
}

function duration(start?: string, end?: string): number | undefined {
  if (!start || !end) return undefined;
  const ms = Date.parse(end) - Date.parse(start);
  return Number.isFinite(ms) && ms >= 0 ? ms : undefined;
}

/** Recorded API responses (capture file), rebuilt into run samples per flow ID. */
export function runSamplesFromResponses(
  responses: { url: string; body?: unknown }[],
): Map<string, RunSample[]> {
  const byFlow = new Map<string, Map<string, RunSample>>();
  // Repetition pages per run and action: [pages, pages with a nextLink].
  const pages = new Map<RunSample, Map<string, [number, number]>>();
  const runOf = (flow: string, name: string): RunSample => {
    const runs = byFlow.get(flow) ?? new Map<string, RunSample>();
    byFlow.set(flow, runs);
    const run = runs.get(name) ?? { name, status: 'Unknown', actions: [], repetitions: {} };
    runs.set(name, run);
    return run;
  };
  for (const { url, body } of responses) {
    const path = decodeURIComponent(url.split('?')[0] ?? '');
    const value = Array.isArray(asObject(body).value) ? (asObject(body).value as unknown[]) : [];
    const nextLink = asString(asObject(body).nextLink);
    let match = /\/flows\/([^/]+)\/runs$/.exec(path);
    if (match?.[1]) {
      for (const raw of value) Object.assign(runOf(match[1], readRun(raw).name), readRun(raw));
      continue;
    }
    match = /\/flows\/([^/]+)\/runs\/([^/]+)\/actions$/.exec(path);
    if (match?.[1] && match[2]) {
      runOf(match[1], match[2]).actions.push(...value.map(readRunAction));
      continue;
    }
    match = /\/flows\/([^/]+)\/runs\/([^/]+)\/actions\/([^/]+)\/repetitions$/.exec(path);
    if (match?.[1] && match[2] && match[3]) {
      const run = runOf(match[1], match[2]);
      const action = match[3];
      run.repetitions[action] = [...(run.repetitions[action] ?? []), ...value.map(readRepetition)];
      const counts = pages.get(run) ?? new Map<string, [number, number]>();
      const [fetched, withNext] = counts.get(action) ?? [0, 0];
      counts.set(action, [fetched + 1, withNext + (nextLink ? 1 : 0)]);
      pages.set(run, counts);
    }
  }
  // The last page still had a nextLink: the list was cut off.
  for (const [run, counts] of pages) {
    const truncated = [...counts].filter(([, [n, next]]) => next >= n).map(([name]) => name);
    if (truncated.length > 0) run.truncated = truncated;
  }
  return new Map([...byFlow].map(([flow, runs]) => [flow, [...runs.values()]]));
}

/** Nearest-rank percentile of unsorted numbers (0 for none). */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1] ?? 0;
}

function isLoop(node: ActionNode): boolean {
  return node.kind === 'foreach' || node.kind === 'until';
}

/**
 * Statistics over a sample of runs: per-action timings and failures, and loop iteration counts.
 * Actions inside loops are only measured through their repetitions: the run's action list shows
 * a misleading single entry for them.
 */
export function summariseRuns(tree: FlowTree, samples: RunSample[]): RunStats {
  const runs = samples.filter((s) => isFinished(s.status));
  const statuses: Record<string, number> = {};
  for (const run of runs) statuses[run.status] = (statuses[run.status] ?? 0) + 1;
  const runDurations = runs
    .map((r) => duration(r.startTime, r.endTime))
    .filter((d): d is number => d !== undefined);

  const inLoop = (node: ActionNode) => ancestors(tree, node).some(isLoop);
  const actions = new Map<string, ActionRunStats>();
  for (const node of tree.all) {
    const looped = inLoop(node);
    const durations: number[] = [];
    const busy: number[] = [];
    const shares: number[] = [];
    let ran = 0;
    let executions = 0;
    let failed = 0;
    let skipped = 0;
    let throttled = 0;
    for (const run of runs) {
      const records: (RunActionRecord | RepetitionRecord)[] = looped
        ? (run.repetitions[node.name] ?? [])
        : run.actions.filter((a) => a.name === node.name);
      let runBusy = 0;
      let executed = 0;
      for (const record of records) {
        const status = record.status.toLowerCase();
        if (status === 'skipped') {
          skipped += 1;
          continue;
        }
        executed += 1;
        if (status === 'failed' || status === 'timedout') failed += 1;
        if (record.code && THROTTLED.test(record.code)) throttled += 1;
        const ms = duration(record.startTime, record.endTime);
        if (ms === undefined) continue;
        durations.push(ms);
        runBusy += ms;
      }
      if (executed === 0) continue;
      ran += 1;
      executions += executed;
      busy.push(runBusy);
      const runMs = duration(run.startTime, run.endTime);
      if (!looped && runMs) shares.push(Math.min(100, (runBusy / runMs) * 100));
    }
    if (ran === 0 && skipped === 0) continue;
    actions.set(node.name, {
      name: node.name,
      runs: ran,
      executions,
      p50Ms: percentile(durations, 50),
      p95Ms: percentile(durations, 95),
      busyP50Ms: percentile(busy, 50),
      ...(shares.length > 0 ? { timeSharePct: Math.round(percentile(shares, 50)) } : {}),
      failed,
      skipped,
      throttled,
    });
  }

  return {
    sampled: runs.length,
    statuses,
    durationP50Ms: percentile(runDurations, 50),
    durationP95Ms: percentile(runDurations, 95),
    actions,
    loops: loopIterations(tree, runs),
  };
}

/**
 * Loop iteration counts from the repetition indexes of the actions inside each loop. For a
 * nested loop, the count is per iteration of the loops around it.
 */
function loopIterations(tree: FlowTree, runs: RunSample[]): Map<string, LoopRunStats> {
  const loops = new Map<string, LoopRunStats>();
  for (const loop of tree.all.filter(isLoop)) {
    const counts: number[] = [];
    let truncated = false;
    for (const run of runs) {
      // Iterations seen per outer position (the indexes of the loops around this one).
      const seen = new Map<string, Set<number>>();
      let found = false;
      for (const [name, repetitions] of Object.entries(run.repetitions)) {
        for (const repetition of repetitions) {
          const at = repetition.indexes.findIndex((i) => i.scope === loop.name);
          if (at < 0) continue;
          found = true;
          const outer = repetition.indexes
            .slice(0, at)
            .map((i) => i.index)
            .join('/');
          const set = seen.get(outer) ?? new Set<number>();
          set.add(repetition.indexes[at]?.index ?? 0);
          seen.set(outer, set);
        }
        if (found && run.truncated?.includes(name)) truncated = true;
      }
      for (const set of seen.values()) counts.push(set.size);
    }
    if (counts.length === 0) continue;
    loops.set(loop.name, {
      name: loop.name,
      iterationsP50: percentile(counts, 50),
      iterationsP95: percentile(counts, 95),
      iterationsMax: Math.max(...counts),
      truncated,
    });
  }
  return loops;
}

/**
 * The actions whose repetitions give the most for the fewest requests: the first action of
 * each loop (iteration counts), then connector, HTTP and child-flow calls inside loops
 * (where the time goes).
 */
export function repetitionTargets(tree: FlowTree, max = 25): string[] {
  const targets: string[] = [];
  const add = (name: string) => {
    if (!targets.includes(name)) targets.push(name);
  };
  for (const loop of tree.all.filter(isLoop)) {
    const first = loop.children[0];
    if (first) add(first.name);
  }
  for (const node of tree.all) {
    const calls = node.kind === 'connector' || node.kind === 'http' || node.kind === 'child-flow';
    if (calls && ancestors(tree, node).some(isLoop)) add(node.name);
  }
  return targets.slice(0, max);
}
