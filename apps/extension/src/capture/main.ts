import './capture.css';
import { getRule } from '@cfa/core';
import { createApiClient, type RecordedRequest } from '../api/client.ts';
import {
  FLOW_SOURCE_LABELS,
  flowApi,
  type Environment,
  type FlowSource,
  type FlowSummary,
} from '../api/flows.ts';
import { ENDPOINTS_KEY, type EndpointRecord } from '../shared/endpoints.ts';
import { HOST_LABELS, type HostKind } from '../shared/hosts.ts';
import { TOKEN_KEYS, isExpired, loadTokens, type TokenRecord } from '../shared/token.ts';
import { buildCaptureFile, captureFlow, type CapturedFlow, type FlowResult } from './capture.ts';
import { byId, h, setStatus } from './dom.ts';

const state = {
  tokens: {} as Partial<Record<HostKind, TokenRecord>>,
  environments: [] as Environment[],
  flows: new Map<string, CapturedFlow>(),
  selected: new Set<string>(),
  requests: [] as RecordedRequest[],
  results: new Map<string, FlowResult>(),
  endpoints: {} as Record<string, EndpointRecord>,
  abort: undefined as AbortController | undefined,
  downloaded: true,
};

const ui = {
  tokens: byId('tokens'),
  origin: byId<HTMLSelectElement>('origin'),
  loadEnvs: byId<HTMLButtonElement>('load-envs'),
  env: byId<HTMLSelectElement>('env'),
  envStatus: byId('env-status'),
  sources: byId('sources'),
  loadFlows: byId<HTMLButtonElement>('load-flows'),
  flowsStatus: byId('flows-status'),
  flowTable: byId('flow-table'),
  runs: byId<HTMLInputElement>('runs'),
  reps: byId<HTMLInputElement>('reps'),
  capture: byId<HTMLButtonElement>('capture'),
  cancel: byId<HTMLButtonElement>('cancel'),
  progress: byId('progress'),
  results: byId('results'),
  anonymise: byId<HTMLInputElement>('anonymise'),
  download: byId<HTMLButtonElement>('download'),
  clear: byId<HTMLButtonElement>('clear'),
  summary: byId('summary'),
  rawUrl: byId<HTMLInputElement>('raw-url'),
  rawSend: byId<HTMLButtonElement>('raw-send'),
  rawResult: byId('raw-result'),
  endpoints: byId('endpoints'),
  endpointCount: byId('endpoint-count'),
  clearEndpoints: byId<HTMLButtonElement>('clear-endpoints'),
};

const SOURCES: FlowSource[] = ['default', 'personal', 'team', 'admin'];
const DEFAULT_SOURCES = new Set<FlowSource>(['default', 'team']);

function client(signal?: AbortSignal) {
  return createApiClient({
    getToken: (kind) => state.tokens[kind],
    onRecord: (request) => {
      state.requests.push(request);
      state.downloaded = false;
      renderSummary();
    },
    ...(signal ? { signal } : {}),
  });
}

function api() {
  const origin = ui.origin.value;
  if (!origin)
    throw new Error('No API host yet. Sign in to make.powerautomate.com in another tab.');
  return flowApi(origin);
}

function count(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function minutesLeft(record: TokenRecord): string {
  if (record.expiresAt === undefined) return 'expiry unknown';
  const minutes = Math.round((record.expiresAt - Date.now()) / 60_000);
  return minutes <= 0 ? 'expired' : `expires in ${minutes} min`;
}

// ── Rendering ───────────────────────────────────────────────────────────────

function renderTokens(): void {
  ui.tokens.replaceChildren(
    ...(Object.keys(HOST_LABELS) as HostKind[]).map((kind) => {
      const record = state.tokens[kind];
      if (!record) return h('div', {}, '– ', HOST_LABELS[kind], ': not captured yet');
      const expired = isExpired(record);
      return h(
        'div',
        {},
        h('span', { class: expired ? 'error' : 'ok' }, expired ? '⚠ ' : '✓ '),
        HOST_LABELS[kind],
        ` · ${record.account ?? 'unknown account'} · ${minutesLeft(record)}`,
        expired ? h('span', { class: 'error' }, ' · refresh the Power Automate tab') : null,
      );
    }),
  );
  if (!state.tokens.flow && !state.tokens.powerplatform) {
    ui.tokens.append(
      h(
        'p',
        { class: 'hint' },
        'Open make.powerautomate.com in another tab and sign in (or refresh it if it is already open). This page updates by itself.',
      ),
    );
  }
  const origins = state.tokens.flow?.origins ?? [];
  const current = ui.origin.value;
  ui.origin.replaceChildren(...origins.map((o) => h('option', { value: o }, o)));
  if (origins.includes(current)) ui.origin.value = current;
}

function renderEnvironments(): void {
  const current = ui.env.value;
  ui.env.replaceChildren(
    ...state.environments.map((env) =>
      h(
        'option',
        { value: env.name },
        `${env.properties?.displayName ?? env.name}${env.properties?.isDefault ? ' (default)' : ''}`,
      ),
    ),
  );
  ui.env.disabled = state.environments.length === 0;
  if (state.environments.some((env) => env.name === current)) ui.env.value = current;
}

function renderSources(): void {
  ui.sources.replaceChildren(
    ...SOURCES.map((source) =>
      h(
        'label',
        { class: 'inline' },
        h('input', {
          type: 'checkbox',
          value: source,
          checked: DEFAULT_SOURCES.has(source),
        }),
        FLOW_SOURCE_LABELS[source],
      ),
    ),
  );
}

function selectedSources(): FlowSource[] {
  return [...ui.sources.querySelectorAll<HTMLInputElement>('input:checked')].map(
    (input) => input.value as FlowSource,
  );
}

function resultCell(name: string): string {
  const result = state.results.get(name);
  if (!result) return '';
  if (result.error) return `error: ${result.error}`;
  return `${result.grade} (${result.score}) · ${count(result.findings.length, 'finding')}`;
}

function renderFlowTable(): void {
  const flows = [...state.flows.values()].sort((a, b) =>
    a.displayName.localeCompare(b.displayName),
  );
  if (flows.length === 0) {
    ui.flowTable.replaceChildren();
    return;
  }
  const all = flows.every((f) => state.selected.has(f.name));
  const toggleAll = h('input', {
    type: 'checkbox',
    checked: all,
    title: 'Select all',
    onchange: () => {
      if (all) state.selected.clear();
      else for (const f of flows) state.selected.add(f.name);
      renderFlowTable();
    },
  });
  const rows = flows.map((flow) =>
    h(
      'tr',
      {},
      h(
        'td',
        {},
        h('input', {
          type: 'checkbox',
          checked: state.selected.has(flow.name),
          onchange: (event: Event) => {
            const box = event.target as HTMLInputElement;
            if (box.checked) state.selected.add(flow.name);
            else state.selected.delete(flow.name);
          },
        }),
      ),
      h('td', {}, flow.displayName),
      h('td', {}, flow.summary.properties?.state ?? ''),
      h('td', {}, flow.summary.properties?.definitionSummary?.triggers?.[0]?.type ?? ''),
      h('td', {}, flow.sources.join(', ')),
      h('td', {}, flow.summary.properties?.lastModifiedTime?.slice(0, 10) ?? ''),
      h('td', {}, resultCell(flow.name)),
    ),
  );
  ui.flowTable.replaceChildren(
    h(
      'div',
      { class: 'table-wrap' },
      h(
        'table',
        {},
        h(
          'thead',
          {},
          h(
            'tr',
            {},
            h('th', {}, toggleAll),
            h('th', {}, 'Name'),
            h('th', {}, 'State'),
            h('th', {}, 'Trigger'),
            h('th', {}, 'Listed by'),
            h('th', {}, 'Modified'),
            h('th', {}, 'Result'),
          ),
        ),
        h('tbody', {}, ...rows),
      ),
    ),
  );
}

function renderResults(): void {
  const results = [...state.results.values()];
  if (results.length === 0) {
    ui.results.replaceChildren(h('p', { class: 'hint' }, 'Nothing captured yet.'));
    return;
  }
  ui.results.replaceChildren(
    ...results.map((result) => {
      const heading = result.error
        ? `${result.displayName}: could not analyse (${result.error})`
        : `${result.displayName} · ${result.grade} (${result.score}) · ${count(result.findings.length, 'finding')} · ${count(result.actionCount ?? 0, 'action')} · ~${result.estimatedActionsPerRun} per run`;
      return h(
        'details',
        {},
        h('summary', {}, heading),
        ...result.findings.map((f) => {
          const rule = getRule(f.ruleId);
          return h(
            'div',
            { class: 'finding' },
            h('span', { class: `severity ${f.severity}` }, f.severity.toUpperCase()),
            h('strong', {}, `${f.ruleId} ${rule?.title ?? ''}`),
            ` · ${f.target}`,
            h('div', {}, f.detail),
            h('div', { class: 'fix' }, `Fix: ${f.fix ?? rule?.fix ?? ''}`),
          );
        }),
        ...result.warnings.map((w) => h('div', { class: 'hint' }, `warning: ${w}`)),
        result.findings.length === 0 && !result.error
          ? h('p', { class: 'ok' }, 'No findings.')
          : null,
      );
    }),
  );
}

function renderSummary(): void {
  const throttled = state.requests.filter((r) => r.status === 429).length;
  const failed = state.requests.filter((r) => r.error && r.status !== 429).length;
  const bytes = state.requests.reduce(
    (sum, r) => sum + (r.body ? JSON.stringify(r.body).length : 0),
    0,
  );
  setStatus(
    ui.summary,
    `${count(state.requests.length, 'request')} recorded (${(bytes / 1_048_576).toFixed(1)} MB)` +
      `${throttled ? ` · ${throttled} throttled (429)` : ''}${failed ? ` · ${failed} failed` : ''}` +
      ` · ${count(state.results.size, 'flow')} analysed.`,
  );
}

function renderEndpoints(): void {
  const endpoints = Object.values(state.endpoints).sort(
    (a, b) => a.host.localeCompare(b.host) || a.path.localeCompare(b.path),
  );
  ui.endpointCount.textContent = `(${endpoints.length})`;
  ui.endpoints.replaceChildren(
    h(
      'div',
      { class: 'table-wrap' },
      h(
        'table',
        {},
        h(
          'thead',
          {},
          h('tr', {}, ...['Method', 'Host', 'Path', 'Query', 'Calls'].map((t) => h('th', {}, t))),
        ),
        h(
          'tbody',
          {},
          ...endpoints.map((e) =>
            h(
              'tr',
              {},
              h('td', {}, e.method),
              h('td', {}, h('code', {}, e.host)),
              h('td', {}, h('code', {}, e.path)),
              h('td', {}, h('code', {}, e.query)),
              h('td', {}, e.count),
            ),
          ),
        ),
      ),
    ),
  );
}

function setBusy(busy: boolean): void {
  for (const button of [ui.loadEnvs, ui.loadFlows, ui.capture, ui.download, ui.clear, ui.rawSend]) {
    button.disabled = busy;
  }
  ui.cancel.hidden = !busy;
}

async function busy(task: () => Promise<void>): Promise<void> {
  setBusy(true);
  try {
    await task();
  } finally {
    setBusy(false);
  }
}

// ── Actions ─────────────────────────────────────────────────────────────────

async function loadEnvironments(): Promise<void> {
  setStatus(ui.envStatus, 'Loading environments…');
  try {
    state.environments = await client().getAll<Environment>(api().environments(), 'environments');
    renderEnvironments();
    setStatus(ui.envStatus, `${count(state.environments.length, 'environment')}.`);
  } catch (error) {
    setStatus(ui.envStatus, errorText(error), true);
  }
}

async function loadFlows(): Promise<void> {
  const environment = ui.env.value;
  if (!environment) return setStatus(ui.flowsStatus, 'Pick an environment first.', true);
  const sources = selectedSources();
  const notes: string[] = [];
  const c = client();
  const urls = api();
  for (const source of sources) {
    setStatus(ui.flowsStatus, `Loading ${FLOW_SOURCE_LABELS[source]}…`);
    try {
      const flows = await c.getAll<FlowSummary>(
        urls.flows(environment, source),
        `flows: ${source}`,
        2000,
        40,
      );
      for (const summary of flows) {
        const existing = state.flows.get(summary.name);
        if (existing) {
          if (!existing.sources.includes(source)) existing.sources.push(source);
        } else {
          state.flows.set(summary.name, {
            name: summary.name,
            displayName: summary.properties?.displayName ?? summary.name,
            sources: [source],
            summary,
          });
        }
      }
      notes.push(`${FLOW_SOURCE_LABELS[source]}: ${flows.length}`);
    } catch (error) {
      notes.push(`${FLOW_SOURCE_LABELS[source]}: ${errorText(error)}`);
    }
  }
  renderFlowTable();
  setStatus(ui.flowsStatus, `${count(state.flows.size, 'flow')} in total. ${notes.join(' · ')}`);
}

async function captureSelected(): Promise<void> {
  const environment = ui.env.value;
  const flows = [...state.selected]
    .map((name) => state.flows.get(name))
    .filter((f) => f !== undefined);
  if (!environment || flows.length === 0) {
    return setStatus(ui.progress, 'Load and select at least one flow first.', true);
  }
  const options = {
    runsPerFlow: Math.max(0, Math.min(50, Number(ui.runs.value) || 0)),
    repetitionPages: Math.max(0, Math.min(10, Number(ui.reps.value) || 0)),
  };
  state.abort = new AbortController();
  const c = client(state.abort.signal);
  const urls = api();
  try {
    for (const [index, flow] of flows.entries()) {
      setStatus(ui.progress, `Flow ${index + 1} of ${flows.length}: ${flow.displayName}…`);
      state.results.set(flow.name, await captureFlow(c, urls, environment, flow, options));
      renderResults();
      renderFlowTable();
    }
    setStatus(ui.progress, `Done: ${count(flows.length, 'flow')} captured.`);
  } catch (error) {
    const cancelled = state.abort.signal.aborted;
    setStatus(ui.progress, cancelled ? 'Cancelled.' : errorText(error), !cancelled);
  } finally {
    state.abort = undefined;
    renderSummary();
  }
}

async function sendRaw(): Promise<void> {
  const input = ui.rawUrl.value.trim();
  if (!input) return;
  try {
    const url = input.startsWith('/') ? `${ui.origin.value}${input}` : input;
    const body = await client().get<unknown>(url, 'manual');
    const text = JSON.stringify(body, null, 2) ?? '(empty)';
    ui.rawResult.textContent =
      text.length > 50_000 ? `${text.slice(0, 50_000)}\n… (truncated)` : text;
  } catch (error) {
    ui.rawResult.textContent = errorText(error);
  }
}

function download(): void {
  const file = buildCaptureFile(
    {
      environment: ui.env.value || undefined,
      tokens: Object.values(state.tokens),
      endpoints: Object.values(state.endpoints),
      flows: [...state.flows.values()].filter(
        (f) => state.selected.has(f.name) || state.results.has(f.name),
      ),
      requests: state.requests,
      results: [...state.results.values()],
    },
    {
      anonymise: ui.anonymise.checked,
      extensionVersion: chrome.runtime.getManifest().version,
      userAgent: navigator.userAgent,
    },
  );
  const blob = new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  const suffix = ui.anonymise.checked ? 'anonymised' : 'raw';
  h('a', { href: url, download: `cfa-capture-${stamp}.${suffix}.json` }).click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  state.downloaded = true;
}

function clearCapture(): void {
  state.requests = [];
  state.results.clear();
  state.downloaded = true;
  renderResults();
  renderFlowTable();
  renderSummary();
}

// ── Wiring ──────────────────────────────────────────────────────────────────

ui.loadEnvs.addEventListener('click', () => void busy(loadEnvironments));
ui.loadFlows.addEventListener('click', () => void busy(loadFlows));
ui.capture.addEventListener('click', () => void busy(captureSelected));
ui.cancel.addEventListener('click', () => state.abort?.abort());
ui.rawSend.addEventListener('click', () => void busy(sendRaw));
ui.download.addEventListener('click', download);
ui.clear.addEventListener('click', clearCapture);
ui.clearEndpoints.addEventListener(
  'click',
  () => void chrome.storage.session.remove(ENDPOINTS_KEY),
);

chrome.storage.session.onChanged.addListener((changes) => {
  if (Object.values(TOKEN_KEYS).some((key) => key in changes)) {
    void loadTokens().then((tokens) => {
      state.tokens = tokens;
      renderTokens();
    });
  }
  const endpointChange = changes[ENDPOINTS_KEY];
  if (endpointChange) {
    state.endpoints = (endpointChange.newValue as Record<string, EndpointRecord> | undefined) ?? {};
    renderEndpoints();
  }
});

window.addEventListener('beforeunload', (event) => {
  if (!state.downloaded) event.preventDefault();
});

setInterval(renderTokens, 30_000);

renderSources();
renderResults();
renderSummary();
void (async () => {
  state.tokens = await loadTokens();
  renderTokens();
  const stored = await chrome.storage.session.get(ENDPOINTS_KEY);
  state.endpoints = (stored[ENDPOINTS_KEY] as Record<string, EndpointRecord> | undefined) ?? {};
  renderEndpoints();
})();
