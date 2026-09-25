import { describe, expect, it } from 'vitest';
import bad from '../../../fixtures/flows/sync-contacts-bad.json' with { type: 'json' };
import { analyseFlow } from '../src/analyse.ts';
import { anonymise, createAnonymiser, findInterpolations } from '../src/anonymise.ts';

const GUID = 'A1B2C3D4-1111-2222-3333-444455556666';

describe('anonymise', () => {
  it('maps the same GUID to the same placeholder, with or without dashes', () => {
    const out = anonymise({
      a: GUID,
      b: `Default-${GUID.toLowerCase()}`,
      c: GUID.replace(/-/g, '').toLowerCase(),
      d: '99999999-1111-2222-3333-444455556666',
    }) as Record<string, string>;
    expect(out.a).toBe('00000000-0000-4000-8000-000000000001');
    expect(out.b).toBe('Default-00000000-0000-4000-8000-000000000001');
    expect(out.c).toBe('00000000000040008000000000000001');
    expect(out.d).toBe('00000000-0000-4000-8000-000000000002');
  });

  it('replaces emails and names consistently', () => {
    const out = anonymise({
      owner: { displayName: 'Jane Doe', email: 'Jane.Doe@contoso.com' },
      other: { displayName: 'Jane Doe', userPrincipalName: 'jane.doe@contoso.com' },
    }) as Record<string, Record<string, string>>;
    expect(out.owner).toEqual({ displayName: 'Name 1', email: 'user1@example.com' });
    expect(out.other).toEqual({ displayName: 'Name 1', userPrincipalName: 'user1@example.com' });
  });

  it('drops signed links and connector metadata', () => {
    const out = anonymise({
      properties: {
        inputsLink: { uri: 'https://prod.logic.azure.com/x?sig=secret' },
        outputsLink: {},
        metadata: { '%252fShared%2bDocuments%252fPayroll.xlsx': '/Shared Documents/Payroll.xlsx' },
        status: 'Succeeded',
      },
    });
    expect(out).toEqual({ properties: { status: 'Succeeded' } });
  });

  it('keeps API hosts but strips secrets from their query strings', () => {
    const anonymiser = createAnonymiser();
    const url = anonymiser.text(
      `https://emea.api.flow.microsoft.com/providers/Microsoft.ProcessSimple/environments/Default-${GUID}/flows?api-version=2016-11-01&sig=abc&$top=5`,
    );
    expect(url).toBe(
      'https://emea.api.flow.microsoft.com/providers/Microsoft.ProcessSimple/environments/Default-00000000-0000-4000-8000-000000000001/flows?api-version=2016-11-01&$top=5',
    );
    expect(
      anonymiser.text(
        'https://0123456789abcdef0123456789abcd.ef.environment.api.powerplatform.com/powerautomate/flows',
      ),
    ).toBe('https://envhost1.xx.environment.api.powerplatform.com/powerautomate/flows');
  });

  it('keeps expressions inside filters intact', () => {
    const out = anonymise({
      inputs: {
        parameters: {
          $filter:
            "status eq 'Open' and name eq '@{items('Apply_to_each_5')?['Customer Name']}' and code eq '@{outputs('Add_a_new_PO')?['body/code']}'",
        },
      },
    }) as { inputs: { parameters: { $filter: string } } };
    expect(out.inputs.parameters.$filter).toBe(
      "status eq '<v>' and name eq '@{items('Apply_to_each_5')?['Customer Name']}' and code eq '@{outputs('Add_a_new_PO')?['body/code']}'",
    );
  });

  it('hides tenant hosts', () => {
    expect(
      createAnonymiser().text(
        'https://0123456789abcdef0123456789abcd.05.tenant.api.powerplatform.com/x',
      ),
    ).toBe('https://envhost1.xx.tenant.api.powerplatform.com/x');
  });

  it('replaces other hosts and paths', () => {
    const anonymiser = createAnonymiser();
    expect(
      anonymiser.text(
        'see https://contoso.sharepoint.com/sites/HR and https://contoso.sharepoint.com/sites/HR',
      ),
    ).toBe('see https://host1.example.com/path1 and https://host1.example.com/path1');
    expect(anonymiser.text('https://contoso.crm4.dynamics.com/')).toBe('https://host2.example.com');
  });

  it('replaces literal inputs but keeps structure and expressions', () => {
    const out = anonymise({
      actions: {
        Update: {
          type: 'OpenApiConnection',
          inputs: {
            host: {
              operationId: 'UpdateRecord',
              connectionName: 'shared_commondataserviceforapps',
            },
            parameters: {
              entityName: 'accounts',
              $select: 'name,revenue',
              $filter: "name eq 'Contoso' and statecode eq 0",
              'item/description': 'Top secret customer',
              'item/name': "@items('Apply_to_each')?['name']",
              'item/note': "Hello @{items('Apply_to_each')?['firstname']}, thanks",
              'item/code': "@concat('ACME-', variables('suffix'))",
            },
          },
        },
        Check: {
          type: 'If',
          expression: { and: [{ equals: ["@triggerBody()?['country']", 'Vietnam'] }] },
        },
      },
    }) as {
      actions: {
        Update: { inputs: { host: unknown; parameters: Record<string, string> } };
        Check: { expression: { and: { equals: string[] }[] } };
      };
    };
    const params = out.actions.Update.inputs.parameters;
    expect(out.actions.Update.inputs.host).toEqual({
      operationId: 'UpdateRecord',
      connectionName: 'shared_commondataserviceforapps',
    });
    expect(params.entityName).toBe('accounts');
    expect(params.$select).toBe('name,revenue');
    expect(params.$filter).toBe("name eq '<v>' and statecode eq 0");
    expect(params['item/description']).toBe('<value>');
    expect(params['item/name']).toBe("@items('Apply_to_each')?['name']");
    expect(params['item/note']).toBe("<text>@{items('Apply_to_each')?['firstname']}<text>");
    expect(params['item/code']).toBe("@concat('<v>', variables('suffix'))");
    expect(out.actions.Check.expression.and[0]?.equals).toEqual([
      "@triggerBody()?['country']",
      '<value>',
    ]);
  });

  it('keeps an anonymised flow analysable with the same findings', () => {
    const before = analyseFlow(bad).findings.map((f) => `${f.ruleId}:${f.target.name ?? ''}`);
    const after = analyseFlow(anonymise(bad)).findings.map(
      (f) => `${f.ruleId}:${f.target.name ?? ''}`,
    );
    expect(after).toEqual(before);
    expect(JSON.stringify(anonymise(bad))).not.toContain('contoso');
  });
});

describe('findInterpolations', () => {
  const inners = (value: string) => findInterpolations(value).map((i) => i.inner);

  it('finds expressions, skipping quoted strings and their escaped quotes', () => {
    const text = "Hello @{triggerBody()?['name']}, total @{outputs('Compose')}";
    expect(findInterpolations(text)).toEqual([
      { start: 6, end: 31, inner: "triggerBody()?['name']" },
      { start: 39, end: 60, inner: "outputs('Compose')" },
    ]);
    expect(inners("@{concat('a}b', 'it''s')} and @{variables('x')}")).toEqual([
      "concat('a}b', 'it''s')",
      "variables('x')",
    ]);
    expect(inners("@{''''}@{'}'}")).toEqual(["''''", "'}'"]);
    expect(inners("name eq '@{items('Loop')?['name']}'")).toEqual(["items('Loop')?['name']"]);
  });

  it('rejects what is not a complete expression', () => {
    expect(inners('@{@{nested}')).toEqual(['nested']);
    expect(inners("@{unclosed 'string}")).toEqual([]);
    expect(inners('@{has { brace}')).toEqual([]);
    expect(inners('no expressions at all')).toEqual([]);
  });

  it('stays fast on input that makes a backtracking pattern explode', () => {
    const attack = `@{{${"'".repeat(50_000)}`;
    const started = performance.now();
    expect(findInterpolations(attack)).toEqual([]);
    expect(findInterpolations(`@{${"''".repeat(50_000)}`)).toEqual([]);
    expect(performance.now() - started).toBeLessThan(500);
  });
});
