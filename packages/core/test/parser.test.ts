import { describe, expect, it } from 'vitest';
import bad from '../../../fixtures/flows/sync-contacts-bad.json' with { type: 'json' };
import clientdata from '../../../fixtures/flows/poll-orders-clientdata.json' with { type: 'json' };
import { FlowParseError, readFlow } from '../src/definition.ts';
import {
  ancestors,
  descendants,
  enclosingLoops,
  orderByRunAfter,
  parseFlow,
} from '../src/parser.ts';
import { resolveConnector } from '../src/connectors.ts';
import { hasUnreadableReferences, scanReferences } from '../src/expressions.ts';
import { compose, condition, dataverse, flow, foreach, scope, until } from './builders.ts';

describe('readFlow', () => {
  it('reads a flow resource from the API', () => {
    const input = readFlow(bad);
    expect(input.displayName).toBe('Sync account contacts (before)');
    expect(Object.keys(input.definition)).toContain('actions');
    expect(Object.keys(input.connectionReferences)).toContain('shared_office365');
  });

  it('reads Dataverse clientdata as a string, an object and a workflow row', () => {
    const text = JSON.stringify(clientdata);
    expect(Object.keys(readFlow(text).definition.actions as object)).toContain('Do_until_done');
    expect(Object.keys(readFlow(clientdata).definition.actions as object)).toContain(
      'Do_until_done',
    );
    const row = readFlow({ name: 'Poll orders', clientdata: text });
    expect(row.displayName).toBe('Poll orders');
  });

  it('reads a bare definition and a { definition } wrapper', () => {
    const bare = flow({ A: compose(1) });
    expect(readFlow(bare).definition).toBe(bare);
    expect(readFlow({ definition: bare, displayName: 'X' }).displayName).toBe('X');
  });

  it('rejects things that are not flows', () => {
    expect(() => readFlow('not json')).toThrow(FlowParseError);
    expect(() => readFlow({ hello: 1 })).toThrow(FlowParseError);
    expect(() => readFlow(42)).toThrow(FlowParseError);
  });
});

describe('parseFlow', () => {
  it('orders actions by runAfter, not JSON order', () => {
    const tree = parseFlow(
      flow({
        C: compose(3, { B: ['Succeeded'] }),
        A: compose(1),
        B: compose(2, { A: ['Succeeded'] }),
      }),
    );
    expect(tree.actions.map((a) => a.name)).toEqual(['A', 'B', 'C']);
  });

  it('keeps JSON order when runAfter has a cycle', () => {
    const ordered = orderByRunAfter([
      ['X', { runAfter: { Y: [] } }],
      ['Y', { runAfter: { X: [] } }],
    ]);
    expect(ordered.map(([name]) => name)).toEqual(['X', 'Y']);
  });

  it('walks every container type with paths, branches and depth', () => {
    const tree = parseFlow(
      flow({
        Try: scope({
          Loop: foreach("@body('x')", {
            Check: condition({ Yes: compose(1) }, { No: compose(2) }),
          }),
          Switch: {
            type: 'Switch',
            expression: '@x',
            cases: { Case_A: { case: 'a', actions: { InA: compose(1) } } },
            default: { actions: { InDefault: compose(2) } },
            runAfter: { Loop: ['Succeeded'] },
          },
          Poll: until({ InUntil: compose(3) }, { count: 5, timeout: 'PT5M' }),
        }),
      }),
    );
    expect(tree.actionCount).toBe(10);
    expect(tree.maxDepth).toBe(4);
    const yes = tree.byName.get('Yes')!;
    expect(yes.path).toEqual(['Try', 'Loop', 'Check', 'Yes']);
    expect(yes.branch).toBe('actions');
    expect(tree.byName.get('No')!.branch).toBe('else');
    expect(tree.byName.get('InA')!.branch).toBe('case:Case_A');
    expect(tree.byName.get('InDefault')!.branch).toBe('default');
    expect(tree.byName.get('Poll')!.settings.limit).toEqual({ count: 5, timeout: 'PT5M' });
    expect(ancestors(tree, yes).map((a) => a.name)).toEqual(['Check', 'Loop', 'Try']);
    expect(enclosingLoops(tree, yes).map((a) => a.name)).toEqual(['Loop']);
    expect(descendants(tree.byName.get('Loop')!).map((a) => a.name)).toEqual([
      'Check',
      'Yes',
      'No',
    ]);
  });

  it('reads connector, operation, parameters and settings', () => {
    const tree = parseFlow(bad);
    const list = tree.byName.get('List_accounts')!;
    expect(list.kind).toBe('connector');
    expect(list.connector).toBe('shared_commondataserviceforapps');
    expect(list.operationId).toBe('ListRecords');
    expect(list.parameters.entityName).toBe('accounts');
    const append = tree.byName.get('Append_email')!;
    expect(append.kind).toBe('variable-write');
    expect(append.variable).toBe('emails');
    expect(append.references).toEqual(['Get_primary_contact']);
    expect(tree.byName.get('Initialize_emails')!.declares).toEqual(['emails']);
    const get = tree.byName.get('Get_primary_contact')!;
    expect(get.loopItemRefs).toEqual(['Apply_to_each']);
    expect(tree.triggers[0]!.kind).toBe('dataverse');
  });

  it('resolves connectors through solution connection references', () => {
    const tree = parseFlow(clientdata);
    expect(tree.byName.get('List_open_order')!.connector).toBe('shared_commondataserviceforapps');
    expect(tree.triggers[0]!.recurrence).toEqual({ frequency: 'Minute', interval: 1 });
  });

  it('reads loop concurrency and sequential options', () => {
    const tree = parseFlow(
      flow({
        Parallel: foreach('@x', {}, { concurrency: 20 }),
        Sequential: { ...foreach('@x', {}), operationOptions: 'Sequential' },
      }),
    );
    expect(tree.byName.get('Parallel')!.settings.concurrency).toBe(20);
    expect(tree.byName.get('Sequential')!.settings.sequential).toBe(true);
  });

  it('never throws on odd shapes, it warns', () => {
    const tree = parseFlow(flow({ Broken: 'nope', Untyped: { runAfter: {} } }));
    expect(tree.actionCount).toBe(2);
    expect(tree.warnings.length).toBe(2);
  });

  it('handles older ApiConnection actions', () => {
    const tree = parseFlow(
      flow({
        Get_items: {
          type: 'ApiConnection',
          runAfter: {},
          inputs: {
            host: {
              connection: {
                name: "@parameters('$connections')['shared_sharepointonline']['connectionId']",
              },
            },
            method: 'get',
            path: '/datasets/x/tables/y/items',
            queries: { $top: 10 },
          },
        },
      }),
    );
    const node = tree.byName.get('Get_items')!;
    expect(node.connector).toBe('shared_sharepointonline');
    expect(node.method).toBe('get');
    expect(node.parameters.$top).toBe(10);
  });
});

describe('resolveConnector', () => {
  const refs = {
    shared_commondataserviceforapps_1: { api: { name: 'shared_commondataserviceforapps' } },
    shared_x: { id: '/providers/Microsoft.PowerApps/apis/shared_sharepointonline' },
  };
  it.each([
    [{ apiId: '/providers/Microsoft.PowerApps/apis/shared_sql' }, 'shared_sql'],
    [{ connectionName: 'shared_commondataserviceforapps_1' }, 'shared_commondataserviceforapps'],
    [{ connection: 'shared_x' }, 'shared_sharepointonline'],
    [
      { connection: { referenceName: 'shared_commondataserviceforapps_1' } },
      'shared_commondataserviceforapps',
    ],
    [
      { connection: { name: "@parameters('$connections')['shared_office365_2']['connectionId']" } },
      'shared_office365',
    ],
    [{ connectionName: 'unknown_thing' }, 'shared_unknown_thing'],
  ])('resolves %j', (host, expected) => {
    expect(resolveConnector(host, refs)).toBe(expected);
  });
});

describe('scanReferences', () => {
  it('finds action, loop item and variable references', () => {
    const refs = scanReferences({
      a: "@body('Get_a_row')?['name']",
      b: ["@{outputs('List_rows')?['body/value']}", "@items('Apply_to_each')?['id']"],
      c: "@concat(variables('prefix'), item()?['x'], actions('It''s_here'))",
    });
    expect(refs.actions.sort()).toEqual(['Get_a_row', "It's_here", 'List_rows']);
    expect(refs.loopItems).toEqual(['Apply_to_each']);
    expect(refs.variables).toEqual(['prefix']);
    expect(refs.usesItem).toBe(true);
  });

  it('spots references it cannot read', () => {
    expect(hasUnreadableReferences("@{items('Loop'<v>'x']}")).toBe(true);
    expect(hasUnreadableReferences("@{items('Loop')?['x']} @{variables('v')}")).toBe(false);
    expect(hasUnreadableReferences('plain text')).toBe(false);
  });

  it('ignores plain text', () => {
    expect(scanReferences('body(x) and items').actions).toEqual([]);
  });
});

describe('dataverse builder', () => {
  it('produces a connector action the parser understands', () => {
    const tree = parseFlow(flow({ Get: dataverse('GetItem', { entityName: 'contacts' }) }));
    expect(tree.byName.get('Get')!.operationId).toBe('GetItem');
  });
});
