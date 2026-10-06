import type { FlowRef } from './flow-url.ts';
import type { PaneRunTarget } from './pane-result.ts';

/** A run of a flow, as the pane lists it. Plain data only. */
export interface LinkedRun {
  environment: string;
  flowName: string;
  /** The flow's name in the portal, when known. */
  displayName?: string;
  runName: string;
  status: string;
  startTime?: string;
  durationMs?: number;
}

/** What started the run. */
export type RunOrigin =
  /** Its own trigger: nothing else in the chain came before it. */
  | { kind: 'trigger'; triggerName?: string }
  /** Resubmitted from an earlier run of the same flow. */
  | { kind: 'resubmitted'; run: LinkedRun }
  /** A Run a Child Flow action in another run. `actions`: the parent flow's actions calling it. */
  | { kind: 'parent'; run: LinkedRun; actions: string[] }
  /** Another run with the same tracking ID started it, but that run wasn't found. */
  | { kind: 'unknown'; trackingId: string; reason: string };

/** The runs of one child flow that this run started. */
export interface ChildFlowRuns {
  /** The child flow, when it is among the flows you can see. */
  flowName?: string;
  displayName: string;
  /** The Run a Child Flow actions in this flow that call it. */
  actions: PaneRunTarget[];
  /** Oldest first. */
  runs: LinkedRun[];
  /** Matching runs beyond the ones listed. */
  more: number;
  /** Why no runs are listed: not called in this run, not visible to you… */
  note?: string;
}

export interface PaneRunLinks {
  ref: FlowRef & { runName: string };
  run?: LinkedRun;
  origin?: RunOrigin;
  children: ChildFlowRuns[];
  error?: string;
}
