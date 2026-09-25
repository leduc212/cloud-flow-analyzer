// "All flows": every flow in an environment with its grade and top findings. Reads through the
// sign-in the extension captured from the portal, like the pane does; read-only.
import './flows.css';
import { createApiClient } from '../api/client.ts';
import { flowApi, type Environment, type FlowSource, type FlowSummary } from '../api/flows.ts';
import { byId, h, setStatus } from '../shared/dom.ts';
import { friendlyError } from '../shared/errors.ts';
import type { BackgroundMessage } from '../shared/messages.ts';
import { TOKEN_KEYS, isExpired, loadTokens, type TokenRecord } from '../shared/token.ts';
import type { HostKind } from '../shared/hosts.ts';
import { analyseAll, sessionAnalysisCache } from './analyse-all.ts';
import {
  filterRows,
  markdownSummary,
  mergeFlowLists,
  sortRows,
  type FlowRow,
  type RowFilter,
  type SortKey,
} from './model.ts';

const ui = {
  connection: byId('connection'),
  env: byId<HTMLSelectElement>('env'),
  analyse: byId<HTMLButtonElement>('analyse'),
  stop: byId<HTMLButtonElement>('stop'),
  copy: byId<HTMLButtonElement>('copy'),
  status: byId('status'),
  search: byId<HTMLInputElement>('search'),
  filters: byId('filters'),
  table: byId('table'),
};

const state = {
  tokens: {} as Partial<Record<HostKind, TokenRecord>>,
  environments: [] as Environment[],
  rows: [] as FlowRow[],
  sort: { key: 'grade' as SortKey, descending: false },
  filter: 'all' as RowFilter,
  abort: undefined as AbortController | undefined,
};

const FILTERS: [RowFilter, string][] = [
  ['all', 'All'],
  ['needs-work', 'Grade C or lower'],
  ['high', 'High findings'],
  ['not-analysed', 'Not analysed'],
];

function send(message: BackgroundMessage): void {
  void chrome.runtime.sendMessage(message);
}

function origin(): string | undefined {
  return state.tokens.flow?.origins[0];
}

function client(signal?: AbortSignal) {
  return createApiClient({
    getToken: (kind) => state.tokens[kind],
    ...(signal ? { signal } : {}),
  });
}

function renderConnection(): void {
  const token = state.tokens.flow;
  if (!token) {
    setStatus(
      ui.connection,
      'Not signed in yet: open make.powerautomate.com in another tab and sign in. This page updates by itself.',
      true,
    );
  } else if (isExpired(token)) {
    setStatus(ui.connection, 'Your sign-in has expired: refresh the Power Automate tab.', true);
  } else {
    setStatus(ui.connection, `Signed in${token.account ? ` as ${token.account}` : ''}.`);
  }
}

function renderFilters(): void {
  ui.filters.replaceChildren(
    ...FILTERS.map(([filter, text]) =>
      h(
        'button',
        {
          class: 'chip',
          type: 'button',
          'aria-pressed': String(state.filter === filter),
          onclick: () => {
            state.filter = filter;
            renderFilters();
            renderTable();
          },
        },
        text,
      ),
    ),
  );
}

function header(key: SortKey | undefined, text: string): HTMLTableCellElement {
  if (!key) return h('th', {}, text);
  const active = state.sort.key === key;
  return h(
    'th',
    active ? { 'aria-sort': state.sort.descending ? 'descending' : 'ascending' } : {},
    h(
      'button',
      {
        type: 'button',
        onclick: () => {
          state.sort = { key, descending: active ? !state.sort.descending : false };
          renderTable();
        },
      },
      text,
    ),
  );
}

const SOURCE_LABEL: Record<FlowSource, string> = {
  default: 'yours / shared',
  personal: 'yours',
  team: 'shared',
  admin: 'admin',
};

function renderRow(row: FlowRow): HTMLTableRowElement {
  const a = row.analysis;
  return h(
    'tr',
    { 'data-flow': row.name },
    h(
      'td',
      {},
      h('div', { class: 'name' }, row.displayName),
      h(
        'div',
        { class: 'muted' },
        `${row.trigger} · ${row.state}${row.suspension ? ` (${row.suspension})` : ''}`,
      ),
    ),
    h(
      'td',
      {},
      a
        ? h(
            'span',
            {
              class: `grade ${a.grade}`,
              title: `Score ${a.score} / 100${a.capped ? ', capped at C by a security finding' : ''}`,
            },
            a.grade,
          )
        : row.error
          ? h('span', { class: 'error' }, '–')
          : h('span', { class: 'muted' }, '·'),
    ),
    h(
      'td',
      {},
      a
        ? h(
            'span',
            {},
            h('span', { class: 'count high', title: 'High' }, a.counts.high),
            h('span', { class: 'count medium', title: 'Medium' }, a.counts.medium),
            h('span', { class: 'count low', title: 'Low' }, a.counts.low),
          )
        : null,
    ),
    h(
      'td',
      { class: 'top' },
      row.error
        ? h('div', { class: 'error' }, row.error)
        : a
          ? a.top.length === 0
            ? h('div', { class: 'muted' }, 'No findings')
            : h(
                'div',
                {},
                ...a.top.map((f) =>
                  h('div', {}, h('b', {}, f.title), ` · ${f.target} (${f.ruleId})`),
                ),
              )
          : null,
    ),
    h(
      'td',
      { class: 'muted' },
      row.lastModified ? row.lastModified.slice(0, 10) : '',
      h('div', {}, row.sources.map((s) => SOURCE_LABEL[s]).join(', ')),
    ),
    h(
      'td',
      {},
      h(
        'button',
        {
          type: 'button',
          class: 'open',
          title: 'Open the flow in the portal, with the analysis pane',
          onclick: () =>
            send({ type: 'cfa:open-flow', environment: ui.env.value, flowName: row.name }),
        },
        'Open ↗',
      ),
    ),
  );
}

function renderTable(): void {
  if (state.rows.length === 0) {
    ui.table.replaceChildren();
    return;
  }
  const rows = sortRows(
    filterRows(state.rows, ui.search.value, state.filter),
    state.sort.key,
    state.sort.descending,
  );
  ui.table.replaceChildren(
    h(
      'table',
      {},
      h(
        'thead',
        {},
        h(
          'tr',
          {},
          header('name', 'Flow'),
          header('grade', 'Grade'),
          header('issues', 'Issues'),
          header(undefined, 'Top findings'),
          header('modified', 'Modified'),
          header(undefined, ''),
        ),
      ),
      h('tbody', {}, ...rows.map(renderRow)),
    ),
    rows.length === 0 ? h('p', { class: 'muted' }, 'No flows match.') : '',
  );
  ui.copy.disabled = !state.rows.some((r) => r.analysis);
}

function setBusy(busy: boolean): void {
  ui.analyse.disabled = busy || state.rows.length === 0;
  ui.env.disabled = busy || state.environments.length === 0;
  ui.stop.hidden = !busy;
}

async function loadEnvironments(): Promise<void> {
  const from = origin();
  if (!from) return;
  try {
    state.environments = await client().getAll<Environment>(
      flowApi(from).environments(),
      'environments',
    );
  } catch (error) {
    setStatus(ui.status, friendlyError(error), true);
    return;
  }
  const wanted = new URLSearchParams(location.search).get('env')?.toLowerCase();
  const pick =
    state.environments.find((e) => e.name.toLowerCase() === wanted) ??
    state.environments.find((e) => e.properties?.isDefault) ??
    state.environments[0];
  ui.env.replaceChildren(
    ...state.environments.map((e) =>
      h('option', { value: e.name }, e.properties?.displayName ?? e.name),
    ),
  );
  if (pick) ui.env.value = pick.name;
  ui.env.disabled = state.environments.length === 0;
  await loadFlows();
}

async function loadFlows(): Promise<void> {
  const from = origin();
  const environment = ui.env.value;
  if (!from || !environment) return;
  state.abort?.abort();
  state.rows = [];
  renderTable();
  setBusy(true);
  setStatus(ui.status, 'Loading flows…');
  const api = flowApi(from);
  const c = client();
  const lists: Partial<Record<FlowSource, FlowSummary[]>> = {};
  const notes: string[] = [];
  for (const source of ['default', 'admin'] as const) {
    try {
      lists[source] = await c.getAll<FlowSummary>(
        api.flows(environment, source),
        'flows',
        5000,
        50,
      );
    } catch (error) {
      // Only environment admins can list everyone's flows: the others see their own list.
      if (source === 'admin')
        notes.push('not an environment admin: showing your flows and flows shared with you');
      else notes.push(friendlyError(error));
    }
  }
  state.rows = mergeFlowLists(lists);
  // Flows analysed earlier in this browser session (and not changed since) show at once.
  await Promise.all(
    state.rows.map(async (row) => {
      const cached = await sessionAnalysisCache
        .get(`${environment}/${row.name}/${row.lastModified ?? ''}`)
        .catch(() => undefined);
      if (cached) row.analysis = cached;
    }),
  );
  setBusy(false);
  renderTable();
  const done = state.rows.filter((r) => r.analysis).length;
  setStatus(
    ui.status,
    `${state.rows.length} flows${done ? `, ${done} already analysed` : ''}.${notes.length ? ` ${notes.join('. ')}.` : ''}`,
  );
}

async function analyse(): Promise<void> {
  const from = origin();
  const environment = ui.env.value;
  if (!from || !environment) return;
  const controller = new AbortController();
  state.abort = controller;
  const todo = state.rows.filter((r) => !r.analysis);
  let done = 0;
  setBusy(true);
  setStatus(ui.status, `Analysing ${todo.length} flows…`);
  try {
    const result = await analyseAll(client(controller.signal), flowApi(from), environment, todo, {
      signal: controller.signal,
      cache: sessionAnalysisCache,
      onRow: () => {
        done += 1;
        setStatus(ui.status, `Analysed ${done} of ${todo.length}…`);
        renderTable();
      },
    });
    const failed = todo.filter((r) => r.error).length;
    setStatus(
      ui.status,
      `${result.cancelled ? 'Stopped' : 'Done'}: ${state.rows.filter((r) => r.analysis).length} of ${state.rows.length} flows analysed${failed ? `, ${failed} couldn't be read` : ''}.`,
    );
  } catch (error) {
    setStatus(ui.status, friendlyError(error), true);
  } finally {
    if (state.abort === controller) state.abort = undefined;
    setBusy(false);
    renderTable();
  }
}

async function copySummary(): Promise<void> {
  const environment = ui.env.selectedOptions[0]?.textContent ?? ui.env.value;
  try {
    await navigator.clipboard.writeText(markdownSummary(state.rows, environment));
    setStatus(ui.status, 'Summary copied as Markdown.');
  } catch {
    setStatus(ui.status, "Couldn't copy to the clipboard.", true);
  }
}

async function refreshTokens(): Promise<void> {
  const hadToken = Boolean(origin());
  state.tokens = await loadTokens();
  renderConnection();
  if (!hadToken && origin()) await loadEnvironments();
}

ui.env.addEventListener('change', () => void loadFlows());
ui.analyse.addEventListener('click', () => void analyse());
ui.stop.addEventListener('click', () => state.abort?.abort());
ui.copy.addEventListener('click', () => void copySummary());
ui.search.addEventListener('input', () => renderTable());
chrome.storage.session.onChanged.addListener((changes) => {
  if (Object.values(TOKEN_KEYS).some((key) => key in changes)) void refreshTokens();
});

renderFilters();
void refreshTokens();
