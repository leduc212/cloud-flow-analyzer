import type { RunSampleMode } from '@cfa/core';
import type { PaneResult } from './pane-result.ts';

/** Messages to the background worker. */
export type BackgroundMessage =
  | { type: 'cfa:analyse-tab'; tabId: number; runs?: RunSampleMode }
  /** From the pane. `runs`: also read the flow's runs (the latest, or the slowest of them). */
  | { type: 'cfa:analyse-sender'; runs?: RunSampleMode }
  /** From the pane: stop reading runs, and show what was read so far. */
  | { type: 'cfa:cancel-runs' }
  /** From the pane: save the daily request limit (undefined clears it), then analyse again. */
  | { type: 'cfa:set-limit'; limit?: number; runs?: RunSampleMode }
  | { type: 'cfa:open-capture' }
  /** Open the All flows page, on this environment when known. */
  | { type: 'cfa:open-flows'; environment?: string }
  /** From the All flows page: open a flow in the portal, then analyse it in the pane. */
  | { type: 'cfa:open-flow'; environment: string; flowName: string }
  /** Forget every run read so far (kept in IndexedDB). */
  | { type: 'cfa:clear-run-cache' };

/** Messages to the content script in a portal tab. */
export type ContentMessage =
  /** `runs`: only the runs are being read; keep showing the findings. */
  | { type: 'cfa:loading'; flowId: string; runs?: boolean }
  | { type: 'cfa:result'; result: PaneResult }
  | { type: 'cfa:error'; message: string }
  /** Reading recent runs: `done` of `total` runs read. */
  | { type: 'cfa:runs-progress'; flowId: string; done: number; total: number };
