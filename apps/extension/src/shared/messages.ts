import type { PaneResult } from './pane-result.ts';

/** Messages to the background worker. */
export type BackgroundMessage =
  | { type: 'cfa:analyse-tab'; tabId: number; runs?: boolean }
  /** From the pane. `runs`: also read the flow's recent runs. */
  | { type: 'cfa:analyse-sender'; runs?: boolean }
  | { type: 'cfa:open-capture' }
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
