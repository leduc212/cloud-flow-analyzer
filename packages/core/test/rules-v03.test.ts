import { describe, expect, it } from 'vitest';
import { analyseFlow } from '../src/analyse.ts';
import type { RunSample } from '../src/runs.ts';
import { chain, compose, dataverse, findings, flow, foreach, scope } from './builders.ts';

const LIST = "@outputs('List_rows')?['body/value']";
const at = (seconds: number) => new Date(Date.UTC(2026, 0, 1) + seconds * 1000).toISOString();

describe('SPD09 same data read more than once', () => {
  const read = (runAfter: Record<string, string[]> = {}) =>
    dataverse('GetItem', { entityName: 'accounts', recordId: "@triggerBody()?['id']" }, runAfter);

  it('flags a repeated read with the same inputs', () => {
    const [finding, ...rest] = findings(
      flow({
        First: read(),
        Other: compose(1, { First: ['Succeeded'] }),
        Again: read({ Other: ['Succeeded'] }),
      }),
      'SPD09',
    );
    expect(rest).toEqual([]);
    expect(finding?.target.name).toBe('Again');
    expect(finding?.message).toBe('"Again" reads the same data as "First", with the same inputs.');
  });

  it('ignores different inputs, opposite branches, loops and tables the flow writes to', () => {
    const other = dataverse('GetItem', {
      entityName: 'accounts',
      recordId: "@triggerBody()?['x']",
    });
    expect(findings(flow({ A: read(), B: other }), 'SPD09')).toEqual([]);
    const branches = {
      type: 'If',
      runAfter: {},
      expression: { equals: ['@true', true] },
      actions: { A: read() },
      else: { actions: { B: read() } },
    };
    expect(findings(flow({ Check: branches }), 'SPD09')).toEqual([]);
    expect(findings(flow({ A: read(), L: foreach(LIST, { B: read() }) }), 'SPD09')).toEqual([]);
    const written = flow({
      A: read(),
      Update: dataverse('UpdateRecord', { entityName: 'accounts' }, { A: ['Succeeded'] }),
      B: read({ Update: ['Succeeded'] }),
    });
    expect(findings(written, 'SPD09')).toEqual([]);
  });
});

describe('RES04 with pagination (was RES05)', () => {
  it('raises an unfiltered query that pages through many rows', () => {
    const paged = (minimumItemCount: number, parameters: Record<string, unknown>) => ({
      ...dataverse('ListRecords', { entityName: 'accounts', $select: 'name', ...parameters }),
      runtimeConfiguration: { paginationPolicy: { minimumItemCount } },
    });
    const [big] = findings(flow({ Q: paged(50_000, {}) }), 'RES04');
    expect(big?.severity).toBe('high');
    expect(big?.message).toContain('each run can read up to 50,000 rows');
    expect(findings(flow({ Q: paged(50_000, { $filter: 'statecode eq 0' }) }), 'RES04')).toEqual(
      [],
    );
    expect(findings(flow({ Q: paged(5000, {}) }), 'RES04')[0]?.severity).toBe('medium');
  });
});

describe('RES07 update writes back unchanged values', () => {
  const trigger = {
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
    },
  };
  const keepOld = (column: string, source: string) =>
    `@if(empty(variables('new')), ${source}?['body/${column}'], variables('new'))`;

  it('flags three or more columns that fall back to the row current value', () => {
    const update = dataverse('UpdateRecord', {
      entityName: 'accounts',
      recordId: "@triggerOutputs()?['body/accountid']",
      'item/name': keepOld('name', 'triggerOutputs()'),
      'item/city': keepOld('city', "outputs('Get_account')"),
      'item/country': keepOld('country', 'triggerOutputs()'),
      'item/phone': "@variables('phone')",
    });
    const get = dataverse('GetItem', { entityName: 'accounts', recordId: 'x' });
    const [finding] = findings(flow({ Get_account: get, Update: update }, trigger), 'RES07');
    expect(finding?.message).toContain("row's current value in 3 columns (name, city, country)");
  });

  it('ignores fewer columns and values read from other tables', () => {
    const other = dataverse('GetItem', { entityName: 'contacts', recordId: 'x' });
    const update = dataverse('UpdateRecord', {
      entityName: 'accounts',
      'item/name': keepOld('name', "outputs('Get_contact')"),
      'item/city': keepOld('city', "outputs('Get_contact')"),
      'item/country': keepOld('country', "outputs('Get_contact')"),
      'item/phone': keepOld('phone', 'triggerOutputs()'),
    });
    expect(findings(flow({ Get_contact: other, Update: update }, trigger), 'RES07')).toEqual([]);
  });
});

/** Runs whose first step starts `delay` seconds after the run. */
function delayed(delays: number[]): RunSample[] {
  return delays.map((delay, i) => ({
    name: `r${i}`,
    status: 'Succeeded',
    startTime: at(0),
    endTime: at(delay + 5),
    actions: [
      { name: 'Compose_1', status: 'Succeeded', startTime: at(delay), endTime: at(delay + 1) },
    ],
    repetitions: {},
  }));
}

describe('REL06 runs wait before they start', () => {
  const limited = {
    manual: {
      type: 'Request',
      kind: 'Button',
      inputs: { schema: {} },
      runtimeConfiguration: { concurrency: { runs: 1 } },
    },
  };

  it('blames the trigger concurrency limit when there is one', () => {
    const result = analyseFlow(flow(chain(1), limited), { runs: delayed([90, 120, 150]) });
    const [finding] = result.findings.filter((f) => f.ruleId === 'REL06');
    expect(finding?.severity).toBe('medium');
    expect(finding?.message).toBe(
      'In 3 recent runs, runs waited a median of 2.0 min (slowest 5%: 2.5 min) before their first step: the trigger lets only 1 run go at a time, so the others queue.',
    );
    expect(result.runStats?.startDelayP50Ms).toBe(120_000);
  });

  it('suspects throttling without a limit, and stays quiet for quick starts', () => {
    const [slow] = analyseFlow(flow(chain(1)), { runs: delayed([60, 60, 60]) }).findings.filter(
      (f) => f.ruleId === 'REL06',
    );
    expect(slow?.severity).toBe('low');
    expect(slow?.message).toContain('request limits');
    const quick = analyseFlow(flow(chain(1), limited), { runs: delayed([0.1, 0.2, 5]) });
    expect(quick.findings.filter((f) => f.ruleId === 'REL06')).toEqual([]);
  });
});

describe('SPD05 with runs', () => {
  const loopFlow = flow({
    L: foreach(LIST, {
      Check: {
        type: 'If',
        runAfter: {},
        expression: { equals: ["@item()?['status']", 'Open'] },
        actions: { Update: dataverse('UpdateRecord') },
        else: { actions: {} },
      },
    }),
  });
  /** One run: 10 items checked, `worked` of them updated. */
  const sample = (worked: number): RunSample[] => [
    {
      name: 'r1',
      status: 'Succeeded',
      startTime: at(0),
      endTime: at(10),
      actions: [{ name: 'L', status: 'Succeeded', startTime: at(0), endTime: at(9) }],
      repetitions: {
        Check: Array.from({ length: 10 }, (_, i) => ({
          indexes: [{ scope: 'L', index: i }],
          status: 'Succeeded',
          startTime: at(i),
          endTime: at(i + 0.1),
        })),
        Update: Array.from({ length: 10 }, (_, i) => ({
          indexes: [{ scope: 'L', index: i }],
          status: i < worked ? 'Succeeded' : 'Skipped',
          startTime: at(i),
          endTime: at(i + 0.5),
        })),
      },
    },
  ];
  const spd05 = (worked: number) =>
    analyseFlow(loopFlow, { runs: sample(worked) }).findings.find((f) => f.ruleId === 'SPD05');

  it('measures how many items the condition turned away', () => {
    expect(spd05(1)?.severity).toBe('high');
    expect(spd05(1)?.message).toContain('90% of the 10 items checked in recent runs did nothing.');
    expect(spd05(5)?.severity).toBe('medium');
    expect(spd05(10)?.severity).toBe('low');
    expect(spd05(10)?.message).toContain(
      '100% passed, so filtering first would save little today.',
    );
  });
});

describe('MNT02 default step names', () => {
  it('reports three or more default names once, without touching the grade', () => {
    const input = flow({
      Compose: compose(1),
      Compose_2: compose(2, { Compose: ['Succeeded'] }),
      Scope_3: scope({}, { Compose_2: ['Succeeded'] }),
      Order_total: compose(3, { Scope_3: ['Succeeded'] }),
    });
    const [finding, ...rest] = findings(input, 'MNT02');
    expect(rest).toEqual([]);
    expect(finding?.category).toBe('maintainability');
    expect(finding?.target.name).toBe('Compose');
    expect(finding?.message).toBe(
      '3 of the 4 steps keep the name the designer gave them: "Compose", "Compose 2", "Scope 3".',
    );
    expect(analyseFlow(input).score.overall).toBe(100);
  });

  it('ignores flows with fewer default names, and names that only start like one', () => {
    expect(findings(flow({ Compose: compose(1), Scope: scope({}) }), 'MNT02')).toEqual([]);
    const renamed = flow({
      Compose_total: compose(1),
      Condition_is_approved: compose(2),
      Scope_Try: scope({}),
    });
    expect(findings(renamed, 'MNT02')).toEqual([]);
  });
});
