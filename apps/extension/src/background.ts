// Background service worker.
//
// Watches the maker portal's own requests to the Power Automate / Power Platform APIs, and keeps
// the latest bearer token per API in chrome.storage.session (memory only, never on disk). The
// browser stops this worker when idle, so nothing important lives in module variables.
// It never blocks or changes requests.
//
// It also runs the analysis for the in-page pane: the popup (or the pane's Re-analyse button)
// asks for a tab to be analysed; the worker injects the pane, fetches the flow with the captured
// token, analyses it and sends the result to the pane. The page never sees the token. When the
// pane asks for it, the worker also reads the flow's recent runs (cached in IndexedDB).
import { analyseFlow, parseFlow, type RunSampleMode } from '@cfa/core';
import { NoTokenError, createApiClient } from './api/client.ts';
import { fetchFlow } from './api/flow-lookup.ts';
import { flowApi } from './api/flows.ts';
import { DEFAULT_RUN_SAMPLE, fetchRunSamples, type FetchedRuns } from './api/runs.ts';
import { friendlyError } from './shared/errors.ts';
import { flowPageUrl, parseFlowUrl } from './shared/flow-url.ts';
import type { BackgroundMessage, ContentMessage } from './shared/messages.ts';
import { openExtensionPage } from './shared/open-page.ts';
import { buildPaneResult } from './shared/pane-result.ts';
import { indexedDbRunCache } from './shared/run-cache.ts';
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

const runCache = indexedDbRunCache();
const LIMIT_KEY = 'settings:dailyRequestLimit';
/** Run reading in progress per tab, so the pane can stop it. */
const readingRuns = new Map<number, AbortController>();

function flowName(flow: unknown, fallback: string): string {
  const name = (flow as { name?: unknown } | null)?.name;
  return typeof name === 'string' && name ? name : fallback;
}

async function dailyRequestLimit(): Promise<number | undefined> {
  const value = (await chrome.storage.local.get(LIMIT_KEY))[LIMIT_KEY];
  return typeof value === 'number' && value > 0 ? value : undefined;
}

async function setDailyRequestLimit(limit: number | undefined): Promise<void> {
  if (limit && limit > 0) await chrome.storage.local.set({ [LIMIT_KEY]: Math.round(limit) });
  else await chrome.storage.local.remove(LIMIT_KEY);
}

async function analyseTab(tabId: number, runs?: RunSampleMode): Promise<void> {
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
  await send(tabId, { type: 'cfa:loading', flowId: ref.flowId, runs: runs !== undefined });
  try {
    const tokens = await loadTokens();
    const client = createApiClient({ getToken: (kind) => tokens[kind] });
    const flow = await fetchFlow(client, tokens, ref);
    if (!runs) {
      await send(tabId, { type: 'cfa:result', result: buildPaneResult(ref, analyseFlow(flow)) });
      return;
    }
    readingRuns.get(tabId)?.abort();
    const controller = new AbortController();
    readingRuns.set(tabId, controller);
    const limit = await dailyRequestLimit();
    let fetched: FetchedRuns | undefined;
    let error: string | undefined;
    try {
      const origin = tokens.flow?.origins[0];
      if (!origin) throw new NoTokenError('flow');
      fetched = await fetchRunSamples(
        createApiClient({ getToken: (kind) => tokens[kind], signal: controller.signal }),
        flowApi(origin),
        ref.environment,
        flowName(flow, ref.flowId),
        parseFlow(flow),
        {
          ...DEFAULT_RUN_SAMPLE,
          mode: runs,
          cache: runCache,
          signal: controller.signal,
          onProgress: (done, total) =>
            void send(tabId, { type: 'cfa:runs-progress', flowId: ref.flowId, done, total }).catch(
              () => undefined,
            ),
        },
      );
    } catch (err) {
      error = controller.signal.aborted ? 'Stopped before any run was read.' : friendlyError(err);
    } finally {
      if (readingRuns.get(tabId) === controller) readingRuns.delete(tabId);
    }
    const analysis = analyseFlow(flow, {
      ...(fetched ? { runs: fetched.samples, sample: fetched.mode } : {}),
      ...(fetched?.runsPerDay !== undefined ? { runsPerDay: fetched.runsPerDay } : {}),
      ...(limit !== undefined ? { dailyRequestLimit: limit } : {}),
    });
    const extra = limit !== undefined ? { dailyRequestLimit: limit } : {};
    await send(tabId, {
      type: 'cfa:result',
      result: buildPaneResult(
        ref,
        analysis,
        new Date(),
        fetched
          ? {
              mode: fetched.mode,
              listed: fetched.listed,
              picked: fetched.picked,
              fromCache: fetched.fromCache,
              cancelled: fetched.cancelled,
              ...(fetched.runsPerDay !== undefined ? { runsPerDay: fetched.runsPerDay } : {}),
              ...extra,
            }
          : { error: error ?? 'The runs could not be read.', ...extra },
      ),
    });
  } catch (error) {
    await send(tabId, { type: 'cfa:error', message: friendlyError(error) });
  }
}

const OPEN_FLOW_TIMEOUT_MS = 5 * 60_000;

/**
 * Opens a flow's page and shows the analysis pane once the tab has loaded the flow. Loads of
 * other pages first (a sign-in redirect, or an error page the user reloads) are waited out.
 */
async function openFlow(environment: string, flowName: string): Promise<void> {
  const tab = await chrome.tabs.create({ url: flowPageUrl(environment, flowName) });
  const tabId = tab.id;
  if (tabId === undefined) return;
  const stop = () => {
    chrome.tabs.onUpdated.removeListener(loaded);
    clearTimeout(timer);
  };
  const loaded = (id: number, info: { status?: string }) => {
    if (id !== tabId || info.status !== 'complete') return;
    void chrome.tabs.get(tabId).then(async (current) => {
      if (!parseFlowUrl(current.url)) return;
      try {
        await analyseTab(tabId);
        stop();
      } catch {
        // An error page keeps the flow's URL but can't take the pane: wait for a reload.
      }
    });
  };
  const timer = setTimeout(stop, OPEN_FLOW_TIMEOUT_MS);
  chrome.tabs.onUpdated.addListener(loaded);
}

chrome.runtime.onMessage.addListener((message: BackgroundMessage, sender) => {
  const fail = (error: unknown) => console.error('Cloud Flow Analyzer:', error);
  if (message.type === 'cfa:analyse-tab') analyseTab(message.tabId, message.runs).catch(fail);
  else if (message.type === 'cfa:analyse-sender' && sender.tab?.id !== undefined) {
    analyseTab(sender.tab.id, message.runs).catch(fail);
  } else if (message.type === 'cfa:open-capture') openExtensionPage(CAPTURE_PAGE).catch(fail);
  else if (message.type === 'cfa:open-flows') {
    const query = message.environment ? `?env=${encodeURIComponent(message.environment)}` : '';
    openExtensionPage(`flows.html${query}`).catch(fail);
  } else if (message.type === 'cfa:clear-run-cache') runCache.clear().catch(fail);
  else if (message.type === 'cfa:open-flow') {
    openFlow(message.environment, message.flowName).catch(fail);
  } else if (message.type === 'cfa:cancel-runs' && sender.tab?.id !== undefined) {
    readingRuns.get(sender.tab.id)?.abort();
  } else if (message.type === 'cfa:set-limit' && sender.tab?.id !== undefined) {
    const tabId = sender.tab.id;
    setDailyRequestLimit(message.limit)
      .then(() => analyseTab(tabId, message.runs))
      .catch(fail);
  }
  return false;
});
