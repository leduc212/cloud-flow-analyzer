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

/** Where a message to the worker came from. */
export type MessageSource = 'extension-page' | 'portal-tab' | 'unknown';

/** Who may send each message: the pane (in a portal tab) or the extension's own pages. */
export const MESSAGE_SOURCES: Record<BackgroundMessage['type'], readonly MessageSource[]> = {
  'cfa:analyse-tab': ['extension-page'],
  'cfa:analyse-sender': ['portal-tab'],
  'cfa:cancel-runs': ['portal-tab'],
  'cfa:set-limit': ['portal-tab'],
  'cfa:open-capture': ['extension-page'],
  'cfa:open-flows': ['extension-page'],
  'cfa:open-flow': ['extension-page'],
  'cfa:clear-run-cache': ['portal-tab', 'extension-page'],
};

const PORTAL_URL = /^https:\/\/make\.(preview\.)?(powerautomate|powerapps)\.com\//i;

/** Classifies a sender. Only this extension can message the worker, but not every frame of it is equal. */
export function messageSource(
  sender: { id?: string; url?: string; tab?: { id?: number } },
  extensionId: string,
): MessageSource {
  if (sender.id !== extensionId || !sender.url) return 'unknown';
  if (sender.url.startsWith(`chrome-extension://${extensionId}/`)) return 'extension-page';
  if (sender.tab?.id !== undefined && PORTAL_URL.test(sender.url)) return 'portal-tab';
  return 'unknown';
}

/** True when the message is well formed and its sender may send it. */
export function isAllowed(
  message: unknown,
  sender: { id?: string; url?: string; tab?: { id?: number } },
  extensionId: string,
): message is BackgroundMessage {
  if (typeof message !== 'object' || message === null) return false;
  const type = (message as { type?: unknown }).type;
  if (typeof type !== 'string' || !Object.hasOwn(MESSAGE_SOURCES, type)) return false;
  const allowed = MESSAGE_SOURCES[type as BackgroundMessage['type']];
  return allowed.includes(messageSource(sender, extensionId));
}
