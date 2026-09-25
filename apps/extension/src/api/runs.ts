import {
  ancestors,
  isFinished,
  readRepetition,
  readRun,
  readRunAction,
  repetitionTargets,
  type FlowTree,
  type RunSample,
} from '@cfa/core';
import type { RunCache } from '../shared/run-cache.ts';
import { ApiError, NoTokenError, type ApiClient } from './client.ts';
import type { FlowApi } from './flows.ts';

export interface RunSampleOptions {
  /** Latest runs to read. */
  runs: number;
  /** Pages of 100 repetitions read per loop action and run. */
  repetitionPages: number;
  /** Loop actions whose repetitions are read (see `repetitionTargets`). */
  maxLoopActions: number;
  cache?: RunCache;
  onProgress?(done: number, total: number): void;
}

export const DEFAULT_RUN_SAMPLE: Omit<RunSampleOptions, 'cache' | 'onProgress'> = {
  runs: 20,
  repetitionPages: 3,
  maxLoopActions: 15,
};

export interface FetchedRuns {
  samples: RunSample[];
  /** Runs listed, finished or not. */
  listed: number;
  fromCache: number;
}

/** Errors that stop the whole run analysis (as opposed to one missing list). */
function isFatal(error: unknown): boolean {
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
  const listed = await client.getAll<unknown>(
    api.runs(environment, flowName, options.runs),
    'runs',
    options.runs,
    1,
  );
  const runs = listed.map(readRun).filter((run) => run.name && isFinished(run.status));
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
  options.onProgress?.(0, runs.length);
  const progress = () => options.onProgress?.(++done, runs.length);

  const samples = await Promise.all(
    runs.map(async (run): Promise<RunSample | undefined> => {
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
    }),
  );
  return {
    samples: samples.filter((s): s is RunSample => s !== undefined),
    listed: listed.length,
    fromCache,
  };
}
