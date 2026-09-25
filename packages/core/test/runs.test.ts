import { describe, expect, it } from 'vitest';
import { analyseFlow } from '../src/analyse.ts';
import { parseFlow } from '../src/parser.ts';
import {
  percentile,
  readRepetition,
  readRun,
  readRunAction,
  repetitionTargets,
  runSamplesFromResponses,
  summariseRuns,
  type RepetitionRecord,
  type RunActionRecord,
  type RunSample,
} from '../src/runs.ts';
import { compose, dataverse, flow, foreach } from './builders.ts';

const LIST = "@outputs('List_rows')?['body/value']";

/** ISO time `seconds` after a fixed start. */
const at = (seconds: number) => new Date(Date.UTC(2026, 0, 1) + seconds * 1000).toISOString();

const action = (
  name: string,
  start: number,
  end: number,
  status = 'Succeeded',
  code?: string,
): RunActionRecord => ({
  name,
  status,
  startTime: at(start),
  endTime: at(end),
  ...(code ? { code } : {}),
});

const repetition = (
  indexes: [string, number][],
  start: number,
  end: number,
  status = 'Succeeded',
  code?: string,
): RepetitionRecord => ({
  indexes: indexes.map(([scope, index]) => ({ scope, index })),
  status,
  startTime: at(start),
  endTime: at(end),
  ...(code ? { code } : {}),
});

function run(
  name: string,
  seconds: number,
  actions: RunActionRecord[],
  repetitions: RunSample['repetitions'] = {},
  status = 'Succeeded',
): RunSample {
  return { name, status, startTime: at(0), endTime: at(seconds), actions, repetitions };
}

/** A loop with one update per item. */
const loopFlow = flow({
  List_rows: dataverse('ListRecords', { $select: 'name', $filter: 'x' }),
  Loop: foreach(
    LIST,
    { Update: dataverse('UpdateRecord') },
    { runAfter: { List_rows: ['Succeeded'] } },
  ),
});

/** A run of `loopFlow` whose loop takes `loopSeconds` of 10 and handles `items` items. */
function loopRun(name: string, items: number, loopSeconds = 8): RunSample {
  return run(name, 10, [action('List_rows', 0, 1), action('Loop', 1, 1 + loopSeconds)], {
    Update: Array.from({ length: items }, (_, i) =>
      repetition([['Loop', i]], 1 + i * 0.1, 1.1 + i * 0.1),
    ),
  });
}

describe('reading API records', () => {
  it('reads runs, actions and repetitions', () => {
    expect(
      readRun({
        name: 'r1',
        properties: { status: 'Succeeded', startTime: at(0), endTime: at(5) },
      }),
    ).toEqual({ name: 'r1', status: 'Succeeded', startTime: at(0), endTime: at(5) });
    expect(
      readRunAction({
        name: 'A',
        properties: { status: 'Failed', error: { code: 'TooManyRequests' } },
      }),
    ).toEqual({ name: 'A', status: 'Failed', code: 'TooManyRequests' });
    expect(
      readRepetition({
        properties: {
          repetitionIndexes: [
            { scopeName: 'Outer', itemIndex: 2 },
            { scopeName: 'Inner', itemIndex: 0 },
          ],
          status: 'Skipped',
        },
      }),
    ).toEqual({
      indexes: [
        { scope: 'Outer', index: 2 },
        { scope: 'Inner', index: 0 },
      ],
      status: 'Skipped',
    });
  });

  it('rebuilds run samples from recorded responses, spotting cut-off repetitions', () => {
    const base =
      'https://api.flow.microsoft.com/providers/Microsoft.ProcessSimple/environments/e/flows/f1';
    const samples = runSamplesFromResponses([
      {
        url: `${base}/runs?api-version=2016-11-01&$top=2`,
        body: { value: [{ name: 'r1', properties: { status: 'Succeeded' } }] },
      },
      {
        url: `${base}/runs/r1/actions?api-version=2016-11-01`,
        body: { value: [{ name: 'A', properties: { status: 'Succeeded' } }] },
      },
      {
        url: `${base}/runs/r1/actions/Inner/repetitions?api-version=2016-11-01`,
        body: { value: [{ properties: { status: 'Succeeded' } }], nextLink: 'next' },
      },
      {
        url: `${base}/runs/r1/actions/Inner/repetitions?api-version=2016-11-01&$skiptoken=x`,
        body: { value: [{ properties: { status: 'Succeeded' } }] },
      },
      {
        url: `${base}/runs/r1/actions/Cut/repetitions?api-version=2016-11-01`,
        body: { value: [{ properties: { status: 'Succeeded' } }], nextLink: 'next' },
      },
    ]);
    const [sample] = samples.get('f1') ?? [];
    expect(sample?.status).toBe('Succeeded');
    expect(sample?.actions.map((a) => a.name)).toEqual(['A']);
    expect(sample?.repetitions.Inner).toHaveLength(2);
    expect(sample?.truncated).toEqual(['Cut']);
  });
});

describe('summariseRuns', () => {
  it('takes percentiles by nearest rank', () => {
    expect(percentile([], 50)).toBe(0);
    expect(percentile([5, 1, 3], 50)).toBe(3);
    expect(percentile([1, 2, 3, 4], 95)).toBe(4);
  });

  it('measures time share outside loops and busy time from repetitions inside them', () => {
    const tree = parseFlow(loopFlow);
    const stats = summariseRuns(tree, [loopRun('r1', 4), loopRun('r2', 6), loopRun('r3', 5)]);
    expect(stats.sampled).toBe(3);
    expect(stats.durationP50Ms).toBe(10_000);
    expect(stats.actions.get('Loop')?.timeSharePct).toBe(80);
    expect(stats.actions.get('List_rows')?.timeSharePct).toBe(10);
    const update = stats.actions.get('Update');
    expect(update?.timeSharePct).toBeUndefined();
    expect(update?.executions).toBe(15);
    expect(update?.p50Ms).toBe(100);
    expect(update?.busyP50Ms).toBe(500);
    expect(stats.loops.get('Loop')).toEqual({
      name: 'Loop',
      iterationsP50: 5,
      iterationsP95: 6,
      iterationsMax: 6,
      truncated: false,
    });
  });

  it('ignores unfinished runs and counts skips, failures and throttling', () => {
    const tree = parseFlow(loopFlow);
    const stats = summariseRuns(tree, [
      run('r1', 10, [
        action('List_rows', 0, 1, 'Failed', 'TooManyRequests'),
        action('Loop', 1, 1, 'Skipped'),
      ]),
      { ...loopRun('r2', 3), status: 'Running' },
    ]);
    expect(stats.sampled).toBe(1);
    expect(stats.statuses).toEqual({ Succeeded: 1 });
    expect(stats.actions.get('List_rows')).toMatchObject({ failed: 1, throttled: 1, runs: 1 });
    expect(stats.actions.get('Loop')).toMatchObject({ runs: 0, skipped: 1 });
  });

  it('counts nested loop items per outer item and flags cut-off lists', () => {
    const tree = parseFlow(
      flow({ Outer: foreach(LIST, { Inner: foreach('@x', { C: compose(1) }) }) }),
    );
    const repetitions = [
      repetition(
        [
          ['Outer', 0],
          ['Inner', 0],
        ],
        0,
        1,
      ),
      repetition(
        [
          ['Outer', 0],
          ['Inner', 1],
        ],
        0,
        1,
      ),
      repetition(
        [
          ['Outer', 1],
          ['Inner', 0],
        ],
        0,
        1,
      ),
      repetition(
        [
          ['Outer', 1],
          ['Inner', 1],
        ],
        0,
        1,
      ),
      repetition(
        [
          ['Outer', 1],
          ['Inner', 2],
        ],
        0,
        1,
      ),
      repetition(
        [
          ['Outer', 1],
          ['Inner', 3],
        ],
        0,
        1,
      ),
    ];
    const sample = { ...run('r1', 10, [], { C: repetitions }), truncated: ['C'] };
    const stats = summariseRuns(tree, [sample]);
    expect(stats.loops.get('Outer')).toMatchObject({ iterationsP50: 2, truncated: true });
    expect(stats.loops.get('Inner')).toMatchObject({
      iterationsP50: 2,
      iterationsMax: 4,
      truncated: true,
    });
  });

  it('picks the repetitions worth fetching: first action of each loop, then calls in loops', () => {
    const tree = parseFlow(
      flow({
        Get: dataverse('GetItem'),
        Loop: foreach(LIST, {
          First: compose(1),
          Update: dataverse('UpdateRecord', {}, { First: ['Succeeded'] }),
        }),
      }),
    );
    expect(repetitionTargets(tree)).toEqual(['First', 'Update']);
    expect(repetitionTargets(tree, 1)).toEqual(['First']);
  });
});

describe('analysing with runs', () => {
  it('adds measured evidence to 📊 findings and uses measured loop sizes', () => {
    const samples = [loopRun('r1', 4), loopRun('r2', 6), loopRun('r3', 5)];
    const { findings, estimate, runStats } = analyseFlow(loopFlow, { runs: samples });
    const spd01 = findings.find((f) => f.ruleId === 'SPD01');
    expect(spd01?.evidence).toEqual({ timeSharePct: 80, iterationsP50: 5 });
    expect(spd01?.message).toContain(
      'In 3 recent runs (medians): "Loop" took 80% of the run time (8.0 s) over 5 items.',
    );
    expect(spd01?.severity).toBe('high');
    expect(estimate).toEqual({ total: 1 + 1 + 1 + 5, assumed: false });
    expect(runStats?.sampled).toBe(3);
    // Rules that don't use run data are unchanged.
    expect(findings.find((f) => f.ruleId === 'REL10')?.evidence).toBeUndefined();
  });

  it('lowers per-item findings to low when the loop never had more than one item', () => {
    const { findings } = analyseFlow(loopFlow, { runs: [loopRun('r1', 1), loopRun('r2', 1)] });
    const spd01 = findings.find((f) => f.ruleId === 'SPD01');
    expect(spd01?.severity).toBe('low');
    expect(spd01?.message).toContain('over 1 item.');
  });

  it('is the same as before without finished runs', () => {
    const without = analyseFlow(loopFlow);
    const running = analyseFlow(loopFlow, { runs: [{ ...loopRun('r1', 3), status: 'Running' }] });
    expect(running.findings).toEqual(without.findings);
    expect(running.estimate).toEqual(without.estimate);
  });
});

describe('RES01 most runs stop at the first check', () => {
  const trigger = (conditions: string[] = []) => ({
    When_a_row_is_modified: {
      type: 'OpenApiConnectionWebhook',
      inputs: {
        host: {
          apiId: '/providers/Microsoft.PowerApps/apis/shared_commondataserviceforapps',
          operationId: 'SubscribeWebhookTrigger',
        },
        parameters: {
          'subscriptionRequest/message': 3,
          'subscriptionRequest/entityname': 'account',
          'subscriptionRequest/filteringattributes': 'statuscode',
        },
      },
      ...(conditions.length
        ? { conditions: conditions.map((expression) => ({ expression })) }
        : {}),
    },
  });
  const check = (expression: unknown) => ({
    type: 'If',
    runAfter: {},
    expression,
    actions: { Update: dataverse('UpdateRecord') },
    else: { actions: {} },
  });
  const ON_TRIGGER = { equals: ["@triggerOutputs()?['body/statuscode']", 1] };
  /** `work` of `count` runs updated something; the rest stopped at the check. */
  const samples = (count: number, work: number) =>
    Array.from({ length: count }, (_, i) =>
      run(`r${i}`, 1, [
        action('Check', 0, 1),
        action('Update', 0, 1, i < work ? 'Succeeded' : 'Skipped'),
      ]),
    );

  it('flags a trigger-data check that stops most runs', () => {
    const [finding] = analyseFlow(flow({ Check: check(ON_TRIGGER) }, trigger()), {
      runs: samples(10, 1),
    }).findings.filter((f) => f.ruleId === 'RES01');
    expect(finding?.target.name).toBe('Check');
    expect(finding?.message).toContain('9 of 10 recent runs stopped at "Check"');
    expect(finding?.confidence).toBe(0.9);
  });

  it('needs 5+ runs, a majority of empty runs, no trigger condition and trigger data only', () => {
    const rule = (input: unknown, runs: RunSample[]) =>
      analyseFlow(input, { runs }).findings.filter((f) => f.ruleId === 'RES01');
    const input = flow({ Check: check(ON_TRIGGER) }, trigger());
    expect(rule(input, samples(4, 0))).toEqual([]);
    expect(rule(input, samples(10, 6))).toEqual([]);
    expect(rule(flow({ Check: check(ON_TRIGGER) }, trigger(['@true'])), samples(10, 0))).toEqual(
      [],
    );
    const onAction = check({ equals: ["@outputs('Get')?['body/x']", 1] });
    expect(rule(flow({ Check: onAction }, trigger()), samples(10, 0))).toEqual([]);
    expect(analyseFlow(input).findings.filter((f) => f.ruleId === 'RES01')).toEqual([]);
  });
});
