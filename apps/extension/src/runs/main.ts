// "Runs": one flow's run list, filtered by duration, status and start time, with a duration
// histogram, export, and the run analysis of the matching runs. Reads through the sign-in the
// extension captured from the portal, like the All flows page; read-only.
import '../flows/flows.css';
import './runs.css';
import { analyseFlow, getRule, label, parseFlow, type FlowTree } from '@cfa/core';
import { createApiClient } from '../api/client.ts';
import { fetchFlow } from '../api/flow-lookup.ts';
import { flowApi } from '../api/flows.ts';
import { DEFAULT_RUN_SAMPLE, fetchRunSamples, listRuns, type ListedRun } from '../api/runs.ts';
import { formatDuration } from '../content/report.ts';
import { byId, h, setStatus } from '../shared/dom.ts';
import { friendlyError } from '../shared/errors.ts';
import { flowRunUrl } from '../shared/flow-url.ts';
import type { HostKind } from '../shared/hosts.ts';
import type { BackgroundMessage } from '../shared/messages.ts';
import { buildPaneRuns, type PaneRuns } from '../shared/pane-result.ts';
import { indexedDbRunCache } from '../shared/run-cache.ts';
import { TOKEN_KEYS, isExpired, loadTokens, type TokenRecord } from '../shared/token.ts';
import {
  bucketLabel,
  describeFilter,
  durationStats,
  filterRuns,
  histogram,
  parseDuration,
  runsCsv,
  runsMarkdown,
  sortRuns,
  splitDuration,
  statusCounts,
  toRows,
  type DurationUnit,
  type RunFilter,
  type RunRow,
  type RunSortKey,
} from './model.ts';

const ui = {
  flow: byId('flow'),
  connection: byId('connection'),
  period: byId<HTMLSelectElement>('period'),
  limit: byId<HTMLSelectElement>('limit'),
  read: byId<HTMLButtonElement>('read'),
  stop: byId<HTMLButtonElement>('stop'),
  status: byId('status'),
  min: byId<HTMLInputElement>('min'),
  minUnit: byId<HTMLSelectElement>('min-unit'),
  max: byId<HTMLInputElement>('max'),
  maxUnit: byId<HTMLSelectElement>('max-unit'),
  presets: byId('presets'),
  statuses: byId('statuses'),
  from: byId<HTMLInputElement>('from'),
  to: byId<HTMLInputElement>('to'),
  summary: byId('summary'),
  histogram: byId('histogram'),
  analyse: byId<HTMLButtonElement>('analyse'),
  csv: byId<HTMLButtonElement>('csv'),
  copy: byId<HTMLButtonElement>('copy'),
  analysis: byId('analysis'),
  table: byId('table'),
};

const params = new URLSearchParams(location.search);
const PAGE_ROWS = 200;
/** Runs read by Analyse matching runs: the slowest of the matching ones. */
const ANALYSED_RUNS = DEFAULT_RUN_SAMPLE.runs;

const state = {
  environment: params.get('env') ?? '',
  /** The flow's name (from the URL until the flow is read: it may be a workflow ID there). */
  flowName: params.get('flow') ?? '',
  displayName: '',
  flow: undefined as unknown,
  tree: undefined as FlowTree | undefined,
  tokens: {} as Partial<Record<HostKind, TokenRecord>>,
  rows: [] as RunRow[],
  hidden: new Set<string>(),
  sort: { key: 'duration' as RunSortKey, descending: true },
  shown: PAGE_ROWS,
  abort: undefined as AbortController | undefined,
  started: false,
};

const runCache = indexedDbRunCache();

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

const formatStart = (row: { start: number }) =>
  Number.isNaN(row.start)
    ? '–'
    : new Date(row.start).toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });

function currentFilter(): RunFilter {
  const from = Date.parse(ui.from.value);
  const to = Date.parse(ui.to.value);
  const minMs = parseDuration(ui.min.value, ui.minUnit.value as DurationUnit);
  const maxMs = parseDuration(ui.max.value, ui.maxUnit.value as DurationUnit);
  return {
    hidden: state.hidden,
    ...(minMs !== undefined ? { minMs } : {}),
    ...(maxMs !== undefined ? { maxMs } : {}),
    ...(Number.isNaN(from) ? {} : { from }),
    // "until 14:05" includes runs that started during that minute.
    ...(Number.isNaN(to) ? {} : { to: to + 59_999 }),
  };
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

function renderFlow(): void {
  ui.flow.replaceChildren(
    h('span', { class: 'name' }, state.displayName || state.flowName),
    h(
      'button',
      {
        type: 'button',
        class: 'link-button',
        title: 'Open the flow in the portal, with the analysis pane',
        onclick: () =>
          send({ type: 'cfa:open-flow', environment: state.environment, flowName: state.flowName }),
      },
      'Open the flow ↗',
    ),
  );
}

function setDuration(input: HTMLInputElement, unit: HTMLSelectElement, ms: number | undefined) {
  if (ms === undefined) {
    input.value = '';
    return;
  }
  const split = splitDuration(ms);
  input.value = split.value;
  unit.value = split.unit;
}

function renderPresets(): void {
  const stats = durationStats(state.rows);
  const preset = (text: string, title: string, apply: () => void, disabled = false) =>
    h('button', { class: 'chip', type: 'button', title, disabled, onclick: apply }, text);
  ui.presets.replaceChildren(
    preset(
      'Slowest 5%',
      stats.count ? `At least ${formatDuration(stats.p95Ms)}` : 'Read some runs first',
      () => {
        setDuration(ui.min, ui.minUnit, stats.p95Ms);
        setDuration(ui.max, ui.maxUnit, undefined);
        update();
      },
      stats.count === 0,
    ),
    preset(
      '2× the median or more',
      stats.count ? `At least ${formatDuration(stats.p50Ms * 2)}` : 'Read some runs first',
      () => {
        setDuration(ui.min, ui.minUnit, stats.p50Ms * 2);
        setDuration(ui.max, ui.maxUnit, undefined);
        update();
      },
      stats.count === 0,
    ),
    preset('Clear filters', 'Show every run', () => {
      for (const input of [ui.min, ui.max, ui.from, ui.to]) input.value = '';
      state.hidden.clear();
      update();
    }),
  );
}

function renderStatuses(): void {
  ui.statuses.replaceChildren(
    ...statusCounts(state.rows).map(([status, count]) => {
      const key = status.toLowerCase();
      return h(
        'button',
        {
          class: 'chip',
          type: 'button',
          'aria-pressed': String(!state.hidden.has(key)),
          onclick: () => {
            if (state.hidden.has(key)) state.hidden.delete(key);
            else state.hidden.add(key);
            update();
          },
        },
        `${status} ${count.toLocaleString('en-US')}`,
      );
    }),
  );
}

const CHART_HEIGHT = 120;

/** One column per duration bucket: the matching runs in the accent colour, the rest lighter. */
function renderHistogram(filter: RunFilter): void {
  const buckets = histogram(state.rows, filter);
  if (buckets.length === 0) {
    ui.histogram.replaceChildren();
    return;
  }
  const most = Math.max(...buckets.map((b) => b.count));
  const tallest = buckets.findIndex((b) => b.count === most);
  const tooltip = h('div', { class: 'chart-tooltip', role: 'tooltip', hidden: true });
  const show = (slot: HTMLElement, text: string) => {
    tooltip.textContent = text;
    tooltip.hidden = false;
    // Just above the column's bar, inside the chart.
    const area = ui.histogram.getBoundingClientRect();
    const box = slot.getBoundingClientRect();
    const bar = slot.querySelector('.bar-stack')?.getBoundingClientRect() ?? box;
    // Centred on the column, but kept inside the chart at its edges.
    const half = tooltip.offsetWidth / 2;
    const centre = box.left + box.width / 2 - area.left;
    tooltip.style.left = `${Math.min(Math.max(centre, half), area.width - half)}px`;
    tooltip.style.top = `${Math.max(0, bar.top - area.top - 6)}px`;
  };
  const hide = () => (tooltip.hidden = true);
  const px = (count: number) => (count === 0 ? 0 : Math.max(2, (count / most) * CHART_HEIGHT));
  const columns = buckets.map((bucket, i) => {
    const range = bucketLabel(bucket);
    const text = `${range}: ${bucket.count.toLocaleString('en-US')} ${bucket.count === 1 ? 'run' : 'runs'}${bucket.matching < bucket.count ? `, ${bucket.matching.toLocaleString('en-US')} matching` : ''}`;
    const slot: HTMLButtonElement = h(
      'button',
      {
        class: 'bar-slot',
        type: 'button',
        'aria-label': `${text}. Show runs taking at least ${bucket.fromMs === 0 ? '0 s' : formatDuration(bucket.fromMs)}.`,
        onclick: () => {
          setDuration(ui.min, ui.minUnit, bucket.fromMs === 0 ? undefined : bucket.fromMs);
          update();
        },
        onmouseenter: () => show(slot, text),
        onfocus: () => show(slot, text),
        onmouseleave: hide,
        onblur: hide,
      },
      h(
        'span',
        { class: 'bar-stack', style: `height: ${px(bucket.count)}px` },
        i === tallest ? h('span', { class: 'bar-value' }, most.toLocaleString('en-US')) : null,
        bucket.count > bucket.matching
          ? h('span', {
              class: 'bar rest top',
              style: `height: ${px(bucket.count) - px(bucket.matching)}px`,
            })
          : null,
        bucket.matching > 0
          ? h('span', {
              class: bucket.count > bucket.matching ? 'bar match' : 'bar match top',
              style: `height: ${px(bucket.matching)}px`,
            })
          : null,
      ),
    );
    return h(
      'div',
      { class: 'bar-column' },
      slot,
      h('span', { class: 'bar-label', 'aria-hidden': 'true' }, range),
    );
  });
  ui.histogram.replaceChildren(
    h('div', { class: 'bars', role: 'group', 'aria-label': 'Runs by duration' }, ...columns),
    tooltip,
  );
}

function sortHeader(key: RunSortKey | undefined, text: string): HTMLTableCellElement {
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
          state.sort = { key, descending: active ? !state.sort.descending : true };
          renderTable(filterRuns(state.rows, currentFilter()));
        },
      },
      text,
    ),
  );
}

function renderTable(matching: RunRow[]): void {
  if (state.rows.length === 0) {
    ui.table.replaceChildren();
    return;
  }
  const median = durationStats(state.rows).p50Ms;
  const rows = sortRuns(matching, state.sort.key, state.sort.descending);
  const shown = rows.slice(0, state.shown);
  ui.table.replaceChildren(
    h(
      'table',
      { class: 'runs-table' },
      h(
        'thead',
        {},
        h(
          'tr',
          {},
          sortHeader('started', 'Started'),
          sortHeader('duration', 'Duration'),
          sortHeader(undefined, 'Vs median'),
          sortHeader(undefined, 'Status'),
          sortHeader(undefined, ''),
        ),
      ),
      h(
        'tbody',
        {},
        ...shown.map((row) =>
          h(
            'tr',
            { 'data-run': row.name },
            h('td', {}, formatStart(row)),
            h(
              'td',
              { class: 'number' },
              row.durationMs !== undefined ? formatDuration(row.durationMs) : '–',
              row.running ? h('span', { class: 'muted' }, ' so far') : null,
            ),
            h(
              'td',
              { class: 'number muted' },
              row.durationMs !== undefined && median > 0
                ? `×${(row.durationMs / median).toFixed(1)}`
                : '',
            ),
            h('td', { class: `run-status ${row.status.toLowerCase()}` }, row.status),
            h(
              'td',
              {},
              h(
                'a',
                {
                  class: 'open',
                  href: flowRunUrl(state.environment, state.flowName, row.name),
                  target: '_blank',
                  rel: 'noreferrer',
                  title: `Open run ${row.name} in the portal`,
                },
                'Open ↗',
              ),
            ),
          ),
        ),
      ),
    ),
    rows.length === 0 ? h('p', { class: 'muted' }, 'No runs match.') : '',
    rows.length > shown.length
      ? h(
          'button',
          {
            type: 'button',
            class: 'more',
            onclick: () => {
              state.shown += PAGE_ROWS;
              renderTable(matching);
            },
          },
          `Show ${Math.min(PAGE_ROWS, rows.length - shown.length)} more of ${(rows.length - shown.length).toLocaleString('en-US')}`,
        )
      : '',
  );
}

/** Everything that depends on the filter. */
function update(resetPaging = true): void {
  if (resetPaging) state.shown = PAGE_ROWS;
  const filter = currentFilter();
  const matching = filterRuns(state.rows, filter);
  const all = durationStats(state.rows);
  const finished = matching.filter((r) => !r.running && r.durationMs !== undefined).length;
  renderStatuses();
  renderPresets();
  renderHistogram(filter);
  renderTable(matching);
  ui.summary.textContent =
    state.rows.length === 0
      ? ''
      : `${matching.length.toLocaleString('en-US')} of ${state.rows.length.toLocaleString('en-US')} runs match${all.count ? ` · median ${formatDuration(all.p50Ms)} · slowest 5% take ${formatDuration(all.p95Ms)} or more · longest ${formatDuration(all.maxMs)}` : ''}`;
  const reading = state.abort !== undefined;
  ui.csv.disabled = matching.length === 0;
  ui.copy.disabled = matching.length === 0;
  ui.analyse.disabled = reading || !state.tree || finished === 0;
  ui.analyse.textContent =
    finished > ANALYSED_RUNS
      ? `Analyse the ${ANALYSED_RUNS} slowest matching runs`
      : `Analyse ${finished === 1 ? 'the matching run' : `the ${finished} matching runs`}`;
  ui.analyse.title = state.tree
    ? 'Reads their steps: where the time goes, loop sizes and failures'
    : "The flow's definition couldn't be read, so its runs can't be analysed";
}

function setReading(reading: boolean): void {
  ui.read.disabled = reading || !origin() || !state.flowName;
  ui.period.disabled = reading;
  ui.limit.disabled = reading;
  ui.stop.hidden = !reading;
}

async function readRuns(): Promise<void> {
  const from = origin();
  if (!from || !state.flowName) return;
  state.abort?.abort();
  const controller = new AbortController();
  state.abort = controller;
  setReading(true);
  ui.analysis.hidden = true;
  const days = Number(ui.period.value);
  const limit = Number(ui.limit.value);
  const since = Date.now() - days * 86_400_000;
  const progress = (runs: ListedRun[]) => {
    const oldest = runs.at(-1);
    setStatus(
      ui.status,
      `Read ${runs.length.toLocaleString('en-US')} runs${oldest?.startTime ? `, back to ${formatStart({ start: Date.parse(oldest.startTime) })}` : ''}…`,
    );
    state.rows = toRows(runs, Date.now());
    update();
  };
  setStatus(ui.status, 'Reading runs…');
  try {
    const result = await listRuns(
      client(controller.signal),
      flowApi(from),
      state.environment,
      state.flowName,
      { since, max: limit, signal: controller.signal, onPage: progress },
    );
    state.rows = toRows(result.runs, Date.now());
    const count = result.runs.length.toLocaleString('en-US');
    const oldest = result.runs.at(-1)?.startTime;
    const back = oldest ? `, back to ${formatStart({ start: Date.parse(oldest) })}` : '';
    setStatus(
      ui.status,
      result.reached === 'cancelled'
        ? `Stopped: ${count} runs read${back}.`
        : result.reached === 'max'
          ? `${count} runs${back}: the most "Up to" allows. Raise it to read further back.`
          : result.runs.length === 0
            ? `No runs in the ${ui.period.selectedOptions[0]?.textContent?.toLowerCase() ?? 'period'}.`
            : `${count} runs from the ${ui.period.selectedOptions[0]?.textContent?.toLowerCase() ?? 'period'}.`,
    );
  } catch (error) {
    setStatus(ui.status, friendlyError(error), true);
  } finally {
    if (state.abort === controller) state.abort = undefined;
    setReading(false);
    update();
  }
}

function renderAnalysis(runs: PaneRuns, matching: number, findings: HTMLElement[]): void {
  const list = (title: string, items: [string, string][]) =>
    items.length === 0
      ? []
      : [
          h('h3', {}, title),
          h(
            'ul',
            {},
            ...items.map(([name, value]) =>
              h('li', {}, h('span', {}, name), h('span', { class: 'value' }, value)),
            ),
          ),
        ];
  const statuses = Object.entries(runs.statuses)
    .sort((a, b) => b[1] - a[1])
    .map(([status, count]) => `${count} ${status.toLowerCase()}`)
    .join(', ');
  ui.analysis.replaceChildren(
    h('h2', {}, 'Where the time goes in these runs'),
    h(
      'p',
      { class: 'muted' },
      `${runs.sampled} of ${matching.toLocaleString('en-US')} matching runs${runs.picked < matching ? ' (the slowest)' : ''} · ${statuses} · median ${formatDuration(runs.durationP50Ms)}${runs.fromCache ? ` · ${runs.fromCache} from cache` : ''}${runs.cancelled ? ' · stopped early' : ''}`,
    ),
    h(
      'div',
      { class: 'analysis-lists' },
      h(
        'div',
        {},
        ...list(
          'Slowest steps',
          runs.slowest.map((item) => [
            item.targetLabel,
            item.timeSharePct !== undefined
              ? `${item.timeSharePct}% · ${formatDuration(item.busyP50Ms)}`
              : `${formatDuration(item.busyP50Ms)} · ${item.executionsPerRun ?? 1}×`,
          ]),
        ),
      ),
      h(
        'div',
        {},
        ...list(
          'Loop sizes',
          runs.loops.map((loop) => [
            loop.targetLabel,
            `${loop.iterationsP50}${loop.truncated ? '+' : ''} items (max ${loop.iterationsMax}${loop.truncated ? '+' : ''})`,
          ]),
        ),
        ...list(
          'Failures',
          runs.failures.map((item) => [
            item.targetLabel,
            [
              item.failed ? `failed ${item.failed}×` : '',
              item.throttled ? `throttled ${item.throttled}×` : '',
            ]
              .filter(Boolean)
              .join(' · '),
          ]),
        ),
      ),
    ),
    ...(findings.length > 0
      ? [h('h3', {}, 'Findings these runs back up'), h('ul', { class: 'findings' }, ...findings)]
      : []),
    h(
      'p',
      { class: 'hint' },
      'Medians per run. Open the flow to jump to these steps in the designer and see every finding.',
    ),
  );
  ui.analysis.hidden = false;
}

async function analyseMatching(): Promise<void> {
  const from = origin();
  const tree = state.tree;
  if (!from || !tree) return;
  const matching = filterRuns(state.rows, currentFilter());
  const given: ListedRun[] = matching.map((row) => ({
    name: row.name,
    status: row.status,
    ...(row.startTime ? { startTime: row.startTime } : {}),
    ...(row.endTime ? { endTime: row.endTime } : {}),
  }));
  const controller = new AbortController();
  state.abort = controller;
  setReading(true);
  update(false);
  setStatus(ui.status, 'Reading the runs’ steps…');
  try {
    const fetched = await fetchRunSamples(
      client(controller.signal),
      flowApi(from),
      state.environment,
      state.flowName,
      tree,
      {
        ...DEFAULT_RUN_SAMPLE,
        mode: 'slowest',
        given,
        cache: runCache,
        signal: controller.signal,
        onProgress: (done, total) =>
          setStatus(ui.status, `Reading the runs’ steps… ${done} of ${total}`),
      },
    );
    const analysis = analyseFlow(state.flow, { runs: fetched.samples, sample: 'slowest' });
    const runs = buildPaneRuns(analysis, fetched);
    if (!runs || fetched.samples.length === 0) {
      setStatus(
        ui.status,
        fetched.cancelled
          ? 'Stopped before any run was read.'
          : "The runs' steps couldn't be read.",
        true,
      );
      return;
    }
    const findings = analysis.findings
      .filter((f) => f.evidence)
      .slice(0, 5)
      .map((f) =>
        h(
          'li',
          {},
          h('b', {}, getRule(f.ruleId)?.title ?? f.ruleId),
          ` · ${f.target.name ? label(f.target.name) : 'Whole flow'} (${f.ruleId}): ${f.message}`,
        ),
      );
    renderAnalysis(runs, matching.length, findings);
    setStatus(
      ui.status,
      `Analysed ${fetched.samples.length} ${fetched.samples.length === 1 ? 'run' : 'runs'}.`,
    );
  } catch (error) {
    setStatus(ui.status, friendlyError(error), true);
  } finally {
    if (state.abort === controller) state.abort = undefined;
    setReading(false);
    update(false);
  }
}

function downloadCsv(): void {
  const rows = sortRuns(
    filterRuns(state.rows, currentFilter()),
    state.sort.key,
    state.sort.descending,
  );
  const blob = new Blob([runsCsv(rows, state.environment, state.flowName)], {
    type: 'text/csv',
  });
  const url = URL.createObjectURL(blob);
  const name = (state.displayName || state.flowName).replace(/[^\w.-]+/g, '-').slice(0, 60);
  const link = h('a', { href: url, download: `runs-${name}.csv` });
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  setStatus(ui.status, `${rows.length.toLocaleString('en-US')} runs saved as CSV.`);
}

async function copyMarkdown(): Promise<void> {
  const filter = currentFilter();
  const rows = sortRuns(filterRuns(state.rows, filter), state.sort.key, state.sort.descending);
  const text = runsMarkdown(rows, {
    environment: state.environment,
    flowName: state.flowName,
    displayName: state.displayName || state.flowName,
    filter: describeFilter(
      filter,
      statusCounts(state.rows).map(([status]) => status),
    ),
  });
  try {
    await navigator.clipboard.writeText(text);
    setStatus(ui.status, 'Copied as Markdown.');
  } catch {
    setStatus(ui.status, "Couldn't copy to the clipboard.", true);
  }
}

/** Reads the flow (for its name, and its definition to analyse runs), then its runs. */
async function start(): Promise<void> {
  if (state.started || !origin() || !state.environment || !state.flowName) return;
  state.started = true;
  try {
    const flow = await fetchFlow(client(), state.tokens, {
      environment: state.environment,
      flowId: state.flowName.toLowerCase(),
    });
    const record = flow as { name?: unknown; properties?: { displayName?: unknown } };
    if (typeof record.name === 'string' && record.name) state.flowName = record.name;
    if (typeof record.properties?.displayName === 'string')
      state.displayName = record.properties.displayName;
    state.flow = flow;
    state.tree = parseFlow(flow);
  } catch (error) {
    // The run list may still be readable without the definition.
    setStatus(ui.status, `${friendlyError(error)} Reading its runs anyway…`, true);
  }
  renderFlow();
  document.title = `Cloud Flow Analyzer · Runs · ${state.displayName || state.flowName}`;
  await readRuns();
}

async function refreshTokens(): Promise<void> {
  state.tokens = await loadTokens();
  renderConnection();
  setReading(state.abort !== undefined);
  await start();
}

if (!state.environment || !state.flowName) {
  setStatus(
    ui.status,
    'No flow chosen. Open this page from a flow: Runs in the analysis pane, the extension button, or the All flows page.',
    true,
  );
} else {
  renderFlow();
}
for (const input of [ui.min, ui.max, ui.from, ui.to])
  input.addEventListener('input', () => update());
for (const select of [ui.minUnit, ui.maxUnit]) select.addEventListener('change', () => update());
ui.read.addEventListener('click', () => void readRuns());
ui.stop.addEventListener('click', () => state.abort?.abort());
ui.analyse.addEventListener('click', () => void analyseMatching());
ui.csv.addEventListener('click', downloadCsv);
ui.copy.addEventListener('click', () => void copyMarkdown());
chrome.storage.session.onChanged.addListener((changes) => {
  if (Object.values(TOKEN_KEYS).some((key) => key in changes)) void refreshTokens();
});
update();
void refreshTokens();
