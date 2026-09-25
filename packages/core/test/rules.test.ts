import { describe, expect, it } from 'vitest';
import bad from '../../../fixtures/flows/sync-contacts-bad.json' with { type: 'json' };
import good from '../../../fixtures/flows/sync-contacts-good.json' with { type: 'json' };
import clientdata from '../../../fixtures/flows/poll-orders-clientdata.json' with { type: 'json' };
import { analyseFlow } from '../src/analyse.ts';
import { RULES } from '../src/rules/index.ts';
import {
  chain,
  childFlow,
  compose,
  dataverse,
  findings,
  flow,
  foreach,
  http,
  outlook,
  ruleIds,
  scope,
  sharepoint,
  until,
  variable,
  wait,
} from './builders.ts';

const LIST = "@outputs('List_rows')?['body/value']";

describe('rule catalogue', () => {
  it('has unique ids and complete texts', () => {
    const ids = RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const rule of RULES) {
      expect(rule.title, rule.id).not.toBe('');
      expect(rule.why.length, rule.id).toBeGreaterThan(40);
      expect(rule.fix.length, rule.id).toBeGreaterThan(40);
      expect(rule.docs.length, rule.id).toBeGreaterThan(0);
      for (const url of rule.docs) expect(url).toMatch(/^https:\/\/learn\.microsoft\.com\//);
    }
  });
});

describe('fixtures', () => {
  it('finds every problem in the "before" flow', () => {
    expect(ruleIds(bad)).toEqual(['REL02', 'RES02', 'RES04', 'SPD01', 'SPD02', 'SPD03']);
  });

  it('finds nothing in the fixed "after" flow', () => {
    expect(analyseFlow(good).findings).toEqual([]);
    expect(analyseFlow(good).score.overall).toBe(100);
  });

  it('finds every problem in the solution flow', () => {
    expect(ruleIds(clientdata)).toEqual([
      'REL02',
      'REL04',
      'RES03',
      'SPD04',
      'SPD07',
      'SPD08',
      'SPD10',
    ]);
  });

  it('sorts findings by severity, then confidence', () => {
    const severities = analyseFlow(bad).findings.map((f) => f.severity);
    const rank = { high: 0, medium: 1, low: 2 };
    expect(severities).toEqual([...severities].sort((a, b) => rank[a] - rank[b]));
  });
});

describe('SPD01 loop runs one item at a time', () => {
  it('flags a sequential loop with connector calls', () => {
    const [finding] = findings(
      flow({ Loop: foreach(LIST, { Update: dataverse('UpdateRecord') }) }),
      'SPD01',
    );
    expect(finding?.target.name).toBe('Loop');
    expect(finding?.blockedBy).toBeUndefined();
    expect(finding?.message).toContain('"Update"');
  });

  it('is blocked by variable writes', () => {
    const [finding] = findings(
      flow({
        Loop: foreach(LIST, {
          Update: dataverse('UpdateRecord'),
          Count: variable('IncrementVariable', 'n', 1, { Update: ['Succeeded'] }),
        }),
      }),
      'SPD01',
    );
    expect(finding?.blockedBy).toEqual(['SPD02']);
    expect(finding?.fix).toContain('SPD02');
  });

  it('ignores concurrent loops, loops without calls and inner loops', () => {
    expect(
      findings(
        flow({ L: foreach(LIST, { U: dataverse('UpdateRecord') }, { concurrency: 10 }) }),
        'SPD01',
      ),
    ).toEqual([]);
    expect(findings(flow({ L: foreach(LIST, { C: compose(1) }) }), 'SPD01')).toEqual([]);
    const nested = findings(
      flow({ Outer: foreach(LIST, { Inner: foreach('@x', { U: dataverse('UpdateRecord') }) }) }),
      'SPD01',
    );
    expect(nested.map((f) => f.target.name)).toEqual(['Outer']);
  });

  it('notes an explicit concurrency of 1 with lower confidence', () => {
    const [finding] = findings(
      flow({ L: foreach(LIST, { U: dataverse('UpdateRecord') }, { concurrency: 1 }) }),
      'SPD01',
    );
    expect(finding?.message).toContain('concurrency is set to 1');
    expect(finding?.confidence).toBe(0.6);
  });
});

describe('SPD02 variable written inside a loop', () => {
  it('reports each loop once, listing its writes', () => {
    const result = findings(
      flow({
        L: foreach(LIST, {
          Append: variable('AppendToArrayVariable', 'names', "@item()?['name']"),
          Count: variable('IncrementVariable', 'n', 1, { Append: ['Succeeded'] }),
        }),
      }),
      'SPD02',
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.target.name).toBe('L');
    expect(result[0]?.message).toContain('variables "names", "n"');
  });

  it('gives the matching fix when all writes are the same kind', () => {
    const [finding] = findings(
      flow({ L: foreach(LIST, { Count: variable('IncrementVariable', 'n', 1) }) }),
      'SPD02',
    );
    expect(finding?.fix).toContain('length(');
  });

  it('skips writes whose value comes from a call in the loop', () => {
    const result = findings(
      flow({
        L: foreach(LIST, {
          Create: dataverse('CreateRecord'),
          Append: variable('AppendToArrayVariable', 'ids', "@outputs('Create')?['body/id']", {
            Create: ['Succeeded'],
          }),
        }),
      }),
      'SPD02',
    );
    expect(result).toEqual([]);
  });

  it('leaves writes outside loops, inside Do until and in parallel loops (REL01) alone', () => {
    expect(findings(flow({ S: variable('SetVariable', 'x', 1) }), 'SPD02')).toEqual([]);
    expect(findings(flow({ U: until({ S: variable('SetVariable', 'x', 1) }) }), 'SPD02')).toEqual(
      [],
    );
    const parallel = flow({
      L: foreach(LIST, { S: variable('SetVariable', 'x', 1) }, { concurrency: 5 }),
    });
    expect(findings(parallel, 'SPD02')).toEqual([]);
    expect(findings(parallel, 'REL01')).toHaveLength(1);
  });
});

describe('SPD03 per-item reads', () => {
  it('flags single-record reads in a loop', () => {
    const [finding] = findings(
      flow({ L: foreach(LIST, { Get: dataverse('GetItem', { recordId: "@items('L')?['id']" }) }) }),
      'SPD03',
    );
    expect(finding?.severity).toBe('high');
    expect(finding?.confidence).toBe(0.9);
    expect(finding?.fix).toContain('List rows');
  });

  it('flags list queries filtered by the current item (N+1)', () => {
    const [finding] = findings(
      flow({
        L: foreach(LIST, {
          Q: sharepoint('GetItems', { $filter: "Title eq '@{items('L')?['name']}'" }),
        }),
      }),
      'SPD03',
    );
    expect(finding?.message).toContain('N+1');
  });

  it('flags HTTP GET per item with low confidence', () => {
    const [finding] = findings(
      flow({
        L: foreach(LIST, { Call: http('GET', "https://api.example.com/x/@{item()?['id']}") }),
      }),
      'SPD03',
    );
    expect(finding?.severity).toBe('medium');
    expect(finding?.confidence).toBe(0.5);
  });

  it('flags queries that change per item through variables or actions in the loop', () => {
    const viaVariable = findings(
      flow({
        L: foreach(LIST, {
          Set: variable('SetVariable', 'code', "@items('L')?['code']"),
          Q: dataverse(
            'ListRecords',
            { $filter: "code eq '@{variables('code')}'" },
            { Set: ['Succeeded'] },
          ),
        }),
      }),
      'SPD03',
    );
    expect(viaVariable[0]?.message).toContain('N+1');
    const viaAction = findings(
      flow({
        L: foreach(LIST, {
          Add: dataverse('CreateRecord'),
          Q: dataverse(
            'ListRecords',
            { $filter: "name eq '@{outputs('Add')?['body/name']}'" },
            { Add: ['Succeeded'] },
          ),
        }),
      }),
      'SPD03',
    );
    expect(viaAction[0]?.message).toContain('N+1');
  });

  it('flags the same query repeated on every item', () => {
    const [finding] = findings(
      flow({ L: foreach(LIST, { Q: dataverse('ListRecords', { $top: 5 }) }) }),
      'SPD03',
    );
    expect(finding?.message).toContain('runs the same query');
    expect(finding?.fix).toContain('once, before the loop');
  });

  it('ignores writes, reads outside loops and non-GET HTTP calls', () => {
    expect(findings(flow({ L: foreach(LIST, { U: dataverse('UpdateRecord') }) }), 'SPD03')).toEqual(
      [],
    );
    expect(findings(flow({ G: dataverse('GetItem') }), 'SPD03')).toEqual([]);
    expect(findings(flow({ L: foreach(LIST, { P: http('POST', '@{item()}') }) }), 'SPD03')).toEqual(
      [],
    );
  });
});

describe('SPD04 / SPD07 / SPD08 / SPD10', () => {
  it('SPD04 ignores empty inner loops', () => {
    expect(findings(flow({ O: foreach(LIST, { I: foreach('@x', {}) }) }), 'SPD04')).toEqual([]);
  });

  it('SPD04 flags nested loops, medium only when the inner loop makes calls', () => {
    const quiet = findings(
      flow({ O: foreach(LIST, { I: foreach('@x', { C: compose(1) }) }) }),
      'SPD04',
    );
    expect(quiet[0]?.severity).toBe('low');
    const busy = findings(
      flow({ O: foreach(LIST, { I: foreach('@x', { U: dataverse('UpdateRecord') }) }) }),
      'SPD04',
    );
    expect(busy[0]?.severity).toBe('medium');
  });

  it('SPD07 flags child flows in loops only', () => {
    expect(findings(flow({ L: foreach(LIST, { Child: childFlow({}) }) }), 'SPD07')).toHaveLength(1);
    expect(findings(flow({ Child: childFlow({}) }), 'SPD07')).toEqual([]);
  });

  it('SPD08 flags Do until with a Delay', () => {
    expect(
      findings(flow({ U: until({ D: wait() }, { count: 5, timeout: 'PT5M' }) }), 'SPD08'),
    ).toHaveLength(1);
    expect(
      findings(flow({ U: until({ C: compose(1) }, { count: 5, timeout: 'PT5M' }) }), 'SPD08'),
    ).toEqual([]);
  });

  it('SPD10 flags loops over a one-row query, and SPD01 then stays quiet', () => {
    const input = flow({
      List_rows: dataverse('ListRecords', { $select: 'a', $top: 1 }),
      L: foreach(
        LIST,
        { U: dataverse('UpdateRecord') },
        { runAfter: { List_rows: ['Succeeded'] } },
      ),
    });
    expect(findings(input, 'SPD10')).toHaveLength(1);
    expect(findings(input, 'SPD01')).toEqual([]);
  });
});

describe('RES02 Dataverse trigger without filtering columns', () => {
  const trigger = (parameters: Record<string, unknown>) => ({
    When_a_row_changes: {
      type: 'OpenApiConnectionWebhook',
      inputs: {
        host: {
          apiId: '/providers/Microsoft.PowerApps/apis/shared_commondataserviceforapps',
          operationId: 'SubscribeWebhookTrigger',
        },
        parameters: { 'subscriptionRequest/entityname': 'contact', ...parameters },
      },
    },
  });

  it.each([3, 4, 6, 7, '3'])('flags message %s without columns', (message) => {
    const [finding] = findings(
      flow({}, trigger({ 'subscriptionRequest/message': message })),
      'RES02',
    );
    expect(finding?.target).toEqual({
      kind: 'trigger',
      name: 'When_a_row_changes',
      path: ['When_a_row_changes'],
    });
    expect(finding?.message).toContain('"contact", for every row');
  });

  it.each([1, 2, 5])('ignores message %s (no update)', (message) => {
    expect(
      findings(flow({}, trigger({ 'subscriptionRequest/message': message })), 'RES02'),
    ).toEqual([]);
  });

  it('ignores triggers with filtering columns', () => {
    const input = flow(
      {},
      trigger({
        'subscriptionRequest/message': 3,
        'subscriptionRequest/filteringattributes': 'name',
      }),
    );
    expect(findings(input, 'RES02')).toEqual([]);
  });
});

describe('RES03 frequent schedule', () => {
  const recurrence = (frequency: string, interval: number) => ({
    Recurrence: { type: 'Recurrence', recurrence: { frequency, interval } },
  });
  it.each([
    ['Second', 30, 'high'],
    ['Minute', 1, 'high'],
    ['Minute', 5, 'medium'],
  ])('%s every %i → %s', (frequency, interval, severity) => {
    const [finding] = findings(flow({}, recurrence(frequency, interval)), 'RES03');
    expect(finding?.severity).toBe(severity);
  });
  it.each([
    ['Minute', 15],
    ['Hour', 1],
    ['Day', 1],
  ])('ignores %s every %i', (frequency, interval) => {
    expect(findings(flow({}, recurrence(frequency, interval)), 'RES03')).toEqual([]);
  });
});

describe('RES04 list query reads too much', () => {
  it('flags missing columns and rows separately', () => {
    const both = findings(
      flow({ Q: dataverse('ListRecords', { entityName: 'accounts' }) }),
      'RES04',
    );
    expect(both[0]?.message).toContain('every column of every row');
    const columns = findings(flow({ Q: dataverse('ListRecords', { $filter: 'a eq 1' }) }), 'RES04');
    expect(columns[0]?.message).toContain('every column');
    const rows = findings(flow({ Q: dataverse('ListRecords', { $select: 'a' }) }), 'RES04');
    expect(rows[0]?.message).toContain('every row');
  });

  it('accepts FetchXML and SharePoint queries without a column list', () => {
    expect(
      findings(flow({ Q: dataverse('ListRecords', { fetchXml: '<fetch/>' }) }), 'RES04'),
    ).toEqual([]);
    expect(findings(flow({ Q: sharepoint('GetItems', { $top: 100 }) }), 'RES04')).toEqual([]);
    expect(findings(flow({ Q: sharepoint('GetItems', { $top: '' }) }), 'RES04')).toHaveLength(1);
  });
});

describe('REL01 parallel loop writes variables', () => {
  it('flags Set variable as a race, once per loop', () => {
    const [finding, ...rest] = findings(
      flow({
        L: foreach(
          LIST,
          {
            A: variable('SetVariable', 'code', 1),
            B: variable('SetVariable', 'name', 1, { A: ['Succeeded'] }),
          },
          { concurrency: 20 },
        ),
      }),
      'REL01',
    );
    expect(rest).toEqual([]);
    expect(finding?.severity).toBe('high');
    expect(finding?.message).toContain('"code", "name"');
    expect(finding?.message).toContain('up to 20');
  });

  it('treats appends and increments as safe but unordered', () => {
    const [finding] = findings(
      flow({
        L: foreach(
          LIST,
          {
            A: variable('AppendToArrayVariable', 'names', 1),
            B: variable('IncrementVariable', 'count', 1, { A: ['Succeeded'] }),
          },
          { concurrency: 20 },
        ),
      }),
      'REL01',
    );
    expect(finding?.severity).toBe('low');
    expect(finding?.message).toContain('order of the values is random');
  });
});

describe('REL02 no error handling', () => {
  it('flags flows of 5+ actions without a failure path', () => {
    expect(findings(flow(chain(5)), 'REL02')).toHaveLength(1);
    expect(findings(flow(chain(4)), 'REL02')).toEqual([]);
  });

  it('accepts any action that runs after Failed or TimedOut', () => {
    const input = flow({
      Try: scope(chain(5)),
      Catch: scope({ Notify: outlook() }, { Try: ['TimedOut'] }),
    });
    expect(findings(input, 'REL02')).toEqual([]);
  });
});

describe('REL04 Do until limits', () => {
  it('flags missing and default limits, not custom ones', () => {
    expect(findings(flow({ U: until({}) }), 'REL04')[0]?.message).toContain('no Count or Timeout');
    expect(
      findings(flow({ U: until({}, { count: 60, timeout: 'PT1H' }) }), 'REL04')[0]?.message,
    ).toContain('default limits');
    expect(findings(flow({ U: until({}, { count: 10, timeout: 'PT10M' }) }), 'REL04')).toEqual([]);
  });
});

describe('REL05 platform limits', () => {
  it('flags 400+ actions', () => {
    expect(findings(flow(chain(400)), 'REL05')[0]?.message).toContain('400 actions');
    expect(findings(flow(chain(399)), 'REL05')).toEqual([]);
  });

  it('flags nesting 7 levels deep', () => {
    let actions: Record<string, unknown> = { Deepest: compose(1) };
    for (let level = 6; level >= 1; level--) actions = { [`Scope_${level}`]: scope(actions) };
    const [finding] = findings(flow(actions), 'REL05');
    expect(finding?.target.name).toBe('Deepest');
    expect(finding?.message).toContain('7 levels');
  });
});

describe('robustness', () => {
  it('turns a crashing rule into a warning', () => {
    const exploding = {
      ...RULES[0]!,
      id: 'BOOM',
      check: () => {
        throw new Error('bad');
      },
    };
    const result = analyseFlow(flow({ A: compose(1) }), { rules: [exploding] });
    expect(result.findings).toEqual([]);
    expect(result.warnings).toEqual(['Rule BOOM failed: bad']);
  });
});
