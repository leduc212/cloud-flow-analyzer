import { describe, expect, it } from 'vitest';
import bad from '../../../fixtures/flows/sync-contacts-bad.json' with { type: 'json' };
import { parseFlow } from '@cfa/core';
import { createApiClient } from '../src/api/client.ts';
import { flowApi } from '../src/api/flows.ts';
import { fetchRunSamples, listRuns, type ListedRun } from '../src/api/runs.ts';
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
  type RunFilter,
} from '../src/runs/model.ts';
import type { TokenRecord } from '../src/shared/token.ts';

const ORIGIN = 'https://api.flow.microsoft.com';
const TOKEN: TokenRecord = { kind: 'flow', token: 't', capturedAt: 0, origins: [ORIGIN] };
const api = flowApi(ORIGIN);
const T0 = Date.UTC(2026, 9, 1);
const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();
const NOW = T0 + 10_000_000;

const run = (name: string, start: number, seconds: number | undefined, status = 'Succeeded') => ({
  name,
  status,
  startTime: at(start),
  ...(seconds !== undefined ? { endTime: at(start + seconds) } : {}),
});

// Newest first: quick, slow, failed, one still running, one without times.
const RUNS: ListedRun[] = [
  run('running', 9000, undefined, 'Running'),
  run('quick', 5000, 0.5),
  run('slow', 4000, 600),
  run('failed', 3000, 45, 'Failed'),
  run('medium', 2000, 90),
  { name: 'odd', status: 'Succeeded' },
];
const rows = toRows(RUNS, NOW);
const none: RunFilter = { hidden: new Set() };
const names = (list: { name: string }[]) => list.map((r) => r.name);

describe('run rows', () => {
  it('works out durations, counting runs still going up to now', () => {
    const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
    expect(byName.quick?.durationMs).toBe(500);
    expect(byName.slow?.durationMs).toBe(600_000);
    expect(byName.running).toMatchObject({ running: true, durationMs: NOW - (T0 + 9_000_000) });
    expect(byName.odd?.durationMs).toBeUndefined();
  });

  it('filters by duration, status and start time', () => {
    expect(names(filterRuns(rows, { ...none, minMs: 60_000 }))).toEqual([
      'running',
      'slow',
      'medium',
    ]);
    expect(names(filterRuns(rows, { ...none, minMs: 30_000, maxMs: 120_000 }))).toEqual([
      'failed',
      'medium',
    ]);
    expect(names(filterRuns(rows, { hidden: new Set(['succeeded', 'running']) }))).toEqual([
      'failed',
    ]);
    expect(names(filterRuns(rows, { ...none, from: T0 + 3_000_000, to: T0 + 5_000_000 }))).toEqual([
      'quick',
      'slow',
      'failed',
    ]);
  });

  it('sorts by duration or start, runs without a duration last', () => {
    expect(names(sortRuns(rows, 'duration'))).toEqual([
      'running',
      'slow',
      'medium',
      'failed',
      'quick',
      'odd',
    ]);
    expect(names(sortRuns(rows, 'duration', false)).slice(0, 2)).toEqual(['quick', 'failed']);
    expect(names(sortRuns(rows, 'started', false))[0]).toBe('medium');
  });

  it('summarises finished runs only, and counts statuses', () => {
    const stats = durationStats(rows);
    expect(stats).toMatchObject({ count: 4, p50Ms: 45_000, maxMs: 600_000 });
    expect(statusCounts(rows)).toEqual([
      ['Succeeded', 4],
      ['Failed', 1],
      ['Running', 1],
    ]);
  });

  it('reads and splits typed durations', () => {
    expect(parseDuration('2.5', 'min')).toBe(150_000);
    expect(parseDuration('', 's')).toBeUndefined();
    expect(parseDuration('-1', 's')).toBeUndefined();
    expect(parseDuration('abc', 'h')).toBeUndefined();
    expect(splitDuration(150_000)).toEqual({ value: '2.5', unit: 'min' });
    expect(splitDuration(5400_000)).toEqual({ value: '1.5', unit: 'h' });
    expect(splitDuration(800)).toEqual({ value: '0.8', unit: 's' });
  });
});

describe('the duration histogram', () => {
  it('counts runs per bucket, from the first bucket with runs to the last', () => {
    const buckets = histogram(rows, { ...none, minMs: 60_000 });
    expect(buckets[0]).toMatchObject({ fromMs: 0, toMs: 1000, count: 1, matching: 0 });
    expect(buckets.map(bucketLabel)).toEqual([
      'under 1 s',
      '1–2 s',
      '2–5 s',
      '5–10 s',
      '10–30 s',
      '30 s–1 min',
      '1–2 min',
      '2–5 min',
      '5–10 min',
      '10–30 min',
    ]);
    // 45 s (failed) is in 30 s–1 min, 90 s in 1–2 min; 10 min and the run going for 16.7 min
    // are both in 10–30 min.
    expect(buckets.map((b) => b.count)).toEqual([1, 0, 0, 0, 0, 1, 1, 0, 0, 2]);
    expect(buckets.map((b) => b.matching)).toEqual([0, 0, 0, 0, 0, 0, 1, 0, 0, 2]);
    expect(histogram([], none)).toEqual([]);
    expect(bucketLabel({ fromMs: 86_400_000, count: 1, matching: 1 })).toBe('1 d or more');
  });
});

describe('exports', () => {
  it('writes CSV that spreadsheets read as data, never formulas', () => {
    const csv = runsCsv(
      toRows([run('=HYPERLINK("x")', 0, 2), run('a,b', 10, 1)], NOW),
      'env',
      'flow',
    );
    const lines = csv.trimEnd().split('\r\n');
    expect(lines[0]).toBe('run,status,started,ended,duration_seconds,still_running,url');
    expect(lines[1]).toMatch(/^"'=HYPERLINK\(""x""\)",Succeeded,/);
    expect(lines[2]).toContain('"a,b",Succeeded,');
    expect(lines[2]).toContain(
      ',1.0,no,https://make.powerautomate.com/environments/env/flows/flow/runs/a%2Cb',
    );
  });

  it('writes a Markdown table with the filter in words', () => {
    const filter = { ...none, minMs: 60_000, hidden: new Set(['failed']) };
    const text = runsMarkdown(
      sortRuns(filterRuns(rows, filter), 'duration'),
      {
        environment: 'env',
        flowName: 'flow',
        displayName: 'Sync | contacts',
        filter: describeFilter(filter, ['Succeeded', 'Failed', 'Running']),
      },
      2,
    );
    expect(text).toContain('# Runs of Sync \\| contacts');
    expect(text).toContain(
      '3 runs (at least 1.0 min, Succeeded, Running only), the first 2 listed.',
    );
    expect(text).toContain('(running) | Running | [running](');
    expect(text.split('\n').filter((l) => l.startsWith('| 2026'))).toHaveLength(2);
    expect(describeFilter(none, ['Succeeded'])).toBe('all runs');
  });
});

function client(pages: unknown[][], refuse = false) {
  const calls: string[] = [];
  return {
    calls,
    client: createApiClient({
      getToken: () => TOKEN,
      sleep: async () => undefined,
      fetch: async (input) => {
        const url = new URL(String(input));
        calls.push(`${url.pathname.split('/').slice(-2).join('/')}${url.search}`);
        if (refuse) return new Response('{"error":{"code":"Nope"}}', { status: 403 });
        const page = Number(url.searchParams.get('page') ?? '0');
        const next =
          page + 1 < pages.length ? `${ORIGIN}${url.pathname}?page=${page + 1}` : undefined;
        return new Response(
          JSON.stringify({ value: pages[page] ?? [], ...(next ? { nextLink: next } : {}) }),
          {
            headers: { 'content-type': 'application/json' },
          },
        );
      },
    }),
  };
}

const listed = (name: string, start: number) => ({
  name,
  properties: { status: 'Succeeded', startTime: at(start), endTime: at(start + 1) },
});

describe('listRuns', () => {
  const pages = [
    [listed('r5', 500), listed('r4', 400)],
    [listed('r3', 300), listed('r2', 200)],
    [listed('r1', 100)],
  ];

  it('reads pages back to a date, keeping only runs since then', async () => {
    const { client: c, calls } = client(pages);
    const seen: number[] = [];
    const result = await listRuns(c, api, 'env', 'flow', {
      since: T0 + 250_000,
      max: 100,
      onPage: (runs) => seen.push(runs.length),
    });
    expect(result).toMatchObject({ reached: 'since' });
    expect(names(result.runs)).toEqual(['r5', 'r4', 'r3']);
    expect(seen).toEqual([2, 3]);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain('$top=50');
  });

  it('stops at the most runs asked for, or at the end of the list', async () => {
    const capped = await listRuns(client(pages).client, api, 'env', 'flow', { since: 0, max: 3 });
    expect(capped).toMatchObject({ reached: 'max' });
    expect(names(capped.runs)).toEqual(['r5', 'r4', 'r3']);
    const all = await listRuns(client(pages).client, api, 'env', 'flow', { since: 0, max: 100 });
    expect(all).toMatchObject({ reached: 'since' });
    expect(all.runs).toHaveLength(5);
  });

  it('keeps what was read when stopped, and reports errors otherwise', async () => {
    const controller = new AbortController();
    const { client: c } = client(pages);
    const result = await listRuns(c, api, 'env', 'flow', {
      since: 0,
      max: 100,
      signal: controller.signal,
      onPage: () => controller.abort(),
    });
    expect(result).toMatchObject({ reached: 'cancelled' });
    expect(result.runs).toHaveLength(2);
    await expect(
      listRuns(client(pages, true).client, api, 'env', 'flow', { since: 0, max: 10 }),
    ).rejects.toThrow('Nope');
  });
});

describe('analysing given runs', () => {
  it('reads the slowest of the runs given, without listing the flow', async () => {
    const { client: c, calls } = client([]);
    const given = [
      run('a', 0, 5),
      run('b', 10, 50),
      run('c', 100, 20),
      run('d', 200, undefined, 'Running'),
    ];
    const result = await fetchRunSamples(c, api, 'env', 'flow', parseFlow(bad), {
      runs: 2,
      mode: 'slowest',
      repetitionPages: 1,
      maxLoopActions: 15,
      given,
    });
    expect(result).toMatchObject({ mode: 'slowest', listed: 4, picked: 2 });
    expect(calls.some((c) => c.startsWith('flow/runs'))).toBe(false);
    expect(
      calls
        .filter((c) => c.includes('/actions'))
        .map((c) => c.split('?')[0])
        .sort(),
    ).toEqual(['b/actions', 'c/actions']);
  });
});
