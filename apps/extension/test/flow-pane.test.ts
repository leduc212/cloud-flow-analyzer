import { describe, expect, it } from 'vitest';
import bad from '../../../fixtures/flows/sync-contacts-bad.json' with { type: 'json' };
import { analyseFlow } from '@cfa/core';
import { createApiClient } from '../src/api/client.ts';
import { fetchFlow } from '../src/api/flow-lookup.ts';
import { environmentHost } from '../src/api/flows.ts';
import { parseFlowUrl } from '../src/shared/flow-url.ts';
import { buildPaneResult } from '../src/shared/pane-result.ts';
import type { TokenRecord } from '../src/shared/token.ts';

const FLOW = 'aaaaaaaa-1111-2222-3333-444444444444';
const ENV = 'Default-11111111-2222-3333-4444-555555555555';

describe('parseFlowUrl', () => {
  it.each([
    `https://make.powerautomate.com/environments/${ENV}/flows/${FLOW}/details`,
    `https://make.powerautomate.com/environments/${ENV}/flows/${FLOW}/edit?v3=true`,
    `https://make.powerautomate.com/environments/${ENV}/flows/shared/${FLOW}/details`,
    `https://make.powerautomate.com/environments/${ENV}/solutions/bbbbbbbb-1111-2222-3333-444444444444/flows/${FLOW}`,
    `https://make.powerapps.com/environments/${ENV}/solutions/bbbbbbbb-1111-2222-3333-444444444444/objects/cloudflows/${FLOW}/view`,
    `https://make.preview.powerautomate.com/environments/${ENV}/flows/${FLOW.toUpperCase()}/runs`,
  ])('reads %s', (url) => {
    expect(parseFlowUrl(url)).toEqual({ environment: ENV, flowId: FLOW });
  });

  it.each([
    `https://make.powerautomate.com/environments/${ENV}/flows`,
    `https://make.powerautomate.com/environments/${ENV}/flows/new`,
    `https://evil.example.com/environments/${ENV}/flows/${FLOW}`,
    'not a url',
    undefined,
  ])('ignores %s', (url) => {
    expect(parseFlowUrl(url)).toBeUndefined();
  });
});

describe('environmentHost', () => {
  it('drops hyphens and puts a dot before the last two characters', () => {
    expect(environmentHost('Default-11111111-2222-3333-4444-555555555555')).toBe(
      'default111111112222333344445555555555.55.environment.api.powerplatform.com',
    );
  });
});

describe('fetchFlow', () => {
  const token = (kind: 'flow' | 'powerplatform', origin: string): TokenRecord => ({
    kind,
    token: 't',
    capturedAt: 0,
    origins: [origin],
  });
  const flowToken = token('flow', 'https://api.flow.microsoft.com');

  function tenant(routes: Record<string, unknown>) {
    const calls: string[] = [];
    const client = createApiClient({
      getToken: () => flowToken,
      sleep: async () => {},
      fetch: async (input) => {
        const url = new URL(String(input));
        calls.push(`${url.host}${url.pathname}`);
        for (const [pattern, body] of Object.entries(routes)) {
          if (url.pathname.endsWith(pattern)) {
            return new Response(JSON.stringify(body), { status: 200 });
          }
        }
        return new Response('{}', { status: 404 });
      },
    });
    return { client, calls };
  }

  const ref = { environment: ENV, flowId: FLOW };

  it('gets the flow directly', async () => {
    const { client, calls } = tenant({ [`/flows/${FLOW}`]: bad });
    await expect(fetchFlow(client, { flow: flowToken }, ref)).resolves.toEqual(bad);
    expect(calls).toHaveLength(1);
  });

  it('finds solution flows by their Dataverse workflow ID', async () => {
    const { client, calls } = tenant({
      '/v2/flows': {
        value: [{ name: 'real-name', properties: { workflowEntityId: FLOW.toUpperCase() } }],
      },
      '/flows/real-name': bad,
    });
    await expect(fetchFlow(client, { flow: flowToken }, ref)).resolves.toEqual(bad);
    expect(calls.at(-1)).toContain('/flows/real-name');
  });

  it('falls back to the Power Platform API', async () => {
    const pp = token('powerplatform', 'https://x.api.powerplatform.com');
    const { client, calls } = tenant({ [`/powerautomate/flows/${FLOW}`]: bad });
    await expect(fetchFlow(client, { powerplatform: pp }, ref)).resolves.toEqual(bad);
    expect(calls[0]).toContain('.environment.api.powerplatform.com/powerautomate/flows/');
  });

  it('explains when the flow is missing', async () => {
    const { client } = tenant({ '/flows': { value: [] } });
    await expect(fetchFlow(client, { flow: flowToken }, ref)).rejects.toThrow("wasn't found");
  });
});

describe('buildPaneResult', () => {
  it('carries findings with rule texts and designer labels, as plain data', () => {
    const result = buildPaneResult(
      { environment: ENV, flowId: FLOW },
      analyseFlow(bad),
      new Date(0),
    );
    expect(result.displayName).toBe('Sync account contacts (before)');
    const spd03 = result.findings.find((f) => f.ruleId === 'SPD03');
    expect(spd03).toMatchObject({
      title: 'Data read one item at a time inside a loop',
      targetLabel: 'Get primary contact',
      target: { kind: 'action', name: 'Get_primary_contact' },
    });
    expect(spd03?.fix).toContain('List rows');
    expect(result.findings.find((f) => f.ruleId === 'REL02')?.targetLabel).toBe('Whole flow');
    expect(result.order.slice(0, 3)).toEqual([
      'When_a_row_is_added,_modified_or_deleted',
      'Initialize_emails',
      'Initialize_count',
    ]);
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });
});
