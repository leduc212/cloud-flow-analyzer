// Background service worker.
//
// Watches the maker portal's own requests to the Power Automate / Power Platform APIs, and keeps
// the latest bearer token per API in chrome.storage.session (memory only, never on disk). The
// browser stops this worker when idle, so nothing important lives in module variables.
// It never blocks or changes requests.
//
// It also runs the analysis for the in-page pane: the popup (or the pane's Re-analyse button)
// asks for a tab to be analysed; the worker injects the pane, fetches the flow with the captured
// token, analyses it and sends the result to the pane. The page never sees the token.
import { analyseFlow } from '@cfa/core';
import { createApiClient } from './api/client.ts';
import { fetchFlow } from './api/flow-lookup.ts';
import { parseFlowUrl } from './shared/flow-url.ts';
import type { BackgroundMessage, ContentMessage } from './shared/messages.ts';
import { openExtensionPage } from './shared/open-page.ts';
import { buildPaneResult } from './shared/pane-result.ts';
import { ENDPOINTS_KEY, addEndpoint, type EndpointRecord } from './shared/endpoints.ts';
import { API_URL_PATTERNS, hostKind, isPortalOrigin, type HostKind } from './shared/hosts.ts';
import { TOKEN_KEYS, loadTokens, makeTokenRecord, type TokenRecord } from './shared/token.ts';

const CAPTURE_PAGE = 'capture.html';

/** Last token+origin written per API, to skip storage writes for repeat requests. */
const lastWritten = new Map<HostKind, string>();

async function saveToken(kind: HostKind, token: string, origin: string): Promise<void> {
  const marker = `${origin} ${token}`;
  if (lastWritten.get(kind) === marker) return;
  lastWritten.set(kind, marker);
  const key = TOKEN_KEYS[kind];
  const previous = (await chrome.storage.session.get(key))[key] as TokenRecord | undefined;
  await chrome.storage.session.set({ [key]: makeTokenRecord(kind, token, origin, previous) });
}

let endpoints: Promise<Record<string, EndpointRecord>> | undefined;
let flushTimer: ReturnType<typeof setTimeout> | undefined;

async function recordEndpoint(method: string, url: URL): Promise<void> {
  endpoints ??= chrome.storage.session
    .get(ENDPOINTS_KEY)
    .then((stored) => (stored[ENDPOINTS_KEY] as Record<string, EndpointRecord> | undefined) ?? {});
  const table = await endpoints;
  if (!addEndpoint(table, method, url)) return;
  clearTimeout(flushTimer);
  flushTimer = setTimeout(() => void chrome.storage.session.set({ [ENDPOINTS_KEY]: table }), 1000);
}

// The capture page can clear the endpoint list; forget the in-memory copy too.
chrome.storage.session.onChanged.addListener((changes) => {
  const change = changes[ENDPOINTS_KEY];
  if (change && change.newValue === undefined) {
    clearTimeout(flushTimer);
    endpoints = undefined;
  }
});

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    // Only the portal's own calls: the extension's pages call the same hosts.
    if (!isPortalOrigin(details.initiator) || details.method === 'OPTIONS') return;
    const header = details.requestHeaders?.find((h) => h.name.toLowerCase() === 'authorization');
    const match = header?.value ? /^Bearer\s+(.+)$/i.exec(header.value) : null;
    if (!match?.[1]) return;
    const url = new URL(details.url);
    const kind = hostKind(url.hostname);
    if (!kind) return;
    void saveToken(kind, match[1], url.origin);
    void recordEndpoint(details.method, url);
  },
  { urls: API_URL_PATTERNS },
  ['requestHeaders'],
);

async function send(tabId: number, message: ContentMessage): Promise<void> {
  await chrome.tabs.sendMessage(tabId, message, { frameId: 0 });
}

async function analyseTab(tabId: number): Promise<void> {
  const tab = await chrome.tabs.get(tabId);
  const ref = parseFlowUrl(tab.url);
  await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ['content.js'] });
  if (!ref) {
    await send(tabId, {
      type: 'cfa:error',
      message: 'Open a flow first (its details page or the designer), then analyse again.',
    });
    return;
  }
  await send(tabId, { type: 'cfa:loading', flowId: ref.flowId });
  try {
    const tokens = await loadTokens();
    const client = createApiClient({ getToken: (kind) => tokens[kind] });
    const flow = await fetchFlow(client, tokens, ref);
    await send(tabId, { type: 'cfa:result', result: buildPaneResult(ref, analyseFlow(flow)) });
  } catch (error) {
    await send(tabId, {
      type: 'cfa:error',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

chrome.runtime.onMessage.addListener((message: BackgroundMessage, sender) => {
  const fail = (error: unknown) => console.error('Cloud Flow Analyzer:', error);
  if (message.type === 'cfa:analyse-tab') analyseTab(message.tabId).catch(fail);
  else if (message.type === 'cfa:analyse-sender' && sender.tab?.id !== undefined) {
    analyseTab(sender.tab.id).catch(fail);
  } else if (message.type === 'cfa:open-capture') openExtensionPage(CAPTURE_PAGE).catch(fail);
  return false;
});
