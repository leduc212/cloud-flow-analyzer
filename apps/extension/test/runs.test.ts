// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import bad from '../../../fixtures/flows/sync-contacts-bad.json' with { type: 'json' };
import { analyseFlow, parseFlow } from '@cfa/core';
import { createApiClient } from '../src/api/client.ts';
import { flowApi } from '../src/api/flows.ts';
import { fetchRunSamples, type RunSampleOptions } from '../src/api/runs.ts';
import { HOST_ID, Pane, type DismissalStore } from '../src/content/pane.ts';
import { formatPace, markdownReport, scoreWithout } from '../src/content/report.ts';
import type { BackgroundMessage } from '../src/shared/messages.ts';
import { buildPaneResult } from '../src/shared/pane-result.ts';
import { memoryRunCache } from '../src/shared/run-cache.ts';
import type { TokenRecord } from '../src/shared/token.ts';

const ORIGIN = 'https://api.flow.microsoft.com';
const TOKEN: TokenRecord = { kind: 'flow', token: 't', capturedAt: 0, origins: [ORIGIN] };
const FLOW = 'flow-1';
const api = flowApi(ORIGIN);
const tree = parseFlow(bad);

const at = (seconds: number) => new Date(Date.UTC(2026, 0, 1) + seconds * 1000).toISOString();
const entry = (name: string, status: string, start = 0, end = 1) => ({
  name,
  properties: { status, startTime: at(start), endTime: at(end) },
});
const repetitions = (count: number, from = 0) =>
  Array.from({ length: count }, (_, i) => ({
    properties: {
      repetitionIndexes: [{ scopeName: 'Apply_to_each', itemIndex: from + i }],
      status: 'Succeeded',
      startTime: at(1 + i * 0.05),
      endTime: at(1.02 + i * 0.05),
    },
  }));

/** The runs API for `sync-contacts-bad`: r1 loops, r2 skips the loop, r3 is still running. */
function handler(url: URL): Response {
  const path = decodeURIComponent(url.pathname);
  const body = (() => {
    if (path.endsWith(`/flows/${FLOW}/runs`)) {
      return {
        value: [
          { name: 'r1', properties: { status: 'Succeeded', startTime: at(0), endTime: at(10) } },
          { name: 'r2', properties: { status: 'Failed', startTime: at(0), endTime: at(2) } },
          { name: 'r3', properties: { status: 'Running', startTime: at(0) } },
        ],
      };
    }
    if (path.endsWith('/runs/r1/actions')) {
      return {
        value: [
          entry('List_accounts', 'Succeeded', 0, 1),
          entry('Apply_to_each', 'Succeeded', 1, 9),
        ],
      };
    }
    if (path.endsWith('/runs/r2/actions')) {
      return {
        value: [entry('List_accounts', 'Failed', 0, 2), entry('Apply_to_each', 'Skipped')],
      };
    }
    if (path.endsWith('/runs/r1/actions/Get_primary_contact/repetitions')) {
      // A full page with more to come: the list is cut off at one page.
      return {
        value: repetitions(100),
        nextLink: `${ORIGIN}${url.pathname}?page=2`,
      };
    }
    if (path.includes('/runs/r1/actions/')) return { value: repetitions(4) };
    return undefined;
  })();
  return body
    ? new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
    : new Response('{"error":{"code":"NotFound"}}', { status: 404 });
}

function setup(onFetch?: (url: URL) => void, signal?: AbortSignal) {
  const calls: string[] = [];
  const client = createApiClient({
    getToken: () => TOKEN,
    fetch: async (input) => {
      const url = new URL(String(input));
      calls.push(decodeURIComponent(url.pathname));
      onFetch?.(url);
      return handler(url);
    },
    sleep: async () => undefined,
    ...(signal ? { signal } : {}),
  });
  return { client, calls };
}

const options = (extra: Partial<RunSampleOptions> = {}): RunSampleOptions => ({
  runs: 20,
  repetitionPages: 1,
  maxLoopActions: 15,
  ...extra,
});

describe('fetchRunSamples', () => {
  it('reads finished runs, and repetitions only for loops that ran', async () => {
    const { client, calls } = setup();
    const progress: string[] = [];
    const result = await fetchRunSamples(
      client,
      api,
      'env',
      FLOW,
      tree,
      options({ onProgress: (done, total) => progress.push(`${done}/${total}`) }),
    );
    expect(result.listed).toBe(3);
    expect(result.samples.map((s) => s.name).sort()).toEqual(['r1', 'r2']);
    const r1 = result.samples.find((s) => s.name === 'r1');
    expect(Object.keys(r1?.repetitions ?? {}).sort()).toEqual([
      'Get_primary_contact',
      'Update_account',
    ]);
    expect(r1?.truncated).toEqual(['Get_primary_contact']);
    expect(result.samples.find((s) => s.name === 'r2')?.repetitions).toEqual({});
    expect(calls.filter((c) => c.includes('/r2/actions/'))).toEqual([]);
    expect(calls.filter((c) => c.includes('/r3/'))).toEqual([]);
    expect(progress[0]).toBe('0/2');
    expect(progress.at(-1)).toBe('2/2');
  });

  it('uses cached runs instead of fetching them again', async () => {
    const cache = memoryRunCache();
    const first = setup();
    await fetchRunSamples(first.client, api, 'env', FLOW, tree, options({ cache }));
    const second = setup();
    const result = await fetchRunSamples(second.client, api, 'env', FLOW, tree, options({ cache }));
    expect(result.fromCache).toBe(2);
    expect(second.calls).toEqual([
      `/providers/Microsoft.ProcessSimple/environments/env/flows/${FLOW}/runs`,
    ]);
    // A changed flow (different loop actions) reads the runs again.
    const changed = setup();
    await fetchRunSamples(
      changed.client,
      api,
      'env',
      FLOW,
      tree,
      options({ cache, maxLoopActions: 1 }),
    );
    expect(changed.calls.length).toBeGreaterThan(1);
  });
});

async function paneResult(extra: Partial<RunSampleOptions> = {}, dailyRequestLimit?: number) {
  const { client } = setup();
  const { samples, ...fetched } = await fetchRunSamples(
    client,
    api,
    'env',
    FLOW,
    tree,
    options({ now: () => Date.parse(at(86_400)), ...extra }),
  );
  return buildPaneResult(
    { environment: 'env', flowId: FLOW },
    analyseFlow(bad, {
      runs: samples,
      sample: fetched.mode,
      ...(fetched.runsPerDay !== undefined ? { runsPerDay: fetched.runsPerDay } : {}),
      ...(dailyRequestLimit ? { dailyRequestLimit } : {}),
    }),
    new Date(0),
    { ...fetched, ...(dailyRequestLimit ? { dailyRequestLimit } : {}) },
  );
}

describe('formatPace', () => {
  it('reads naturally for busy and quiet flows', () => {
    expect([48.2, 1.6, 1, 0.26, 1 / 30].map(formatPace)).toEqual([
      '48 runs a day',
      '2 runs a day',
      '1 run a day',
      '1 run every 4 days',
      '1 run every 30 days',
    ]);
  });
});

describe('sample modes and stopping', () => {
  it('picks the slowest finished runs of a longer list, and works out the pace', async () => {
    const { client, calls } = setup();
    const result = await fetchRunSamples(
      client,
      api,
      'env',
      FLOW,
      tree,
      options({ mode: 'slowest', runs: 1, slowestOf: 100, now: () => Date.parse(at(86_400)) }),
    );
    expect(result).toMatchObject({ mode: 'slowest', listed: 3, picked: 1, cancelled: false });
    expect(result.samples.map((s) => s.name)).toEqual(['r1']);
    // Three runs started in the last day.
    expect(result.runsPerDay).toBe(3);
    expect(calls[0]).toContain('/runs');
    expect(calls.some((c) => c.includes('/r2/'))).toBe(false);
  });

  it('keeps the runs read so far when stopped', async () => {
    const controller = new AbortController();
    const { client } = setup((url) => {
      if (url.pathname.endsWith('/repetitions')) {
        controller.abort();
        throw new DOMException('Stopped', 'AbortError');
      }
    }, controller.signal);
    const result = await fetchRunSamples(
      client,
      api,
      'env',
      FLOW,
      tree,
      options({ signal: controller.signal }),
    );
    expect(result.cancelled).toBe(true);
    expect(result.samples.map((s) => s.name)).toEqual(['r2']);
    expect(result.picked).toBe(2);
  });
});

describe('runs in the pane result and report', () => {
  it('summarises time, loop sizes and failures', async () => {
    const result = await paneResult();
    const runs = result.runs!;
    expect(runs).toMatchObject({ mode: 'recent', sampled: 2, listed: 3, fromCache: 0 });
    expect(runs.runsPerDay).toBe(3);
    expect(runs.actionsPerRun?.mean).toBeGreaterThan(0);
    expect(runs.statuses).toEqual({ Succeeded: 1, Failed: 1 });
    expect(runs.slowest[0]?.targetLabel).toBe('Apply to each');
    expect(runs.loops).toEqual([
      expect.objectContaining({
        targetLabel: 'Apply to each',
        iterationsP50: 100,
        truncated: true,
      }),
    ]);
    expect(runs.failures.map((f) => f.targetLabel)).toEqual(['List accounts']);
    const spd01 = result.findings.find((f) => f.ruleId === 'SPD01');
    expect(spd01?.evidence?.timeSharePct).toBe(80);
    // Rescoring in the pane gives the same score as the analysis, evidence included.
    expect(scoreWithout(result, new Set()).overall).toBe(result.overall);
    const report = markdownReport(result, new Set());
    expect(report).toContain('**Recent runs:** 2 (1 succeeded, 1 failed)');
    expect(report).toContain('- Apply to each: 100+ items (max 100)');
  });

  it('carries the reason when runs could not be read', () => {
    const result = buildPaneResult(
      { environment: 'env', flowId: FLOW },
      analyseFlow(bad),
      new Date(0),
      { error: 'No access to the run history.' },
    );
    expect(result.runs).toBeUndefined();
    expect(result.runsError).toBe('No access to the run history.');
  });
});

describe('runs in the pane', () => {
  const store: DismissalStore = { load: async () => [], save: async () => undefined };
  const shadow = () => document.getElementById(HOST_ID)!.shadowRoot!;
  const text = (selector: string) => shadow().querySelector(selector)?.textContent ?? '';
  const button = (label: string) =>
    [...shadow().querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.startsWith(label),
    );

  afterEach(() => document.getElementById(HOST_ID)?.remove());

  it('offers run analysis, shows progress without hiding the findings, then the summary', async () => {
    const sent: BackgroundMessage[] = [];
    const pane = new Pane((m) => sent.push(m), store);
    const plain = buildPaneResult({ environment: 'env', flowId: FLOW }, analyseFlow(bad));
    await pane.showResult(plain);
    button('Analyse recent runs')!.click();
    expect(sent).toEqual([{ type: 'cfa:analyse-sender', runs: 'recent' }]);
    button('Slowest runs')!.click();
    expect(sent.at(-1)).toEqual({ type: 'cfa:analyse-sender', runs: 'slowest' });

    pane.showLoading(true);
    pane.showRunsProgress(1, 2);
    expect(text('.runs-progress')).toBe('Reading runs… 1 of 2');
    expect(shadow().querySelectorAll('.finding').length).toBe(plain.findings.length);
    expect(button('Analyse recent runs')!.disabled).toBe(true);
    button('Stop')!.click();
    expect(sent.at(-1)).toEqual({ type: 'cfa:cancel-runs' });

    const withRuns = await paneResult();
    await pane.showResult(withRuns);
    expect(text('.runs summary')).toBe('Recent runs · 2 · median 2.0 s');
    expect(text('.runs')).toContain('Where the time goes');
    expect(text('.runs')).toContain('100+ items (max 100+)');
    expect(text('.runs-progress')).toBe('');
    expect(text('.scores')).toContain('(from runs)');

    button('Clear cached runs')!.click();
    expect(sent.at(-1)).toEqual({ type: 'cfa:clear-run-cache' });
    expect(text('.toast')).toBe('Cached runs cleared.');

    // Analysing again keeps reading runs.
    shadow().querySelector<HTMLButtonElement>('button[title="Analyse again"]')!.click();
    expect(sent.at(-1)).toEqual({ type: 'cfa:analyse-sender', runs: 'recent' });
  });

  it('shows requests a day and lets the user pick a daily limit', async () => {
    const sent: BackgroundMessage[] = [];
    const pane = new Pane((m) => sent.push(m), store);
    const result = await paneResult();
    await pane.showResult(result);
    const mean = result.runs!.actionsPerRun!.mean;
    expect(text('.requests')).toBe(
      `About ${(mean * 3).toLocaleString('en-US')} a day (3 runs a day × ${mean} per run)`,
    );
    const select = shadow().querySelector<HTMLSelectElement>('.limit-select')!;
    select.value = '40000';
    select.dispatchEvent(new Event('change'));
    expect(sent.at(-1)).toEqual({ type: 'cfa:set-limit', limit: 40_000, runs: 'recent' });

    select.value = 'custom';
    select.dispatchEvent(new Event('change'));
    const input = shadow().querySelector<HTMLInputElement>('.limit-input')!;
    expect(input.hidden).toBe(false);
    input.value = '12000';
    button('Set')!.click();
    expect(sent.at(-1)).toEqual({ type: 'cfa:set-limit', limit: 12_000, runs: 'recent' });

    await pane.showResult(await paneResult({}, 1000));
    expect(text('.requests')).toContain(`% of your 1,000 limit`);
    const withLimit = shadow().querySelector<HTMLSelectElement>('.limit-select')!;
    withLimit.value = 'none';
    withLimit.dispatchEvent(new Event('change'));
    expect(sent.at(-1)).toEqual({ type: 'cfa:set-limit', runs: 'recent' });
  });

  it('labels the slowest runs, without a daily pace', async () => {
    const pane = new Pane(vi.fn(), store);
    await pane.showResult(await paneResult({ mode: 'slowest', runs: 1 }));
    expect(text('.runs summary')).toBe('Slowest 1 of 3 runs · median 10.0 s');
    expect(text('.requests')).toBe('');
    expect(button('Recent runs')).toBeDefined();
  });

  it('shows why runs could not be read', async () => {
    const pane = new Pane(vi.fn(), store);
    await pane.showResult(
      buildPaneResult({ environment: 'env', flowId: FLOW }, analyseFlow(bad), new Date(0), {
        error: 'No access to the run history.',
      }),
    );
    expect(text('.runs-error')).toBe('No access to the run history.');
  });
});
