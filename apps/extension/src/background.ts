// Background service worker.
//
// Watches the maker portal's own requests to the Power Automate / Power Platform APIs, and keeps
// the latest bearer token per API in chrome.storage.session (memory only, never on disk). The
// browser stops this worker when idle, so nothing important lives in module variables.
// It never blocks or changes requests.
import { ENDPOINTS_KEY, addEndpoint, type EndpointRecord } from './shared/endpoints.ts';
import { API_URL_PATTERNS, hostKind, isPortalOrigin, type HostKind } from './shared/hosts.ts';
import { TOKEN_KEYS, makeTokenRecord, type TokenRecord } from './shared/token.ts';

const APP_PAGE = 'capture.html';

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

// The toolbar button opens the extension page, or focuses it when it's already open.
chrome.action.onClicked.addListener(() => {
  void (async () => {
    const url = chrome.runtime.getURL(APP_PAGE);
    const [open] = await chrome.runtime.getContexts({
      contextTypes: [chrome.runtime.ContextType.TAB],
      documentUrls: [url],
    });
    if (open && open.tabId >= 0) {
      await chrome.tabs.update(open.tabId, { active: true });
      if (open.windowId >= 0) await chrome.windows.update(open.windowId, { focused: true });
      return;
    }
    await chrome.tabs.create({ url });
  })();
});
