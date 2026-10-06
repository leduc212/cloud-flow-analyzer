import {
  ancestors,
  isFinished,
  readRepetition,
  readRun,
  readRunAction,
  repetitionTargets,
  runsPerDay,
  type FlowTree,
  type RunSample,
  type RunSampleMode,
} from '@cfa/core';
import type { RunCache } from '../shared/run-cache.ts';
import { ApiError, NoTokenError, type ApiClient, type ApiList } from './client.ts';
import type { FlowApi } from './flows.ts';

export interface RunSampleOptions {
  /** Runs to read. */
  runs: number;
  /** `recent`: the latest runs. `slowest`: the slowest of the latest `slowestOf` runs. */
  mode?: RunSampleMode;
  slowestOf?: number;
  /** Stops reading: the runs read so far are returned. */
  signal?: AbortSignal;
  now?: () => number;
  /** Pages of 100 repetitions read per loop action and run. */
  repetitionPages: number;
  /** Loop actions whose repetitions are read (see `repetitionTargets`). */
  maxLoopActions: number;
  cache?: RunCache;
  onProgress?(done: number, total: number): void;
  /** Runs already listed (newest first): pick from these instead of listing the flow's runs. */
  given?: ListedRun[];
}

/** A run as the run list gives it. */
export type ListedRun = ReturnType<typeof readRun>;

export const DEFAULT_RUN_SAMPLE: Pick<
  RunSampleOptions,
  'runs' | 'slowestOf' | 'repetitionPages' | 'maxLoopActions'
> = {
  runs: 20,
  slowestOf: 100,
  repetitionPages: 3,
  maxLoopActions: 15,
};

export interface FetchedRuns {
  samples: RunSample[];
  mode: RunSampleMode;
  /** Runs listed, finished or not. */
  listed: number;
  /** Finished runs picked to be read. */
  picked: number;
  fromCache: number;
  /** How often the flow runs, from the start times of every listed run. */
  runsPerDay?: number;
  /** Stopped by the user before every picked run was read. */
  cancelled: boolean;
}

const duration = (run: { startTime?: string; endTime?: string }) =>
  Date.parse(run.endTime ?? '') - Date.parse(run.startTime ?? '') || 0;

/** Errors that stop the whole run analysis (as opposed to one missing list). */
export function isFatal(error: unknown): boolean {
  if (error instanceof NoTokenError) return true;
  if (error instanceof ApiError) return error.status === 401 || error.status === 429;
  return error instanceof DOMException && error.name === 'AbortError';
}

/**
 * Reads the latest finished runs of a flow: each run's actions, and the repetitions of the
 * loop actions worth measuring, only for loops that ran. Cached runs are not fetched again.
 */
export async function fetchRunSamples(
  client: ApiClient,
  api: FlowApi,
  environment: string,
  flowName: string,
  tree: FlowTree,
  options: RunSampleOptions,
): Promise<FetchedRuns> {
  const mode = options.mode ?? 'recent';
  const listSize = mode === 'slowest' ? (options.slowestOf ?? 100) : options.runs;
  const listed =
    options.given ??
    (
      await client.getAll<unknown>(
        api.runs(environment, flowName, listSize),
        'runs',
        listSize,
        Math.ceil(listSize / 50),
      )
    ).map(readRun);
  const finished = listed.filter((run) => run.name && isFinished(run.status));
  const runs =
    mode === 'slowest'
      ? [...finished].sort((a, b) => duration(b) - duration(a)).slice(0, options.runs)
      : finished.slice(0, options.runs);
  const pace = runsPerDay(
    listed.map((run) => run.startTime),
    (options.now ?? Date.now)(),
  );
  const targets = repetitionTargets(tree, options.maxLoopActions);
  const targetKey = targets.join('|');
  // The outermost loop around each target: its repetitions are only worth reading if it ran.
  const outerLoop = new Map(
    targets.map((name) => {
      const node = tree.byName.get(name);
      const loops = node
        ? ancestors(tree, node).filter((a) => a.kind === 'foreach' || a.kind === 'until')
        : [];
      return [name, loops[loops.length - 1]?.name];
    }),
  );

  let done = 0;
  let fromCache = 0;
  let cancelled = false;
  options.onProgress?.(0, runs.length);
  const progress = () => options.onProgress?.(++done, runs.length);

  const readOne = async (run: (typeof runs)[number]): Promise<RunSample | undefined> => {
    options.signal?.throwIfAborted();
    const key = `${environment}/${flowName}/${run.name}`;
    const cached = await options.cache?.get(key);
    if (cached && cached.targets === targetKey) {
      fromCache += 1;
      progress();
      return cached.sample;
    }
    let actions;
    try {
      actions = (
        await client.getAll<unknown>(
          api.runActions(environment, flowName, run.name),
          'run actions',
          2000,
          20,
        )
      ).map(readRunAction);
    } catch (error) {
      if (isFatal(error)) throw error;
      progress();
      return undefined;
    }
    const ran = new Map(actions.map((a) => [a.name, a.status.toLowerCase()]));
    const wanted = targets.filter((name) => {
      const loop = outerLoop.get(name);
      const status = loop ? ran.get(loop) : undefined;
      return status !== undefined && status !== 'skipped';
    });
    const repetitions: RunSample['repetitions'] = {};
    const truncated: string[] = [];
    await Promise.all(
      wanted.map(async (name) => {
        try {
          const { items, more } = await client.getList<unknown>(
            api.repetitions(environment, flowName, run.name, name),
            'repetitions',
            options.repetitionPages * 100,
            options.repetitionPages,
          );
          repetitions[name] = items.map(readRepetition);
          if (more) truncated.push(name);
        } catch (error) {
          // The action may not exist in this run (the flow changed since): skip it.
          if (isFatal(error)) throw error;
        }
      }),
    );
    const sample: RunSample = {
      ...run,
      actions,
      repetitions,
      ...(truncated.length > 0 ? { truncated: truncated.sort() } : {}),
    };
    await options.cache?.set(key, { targets: targetKey, sample, savedAt: Date.now() });
    progress();
    return sample;
  };
  // Stopping mid-way keeps the runs read so far.
  const readSafely = async (run: (typeof runs)[number]): Promise<RunSample | undefined> => {
    try {
      return await readOne(run);
    } catch (error) {
      if (!options.signal?.aborted) throw error;
      cancelled = true;
      return undefined;
    }
  };
  const samples = await Promise.all(runs.map(readSafely));
  return {
    samples: samples.filter((s): s is RunSample => s !== undefined),
    mode,
    listed: listed.length,
    picked: runs.length,
    fromCache,
    ...(pace !== undefined ? { runsPerDay: pace } : {}),
    cancelled,
  };
}

export interface RunListOptions {
  /** Stop at runs that started before this time (ms). */
  since: number;
  /** Stop after this many runs. */
  max: number;
  signal?: AbortSignal;
  /** After each page: runs read so far. */
  onPage?(runs: ListedRun[]): void;
}

export interface RunList {
  /** Newest first, all started at or after `since`. */
  runs: ListedRun[];
  /** Why reading stopped: back to `since` (or the oldest run), at `max`, or stopped by the user. */
  reached: 'since' | 'max' | 'cancelled';
}

/** Reads a flow's run list, newest first, back to a date or up to a number of runs. */
export async function listRuns(
  client: ApiClient,
  api: FlowApi,
  environment: string,
  flowName: string,
  options: RunListOptions,
): Promise<RunList> {
  const runs: ListedRun[] = [];
  let next: string | undefined = api.runs(environment, flowName, 50);
  try {
    for (let page = 1; next; page++) {
      options.signal?.throwIfAborted();
      const body: ApiList<unknown> = await client.get<ApiList<unknown>>(
        next,
        page === 1 ? 'runs' : `runs (page ${page})`,
      );
      const items = (body.value ?? []).map(readRun);
      const fresh = items.filter((run) => !(Date.parse(run.startTime ?? '') < options.since));
      runs.push(...fresh.slice(0, options.max - runs.length));
      options.onPage?.(runs);
      if (fresh.length < items.length) return { runs, reached: 'since' };
      if (runs.length >= options.max) return { runs, reached: 'max' };
      next = body.nextLink;
    }
  } catch (error) {
    if (options.signal?.aborted) return { runs, reached: 'cancelled' };
    throw error;
  }
  return { runs, reached: 'since' };
}
