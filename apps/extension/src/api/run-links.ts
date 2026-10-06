// Which run started this one, and which child flow runs it started.
//
// Every run in a chain (a run, the child flows it calls, theirs…) carries the same tracking ID
// (`correlation.clientTrackingId`): the trigger firing that started the chain. A run started by
// its own trigger has that ID as its trigger's `originHistoryName`; a run started by another run
// has someone else's. Run a Child Flow actions name the child by its Dataverse workflow ID. So
// the parent is a run with the same tracking ID, of a flow that calls this one, that was running
// when this one started; the children are runs with this run's tracking ID, of the flows it
// calls, that started while it ran. Only run lists are read: never inputs or outputs.
import {
  ancestors,
  label,
  parseFlow,
  readRunAction,
  type ActionNode,
  type FlowTree,
} from '@cfa/core';
import { friendlyError } from '../shared/errors.ts';
import { runTarget } from '../shared/pane-result.ts';
import type { ChildFlowRuns, LinkedRun, PaneRunLinks, RunOrigin } from '../shared/run-links.ts';
import { ApiError, type ApiClient, type ApiList } from './client.ts';
import type { FlowApi, FlowSummary } from './flows.ts';
import { isFatal } from './runs.ts';

/** The fields of a run that tell what started it. */
export interface RunRecord {
  name: string;
  status: string;
  startTime?: string;
  endTime?: string;
  /** `correlation.clientTrackingId`: the same for every run in a chain. */
  trackingId?: string;
  /** `trigger.originHistoryName`: the trigger firing behind this run. */
  originHistoryName?: string;
  /** `trigger.sourceHistoryName`: on a resubmitted run, the run it was resubmitted from. */
  sourceHistoryName?: string;
  triggerName?: string;
}

/** The Run a Child Flow actions of a flow, by the workflow ID of the child they call. */
export type ChildFlowCallMap = Record<string, string[]>;

/**
 * The child flows each flow calls, keyed by environment, flow and its last change, so the flows
 * calling this one needn't be read again for every run.
 */
export interface ChildFlowCallCache {
  get(key: string): Promise<ChildFlowCallMap | undefined>;
  set(key: string, calls: ChildFlowCallMap): Promise<void>;
}

export interface RunLinkOptions {
  /** Runs listed per child flow. */
  maxChildRuns: number;
  /** Pages of runs (50 each) read per flow when looking for runs in a chain. */
  maxPages: number;
  now?: () => number;
  callCache?: ChildFlowCallCache;
}

export const DEFAULT_RUN_LINKS: RunLinkOptions = { maxChildRuns: 10, maxPages: 5 };

/** Clock differences between a run and the runs it starts. */
const SLACK_MS = 5000;
/** The longest a run can last (30 days): how far back a parent run can have started. */
const MAX_RUN_MS = 30 * 86_400_000;
const PAGE_SIZE = 50;

const asObject = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value ? value : undefined;
const time = (value: string | undefined): number | undefined => {
  const ms = Date.parse(value ?? '');
  return Number.isNaN(ms) ? undefined : ms;
};
const sameId = (a: string | undefined, b: string | undefined) =>
  a !== undefined && b !== undefined && a.toLowerCase() === b.toLowerCase();

export function readRunRecord(raw: unknown): RunRecord {
  const record = asObject(raw);
  const p = asObject(record.properties);
  const trigger = asObject(p.trigger);
  const fields = {
    startTime: asString(p.startTime),
    endTime: asString(p.endTime),
    trackingId: asString(asObject(p.correlation).clientTrackingId),
    originHistoryName: asString(trigger.originHistoryName),
    sourceHistoryName: asString(trigger.sourceHistoryName),
    triggerName: asString(trigger.name),
  };
  return {
    name: asString(record.name) ?? '',
    status: asString(p.status) ?? 'Unknown',
    ...Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)),
  };
}

/** What started a run, from its own record. */
export function startedBy(run: RunRecord): 'trigger' | 'resubmitted' | 'run' {
  if (run.sourceHistoryName && !sameId(run.sourceHistoryName, run.name)) return 'resubmitted';
  if (
    run.trackingId &&
    !sameId(run.trackingId, run.name) &&
    !sameId(run.trackingId, run.originHistoryName ?? run.name)
  )
    return 'run';
  return 'trigger';
}

/** The Run a Child Flow actions of a flow, with the child's workflow ID (lower case). */
export function childFlowCalls(tree: FlowTree): { node: ActionNode; workflowId: string }[] {
  return tree.all.flatMap((node) => {
    if (node.kind !== 'child-flow') return [];
    const id = asString(asObject(asObject(node.inputs).host).workflowReferenceName);
    return id ? [{ node, workflowId: id.toLowerCase() }] : [];
  });
}

/**
 * Whether a listed flow calls child flows. The default list says (`definitionSummary`); the admin
 * list doesn't, so for its flows only the definition can tell.
 */
function callsChildFlows(flow: FlowSummary): boolean | undefined {
  const actions = flow.properties?.definitionSummary?.actions;
  if (!Array.isArray(actions)) return undefined;
  return actions.some((action) => action.type?.toLowerCase() === 'workflow');
}

const notReadable = (error: unknown) =>
  error instanceof ApiError && (error.status === 403 || error.status === 404);

function linked(
  environment: string,
  flowName: string,
  displayName: string | undefined,
  run: RunRecord,
): LinkedRun {
  const start = time(run.startTime);
  const end = time(run.endTime);
  return {
    environment,
    flowName,
    ...(displayName ? { displayName } : {}),
    runName: run.name,
    status: run.status,
    ...(run.startTime ? { startTime: run.startTime } : {}),
    ...(start !== undefined && end !== undefined ? { durationMs: end - start } : {}),
  };
}

/**
 * Reads runs newest first until one started before `notBefore`, or `maxPages` pages.
 * `complete`: nothing older than what was read could still match.
 */
async function listRunsBack(
  client: ApiClient,
  url: string,
  label: string,
  notBefore: number,
  maxPages: number,
): Promise<{ runs: RunRecord[]; complete: boolean }> {
  const runs: RunRecord[] = [];
  let next: string | undefined = url;
  for (let page = 1; next && page <= maxPages; page++) {
    const body: ApiList<unknown> = await client.get<ApiList<unknown>>(
      next,
      page === 1 ? label : `${label} (page ${page})`,
    );
    const items = (body.value ?? []).map(readRunRecord);
    runs.push(...items);
    next = body.nextLink;
    if (items.some((run) => (time(run.startTime) ?? Infinity) < notBefore)) {
      return { runs, complete: true };
    }
  }
  return { runs, complete: !next };
}

/**
 * A flow's runs in a chain that started within a window. Asks the API to filter by tracking ID;
 * if it refuses the filter, reads the latest runs and filters them here.
 */
async function runsInChain(
  client: ApiClient,
  api: FlowApi,
  environment: string,
  flowName: string,
  trackingId: string,
  window: { from: number; to: number },
  maxPages: number,
): Promise<{ runs: RunRecord[]; complete: boolean }> {
  const filter = `ClientTrackingId eq '${trackingId.replace(/'/g, "''")}'`;
  let listed: { runs: RunRecord[]; complete: boolean };
  try {
    listed = await listRunsBack(
      client,
      api.runs(environment, flowName, PAGE_SIZE, filter),
      'runs (by tracking ID)',
      window.from,
      maxPages,
    );
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 400) throw error;
    listed = await listRunsBack(
      client,
      api.runs(environment, flowName, PAGE_SIZE),
      'runs',
      window.from,
      maxPages,
    );
  }
  return {
    runs: listed.runs.filter((run) => {
      const start = time(run.startTime);
      return (
        sameId(run.trackingId, trackingId) &&
        start !== undefined &&
        start >= window.from &&
        start <= window.to
      );
    }),
    complete: listed.complete,
  };
}

const isLoop = (node: ActionNode) => node.kind === 'foreach' || node.kind === 'until';

/**
 * Finds the run that started `runName` (a parent, or the run it was resubmitted from) and the
 * child flow runs it started.
 */
export async function fetchRunLinks(
  client: ApiClient,
  api: FlowApi,
  environment: string,
  flowName: string,
  flow: unknown,
  runName: string,
  options: RunLinkOptions = DEFAULT_RUN_LINKS,
): Promise<Omit<PaneRunLinks, 'ref'>> {
  const properties = asObject(asObject(flow).properties);
  const displayName = asString(properties.displayName);
  const workflowId = asString(properties.workflowEntityId)?.toLowerCase();
  const tree = parseFlow(flow);
  const now = (options.now ?? Date.now)();
  const run = readRunRecord(await client.get(api.run(environment, flowName, runName), 'run'));
  /** Listed with the admin list too, when this account may read it (environment admins). */
  let adminListed = false;
  let flows: Promise<FlowSummary[]> | undefined;
  const listFlows = () =>
    (flows ??= (async () => {
      const [mine, all] = await Promise.allSettled([
        client.getAll<FlowSummary>(api.flows(environment, 'default'), 'flows', 5000, 50),
        client.getAll<FlowSummary>(api.flows(environment, 'admin'), 'flows (admin)', 5000, 50),
      ]);
      if (all.status === 'rejected' && isFatal(all.reason)) throw all.reason;
      if (mine.status === 'rejected' && (isFatal(mine.reason) || all.status === 'rejected')) {
        throw mine.reason;
      }
      adminListed = all.status === 'fulfilled';
      // The default list's entries first: they say which actions each flow has.
      const merged = new Map<string, FlowSummary>();
      for (const flow of [
        ...(mine.status === 'fulfilled' ? mine.value : []),
        ...(all.status === 'fulfilled' ? all.value : []),
      ]) {
        if (!merged.has(flow.name)) merged.set(flow.name, flow);
      }
      return [...merged.values()];
    })());

  /** The child flows a flow calls, from its definition (read as an admin if need be). */
  async function calledBy(summary: FlowSummary): Promise<ChildFlowCallMap> {
    const modified = summary.properties?.lastModifiedTime;
    const key = modified ? `${environment}/${summary.name}/${modified}` : undefined;
    const cached = key ? await options.callCache?.get(key).catch(() => undefined) : undefined;
    if (cached) return cached;
    let definition: unknown;
    try {
      definition = await client.get(api.flow(environment, summary.name), 'flow (child flow calls)');
    } catch (error) {
      if (!notReadable(error)) throw error;
      definition = await client.get(
        api.flow(environment, summary.name, true),
        'flow (child flow calls, admin)',
      );
    }
    const calls: ChildFlowCallMap = {};
    for (const call of childFlowCalls(parseFlow(definition))) {
      (calls[call.workflowId] ??= []).push(call.node.name);
    }
    if (key) await options.callCache?.set(key, calls).catch(() => undefined);
    return calls;
  }

  async function findParent(trackingId: string): Promise<RunOrigin> {
    const unknown = (reason: string): RunOrigin => ({ kind: 'unknown', trackingId, reason });
    if (!workflowId) {
      return unknown("This flow has no workflow ID, so the flows calling it can't be looked up.");
    }
    const listed = await listFlows();
    const candidates = listed.filter((flow) => callsChildFlows(flow) !== false);
    const unreadable: string[] = [];
    const callers = (
      await Promise.all(
        candidates.map(async (summary) => {
          try {
            const actions = (await calledBy(summary))[workflowId];
            return actions ? [{ summary, actions }] : [];
          } catch (error) {
            if (isFatal(error)) throw error;
            unreadable.push(summary.properties?.displayName ?? summary.name);
            return [];
          }
        }),
      )
    ).flat();
    if (callers.length === 0) {
      const where = adminListed ? 'in this environment' : 'you can see';
      const searched =
        candidates.length === 0
          ? `None of the ${listed.length} flows ${where} calls a child flow.`
          : `None of the ${candidates.length} flows ${where} that call child flows calls this one.`;
      const named = unreadable.slice(0, 3).map((name) => `"${name}"`);
      const failed =
        unreadable.length > 0
          ? ` ${unreadable.length === 1 ? 'One' : unreadable.length} of them couldn't be read: ${named.join(', ')}${unreadable.length > named.length ? ` and ${unreadable.length - named.length} more` : ''}.`
          : '';
      const why = adminListed
        ? ' Another run may have started it by changing something its trigger watches (a Dataverse row, for example).'
        : " It may have been called by a flow you can't see (only environment admins see every flow), or started by a change another run made (to a Dataverse row its trigger watches, for example).";
      return unknown(`${searched}${failed}${why}`);
    }
    const childStart = time(run.startTime) ?? now;
    const window = { from: childStart - MAX_RUN_MS, to: childStart + SLACK_MS };
    let complete = true;
    const found = (
      await Promise.all(
        callers.map(async (caller) => {
          const listed = await runsInChain(
            client,
            api,
            environment,
            caller.summary.name,
            trackingId,
            window,
            options.maxPages,
          );
          complete &&= listed.complete;
          return listed.runs
            .filter(
              (candidate) =>
                !sameId(candidate.name, run.name) &&
                (time(candidate.endTime) ?? Infinity) >= childStart - SLACK_MS,
            )
            .map((candidate) => ({ caller, run: candidate }));
        }),
      )
    ).flat();
    // The closest run that was still going when this one started.
    const best = found.sort(
      (a, b) => (time(b.run.startTime) ?? 0) - (time(a.run.startTime) ?? 0),
    )[0];
    if (!best) {
      const names = callers.map((c) => `"${c.summary.properties?.displayName ?? c.summary.name}"`);
      return unknown(
        `${names.join(', ')} ${callers.length === 1 ? 'calls' : 'call'} this flow, but no run of ${callers.length === 1 ? 'it' : 'them'} with the same tracking ID was found${complete ? '' : ' among the latest runs'}.`,
      );
    }
    return {
      kind: 'parent',
      actions: await callingActions(best.caller.summary.name, best.run.name, best.caller.actions),
      run: linked(
        environment,
        best.caller.summary.name,
        best.caller.summary.properties?.displayName,
        best.run,
      ),
    };
  }

  /**
   * Of the parent flow's actions that call this flow, the ones that were running when this run
   * started (all of them when the parent run's actions can't tell).
   */
  async function callingActions(
    parentFlow: string,
    parentRun: string,
    actions: string[],
  ): Promise<string[]> {
    if (actions.length < 2) return actions;
    const childStart = time(run.startTime);
    if (childStart === undefined) return actions;
    try {
      const records = (
        await client.getAll<unknown>(
          api.runActions(environment, parentFlow, parentRun),
          'parent run actions',
          2000,
          20,
        )
      ).map(readRunAction);
      const running = actions.filter((name) => {
        const record = records.find((r) => r.name === name);
        const start = time(record?.startTime);
        const end = time(record?.endTime) ?? Infinity;
        return (
          record !== undefined &&
          record.status.toLowerCase() !== 'skipped' &&
          start !== undefined &&
          start <= childStart + SLACK_MS &&
          end >= childStart - SLACK_MS
        );
      });
      return running.length > 0 ? running : actions;
    } catch (error) {
      if (isFatal(error)) throw error;
      return actions;
    }
  }

  async function findOrigin(): Promise<RunOrigin> {
    const kind = startedBy(run);
    if (kind === 'trigger') {
      return { kind: 'trigger', ...(run.triggerName ? { triggerName: run.triggerName } : {}) };
    }
    if (kind === 'resubmitted') {
      const source = run.sourceHistoryName ?? '';
      let original: RunRecord = { name: source, status: 'Unknown' };
      try {
        original = readRunRecord(
          await client.get(api.run(environment, flowName, source), 'resubmitted run'),
        );
      } catch (error) {
        if (isFatal(error)) throw error;
      }
      return { kind: 'resubmitted', run: linked(environment, flowName, displayName, original) };
    }
    const trackingId = run.trackingId ?? '';
    try {
      return await findParent(trackingId);
    } catch (error) {
      if (isFatal(error)) throw error;
      return {
        kind: 'unknown',
        trackingId,
        reason: `Couldn't look for it: ${friendlyError(error)}`,
      };
    }
  }

  async function findChildren(): Promise<ChildFlowRuns[]> {
    const calls = new Map<string, ActionNode[]>();
    for (const call of childFlowCalls(tree)) {
      calls.set(call.workflowId, [...(calls.get(call.workflowId) ?? []), call.node]);
    }
    if (calls.size === 0) return [];
    let actions: Map<string, ReturnType<typeof readRunAction>> | undefined;
    try {
      const list = await client.getAll<unknown>(
        api.runActions(environment, flowName, runName),
        'run actions',
        2000,
        20,
      );
      actions = new Map(list.map(readRunAction).map((action) => [action.name, action]));
    } catch (error) {
      if (isFatal(error)) throw error;
    }
    let summaries: FlowSummary[] = [];
    let listError: string | undefined;
    try {
      summaries = await listFlows();
    } catch (error) {
      if (isFatal(error)) throw error;
      listError = friendlyError(error);
    }
    const byWorkflowId = new Map(
      summaries.flatMap((summary) => {
        const id = summary.properties?.workflowEntityId?.toLowerCase();
        return id ? [[id, summary] as const] : [];
      }),
    );
    const trackingId = run.trackingId ?? run.originHistoryName ?? run.name;
    const runStart = time(run.startTime) ?? now;
    const runEnd = time(run.endTime) ?? now;

    return Promise.all(
      [...calls].map(async ([id, nodes]): Promise<ChildFlowRuns> => {
        const summary = byWorkflowId.get(id);
        const base: ChildFlowRuns = {
          ...(summary ? { flowName: summary.name } : {}),
          displayName: summary?.properties?.displayName ?? label(nodes[0]?.name ?? 'Child flow'),
          actions: nodes.map((node) => runTarget(tree, node)),
          runs: [],
          more: 0,
        };
        const ran = actions
          ? nodes.flatMap((node) => {
              const action = actions.get(node.name);
              return action && action.status.toLowerCase() !== 'skipped' ? [{ node, action }] : [];
            })
          : undefined;
        if (ran?.length === 0) {
          return {
            ...base,
            note: run.status === 'Running' ? 'Not called yet.' : 'Not called in this run.',
          };
        }
        if (!summary) {
          return {
            ...base,
            note: listError
              ? `Couldn't list the flows to find it: ${listError}`
              : "This child flow isn't among the flows you can see, so its runs can't be read.",
          };
        }
        // Outside loops, an action's own times say when it called the child; inside a loop
        // they're only its last repetition's, so use the whole run.
        let from = runStart;
        let to = runEnd;
        const timed = ran?.map(({ node, action }) => ({
          inLoop: ancestors(tree, node).some(isLoop),
          start: time(action.startTime),
          end: time(action.endTime),
        }));
        if (timed?.every((t) => !t.inLoop && t.start !== undefined && t.end !== undefined)) {
          from = Math.min(...timed.map((t) => t.start ?? runStart));
          to = Math.max(...timed.map((t) => t.end ?? runEnd));
        }
        try {
          const listed = await runsInChain(
            client,
            api,
            environment,
            summary.name,
            trackingId,
            { from: from - SLACK_MS, to: to + SLACK_MS },
            options.maxPages,
          );
          const runs = listed.runs
            .filter((child) => !sameId(child.name, run.name))
            .sort((a, b) => (time(a.startTime) ?? 0) - (time(b.startTime) ?? 0));
          if (runs.length === 0) {
            return {
              ...base,
              note: listed.complete
                ? 'No run of it was found for this run.'
                : 'No run of it was found among its latest runs.',
            };
          }
          return {
            ...base,
            runs: runs
              .slice(0, options.maxChildRuns)
              .map((child) =>
                linked(environment, summary.name, summary.properties?.displayName, child),
              ),
            more: Math.max(0, runs.length - options.maxChildRuns),
            ...(listed.complete ? {} : { note: 'Only its latest runs were searched.' }),
          };
        } catch (error) {
          if (isFatal(error)) throw error;
          return { ...base, note: `Couldn't read its runs: ${friendlyError(error)}` };
        }
      }),
    );
  }

  const [origin, children] = await Promise.all([findOrigin(), findChildren()]);
  return { run: linked(environment, flowName, displayName, run), origin, children };
}
