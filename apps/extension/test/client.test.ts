import { describe, expect, it } from 'vitest';
import bad from '../../../fixtures/flows/sync-contacts-bad.json' with { type: 'json' };
import {
  ApiError,
  NoTokenError,
  createApiClient,
  createLimiter,
  type RecordedRequest,
} from '../src/api/client.ts';
import { flowApi } from '../src/api/flows.ts';
import { buildCaptureFile, captureFlow, type CapturedFlow } from '../src/capture/capture.ts';
import type { TokenRecord } from '../src/shared/token.ts';

const ORIGIN = 'https://emea.api.flow.microsoft.com';
const TOKEN: TokenRecord = {
  kind: 'flow',
  token: 'secret-token',
  capturedAt: 0,
  origins: [ORIGIN],
  account: 'jane@contoso.com',
};

type Handler = (url: URL) => Response | Promise<Response>;

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function setup(handler: Handler, token: TokenRecord | null = TOKEN) {
  const records: RecordedRequest[] = [];
  const calls: { url: string; auth: string | null }[] = [];
  const sleeps: number[] = [];
  const client = createApiClient({
    getToken: () => token ?? undefined,
    onRecord: (r) => records.push(r),
    fetch: async (input, init) => {
      const url = new URL(String(input));
      calls.push({ url: url.toString(), auth: new Headers(init?.headers).get('authorization') });
      return handler(url);
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { client, records, calls, sleeps };
}

describe('api client', () => {
  it('sends the captured token to API hosts only', async () => {
    const { client, calls } = setup(() => json({ ok: true }));
    await expect(client.get(`${ORIGIN}/x`, 'x')).resolves.toEqual({ ok: true });
    expect(calls[0]?.auth).toBe('Bearer secret-token');
    await expect(client.get('https://evil.example.com/x', 'x')).rejects.toThrow('Refusing');
    await expect(client.get('http://api.flow.microsoft.com/x', 'x')).rejects.toThrow('Refusing');
    expect(calls).toHaveLength(1);
  });

  it('fails clearly without a token', async () => {
    const { client } = setup(() => json({}), null);
    await expect(client.get(`${ORIGIN}/x`, 'x')).rejects.toBeInstanceOf(NoTokenError);
  });

  it('retries 429 after Retry-After and records every attempt without the token', async () => {
    let n = 0;
    const { client, records, sleeps } = setup(() =>
      ++n === 1
        ? json({ error: { code: 'TooManyRequests' } }, 429, { 'retry-after': '3' })
        : json({ value: [1] }),
    );
    await expect(client.get(`${ORIGIN}/x`, 'x')).resolves.toEqual({ value: [1] });
    expect(sleeps).toEqual([3000]);
    expect(records.map((r) => [r.status, r.attempt])).toEqual([
      [429, 0],
      [200, 1],
    ]);
    expect(records[0]?.headers['retry-after']).toBe('3');
    expect(JSON.stringify(records)).not.toContain('secret-token');
  });

  it('backs off exponentially on 5xx and gives up after the retries', async () => {
    const { client, sleeps } = setup(() => json({ error: { message: 'down' } }, 503));
    await expect(client.get(`${ORIGIN}/x`, 'x')).rejects.toThrow('down');
    expect(sleeps).toEqual([1000, 2000, 4000, 8000]);
  });

  it('explains an expired token', async () => {
    const { client } = setup(() => json({}, 401));
    const error = await client.get(`${ORIGIN}/x`, 'x').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(401);
    expect((error as ApiError).message).toContain('Refresh the Power Automate tab');
  });

  it('follows nextLink pages up to the limits', async () => {
    const { client } = setup((url) => {
      const page = Number(url.searchParams.get('page') ?? '1');
      return json({
        value: [page * 10, page * 10 + 1],
        nextLink: page < 5 ? `${ORIGIN}/list?page=${page + 1}` : undefined,
      });
    });
    await expect(client.getAll(`${ORIGIN}/list`, 'list')).resolves.toEqual([
      10, 11, 20, 21, 30, 31, 40, 41, 50, 51,
    ]);
    await expect(client.getAll(`${ORIGIN}/list`, 'list', 3)).resolves.toEqual([10, 11, 20]);
    await expect(client.getAll(`${ORIGIN}/list`, 'list', 100, 2)).resolves.toEqual([
      10, 11, 20, 21,
    ]);
  });

  it('runs at most N tasks at once', async () => {
    const run = createLimiter(2);
    let active = 0;
    let peak = 0;
    const task = () =>
      run(async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
      });
    await Promise.all(Array.from({ length: 6 }, task));
    expect(peak).toBe(2);
  });
});

describe('capture', () => {
  const api = flowApi(ORIGIN);
  const flow: CapturedFlow = {
    name: 'flow-1',
    displayName: 'Sync',
    sources: ['admin'],
    summary: { name: 'flow-1' },
  };

  function tenant(options: { userForbidden?: boolean } = {}) {
    return (url: URL): Response => {
      const path = url.pathname;
      if (path.includes('/scopes/admin/') && path.endsWith('/flows/flow-1')) return json(bad);
      if (path.endsWith('/flows/flow-1')) return options.userForbidden ? json({}, 403) : json(bad);
      if (path.endsWith('/runs')) return json({ value: [{ name: 'run-1' }, { name: 'run-2' }] });
      if (path.endsWith('/actions')) return json({ value: [{ name: 'Apply_to_each' }] });
      if (path.endsWith('/repetitions')) return json({ value: [] });
      return json({}, 404);
    };
  }

  it('captures the definition, runs, actions and loop repetitions, and analyses the flow', async () => {
    const { client, calls } = setup(tenant());
    const result = await captureFlow(client, api, 'env', flow, {
      runsPerFlow: 2,
      repetitionPages: 1,
    });
    expect(result.grade).toBeDefined();
    expect(result.findings.map((f) => f.ruleId)).toContain('SPD03');
    const paths = calls.map((c) => new URL(c.url).pathname.split('/flows/flow-1')[1] ?? '');
    expect(paths.filter((p) => p.endsWith('/actions'))).toHaveLength(2);
    // 4 actions inside the loop × 2 runs.
    expect(paths.filter((p) => p.endsWith('/repetitions'))).toHaveLength(8);
  });

  it('falls back to the admin endpoint for admin-listed flows', async () => {
    const { client, calls } = setup(tenant({ userForbidden: true }));
    const result = await captureFlow(client, api, 'env', flow, {
      runsPerFlow: 0,
      repetitionPages: 0,
    });
    expect(result.error).toBeUndefined();
    expect(calls.map((c) => c.url.includes('/scopes/admin/'))).toEqual([false, true]);
  });

  it('reports a flow it cannot read instead of failing the whole capture', async () => {
    const { client } = setup(tenant({ userForbidden: true }));
    const result = await captureFlow(
      client,
      api,
      'env',
      { ...flow, sources: ['default'] },
      { runsPerFlow: 1, repetitionPages: 1 },
    );
    expect(result.error).toBe('HTTP 403');
  });

  it('writes an anonymised file without the token', async () => {
    const { client, records } = setup(tenant());
    const result = await captureFlow(client, api, 'env', flow, {
      runsPerFlow: 1,
      repetitionPages: 0,
    });
    const file = buildCaptureFile(
      { tokens: [TOKEN], endpoints: [], flows: [flow], requests: records, results: [result] },
      { anonymise: true, extensionVersion: '0.0.1', userAgent: 'test', now: new Date(0) },
    );
    const text = JSON.stringify(file);
    expect(text).not.toContain('secret-token');
    expect(text).not.toContain('contoso');
    expect(text).toContain('"tool":"cloud-flow-analyzer-capture"');
    expect(text).toContain('"ruleId":"SPD03"');
  });
});
