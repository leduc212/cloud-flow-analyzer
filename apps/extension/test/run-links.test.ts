// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import bad from '../../../fixtures/flows/sync-contacts-bad.json' with { type: 'json' };
import { analyseFlow } from '@cfa/core';
import { createApiClient } from '../src/api/client.ts';
import { flowApi } from '../src/api/flows.ts';
import { fetchRunLinks, readRunRecord, startedBy } from '../src/api/run-links.ts';
import { HOST_ID, Pane } from '../src/content/pane.ts';
import { flowRunUrl, parseFlowUrl } from '../src/shared/flow-url.ts';
import { buildPaneResult } from '../src/shared/pane-result.ts';
import type { PaneRunLinks } from '../src/shared/run-links.ts';
import type { TokenRecord } from '../src/shared/token.ts';

declare const jsdom: { reconfigure(options: { url: string }): void };

const ORIGIN = 'https://api.flow.microsoft.com';
const TOKEN: TokenRecord = { kind: 'flow', token: 't', capturedAt: 0, origins: [ORIGIN] };
const api = flowApi(ORIGIN);
const at = (seconds: number) => new Date(Date.UTC(2026, 8, 24) + seconds * 1000).toISOString();

/** A run as the API lists it (shape from a real capture). */
function run(
  name: string,
  start: number,
  end: number | undefined,
  trackingId: string,
  extra: { origin?: string; source?: string; trigger?: string; status?: string } = {},
) {
  return {
    name,
    properties: {
      startTime: at(start),
      ...(end !== undefined ? { endTime: at(end) } : {}),
      status: extra.status ?? (end === undefined ? 'Running' : 'Succeeded'),
      correlation: { clientTrackingId: trackingId },
      trigger: {
        name: extra.trigger ?? 'manual',
        originHistoryName: extra.origin ?? name,
        ...(extra.source ? { sourceHistoryName: extra.source } : {}),
        correlation: { clientTrackingId: trackingId },
      },
    },
  };
}

const callChild = (workflowId: string, runAfter: Record<string, string[]> = {}) => ({
  type: 'Workflow',
  inputs: { host: { workflowReferenceName: workflowId }, body: {} },
  runAfter,
});

function flow(name: string, workflowId: string, actions: Record<string, unknown>) {
  return {
    name,
    properties: {
      displayName: `Flow ${name}`,
      workflowEntityId: workflowId,
      definition: {
        triggers: { manual: { type: 'Request', kind: 'Button', inputs: {} } },
        actions,
      },
    },
  };
}

// "parent" calls "child" (once, and again in a loop) and "other"; it would call a flow nobody
// can see. "unrelated" calls child flows too, but not "child".
const FLOWS: Record<string, ReturnType<typeof flow>> = {
  parent: flow('parent', 'wf-parent', {
    Call_child: callChild('WF-CHILD'),
    Call_other: callChild('wf-other', { Call_child: ['Succeeded'] }),
    Call_hidden: callChild('wf-hidden', { Call_other: ['Succeeded'] }),
  }),
  child: flow('child', 'wf-child', { Compose: { type: 'Compose', inputs: 1 } }),
  other: flow('other', 'wf-other', {}),
  unrelated: flow('unrelated', 'wf-unrelated', { Call_other: callChild('wf-other') }),
};

const SUMMARY_ACTIONS: Record<string, { type: string }[]> = {
  parent: [{ type: 'Workflow' }, { type: 'Workflow' }, { type: 'Workflow' }],
  child: [{ type: 'Compose' }],
  other: [],
  unrelated: [{ type: 'Workflow' }],
};

// Newest first, like the API.
const RUNS: Record<string, ReturnType<typeof run>[]> = {
  parent: [
    run('P2', 500, 520, 'P2'),
    run('P1', 0, 60, 'P1', { trigger: 'manual' }),
    run('P0', -500, -400, 'P0'),
  ],
  child: [
    run('C9', 600, 601, 'X'),
    run('C3', 200, 205, 'P1', { source: 'C1' }),
    run('C2', 20, 30, 'P1'),
    run('C1', 10, 15, 'P1'),
    run('C8', 12, 13, 'SOMEONE-ELSE'),
  ],
  other: [run('O1', 40, 45, 'P1')],
  unrelated: [],
};

const ACTIONS: Record<string, unknown[]> = {
  P1: [
    { name: 'Call_child', properties: { status: 'Succeeded', startTime: at(9), endTime: at(31) } },
    { name: 'Call_other', properties: { status: 'Skipped', startTime: at(31), endTime: at(31) } },
    {
      name: 'Call_hidden',
      properties: { status: 'Succeeded', startTime: at(31), endTime: at(32) },
    },
  ],
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function setup(filter: 'supported' | 'refused' = 'supported') {
  const calls: string[] = [];
  const client = createApiClient({
    getToken: () => TOKEN,
    sleep: async () => undefined,
    fetch: async (input) => {
      const url = new URL(String(input));
      const path = decodeURIComponent(url.pathname).replace(
        '/providers/Microsoft.ProcessSimple/environments/env',
        '',
      );
      const query = url.searchParams.get('$filter');
      calls.push(`${path}${query ? ` ${query}` : ''}`);
      if (path === '/flows') {
        return json({
          value: Object.values(FLOWS).map((f) => ({
            name: f.name,
            properties: {
              displayName: f.properties.displayName,
              workflowEntityId: f.properties.workflowEntityId,
              definitionSummary: { actions: SUMMARY_ACTIONS[f.name] },
            },
          })),
        });
      }
      const match = /^\/flows\/([^/]+)(?:\/runs(?:\/([^/]+))?(\/actions)?)?$/.exec(path);
      const [, name = '', runName, actions] = match ?? [];
      if (!match || !FLOWS[name]) return json({ error: { code: 'NotFound' } }, 404);
      if (actions) return json({ value: ACTIONS[runName ?? ''] ?? [] });
      if (runName) {
        const found = RUNS[name]?.find((r) => r.name === runName);
        return found ? json(found) : json({ error: { code: 'NotFound' } }, 404);
      }
      if (path.endsWith('/runs')) {
        if (!query) return json({ value: RUNS[name] });
        if (filter === 'refused') return json({ error: { code: 'InvalidFilter' } }, 400);
        const id = /ClientTrackingId eq '(.*)'/.exec(query)?.[1];
        return json({
          value: RUNS[name]?.filter((r) => r.properties.correlation.clientTrackingId === id),
        });
      }
      return json(FLOWS[name]);
    },
  });
  return { client, calls };
}

const links = (runName: string, flowName = 'parent', filter?: 'supported' | 'refused') => {
  const { client, calls } = setup(filter);
  const result = fetchRunLinks(client, api, 'env', flowName, FLOWS[flowName], runName, {
    maxChildRuns: 10,
    maxPages: 5,
    now: () => Date.parse(at(1000)),
  });
  return { result, calls };
};

describe('reading runs', () => {
  it('tells what started a run from its tracking IDs (real records)', () => {
    // A run started by its trigger (an email): the tracking ID is that trigger firing.
    const root = readRunRecord({
      name: '08584113138260281161129881307CU28',
      properties: {
        status: 'Succeeded',
        correlation: { clientTrackingId: '08584113138260281162129881307CU15' },
        trigger: {
          name: 'When_a_new_email_arrives_in_a_shared_mailbox_(V2)',
          originHistoryName: '08584113138260281162129881307CU15',
        },
      },
    });
    // A child flow run it started: the same tracking ID, but its own trigger firing.
    const child = readRunRecord({
      name: '08584113137986188023095041872CU16',
      properties: {
        status: 'Succeeded',
        correlation: { clientTrackingId: '08584113138260281162129881307CU15' },
        trigger: { name: 'manual', originHistoryName: '08584113137986188023095041872CU16' },
      },
    });
    const resubmitted = readRunRecord({
      name: '08584127522113506791295156528CU29',
      properties: {
        status: 'Succeeded',
        correlation: { clientTrackingId: '08584127525035686517392093755CU20' },
        trigger: {
          name: 'Recurrence',
          originHistoryName: '08584127522113506791295156528CU29',
          sourceHistoryName: '08584127525035686517392093755CU20',
        },
      },
    });
    expect([root, child, resubmitted].map(startedBy)).toEqual(['trigger', 'run', 'resubmitted']);
    expect(child).toEqual({
      name: '08584113137986188023095041872CU16',
      status: 'Succeeded',
      trackingId: '08584113138260281162129881307CU15',
      originHistoryName: '08584113137986188023095041872CU16',
      triggerName: 'manual',
    });
  });

  it('reads the run from a run page URL', () => {
    const flowId = 'aaaaaaaa-1111-2222-3333-444444444444';
    expect(
      parseFlowUrl(
        `https://make.powerautomate.com/environments/env/flows/${flowId}/runs/08584113137986188023095041872CU16?v3=true`,
      ),
    ).toEqual({ environment: 'env', flowId, runName: '08584113137986188023095041872CU16' });
    expect(flowRunUrl('env', 'f', 'r1')).toBe(
      'https://make.powerautomate.com/environments/env/flows/f/runs/r1',
    );
  });
});

describe('fetchRunLinks', () => {
  it('lists the child flow runs a run started, and says when it was not called', async () => {
    const { result, calls } = links('P1');
    const { run, origin, children } = await result;
    expect(run).toMatchObject({ runName: 'P1', status: 'Succeeded', durationMs: 60_000 });
    expect(origin).toEqual({ kind: 'trigger', triggerName: 'manual' });
    const byName = Object.fromEntries(children.map((c) => [c.displayName, c]));
    // C3 (later, a resubmission) and C8 (another chain) are left out.
    expect(byName['Flow child']?.runs.map((r) => r.runName)).toEqual(['C1', 'C2']);
    expect(byName['Flow child']?.actions.map((a) => a.targetLabel)).toEqual(['Call child']);
    expect(byName['Flow other']).toMatchObject({ runs: [], note: 'Not called in this run.' });
    expect(byName['Call hidden']?.note).toMatch(/isn't among the flows you can see/);
    expect(calls).toContain("/flows/child/runs ClientTrackingId eq 'P1'");
    // Flows are listed once, for both the parent and the children.
    expect(calls.filter((c) => c === '/flows')).toHaveLength(1);
  });

  it('finds the parent run and the action that called it', async () => {
    const { result, calls } = links('C2', 'child');
    const { origin, children } = await result;
    expect(origin).toMatchObject({
      kind: 'parent',
      actions: ['Call_child'],
      run: { flowName: 'parent', displayName: 'Flow parent', runName: 'P1', status: 'Succeeded' },
    });
    expect(children).toEqual([]);
    // Only flows that call child flows are read, and "unrelated" doesn't call this one.
    expect(calls).toContain('/flows/parent');
    expect(calls).toContain('/flows/unrelated');
    expect(calls).not.toContain('/flows/other');
    expect(calls.filter((c) => c.startsWith('/flows/unrelated/runs'))).toEqual([]);
  });

  it('reads the latest runs when the API refuses the tracking ID filter', async () => {
    const { result, calls } = links('C1', 'child', 'refused');
    expect((await result).origin).toMatchObject({ kind: 'parent', run: { runName: 'P1' } });
    expect(calls).toContain('/flows/parent/runs');
    const parent = await links('P1', 'parent', 'refused').result;
    expect(parent.children[0]?.runs.map((r) => r.runName)).toEqual(['C1', 'C2']);
  });

  it('points a resubmitted run at the run it came from', async () => {
    const { origin } = await links('C3', 'child').result;
    expect(origin).toMatchObject({
      kind: 'resubmitted',
      run: { flowName: 'child', runName: 'C1', durationMs: 5000 },
    });
  });

  it('explains when the run that started it is not found', async () => {
    const { origin } = await links('C8', 'child').result;
    expect(origin).toMatchObject({ kind: 'unknown', trackingId: 'SOMEONE-ELSE' });
    expect(origin?.kind === 'unknown' && origin.reason).toMatch(
      /"Flow parent" calls this flow, but no run of it with the same tracking ID was found/,
    );
  });
});

describe('the pane on a run page', () => {
  const FLOW_ID = 'aaaaaaaa-1111-2222-3333-444444444444';
  const PAGE = `https://make.powerautomate.com/environments/env/flows/${FLOW_ID}`;
  const result = buildPaneResult({ environment: 'env', flowId: FLOW_ID }, analyseFlow(bad));
  const shadow = () => document.getElementById(HOST_ID)!.shadowRoot!;
  const text = (selector: string) => shadow().querySelector(selector)?.textContent ?? '';
  afterEach(() => jsdom.reconfigure({ url: 'about:blank' }));

  it('asks for the run links, then shows the parent and the child runs', async () => {
    jsdom.reconfigure({ url: `${PAGE}/runs/R1` });
    const send = vi.fn();
    const pane = new Pane(send, { load: async () => [], save: async () => {} });
    await pane.showResult(result);
    expect(send).toHaveBeenCalledWith({ type: 'cfa:run-links' });
    expect(text('.links')).toContain('Looking for the run that started it');

    const links: PaneRunLinks = {
      ref: { environment: 'env', flowId: FLOW_ID, runName: 'R1' },
      run: { environment: 'env', flowName: FLOW_ID, runName: 'R1', status: 'Failed' },
      origin: {
        kind: 'parent',
        actions: ['Run_a_Child_Flow'],
        run: {
          environment: 'env',
          flowName: 'parent',
          displayName: 'Parent <b>flow</b>',
          runName: 'P1',
          status: 'Succeeded',
          startTime: at(0),
          durationMs: 60_000,
        },
      },
      children: [
        {
          flowName: 'child',
          displayName: 'Child',
          actions: [result.findings[0]!],
          runs: [{ environment: 'env', flowName: 'child', runName: 'C1', status: 'Failed' }],
          more: 3,
        },
      ],
    };
    // An answer for a run the user has left is dropped.
    pane.showRunLinks({ ...links, ref: { ...links.ref, runName: 'R0' } });
    expect(text('.links')).toContain('Looking for');
    pane.showRunLinks(links);
    expect(text('.links summary')).toBe('This run · Failed');
    const anchors = [...shadow().querySelectorAll<HTMLAnchorElement>('.links a.run-link')];
    expect(anchors.map((a) => a.href)).toEqual([
      'https://make.powerautomate.com/environments/env/flows/parent/runs/P1',
      'https://make.powerautomate.com/environments/env/flows/child/runs/C1',
    ]);
    expect(anchors[0]?.textContent).toMatch(/^Parent <b>flow<\/b> · /);
    expect(shadow().querySelector('.links b')).toBeNull();
    expect(text('.links')).toContain('Called by Run a Child Flow in that flow.');
    expect(text('.links')).toContain('and 3 more');
    expect(text('.links .status-succeeded')).toBe('Succeeded · 1.0 min');

    send.mockClear();
    shadow()
      .querySelectorAll<HTMLButtonElement>('.links button')
      .forEach((b) => b.textContent === 'Look again' && b.click());
    expect(send).toHaveBeenCalledWith({ type: 'cfa:run-links' });
    pane.close();
  });

  it('stays hidden away from run pages', async () => {
    jsdom.reconfigure({ url: `${PAGE}/details` });
    const send = vi.fn();
    const pane = new Pane(send, { load: async () => [], save: async () => {} });
    await pane.showResult(result);
    expect(send).not.toHaveBeenCalled();
    expect(shadow().querySelector<HTMLElement>('.links')?.hidden).toBe(true);
    pane.close();
  });
});
