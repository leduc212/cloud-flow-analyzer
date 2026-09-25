import { describe, expect, it } from 'vitest';
import bad from '../../../fixtures/flows/sync-contacts-bad.json' with { type: 'json' };
import good from '../../../fixtures/flows/sync-contacts-good.json' with { type: 'json' };
import { analyseFlow } from '@cfa/core';
import { createApiClient } from '../src/api/client.ts';
import { flowApi, type FlowSummary } from '../src/api/flows.ts';
import { analyseAll, type AnalysisCache } from '../src/flows/analyse-all.ts';
import {
  filterRows,
  markdownSummary,
  mergeFlowLists,
  sortRows,
  summariseAnalysis,
  triggerLabel,
  type FlowRow,
  type RowAnalysis,
} from '../src/flows/model.ts';
import { flowPageUrl, parseEnvironment } from '../src/shared/flow-url.ts';
import type { TokenRecord } from '../src/shared/token.ts';

const ORIGIN = 'https://api.flow.microsoft.com';
const TOKEN: TokenRecord = { kind: 'flow', token: 't', capturedAt: 0, origins: [ORIGIN] };
const api = flowApi(ORIGIN);

const summary = (
  name: string,
  trigger: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): FlowSummary =>
  ({
    name,
    properties: {
      displayName: `Flow ${name}`,
      state: 'Started',
      lastModifiedTime: '2026-09-01T00:00:00Z',
      definitionSummary: { triggers: [trigger] },
      ...extra,
    },
  }) as FlowSummary;

describe('flow rows', () => {
  it('describes triggers from the list summary', () => {
    const label = (trigger: Record<string, unknown>) => triggerLabel(summary('x', trigger));
    expect(label({ type: 'Recurrence' })).toBe('Schedule');
    expect(label({ type: 'Request', kind: 'Button' })).toBe('Manual (button)');
    expect(label({ type: 'Request', kind: 'PowerAppV2' })).toBe('Power Apps');
    expect(label({ type: 'Request', kind: 'Http' })).toBe('HTTP request');
    expect(
      label({
        type: 'OpenApiConnectionWebhook',
        swaggerOperationId: 'SubscribeWebhookTrigger',
        api: { name: 'shared_commondataserviceforapps' },
      }),
    ).toBe('Dataverse: row changes');
    expect(
      label({
        type: 'OpenApiConnection',
        swaggerOperationId: 'OnNewEmailV3',
        api: { name: 'shared_office365' },
      }),
    ).toBe('Office 365 Outlook: OnNewEmailV3');
    expect(triggerLabel({ name: 'x' })).toBe('Unknown');
  });

  it('merges the lists a flow appears in', () => {
    const rows = mergeFlowLists({
      default: [summary('a', { type: 'Recurrence' }), summary('b', { type: 'Recurrence' })],
      admin: [
        summary('a', { type: 'Recurrence' }),
        summary(
          'c',
          { type: 'Recurrence' },
          { state: 'Suspended', flowSuspensionReason: 'CapacityThrottled' },
        ),
      ],
    });
    expect(rows.map((r) => [r.name, r.sources])).toEqual([
      ['a', ['default', 'admin']],
      ['b', ['default']],
      ['c', ['admin']],
    ]);
    expect(rows[2]).toMatchObject({ state: 'Suspended', suspension: 'CapacityThrottled' });
    expect(rows[0]?.suspension).toBeUndefined();
  });

  it('summarises an analysis for the table', () => {
    const a = summariseAnalysis(analyseFlow(bad));
    expect(a.grade).toBe(analyseFlow(bad).score.grade);
    expect(a.counts.high).toBeGreaterThan(0);
    expect(a.top).toHaveLength(3);
    expect(a.top[0]?.severity).toBe('high');
    expect(summariseAnalysis(analyseFlow(good))).toMatchObject({ grade: 'A', top: [] });
  });
});

const analysed = (grade: string, score: number, high = 0): RowAnalysis => ({
  grade,
  score,
  capped: false,
  counts: { high, medium: 1, low: 0 },
  top: [
    { ruleId: 'SPD01', title: 'Loop runs one item at a time', target: 'Loop', severity: 'high' },
  ],
  actionCount: 5,
});
const row = (name: string, analysis?: RowAnalysis, lastModified = '2026-09-01'): FlowRow => ({
  name,
  displayName: name,
  state: 'Started',
  trigger: 'Schedule',
  sources: ['default'],
  lastModified,
  ...(analysis ? { analysis } : {}),
});

describe('sorting, filtering and export', () => {
  const rows = [
    row('Bravo', analysed('A', 95)),
    row('Alpha', analysed('F', 30, 3)),
    row('Charlie'),
    row('Delta', analysed('C', 70, 1), '2026-09-20'),
  ];

  it('sorts worst grade first, unanalysed flows last', () => {
    expect(sortRows(rows, 'grade').map((r) => r.name)).toEqual([
      'Alpha',
      'Delta',
      'Bravo',
      'Charlie',
    ]);
    expect(sortRows(rows, 'grade', true).map((r) => r.name)).toEqual([
      'Bravo',
      'Delta',
      'Alpha',
      'Charlie',
    ]);
    expect(sortRows(rows, 'issues').map((r) => r.name)).toEqual([
      'Alpha',
      'Delta',
      'Bravo',
      'Charlie',
    ]);
    expect(sortRows(rows, 'name').map((r) => r.name)).toEqual([
      'Alpha',
      'Bravo',
      'Charlie',
      'Delta',
    ]);
    expect(sortRows(rows, 'modified', true)[0]?.name).toBe('Delta');
  });

  it('filters by text and by state of the analysis', () => {
    expect(filterRows(rows, 'alp', 'all').map((r) => r.name)).toEqual(['Alpha']);
    expect(filterRows(rows, 'schedule', 'all')).toHaveLength(4);
    expect(filterRows(rows, '', 'needs-work').map((r) => r.name)).toEqual(['Alpha', 'Delta']);
    expect(filterRows(rows, '', 'high').map((r) => r.name)).toEqual(['Alpha', 'Delta']);
    expect(filterRows(rows, '', 'not-analysed').map((r) => r.name)).toEqual(['Charlie']);
  });

  it('escapes backslashes and pipes in Markdown cells', () => {
    const md = markdownSummary([row('A | B \\', analysed('C', 70))], 'Env');
    expect(md).toContain('| A \\| B \\\\ | C (70) |');
  });

  it('exports the analysed flows as Markdown, worst first', () => {
    const md = markdownSummary(rows, 'Contoso Dev', new Date('2026-09-25T00:00:00Z'));
    expect(md).toContain('# Flow analysis: Contoso Dev');
    expect(md).toContain('3 of 4 flows analysed on 2026-09-25.');
    const lines = md
      .split('\n')
      .filter((l) => l.startsWith('| ') && !l.startsWith('| Flow') && !l.startsWith('| ---'));
    expect(lines[0]).toBe(
      '| Alpha | F (30) | 3 | 1 | 0 | SPD01 Loop runs one item at a time: Loop |',
    );
    expect(lines).toHaveLength(3);
  });
});

describe('analyseAll', () => {
  function setup(handler: (path: string) => { status: number; body: unknown }) {
    const calls: string[] = [];
    const client = createApiClient({
      getToken: () => TOKEN,
      fetch: async (input) => {
        const path = decodeURIComponent(new URL(String(input)).pathname);
        calls.push(path);
        const { status, body } = handler(path);
        return new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        });
      },
      sleep: async () => undefined,
    });
    return { client, calls };
  }

  it('analyses each flow, reading admin-only flows through the admin endpoint', async () => {
    const { client, calls } = setup((path) => {
      if (path.endsWith('/flows/ok')) return { status: 200, body: bad };
      if (path.includes('/scopes/admin/') && path.endsWith('/flows/admin-only')) {
        return { status: 200, body: good };
      }
      return { status: 403, body: { error: { code: 'Forbidden', message: 'no' } } };
    });
    const rows = [row('ok'), { ...row('admin-only'), sources: ['admin' as const] }, row('locked')];
    const seen: string[] = [];
    const result = await analyseAll(client, api, 'env', rows, { onRow: (r) => seen.push(r.name) });
    expect(result).toEqual({ analysed: 2, cancelled: false });
    expect(rows[0]?.analysis?.grade).toBe(analyseFlow(bad).score.grade);
    expect(rows[1]?.analysis?.grade).toBe('A');
    expect(rows[2]?.analysis).toBeUndefined();
    expect(rows[2]?.error).toContain("don't have access");
    expect(seen.sort()).toEqual(['admin-only', 'locked', 'ok']);
    // Only the admin-listed flow tries the admin endpoint.
    expect(calls.filter((c) => c.includes('/scopes/admin/'))).toHaveLength(1);
  });

  it('uses cached analyses keyed by last-modified time', async () => {
    const stored = new Map<string, RowAnalysis>();
    const cache: AnalysisCache = {
      get: async (key) => stored.get(key),
      set: async (key, value) => void stored.set(key, value),
    };
    const first = setup(() => ({ status: 200, body: bad }));
    await analyseAll(first.client, api, 'env', [row('a')], { cache });
    const second = setup(() => ({ status: 200, body: bad }));
    const rows = [row('a'), row('a', undefined, '2026-09-30')];
    await analyseAll(second.client, api, 'env', rows, { cache });
    expect(rows[0]?.analysis).toBeDefined();
    // Only the edited flow is fetched again.
    expect(second.calls).toHaveLength(1);
  });

  it('stops when asked, and throws when the sign-in is gone', async () => {
    const controller = new AbortController();
    controller.abort();
    const { client, calls } = setup(() => ({ status: 200, body: bad }));
    const rows = [row('a'), row('b')];
    const result = await analyseAll(client, api, 'env', rows, { signal: controller.signal });
    expect(result).toEqual({ analysed: 0, cancelled: true });
    expect(calls).toEqual([]);
    const expired = setup(() => ({ status: 401, body: {} }));
    await expect(analyseAll(expired.client, api, 'env', [row('a')])).rejects.toThrow('expired');
  });
});

describe('portal URLs', () => {
  it('reads the environment of any portal page and builds flow page URLs', () => {
    expect(parseEnvironment('https://make.powerautomate.com/environments/Default-1/flows')).toBe(
      'Default-1',
    );
    expect(parseEnvironment('https://make.powerapps.com/environments/abc/solutions')).toBe('abc');
    expect(parseEnvironment('https://example.com/environments/abc')).toBeUndefined();
    expect(parseEnvironment(undefined)).toBeUndefined();
    expect(flowPageUrl('Default-1', 'f1')).toBe(
      'https://make.powerautomate.com/environments/Default-1/flows/f1/details',
    );
  });
});
