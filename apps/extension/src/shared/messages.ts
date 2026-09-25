import type { PaneResult } from './pane-result.ts';

/** Messages to the background worker. */
export type BackgroundMessage =
  | { type: 'cfa:analyse-tab'; tabId: number }
  | { type: 'cfa:analyse-sender' }
  | { type: 'cfa:open-capture' };

/** Messages to the content script in a portal tab. */
export type ContentMessage =
  | { type: 'cfa:loading'; flowId: string }
  | { type: 'cfa:result'; result: PaneResult }
  | { type: 'cfa:error'; message: string };
