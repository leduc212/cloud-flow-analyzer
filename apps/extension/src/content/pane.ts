// The analysis pane shown on the maker portal page. It lives in a shadow root so the
// portal's styles and ours can't affect each other, and it only ever shows data the background
// worker sends it.
import { h } from '../shared/dom.ts';
import { flowRunUrl, parseFlowUrl } from '../shared/flow-url.ts';
import type { BackgroundMessage } from '../shared/messages.ts';
import type { RunSampleMode } from '@cfa/core';
import type { PaneFinding, PaneResult, PaneRunTarget, PaneRuns } from '../shared/pane-result.ts';
import type { LinkedRun, PaneRunLinks } from '../shared/run-links.ts';
import styles from './pane.css?raw';
import {
  CAPPED_NOTE,
  CATEGORY_LABELS,
  findingKey,
  formatDuration,
  formatPace,
  markdownReport,
  scoreWithout,
} from './report.ts';
import { designerCheck, revealAction } from './reveal.ts';

export const HOST_ID = 'cfa-pane-host';
const PANE_WIDTH = 400;

type Severity = PaneFinding['severity'];
type Filter = 'all' | Severity | 'dismissed';

/** Where dismissed findings are remembered: per flow, in the browser (never shared). */
export interface DismissalStore {
  load(flowId: string): Promise<string[]>;
  save(flowId: string, keys: string[]): Promise<void>;
}

export const chromeDismissalStore: DismissalStore = {
  async load(flowId) {
    const key = `dismissed:${flowId}`;
    const stored = (await chrome.storage.local.get(key))[key];
    return Array.isArray(stored) ? stored.filter((k): k is string => typeof k === 'string') : [];
  },
  async save(flowId, keys) {
    const key = `dismissed:${flowId}`;
    if (keys.length === 0) await chrome.storage.local.remove(key);
    else await chrome.storage.local.set({ [key]: keys });
  },
};

/**
 * Power Platform requests per 24 hours (Microsoft's request limits page, 2026): Microsoft 365
 * and Power Apps per app users, Premium per user, and Process per flow.
 */
export const LIMIT_PRESETS: [number, string][] = [
  [6000, 'Microsoft 365 / Power Apps per app'],
  [40_000, 'Power Automate Premium (per user)'],
  [250_000, 'Power Automate Process (per flow)'],
];

const SEVERITY_LABEL: Record<Severity, string> = { high: 'HIGH', medium: 'MEDIUM', low: 'LOW' };

const actionLabel = (name: string) => name.replace(/_/g, ' ');

/** When a run started, in the browser's locale: "Sep 24, 11:38:06 PM". */
function formatStart(iso: string | undefined): string {
  const date = new Date(iso ?? '');
  if (Number.isNaN(date.getTime())) return 'Unknown start';
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export class Pane {
  private readonly host: HTMLElement;
  private readonly root: ShadowRoot;
  private readonly panel: HTMLElement;
  private readonly tab: HTMLButtonElement;
  private readonly header: HTMLElement;
  private readonly body: HTMLElement;
  private readonly runsBox: HTMLElement;
  private readonly linksBox: HTMLElement;
  private readonly list: HTMLElement;
  private readonly toast: HTMLElement;
  private readonly checkOutput: HTMLPreElement;
  private result: PaneResult | undefined;
  private filter: Filter = 'all';
  /** Reading runs: how far it got. */
  private runsProgress: { done: number; total: number } | undefined;
  private urlTimer: ReturnType<typeof setInterval> | undefined;
  private dismissed = new Set<string>();
  /** The run on the page whose parent and child runs are shown (or being read). */
  private linksRun: string | undefined;
  private links: PaneRunLinks | undefined;
  private readonly send: (message: BackgroundMessage) => void;
  private readonly store: DismissalStore;

  constructor(
    send: (message: BackgroundMessage) => void,
    store: DismissalStore = chromeDismissalStore,
  ) {
    this.send = send;
    this.store = store;
    // A pane left over from an earlier version of the extension: replace it.
    document.getElementById(HOST_ID)?.remove();
    this.host = h('div', { id: HOST_ID });
    this.root = this.host.attachShadow({ mode: 'open' });
    this.root.append(h('style', {}, styles));

    this.tab = h(
      'button',
      { class: 'tab', type: 'button', hidden: true, onclick: () => this.setMinimised(false) },
      'Flow Analyzer',
    );
    this.header = h('header');
    this.runsBox = h('section', { class: 'runs', 'aria-label': 'Recent runs' });
    this.linksBox = h('section', { class: 'links', 'aria-label': 'This run', hidden: true });
    this.list = h('div', { class: 'findings' });
    this.body = h('div', { class: 'body' }, this.linksBox, this.runsBox, this.list);
    this.toast = h('div', { class: 'toast', role: 'status' });
    this.checkOutput = h('pre');
    const footer = h(
      'footer',
      {},
      this.toast,
      h(
        'details',
        {},
        h('summary', {}, 'Designer check'),
        h(
          'p',
          {},
          "If clicking an action doesn't move the designer, copy this and send it to us. It lists what the page contains (action names included), nothing else.",
        ),
        h(
          'button',
          { type: 'button', onclick: () => void this.copyCheck() },
          'Copy designer check',
        ),
        this.checkOutput,
      ),
    );
    this.panel = h(
      'aside',
      { class: 'pane', 'aria-label': 'Cloud Flow Analyzer' },
      this.header,
      this.body,
      footer,
    );
    this.root.append(this.panel, this.tab);
    document.documentElement.append(this.host);
    this.renderHeader();
  }

  /** `runs`: only the runs are being read, so the findings stay on screen. */
  showLoading(runs = false): void {
    this.setMinimised(false);
    if (runs && this.result) {
      this.runsProgress = { done: 0, total: 0 };
      this.renderRuns();
      return;
    }
    this.result = undefined;
    this.runsProgress = undefined;
    this.renderHeader();
    this.renderRuns();
    this.list.replaceChildren(h('p', { class: 'state' }, 'Reading and analysing the flow…'));
    this.setToast('');
  }

  showRunsProgress(done: number, total: number): void {
    this.runsProgress = { done, total };
    this.renderRuns();
  }

  showError(message: string): void {
    this.setMinimised(false);
    this.result = undefined;
    this.runsProgress = undefined;
    this.linksRun = undefined;
    this.links = undefined;
    this.renderHeader();
    this.renderRunLinks();
    this.renderRuns();
    this.list.replaceChildren(h('p', { class: 'state error' }, message));
  }

  showResult(result: PaneResult): Promise<void> {
    this.result = result;
    this.runsProgress = undefined;
    this.filter = 'all';
    this.dismissed = new Set();
    this.setMinimised(false);
    this.renderHeader();
    this.renderRuns();
    this.renderFindings();
    this.syncRunLinks();
    this.watchUrl();
    return this.store
      .load(result.ref.flowId)
      .then((keys) => {
        if (this.result !== result) return;
        this.dismissed = new Set(keys);
        this.renderHeader();
        this.renderFindings();
      })
      .catch(() => {
        // Dismissals are a convenience; the pane works without them.
      });
  }

  /** The parent and child runs the worker found, for the run on the page. */
  showRunLinks(links: PaneRunLinks): void {
    // The user has moved on to another run since asking.
    if (links.ref.runName !== this.linksRun) return;
    this.links = links;
    this.renderRunLinks();
  }

  close(): void {
    clearInterval(this.urlTimer);
    this.host.remove();
  }

  isAttached(): boolean {
    return this.host.isConnected;
  }

  private setMinimised(minimised: boolean): void {
    this.panel.hidden = minimised;
    this.tab.hidden = !minimised;
    this.tab.textContent = this.result
      ? `Flow Analyzer · ${this.openFindings().length}`
      : 'Flow Analyzer';
  }

  private openFindings(): PaneFinding[] {
    return this.result?.findings.filter((f) => !this.dismissed.has(findingKey(f))) ?? [];
  }

  private async setDismissed(finding: PaneFinding, dismissed: boolean): Promise<void> {
    const result = this.result;
    if (!result) return;
    const key = findingKey(finding);
    if (dismissed) this.dismissed.add(key);
    else this.dismissed.delete(key);
    this.renderHeader();
    this.renderFindings();
    this.setToast(dismissed ? `Dismissed "${finding.title}".` : `Restored "${finding.title}".`);
    try {
      await this.store.save(result.ref.flowId, [...this.dismissed]);
    } catch {
      this.setToast("Couldn't save the dismissal in this browser.", true);
    }
  }

  private async copyReport(): Promise<void> {
    if (!this.result) return;
    try {
      await navigator.clipboard.writeText(markdownReport(this.result, this.dismissed));
      this.setToast('Report copied as Markdown.');
    } catch {
      this.setToast("Couldn't copy to the clipboard.", true);
    }
  }

  private setToast(text: string, isError = false): void {
    this.toast.textContent = text;
    this.toast.classList.toggle('error', isError);
  }

  private renderHeader(): void {
    const result = this.result;
    const titleRow = h(
      'div',
      { class: 'title-row' },
      h('strong', {}, 'Cloud Flow Analyzer'),
      h(
        'button',
        {
          class: 'icon-button',
          type: 'button',
          title: 'Analyse again',
          'aria-label': 'Analyse again',
          onclick: () =>
            this.send({
              type: 'cfa:analyse-sender',
              ...(this.result?.runs ? { runs: this.result.runs.mode } : {}),
            }),
        },
        '↻',
      ),
      result
        ? h(
            'button',
            {
              class: 'icon-button',
              type: 'button',
              title: 'Copy report (Markdown)',
              'aria-label': 'Copy report',
              onclick: () => void this.copyReport(),
            },
            '⧉',
          )
        : null,
      h(
        'button',
        {
          class: 'icon-button',
          type: 'button',
          title: 'Minimise',
          'aria-label': 'Minimise',
          onclick: () => this.setMinimised(true),
        },
        '–',
      ),
      h(
        'button',
        {
          class: 'icon-button',
          type: 'button',
          title: 'Close',
          'aria-label': 'Close',
          onclick: () => this.close(),
        },
        '×',
      ),
    );
    if (!result) {
      this.header.replaceChildren(titleRow);
      return;
    }
    const open = this.openFindings();
    const counts = { high: 0, medium: 0, low: 0 };
    for (const f of open) counts[f.severity]++;
    const score = scoreWithout(result, this.dismissed);
    const dismissedCount = result.findings.length - open.length;
    const chip = (filter: Filter, text: string) =>
      h(
        'button',
        {
          class: 'chip',
          type: 'button',
          'aria-pressed': String(this.filter === filter),
          onclick: () => {
            this.filter = filter;
            this.renderHeader();
            this.renderFindings();
          },
        },
        text,
      );
    this.header.replaceChildren(
      titleRow,
      h('div', { class: 'flow-name' }, result.displayName),
      h(
        'div',
        { class: 'summary' },
        h(
          'div',
          {
            class: `grade ${score.grade}`,
            title: `Score ${score.overall} / 100${score.capped ? ` (${CAPPED_NOTE})` : ''}`,
          },
          score.grade,
        ),
        h(
          'div',
          { class: 'scores' },
          h(
            'div',
            { class: 'categories' },
            ...CATEGORY_LABELS.map(([category, name]) =>
              h('span', {}, `${name} `, h('b', {}, score.categories[category].score)),
            ),
          ),
          `${result.actionCount} actions · ~${result.estimate.total.toLocaleString('en-US')} per run${result.estimate.assumed ? ' (estimated)' : result.runs ? ' (from runs)' : ''}`,
        ),
      ),
      h(
        'div',
        { class: 'filters', role: 'group', 'aria-label': 'Filter by severity' },
        chip('all', `All ${open.length}`),
        chip('high', `High ${counts.high}`),
        chip('medium', `Medium ${counts.medium}`),
        chip('low', `Low ${counts.low}`),
        dismissedCount > 0 ? chip('dismissed', `Dismissed ${dismissedCount}`) : null,
      ),
    );
  }

  private renderFindings(): void {
    const result = this.result;
    if (!result) return;
    if (result.findings.length === 0) {
      this.list.replaceChildren(
        h('p', { class: 'state ok' }, 'No problems found. This flow follows every rule we check.'),
      );
      return;
    }
    const showDismissed = this.filter === 'dismissed';
    const shown = result.findings.filter((f) => {
      if (this.dismissed.has(findingKey(f)) !== showDismissed) return false;
      return this.filter === 'all' || showDismissed || f.severity === this.filter;
    });
    if (shown.length === 0 && this.filter === 'all') {
      this.list.replaceChildren(h('p', { class: 'state ok' }, 'Every finding has been dismissed.'));
      return;
    }
    this.list.replaceChildren(...shown.map((finding) => this.renderFinding(finding)));
  }

  private renderRuns(): void {
    const result = this.result;
    if (!result) {
      this.runsBox.replaceChildren();
      this.runsBox.hidden = true;
      return;
    }
    this.runsBox.hidden = false;
    const progress = this.runsProgress;
    const reading = progress
      ? [
          h(
            'div',
            { class: 'runs-actions' },
            h(
              'span',
              { class: 'runs-progress', role: 'status' },
              progress.total > 0
                ? `Reading runs… ${progress.done} of ${progress.total}`
                : 'Reading runs…',
            ),
            h(
              'button',
              {
                class: 'dismiss',
                type: 'button',
                onclick: () => this.send({ type: 'cfa:cancel-runs' }),
              },
              'Stop',
            ),
          ),
        ]
      : [];
    const read = (mode: RunSampleMode, label: string, primary = true) =>
      h(
        'button',
        {
          class: primary ? 'runs-button' : 'runs-button secondary',
          type: 'button',
          disabled: progress !== undefined,
          onclick: () => this.send({ type: 'cfa:analyse-sender', runs: mode }),
        },
        label,
      );
    const allRuns = h(
      'button',
      {
        class: 'runs-button secondary',
        type: 'button',
        title: 'Every run on its own page: filter by duration, status and date',
        onclick: () =>
          this.send({
            type: 'cfa:open-runs',
            environment: result.ref.environment,
            flowId: result.ref.flowId,
          }),
      },
      'All runs ↗',
    );
    const runs = result.runs;
    if (!runs) {
      this.runsBox.replaceChildren(
        h(
          'div',
          { class: 'runs-cta' },
          h(
            'div',
            { class: 'runs-actions' },
            read('recent', 'Analyse recent runs'),
            read('slowest', 'Slowest runs', false),
            allRuns,
          ),
          h(
            'span',
            { class: 'hint' },
            'Reads the last 20 runs (or the 20 slowest of the last 100): timings, loop sizes and failures. No data from inside the runs.',
          ),
        ),
        ...reading,
        ...(result.runsError ? [h('p', { class: 'runs-error' }, result.runsError)] : []),
      );
      return;
    }
    const other: [RunSampleMode, string] =
      runs.mode === 'recent' ? ['slowest', 'Slowest runs'] : ['recent', 'Recent runs'];
    const again = h(
      'div',
      { class: 'runs-actions' },
      read(runs.mode, 'Read runs again'),
      read(other[0], other[1], false),
      allRuns,
      h(
        'button',
        {
          class: 'dismiss',
          type: 'button',
          title: 'Timings and statuses of runs read so far are kept in this browser',
          onclick: () => {
            this.send({ type: 'cfa:clear-run-cache' });
            this.setToast('Cached runs cleared.');
          },
        },
        'Clear cached runs',
      ),
    );
    if (runs.sampled === 0) {
      this.runsBox.replaceChildren(
        h(
          'p',
          { class: 'hint' },
          runs.cancelled
            ? 'Stopped before any run was read.'
            : 'No finished runs yet. Run the flow, then analyse again.',
        ),
        again,
        ...reading,
      );
      return;
    }
    const statuses = Object.entries(runs.statuses)
      .sort((a, b) => b[1] - a[1])
      .map(([status, count]) => `${count} ${status.toLowerCase()}`)
      .join(', ');
    const row = (item: PaneRunTarget, value: string) =>
      h('li', {}, this.targetButton(item), h('span', { class: 'value' }, value));
    const list = (title: string, items: HTMLElement[]) =>
      items.length > 0 ? [h('h4', {}, title), h('ul', {}, ...items)] : [];
    const title =
      runs.mode === 'slowest'
        ? `Slowest ${runs.sampled} of ${runs.listed} runs · median ${formatDuration(runs.durationP50Ms)}`
        : `Recent runs · ${runs.sampled} · median ${formatDuration(runs.durationP50Ms)}`;
    this.runsBox.replaceChildren(
      h(
        'details',
        { open: true },
        h('summary', {}, title),
        h(
          'p',
          { class: 'hint' },
          `${statuses} · slowest 5%: ${formatDuration(runs.durationP95Ms)}${runs.fromCache ? ` · ${runs.fromCache} from cache` : ''}`,
        ),
        ...(runs.cancelled
          ? [h('p', { class: 'hint' }, `Stopped after ${runs.sampled} of ${runs.picked} runs.`)]
          : []),
        ...this.renderRequests(runs),
        ...list(
          'Where the time goes',
          runs.slowest.map((item) =>
            row(
              item,
              item.timeSharePct !== undefined
                ? `${item.timeSharePct}% · ${formatDuration(item.busyP50Ms)}`
                : `${formatDuration(item.busyP50Ms)} · ${item.executionsPerRun ?? 1}×`,
            ),
          ),
        ),
        ...list(
          'Loop sizes',
          runs.loops.map((loop) =>
            row(
              loop,
              `${loop.iterationsP50}${loop.truncated ? '+' : ''} ${loop.iterationsP50 === 1 && !loop.truncated ? 'item' : 'items'}${loop.nested ? ' per outer item' : ''} (max ${loop.iterationsMax}${loop.truncated ? '+' : ''})`,
            ),
          ),
        ),
        ...list(
          'Failures',
          runs.failures.map((item) =>
            row(
              item,
              [
                item.failed ? `failed ${item.failed}×` : '',
                item.throttled ? `throttled ${item.throttled}×` : '',
              ]
                .filter(Boolean)
                .join(' · '),
            ),
          ),
        ),
        h('p', { class: 'hint' }, 'Medians per run. Findings below now use these numbers.'),
        again,
        ...reading,
      ),
    );
  }

  /**
   * On a run's page of the flow shown, reads that run's parent and child runs (again when the
   * user opens another run); elsewhere, hides them.
   */
  private syncRunLinks(force = false): void {
    const current = parseFlowUrl(location.href);
    const shown = this.result?.ref;
    // Another flow: the notice offers to analyse it, and the links follow.
    if (!current || !shown || current.flowId !== shown.flowId) return;
    if (current.runName === this.linksRun && !force) return;
    this.linksRun = current.runName;
    this.links = undefined;
    this.renderRunLinks();
    if (current.runName) this.send({ type: 'cfa:run-links' });
  }

  private renderRunLinks(): void {
    const box = this.linksBox;
    box.hidden = this.linksRun === undefined;
    if (box.hidden) {
      box.replaceChildren();
      return;
    }
    const links = this.links;
    if (!links) {
      box.replaceChildren(
        h('h3', {}, 'This run'),
        h(
          'p',
          { class: 'hint', role: 'status' },
          'Looking for the run that started it and the child flow runs it started…',
        ),
      );
      return;
    }
    const again = h(
      'div',
      { class: 'runs-actions' },
      h(
        'button',
        { class: 'dismiss', type: 'button', onclick: () => this.syncRunLinks(true) },
        'Look again',
      ),
    );
    if (links.error) {
      box.replaceChildren(
        h('h3', {}, 'This run'),
        h('p', { class: 'runs-error' }, links.error),
        again,
      );
      return;
    }
    const run = links.run;
    const title = run
      ? `This run · ${run.status}${run.durationMs !== undefined ? ` · ${formatDuration(run.durationMs)}` : ''}`
      : 'This run';
    box.replaceChildren(
      h(
        'details',
        { open: true },
        h('summary', {}, title),
        h('h4', {}, 'Started by'),
        ...this.renderOrigin(links),
        h('h4', {}, 'Child flow runs'),
        ...this.renderChildren(links),
        h(
          'p',
          { class: 'hint' },
          'Matched by the tracking ID runs share and by time. Links open in a new tab.',
        ),
        again,
      ),
    );
  }

  private renderOrigin(links: PaneRunLinks): HTMLElement[] {
    const origin = links.origin;
    if (!origin) return [];
    switch (origin.kind) {
      case 'trigger':
        return [
          h(
            'p',
            { class: 'origin' },
            origin.triggerName
              ? `Its trigger (${actionLabel(origin.triggerName)}). No other run started it.`
              : 'Its trigger. No other run started it.',
          ),
        ];
      case 'resubmitted':
        return [
          h('p', { class: 'origin' }, 'Resubmitted from an earlier run:'),
          h('ul', {}, this.runItem(origin.run, false)),
        ];
      case 'parent':
        return [
          h('ul', {}, this.runItem(origin.run, true)),
          h(
            'p',
            { class: 'hint' },
            `Called by ${origin.actions.map(actionLabel).join(' or ')} in that flow.`,
          ),
        ];
      case 'unknown':
        return [
          h('p', { class: 'origin' }, 'Another run, which was not found.'),
          h('p', { class: 'hint' }, origin.reason),
          h('p', { class: 'hint' }, `Tracking ID: ${origin.trackingId}`),
        ];
    }
  }

  private renderChildren(links: PaneRunLinks): HTMLElement[] {
    if (links.children.length === 0) {
      return [h('p', { class: 'hint' }, "This flow doesn't call any child flows.")];
    }
    return links.children.map((child) =>
      h(
        'div',
        { class: 'child-flow' },
        h('div', { class: 'child-name' }, child.displayName),
        h(
          'div',
          { class: 'child-actions' },
          ...child.actions.map((action) => this.targetButton(action)),
        ),
        child.runs.length > 0
          ? h('ul', {}, ...child.runs.map((run) => this.runItem(run, false)))
          : null,
        child.more > 0 ? h('p', { class: 'hint' }, `and ${child.more} more`) : null,
        child.note ? h('p', { class: 'hint' }, child.note) : null,
      ),
    );
  }

  /** A run with a link to its page in the portal; `withFlow` also names its flow. */
  private runItem(run: LinkedRun, withFlow: boolean): HTMLElement {
    const when = formatStart(run.startTime);
    return h(
      'li',
      {},
      h(
        'a',
        {
          class: 'run-link',
          href: flowRunUrl(run.environment, run.flowName, run.runName),
          target: '_blank',
          rel: 'noreferrer',
          title: `Open run ${run.runName}`,
        },
        withFlow ? `${run.displayName ?? run.flowName} · ${when}` : when,
      ),
      h(
        'span',
        { class: `value status-${run.status.toLowerCase()}` },
        run.durationMs !== undefined
          ? `${run.status} · ${formatDuration(run.durationMs)}`
          : run.status,
      ),
    );
  }

  /** Requests a day at the recent pace, against the daily limit the user set. */
  private renderRequests(runs: PaneRuns): HTMLElement[] {
    const perRun = runs.actionsPerRun;
    // The slowest runs aren't typical: only the recent sample gives the pace.
    if (runs.mode !== 'recent' || !perRun || runs.runsPerDay === undefined) return [];
    const perDay = Math.round(perRun.mean * runs.runsPerDay);
    const pace = formatPace(runs.runsPerDay);
    const limit = runs.dailyRequestLimit;
    const share = limit
      ? ` · ${Math.round((perDay / limit) * 100)}% of your ${limit.toLocaleString('en-US')} limit`
      : '';
    return [
      h('h4', {}, 'Requests'),
      h(
        'p',
        { class: 'requests' },
        `About ${perDay < 1 ? 'less than 1' : perDay.toLocaleString('en-US')} a day (${pace} × ${perRun.mean.toLocaleString('en-US')} per run)${share}`,
      ),
      this.limitPicker(limit, runs.mode),
    ];
  }

  private limitPicker(limit: number | undefined, mode: RunSampleMode): HTMLElement {
    const custom = h('input', {
      class: 'limit-input',
      type: 'number',
      min: '1',
      step: '1000',
      placeholder: 'Requests per 24 h',
      'aria-label': 'Daily request limit',
      hidden: true,
    });
    const apply = h(
      'button',
      {
        class: 'dismiss',
        type: 'button',
        hidden: true,
        onclick: () => {
          const value = Number(custom.value);
          if (Number.isFinite(value) && value > 0) this.setLimit(value, mode);
        },
      },
      'Set',
    );
    const select = h(
      'select',
      {
        class: 'limit-select',
        'aria-label': 'Daily request limit',
        onchange: () => {
          if (select.value === 'custom') {
            custom.hidden = false;
            apply.hidden = false;
            custom.focus();
          } else if (select.value === 'none') this.setLimit(undefined, mode);
          else if (select.value) this.setLimit(Number(select.value), mode);
        },
      },
      h(
        'option',
        { value: '' },
        limit ? 'Change your daily limit…' : 'Compare with your daily limit…',
      ),
      ...LIMIT_PRESETS.map(([value, label]) =>
        h('option', { value: String(value) }, `${value.toLocaleString('en-US')} · ${label}`),
      ),
      h('option', { value: 'custom' }, 'Other…'),
      ...(limit ? [h('option', { value: 'none' }, 'Remove the limit')] : []),
    );
    return h('div', { class: 'runs-actions limit' }, select, custom, apply);
  }

  private setLimit(limit: number | undefined, mode: RunSampleMode): void {
    this.send({ type: 'cfa:set-limit', ...(limit ? { limit } : {}), runs: mode });
    this.setToast(
      limit ? `Daily limit set to ${limit.toLocaleString('en-US')}.` : 'Daily limit removed.',
    );
  }

  private targetButton(item: PaneRunTarget): HTMLElement {
    return h(
      'button',
      {
        class: 'target',
        type: 'button',
        title: 'Show in the designer',
        onclick: () => void this.reveal(item),
      },
      `⌖ ${item.targetLabel}`,
    );
  }

  private renderFinding(finding: PaneFinding): HTMLElement {
    const canReveal = finding.target.kind !== 'flow' && finding.target.name !== undefined;
    const target = canReveal
      ? this.targetButton(finding)
      : h('span', { class: 'target static' }, finding.targetLabel);
    const example = finding.example
      ? [
          h('div', { class: 'label' }, 'Before'),
          h('pre', {}, finding.example.before),
          h('div', { class: 'label' }, 'After'),
          h('pre', {}, finding.example.after),
        ]
      : [];
    return h(
      'article',
      { class: 'finding' },
      h(
        'div',
        { class: 'finding-head' },
        h('span', { class: `severity ${finding.severity}` }, SEVERITY_LABEL[finding.severity]),
        h('span', { class: 'rule' }, finding.title),
        h('span', { class: 'rule-id' }, finding.ruleId),
      ),
      h(
        'div',
        { class: 'target-row' },
        target,
        h(
          'button',
          {
            class: 'dismiss',
            type: 'button',
            title: this.dismissed.has(findingKey(finding))
              ? 'Show this finding again'
              : 'Hide this finding and leave it out of the score',
            onclick: () =>
              void this.setDismissed(finding, !this.dismissed.has(findingKey(finding))),
          },
          this.dismissed.has(findingKey(finding)) ? 'Restore' : 'Dismiss',
        ),
      ),
      h('p', { class: 'message' }, finding.message),
      finding.blockedBy
        ? h('div', { class: 'blocked' }, `Fix ${finding.blockedBy.join(', ')} first.`)
        : null,
      h(
        'details',
        {},
        h('summary', {}, 'How to fix'),
        h('p', {}, finding.fix),
        h('div', { class: 'label' }, 'Why it matters'),
        h('p', {}, finding.why),
        ...example,
        h('div', { class: 'label' }, 'Read more'),
        h(
          'ul',
          { class: 'docs' },
          h(
            'li',
            {},
            h(
              'a',
              { href: finding.ruleUrl, target: '_blank', rel: 'noreferrer' },
              `About ${finding.ruleId}`,
            ),
          ),
          ...finding.docs.map((doc) =>
            h(
              'li',
              {},
              h(
                'a',
                { href: doc.url, target: '_blank', rel: 'noreferrer' },
                `Microsoft: ${doc.title}`,
              ),
            ),
          ),
        ),
      ),
    );
  }

  private async reveal(item: PaneRunTarget): Promise<void> {
    const name = item.target.name;
    if (!name) return;
    this.setToast(`Looking for "${item.targetLabel}"…`);
    try {
      const outcome = await revealAction(name, item.target.path, {
        reservedRight: this.panel.hidden ? 0 : PANE_WIDTH,
        order: this.result?.order ?? [],
        parents: this.result?.parents ?? {},
        steps: item.steps,
        onProgress: (text) => this.setToast(text),
      });
      this.setToast(outcome.message, !outcome.ok);
    } catch (error) {
      this.setToast(error instanceof Error ? error.message : String(error), true);
    }
  }

  private async copyCheck(): Promise<void> {
    const text = JSON.stringify(designerCheck(), null, 2);
    this.checkOutput.textContent = text;
    try {
      await navigator.clipboard.writeText(text);
      this.setToast('Designer check copied.');
    } catch {
      this.setToast('Select the text below and copy it.');
    }
  }

  /** The portal is a single-page app: offer to re-analyse when the user opens another flow. */
  private watchUrl(): void {
    clearInterval(this.urlTimer);
    this.urlTimer = setInterval(() => {
      this.syncRunLinks();
      const current = parseFlowUrl(location.href);
      const shown = this.result?.ref;
      const notice = this.header.querySelector('.notice');
      if (!current || !shown || current.flowId === shown.flowId) {
        notice?.remove();
        return;
      }
      if (notice) return;
      this.header.append(
        h(
          'div',
          { class: 'notice' },
          'You opened another flow.',
          h(
            'button',
            { type: 'button', onclick: () => this.send({ type: 'cfa:analyse-sender' }) },
            'Analyse it',
          ),
        ),
      );
    }, 1000);
  }
}
