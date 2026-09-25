// The analysis pane shown on the maker portal page. It lives in a shadow root so the
// portal's styles and ours can't affect each other, and it only ever shows data the background
// worker sends it.
import { h } from '../shared/dom.ts';
import { parseFlowUrl } from '../shared/flow-url.ts';
import type { BackgroundMessage } from '../shared/messages.ts';
import type { PaneFinding, PaneResult } from '../shared/pane-result.ts';
import styles from './pane.css?raw';
import { designerCheck, revealAction } from './reveal.ts';

export const HOST_ID = 'cfa-pane-host';
const PANE_WIDTH = 400;

type Severity = PaneFinding['severity'];
type Filter = 'all' | Severity;

const SEVERITY_LABEL: Record<Severity, string> = { high: 'HIGH', medium: 'MEDIUM', low: 'LOW' };

export class Pane {
  private readonly host: HTMLElement;
  private readonly root: ShadowRoot;
  private readonly panel: HTMLElement;
  private readonly tab: HTMLButtonElement;
  private readonly header: HTMLElement;
  private readonly body: HTMLElement;
  private readonly toast: HTMLElement;
  private readonly checkOutput: HTMLPreElement;
  private result: PaneResult | undefined;
  private filter: Filter = 'all';
  private urlTimer: ReturnType<typeof setInterval> | undefined;
  private readonly send: (message: BackgroundMessage) => void;

  constructor(send: (message: BackgroundMessage) => void) {
    this.send = send;
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
    this.body = h('div', { class: 'body' });
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

  showLoading(): void {
    this.result = undefined;
    this.setMinimised(false);
    this.renderHeader();
    this.body.replaceChildren(h('p', { class: 'state' }, 'Reading and analysing the flow…'));
    this.setToast('');
  }

  showError(message: string): void {
    this.setMinimised(false);
    this.renderHeader();
    this.body.replaceChildren(h('p', { class: 'state error' }, message));
  }

  showResult(result: PaneResult): void {
    this.result = result;
    this.filter = 'all';
    this.setMinimised(false);
    this.renderHeader();
    this.renderFindings();
    this.watchUrl();
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
      ? `Flow Analyzer · ${this.result.findings.length}`
      : 'Flow Analyzer';
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
          onclick: () => this.send({ type: 'cfa:analyse-sender' }),
        },
        '↻',
      ),
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
    const counts = { high: 0, medium: 0, low: 0 };
    for (const f of result.findings) counts[f.severity]++;
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
          { class: `grade ${result.grade}`, title: `Score ${result.overall} / 100` },
          result.grade,
        ),
        h(
          'div',
          { class: 'scores' },
          'Speed ',
          h('b', {}, result.categories.speed),
          ' · Resources ',
          h('b', {}, result.categories.resources),
          ' · Reliability ',
          h('b', {}, result.categories.reliability),
          h('br'),
          `${result.actionCount} actions · ~${result.estimate.total.toLocaleString('en-US')} per run${result.estimate.assumed ? ' (estimated)' : ''}`,
        ),
      ),
      h(
        'div',
        { class: 'filters', role: 'group', 'aria-label': 'Filter by severity' },
        chip('all', `All ${result.findings.length}`),
        chip('high', `High ${counts.high}`),
        chip('medium', `Medium ${counts.medium}`),
        chip('low', `Low ${counts.low}`),
      ),
    );
  }

  private renderFindings(): void {
    const result = this.result;
    if (!result) return;
    if (result.findings.length === 0) {
      this.body.replaceChildren(
        h('p', { class: 'state ok' }, 'No problems found. This flow follows every rule we check.'),
      );
      return;
    }
    const shown = result.findings.filter(
      (f) => this.filter === 'all' || f.severity === this.filter,
    );
    this.body.replaceChildren(...shown.map((finding) => this.renderFinding(finding)));
  }

  private renderFinding(finding: PaneFinding): HTMLElement {
    const canReveal = finding.target.kind !== 'flow' && finding.target.name !== undefined;
    const target = canReveal
      ? h(
          'button',
          {
            class: 'target',
            type: 'button',
            title: 'Show in the designer',
            onclick: () => void this.reveal(finding),
          },
          `⌖ ${finding.targetLabel}`,
        )
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
      target,
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
        ...finding.docs.map((url) =>
          h(
            'div',
            {},
            h('a', { href: url, target: '_blank', rel: 'noreferrer' }, 'Microsoft docs'),
          ),
        ),
      ),
    );
  }

  private async reveal(finding: PaneFinding): Promise<void> {
    const name = finding.target.name;
    if (!name) return;
    this.setToast(`Looking for "${finding.targetLabel}"…`);
    try {
      const outcome = await revealAction(name, finding.target.path, {
        reservedRight: this.panel.hidden ? 0 : PANE_WIDTH,
        order: this.result?.order ?? [],
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
