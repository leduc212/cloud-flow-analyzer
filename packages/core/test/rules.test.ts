import { describe, expect, it } from 'vitest';
import bad from '../../../fixtures/flows/sync-contacts-bad.json' with { type: 'json' };
import good from '../../../fixtures/flows/sync-contacts-good.json' with { type: 'json' };
import clientdata from '../../../fixtures/flows/poll-orders-clientdata.json' with { type: 'json' };
import { analyseFlow } from '../src/analyse.ts';
import { RULES, docLabel } from '../src/rules/index.ts';
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
    expect(ruleIds(bad)).toEqual([
      'REL02',
      'REL07',
      'REL10',
      'RES02',
      'RES04',
      'RES08',
      'SPD01',
      'SPD02',
      'SPD03',
    ]);
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

  it('flags nesting 7 levels below the top level, not 6', () => {
    const nested = (levels: number) => {
      let actions: Record<string, unknown> = { Deepest: compose(1) };
      for (let level = levels; level >= 1; level--)
        actions = { [`Scope_${level}`]: scope(actions) };
      return flow(actions);
    };
    const [finding] = findings(nested(7), 'REL05');
    expect(finding?.target.name).toBe('Deepest');
    expect(finding?.message).toContain('nested 7 levels deep');
    expect(findings(nested(6), 'REL05')).toEqual([]);
  });
});

describe('REL03 retries turned off', () => {
  it('flags retry policy none only', () => {
    const call = (type: string) => ({
      ...http('POST', 'https://example.com'),
      inputs: { method: 'POST', uri: 'https://example.com', retryPolicy: { type } },
    });
    expect(findings(flow({ H: call('none') }), 'REL03')[0]?.target.name).toBe('H');
    expect(findings(flow({ H: call('None') }), 'REL03')).toHaveLength(1);
    expect(findings(flow({ H: call('exponential') }), 'REL03')).toEqual([]);
    expect(findings(flow({ H: http('GET', 'https://example.com') }), 'REL03')).toEqual([]);
  });
});

describe('REL07 flow triggers itself', () => {
  const dataverseTrigger = (parameters: Record<string, unknown>, conditions: string[] = []) => ({
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
          ...parameters,
        },
      },
      ...(conditions.length
        ? { conditions: conditions.map((expression) => ({ expression })) }
        : {}),
    },
  });
  const update = (entityName: string, column = 'description') =>
    dataverse('UpdateRecord', {
      entityName,
      recordId: "@triggerOutputs()?['body/accountid']",
      [`item/${column}`]: 'x',
    });

  it('flags an update of the triggering table (entity set name) with no guard', () => {
    const [finding] = findings(flow({ U: update('accounts') }, dataverseTrigger({})), 'REL07');
    expect(finding?.target.name).toBe('U');
    expect(finding?.confidence).toBe(0.8);
    expect(findings(flow({ U: update('contacts') }, dataverseTrigger({})), 'REL07')).toEqual([]);
  });

  it('accepts trigger conditions and filtering columns the update does not change', () => {
    const guarded = dataverseTrigger({}, ["@not(equals(triggerOutputs()?['body/x'], 1))"]);
    expect(findings(flow({ U: update('accounts') }, guarded), 'REL07')).toEqual([]);
    const columns = dataverseTrigger({ 'subscriptionRequest/filteringattributes': 'name' });
    expect(findings(flow({ U: update('accounts') }, columns), 'REL07')).toEqual([]);
    expect(findings(flow({ U: update('accounts', 'name') }, columns), 'REL07')).toHaveLength(1);
  });

  it('flags a SharePoint item update on the triggering list', () => {
    const trigger = {
      When_an_item_is_modified: {
        type: 'OpenApiConnectionWebhook',
        inputs: {
          host: {
            apiId: '/providers/Microsoft.PowerApps/apis/shared_sharepointonline',
            operationId: 'GetOnUpdatedItems',
          },
          parameters: { dataset: 'https://contoso.sharepoint.com/sites/a', table: 'list-1' },
        },
      },
    };
    const patch = (table: string) =>
      sharepoint('PatchItem', { dataset: 'https://contoso.sharepoint.com/sites/a', table, id: 1 });
    expect(findings(flow({ P: patch('list-1') }, trigger), 'REL07')).toHaveLength(1);
    expect(findings(flow({ P: patch('list-2') }, trigger), 'REL07')).toEqual([]);
  });
});

describe('REL08 failed runs show as Succeeded', () => {
  const terminate = (runStatus: string, runAfter: Record<string, string[]> = {}) => ({
    runAfter,
    type: 'Terminate',
    inputs: { runStatus },
  });

  it('flags a catch path that never terminates as Failed', () => {
    const [finding, ...rest] = findings(
      flow({
        Try: scope(chain(3)),
        Catch: scope({ Notify: outlook() }, { Try: ['Failed'] }),
        Log: compose('x', { Try: ['TimedOut'] }),
      }),
      'REL08',
    );
    expect(rest).toEqual([]);
    expect(finding?.target.name).toBe('Catch');
    expect(finding?.message).toContain('and 1 other error path');
  });

  it('accepts Terminate Failed or Cancelled inside or after the handler', () => {
    const inside = flow({
      Try: scope(chain(3)),
      Catch: scope(
        { Notify: outlook(), End: terminate('Failed', { Notify: ['Succeeded'] }) },
        { Try: ['Failed'] },
      ),
    });
    expect(findings(inside, 'REL08')).toEqual([]);
    const after = flow({
      Try: scope(chain(3)),
      Catch: scope({ Notify: outlook() }, { Try: ['Failed'] }),
      End: terminate('Cancelled', { Catch: ['Succeeded'] }),
    });
    expect(findings(after, 'REL08')).toEqual([]);
    const succeeded = flow({
      Try: scope(chain(3)),
      Catch: scope({ End: terminate('Succeeded') }, { Try: ['Failed'] }),
    });
    expect(findings(succeeded, 'REL08')).toHaveLength(1);
  });

  it('ignores Finally steps, per-item handlers and flows that answer with a Response', () => {
    expect(
      findings(
        flow({ Try: scope(chain(3)), Finally: compose(1, { Try: ['Succeeded', 'Failed'] }) }),
        'REL08',
      ),
    ).toEqual([]);
    expect(
      findings(
        flow({ L: foreach(LIST, { A: compose(1), Log: compose(2, { A: ['Failed'] }) }) }),
        'REL08',
      ),
    ).toEqual([]);
    const child = flow({
      Try: scope(chain(3)),
      Catch: scope(
        { Respond: { runAfter: {}, type: 'Response', inputs: { statusCode: 500 } } },
        { Try: ['Failed'] },
      ),
    });
    expect(findings(child, 'REL08')).toEqual([]);
  });
});

describe('REL09 first item read without checking the list', () => {
  const list = dataverse('ListRecords', { entityName: 'accounts' });

  it('groups [0] reads per source list', () => {
    const [finding, ...rest] = findings(
      flow({
        List_rows: list,
        A: compose("@outputs('List_rows')?['body/value'][0]?['name']", {
          List_rows: ['Succeeded'],
        }),
        B: compose("@{body('List_rows')?['value']?[0]?['id']}", { A: ['Succeeded'] }),
      }),
      'REL09',
    );
    expect(rest).toEqual([]);
    expect(finding?.target.name).toBe('A');
    expect(finding?.message).toContain('2 steps');
    expect(finding?.confidence).toBe(0.6);
  });

  it('uses lower confidence when every read uses ?[0]', () => {
    const [finding] = findings(
      flow({ List_rows: list, A: compose("@outputs('List_rows')?['body/value']?[0]") }),
      'REL09',
    );
    expect(finding?.confidence).toBe(0.5);
  });

  it('accepts reads guarded by empty(), length() or an enclosing condition', () => {
    const inline = flow({
      List_rows: list,
      A: compose(
        "@if(empty(outputs('List_rows')?['body/value']), null, outputs('List_rows')?['body/value'][0])",
      ),
    });
    expect(findings(inline, 'REL09')).toEqual([]);
    const guarded = flow({
      List_rows: list,
      Check: {
        type: 'If',
        runAfter: {},
        expression: { greater: ["@length(outputs('List_rows')?['body/value'])", 0] },
        actions: { A: compose("@outputs('List_rows')?['body/value'][0]") },
        else: { actions: {} },
      },
    });
    expect(findings(guarded, 'REL09')).toEqual([]);
  });

  it('ignores [0] on values that are not lists of records', () => {
    expect(
      findings(flow({ A: compose("@split(triggerBody()?['from'], '<')[0]") }), 'REL09'),
    ).toEqual([]);
    expect(
      findings(flow({ C: compose('x'), A: compose("@outputs('C')?['parts'][0]") }), 'REL09'),
    ).toEqual([]);
  });
});

describe('REL10 list query silently stops at its default page', () => {
  it('flags SharePoint Get items without Top Count or pagination', () => {
    const [finding] = findings(flow({ Q: sharepoint('GetItems', {}) }), 'REL10');
    expect(finding?.message).toContain('at most 100 items');
    expect(findings(flow({ Q: sharepoint('GetItems', { $top: 500 }) }), 'REL10')).toEqual([]);
    const paged = {
      ...sharepoint('GetItems', {}),
      runtimeConfiguration: { paginationPolicy: { minimumItemCount: 5000 } },
    };
    expect(findings(flow({ Q: paged }), 'REL10')).toEqual([]);
  });

  it('flags Dataverse List rows only when a loop goes through it', () => {
    const query = dataverse('ListRecords', { entityName: 'accounts', $select: 'name' });
    expect(findings(flow({ List_rows: query }), 'REL10')).toEqual([]);
    const [finding] = findings(
      flow({ List_rows: query, L: foreach(LIST, { C: compose(1) }) }),
      'REL10',
    );
    expect(finding?.message).toContain('at most 5,000 rows');
    expect(finding?.confidence).toBe(0.4);
  });
});

describe('RES08 one write per loop item', () => {
  it('groups the writes of a loop', () => {
    const [finding, ...rest] = findings(
      flow({
        L: foreach(LIST, {
          Create: dataverse('CreateRecord'),
          Update: dataverse('UpdateRecord', {}, { Create: ['Succeeded'] }),
        }),
      }),
      'RES08',
    );
    expect(rest).toEqual([]);
    expect(finding?.target.name).toBe('L');
    expect(finding?.message).toContain('2 requests per item');
    expect(finding?.fix).toContain('UpdateMultiple');
  });

  it('lowers confidence for parallel loops and ignores reads and one-row loops', () => {
    const parallel = findings(
      flow({ L: foreach(LIST, { U: dataverse('UpdateRecord') }, { concurrency: 20 }) }),
      'RES08',
    );
    expect(parallel[0]?.confidence).toBe(0.5);
    expect(findings(flow({ L: foreach(LIST, { G: dataverse('GetItem') }) }), 'RES08')).toEqual([]);
    const oneRow = flow({
      List_rows: dataverse('ListRecords', { $top: 1 }),
      L: foreach(LIST, { U: dataverse('UpdateRecord') }),
    });
    expect(findings(oneRow, 'RES08')).toEqual([]);
  });
});

describe('SPD05 loop used to filter items', () => {
  const check = (actions: Record<string, unknown>, elseActions: Record<string, unknown> = {}) => ({
    type: 'If',
    runAfter: {},
    expression: { equals: ["@item()?['status']", 'Open'] },
    actions,
    else: { actions: elseActions },
  });

  it('flags a loop whose only step is a one-sided condition on the item', () => {
    const [finding] = findings(
      flow({ L: foreach(LIST, { If: check({ U: dataverse('UpdateRecord') }) }) }),
      'SPD05',
    );
    expect(finding?.target.name).toBe('L');
  });

  it('ignores conditions with an else branch, other steps, or no item reference', () => {
    expect(
      findings(
        flow({ L: foreach(LIST, { If: check({ A: compose(1) }, { B: compose(2) }) }) }),
        'SPD05',
      ),
    ).toEqual([]);
    expect(
      findings(
        flow({ L: foreach(LIST, { If: check({ A: compose(1) }), C: compose(1) }) }),
        'SPD05',
      ),
    ).toEqual([]);
    const other = { ...check({ A: compose(1) }), expression: { equals: ["@variables('x')", 1] } };
    expect(findings(flow({ L: foreach(LIST, { If: other }) }), 'SPD05')).toEqual([]);
  });
});

describe('SEC01 secret visible in run history', () => {
  const getSecret = (secure: boolean) => ({
    runAfter: {},
    type: 'OpenApiConnection',
    inputs: {
      host: {
        apiId: '/providers/Microsoft.PowerApps/apis/shared_keyvault',
        operationId: 'GetSecret',
      },
      parameters: { secretName: 'api-key' },
    },
    ...(secure ? { runtimeConfiguration: { secureData: { properties: ['outputs'] } } } : {}),
  });
  const useSecret = (secure: boolean) => ({
    runAfter: { Get_secret: ['Succeeded'] },
    type: 'Http',
    inputs: {
      method: 'GET',
      uri: 'https://example.com',
      headers: { 'x-api-key': "@body('Get_secret')?['value']" },
    },
    ...(secure ? { runtimeConfiguration: { secureData: { properties: ['inputs'] } } } : {}),
  });

  it('flags Get secret without secure outputs and users without secure inputs', () => {
    const result = findings(flow({ Get_secret: getSecret(false), H: useSecret(false) }), 'SEC01');
    expect(result.map((f) => f.target.name)).toEqual(['Get_secret', 'H']);
    expect(result[0]?.category).toBe('security');
  });

  it('accepts secured steps', () => {
    expect(findings(flow({ Get_secret: getSecret(true), H: useSecret(true) }), 'SEC01')).toEqual(
      [],
    );
  });

  it('caps the grade at C', () => {
    const { score } = analyseFlow(flow({ Get_secret: getSecret(false) }));
    expect(score.capped).toBe(true);
    expect(score.grade).toBe('C');
  });
});

describe('SEC02 hard-coded credential', () => {
  const call = (inputs: Record<string, unknown>) => ({
    runAfter: {},
    type: 'Http',
    inputs: { method: 'GET', uri: 'https://example.com', ...inputs },
  });

  it.each([
    [{ headers: { Authorization: 'Bearer abc123' } }, 'Authorization header'],
    [{ headers: { 'Ocp-Apim-Subscription-Key': 'abc' } }, 'Ocp-Apim-Subscription-Key header'],
    [{ authentication: { type: 'Basic', username: 'u', password: 'p' } }, 'password of its Basic'],
    [{ uri: 'https://f.azurewebsites.net/api/x?code=abc&y=1' }, 'code= parameter'],
  ])('flags %j', (inputs, where) => {
    const [finding] = findings(flow({ H: call(inputs) }), 'SEC02');
    expect(finding?.message).toContain(where);
  });

  it.each([
    { headers: { Authorization: "Bearer @{body('Get_token')?['access_token']}" } },
    { headers: { 'Content-Type': 'application/json' } },
    { authentication: { type: 'Basic', username: 'u', password: "@parameters('pwd')" } },
    { uri: "https://f.azurewebsites.net/api/x?code=@{parameters('key')}" },
    { uri: "@parameters('url')" },
  ])('accepts %j', (inputs) => {
    expect(findings(flow({ H: call(inputs) }), 'SEC02')).toEqual([]);
  });
});

describe('SEC03 HTTP trigger anyone can call', () => {
  const trigger = (inputs: Record<string, unknown>, kind = 'Http') => ({
    manual: { type: 'Request', kind, inputs: { schema: {}, ...inputs } },
  });

  it('flags Anyone and the legacy setting', () => {
    expect(
      findings(flow({}, trigger({ triggerAuthenticationType: 'All' })), 'SEC03')[0]?.confidence,
    ).toBe(0.8);
    expect(findings(flow({}, trigger({})), 'SEC03')[0]?.confidence).toBe(0.6);
  });

  it('accepts tenant-only triggers and other manual triggers', () => {
    expect(findings(flow({}, trigger({ triggerAuthenticationType: 'Tenant' })), 'SEC03')).toEqual(
      [],
    );
    expect(findings(flow({}, trigger({}, 'Button')), 'SEC03')).toEqual([]);
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

describe('docLabel', () => {
  it('turns docs addresses into readable titles', () => {
    expect(
      docLabel(
        'https://learn.microsoft.com/en-us/power-automate/guidance/coding-guidelines/implement-parallel-execution',
      ),
    ).toBe('Implement parallel execution');
    expect(
      docLabel(
        'https://learn.microsoft.com/en-us/power-platform/admin/power-automate-licensing/faqs#what-counts-as-an-action',
      ),
    ).toBe('What counts as an action');
    for (const rule of RULES) for (const url of rule.docs) expect(docLabel(url)).not.toBe('');
  });
});
