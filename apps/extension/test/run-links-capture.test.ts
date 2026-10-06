// Parent and child runs found in a real (anonymised) capture: the API's own responses, replayed.
import { describe, expect, it } from 'vitest';
import capture from '../../../fixtures/captures/cfa-capture-202609250555.anonymised.json' with { type: 'json' };
import { createApiClient } from '../src/api/client.ts';
import { flowApi } from '../src/api/flows.ts';
import { fetchRunLinks } from '../src/api/run-links.ts';
import type { TokenRecord } from '../src/shared/token.ts';

const ORIGIN = 'https://api.flow.microsoft.com';
const TOKEN: TokenRecord = { kind: 'flow', token: 't', capturedAt: 0, origins: [ORIGIN] };
const ENV = capture.environment;

interface Recorded {
  label: string;
  url: string;
  status: number;
  body?: unknown;
}
const requests = capture.requests as Recorded[];
const value = (body: unknown) =>
  ((body as { value?: unknown[] } | undefined)?.value ?? []) as {
    name: string;
  }[];

/** The flow named in an API path, and what follows it. */
const flowPath = (path: string) => /\/flows\/([^/]+)(\/.*)?$/.exec(path);

/** Runs listed per flow, and flows by name, from the capture. */
const runsByFlow = new Map<string, { name: string }[]>();
const flows = new Map<string, unknown>();
for (const request of requests) {
  const path = new URL(request.url).pathname;
  const match = flowPath(path);
  if (!match?.[1]) continue;
  if (match[2] === '/runs') runsByFlow.set(match[1], value(request.body));
  if (!match[2] && request.label.startsWith('flow:')) flows.set(match[1], request.body);
}
/** A flow's name from its label in the capture (display names inside it are anonymised). */
const flowNamed = (label: string) => {
  const request = requests.find((r) => r.label === `flow: ${label}`);
  return (request && flowPath(new URL(request.url).pathname)?.[1]) ?? '';
};
const labelOf = (flow: string) =>
  requests
    .find((r) => r.label.startsWith('flow: ') && flowPath(new URL(r.url).pathname)?.[1] === flow)
    ?.label.slice(6);

/** `adminOnly`: flows left out of the default list, as for flows only an admin sees. */
function replay(adminOnly: string[] = []) {
  const calls: string[] = [];
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const client = createApiClient({
    getToken: () => TOKEN,
    sleep: async () => undefined,
    fetch: async (input) => {
      const url = new URL(String(input));
      calls.push(`${url.pathname}${url.search}`);
      // The capture never asked for runs by tracking ID: refuse, as an API without the filter would.
      if (url.searchParams.has('$filter') && url.pathname.endsWith('/runs')) {
        return json({ error: { code: 'InvalidFilter' } }, 400);
      }
      const match = flowPath(url.pathname);
      if (match?.[1] && match[2] === '/runs')
        return json({ value: runsByFlow.get(match[1]) ?? [] });
      const run = match?.[2] ? /^\/runs\/([^/]+)$/.exec(match[2]) : null;
      if (match?.[1] && run?.[1]) {
        const found = runsByFlow.get(match[1])?.find((r) => r.name === run[1]);
        return found ? json(found) : json({ error: { code: 'NotFound' } }, 404);
      }
      // Anything else (flow lists, flows, run actions) as it was recorded.
      const recorded = requests.find(
        (r) => new URL(r.url).pathname === url.pathname && !r.label.includes('(page'),
      );
      if (!recorded) return json({ error: { code: 'NotFound' } }, 404);
      const pages = requests.filter((r) => r.label === `${recorded.label} (page 2)`);
      const body = recorded.body as { value?: unknown[] };
      const listed =
        pages.length > 0 ? { value: [...(body.value ?? []), ...value(pages[0]?.body)] } : body;
      if (recorded.label === 'flows: default') {
        return json({ value: value(listed).filter((f) => !adminOnly.includes(f.name)) });
      }
      return json(listed, recorded.status);
    },
  });
  return { client, calls };
}

async function links(flowLabel: string, runSuffix: string, adminOnly: string[] = []) {
  const flow = flowNamed(flowLabel);
  const run = runsByFlow.get(flow)?.find((r) => r.name.endsWith(runSuffix))?.name ?? '';
  const { client, calls } = replay(adminOnly.map(flowNamed));
  const result = await fetchRunLinks(client, flowApi(ORIGIN), ENV, flow, flows.get(flow), run);
  return { ...result, calls };
}

describe('run links in a real capture', () => {
  it('finds the run that called a child flow', async () => {
    const { origin } = await links('[Trigger] Ground PO Fields', '72CU16');
    expect(origin?.kind).toBe('parent');
    expect(origin?.kind === 'parent' && labelOf(origin.run.flowName)).toBe(
      'New - [Auto] Reading OCR outcome US88',
    );
    expect(origin?.kind === 'parent' && origin.run.runName).toBe(
      '08584113138260281161129881307CU28',
    );
  });

  it('finds it when the calling flow is only in the admin list', async () => {
    const { origin } = await links('[Trigger] Ground PO Fields', '72CU16', [
      'New - [Auto] Reading OCR outcome US88',
    ]);
    expect(origin).toMatchObject({
      kind: 'parent',
      run: { runName: '08584113138260281161129881307CU28' },
    });
  });

  it('narrows the calling steps to the one running when the child started', async () => {
    const { origin } = await links('[Trigger] Create Non-PO', '21CU26');
    expect(origin).toMatchObject({
      kind: 'parent',
      run: { runName: '08584112951232485875512301452CU29' },
    });
    expect(origin?.kind === 'parent' && labelOf(origin.run.flowName)).toBe(
      'New - [Auto] Reading OCR outcome CA',
    );
    // The flow calls it from six steps.
    expect(origin?.kind === 'parent' && origin.actions.length).toBeLessThan(6);
  });

  it('lists the child flow runs a run started', async () => {
    const { children } = await links('New - [Auto] Reading OCR outcome US88', '07CU28');
    const byFlow = Object.fromEntries(
      children.map((c) => [labelOf(c.flowName ?? ''), c.runs.map((r) => r.runName.slice(-6))]),
    );
    expect(byFlow).toMatchObject({
      '[Trigger] Ground PO Fields': ['72CU16'],
      '[Trigger] Run AI Prompt': ['90cU14', '77CU22'],
      '[Trigger] Extract text from Attachment File': ['35CU06'],
      '[Trigger] Persist Extracted POs': ['96CU27'],
    });
  });

  it('explains a run started by a change another run made', async () => {
    // A Dataverse trigger: its tracking ID is the run that changed the row, not a child flow call.
    const { origin } = await links('[Automated] Update PO Derived Value', '97CU16');
    expect(origin?.kind).toBe('unknown');
    expect(origin?.kind === 'unknown' && origin.reason).toMatch(
      /flows in this environment that call child flows calls this one\..*changing something its trigger watches/,
    );
  });
});
