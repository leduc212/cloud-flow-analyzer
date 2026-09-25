import { hostKind, type HostKind } from '../shared/hosts.ts';
import type { TokenRecord } from '../shared/token.ts';

/** One API call as recorded for the capture file. Never contains the token. */
export interface RecordedRequest {
  id: number;
  label: string;
  method: 'GET';
  url: string;
  status: number;
  durationMs: number;
  startedAt: string;
  attempt: number;
  headers: Record<string, string>;
  body?: unknown;
  error?: string;
}

export class ApiError extends Error {
  override name = 'ApiError';
  readonly status: number;
  readonly url: string;
  constructor(message: string, status: number, url: string) {
    super(message);
    this.status = status;
    this.url = url;
  }
}

export class NoTokenError extends Error {
  override name = 'NoTokenError';
  readonly kind: HostKind;
  constructor(kind: HostKind) {
    super(
      'No token captured yet. Open make.powerautomate.com in another tab, sign in, and refresh the page.',
    );
    this.kind = kind;
  }
}

export interface ApiClientOptions {
  getToken(kind: HostKind): TokenRecord | undefined | Promise<TokenRecord | undefined>;
  onRecord?(request: RecordedRequest): void;
  maxConcurrent?: number;
  maxRetries?: number;
  signal?: AbortSignal;
  fetch?: typeof fetch;
  sleep?(ms: number): Promise<void>;
  now?(): number;
}

export interface ApiList<T> {
  value?: T[];
  nextLink?: string;
}

const RECORDED_HEADERS = /^(retry-after|x-ms-ratelimit-.*|x-ms-request-id|content-type)$/i;

/** Runs at most `max` tasks at once, in order. */
export function createLimiter(max: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async function run<T>(task: () => Promise<T>): Promise<T> {
    if (active >= max) await new Promise<void>((resolve) => waiting.push(resolve));
    active += 1;
    try {
      return await task();
    } finally {
      active -= 1;
      waiting.shift()?.();
    }
  };
}

/** Delay before retrying a throttled or failed call: Retry-After when given, else exponential. */
export function retryDelay(headers: Headers, attempt: number): number {
  const retryAfter = headers.get('retry-after');
  const seconds = retryAfter === null ? NaN : Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds, 120) * 1000;
  return Math.min(2 ** attempt * 1000, 30_000);
}

function errorMessage(body: unknown, status: number): string {
  if (typeof body === 'object' && body !== null && 'error' in body) {
    const error = (body as { error?: { message?: unknown; code?: unknown } }).error;
    if (typeof error?.message === 'string') return error.message;
    if (typeof error?.code === 'string') return error.code;
  }
  return `HTTP ${status}`;
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Read-only client for the Power Automate / Power Platform APIs. Refuses anything but GET to
 * those hosts, sends the token captured for that host, caps parallel calls and backs off on
 * 429 and 5xx responses.
 */
export function createApiClient(options: ApiClientOptions) {
  const run = createLimiter(options.maxConcurrent ?? 4);
  const maxRetries = options.maxRetries ?? 4;
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init));
  const sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? (() => performance.now());
  let nextId = 1;

  async function get<T>(url: string, label: string): Promise<T> {
    const parsed = new URL(url);
    const kind = hostKind(parsed.hostname);
    if (parsed.protocol !== 'https:' || !kind) {
      throw new Error(`Refusing to call ${parsed.host}: not a Power Automate API host.`);
    }
    return run(async () => {
      for (let attempt = 0; ; attempt++) {
        options.signal?.throwIfAborted();
        const token = await options.getToken(kind);
        if (!token) throw new NoTokenError(kind);
        const started = now();
        const record: RecordedRequest = {
          id: nextId++,
          label,
          method: 'GET',
          url,
          status: 0,
          durationMs: 0,
          startedAt: new Date().toISOString(),
          attempt,
          headers: {},
        };
        let response: Response;
        try {
          response = await doFetch(url, {
            method: 'GET',
            headers: { Authorization: `Bearer ${token.token}`, Accept: 'application/json' },
            credentials: 'omit',
            cache: 'no-store',
            ...(options.signal ? { signal: options.signal } : {}),
          });
        } catch (error) {
          record.error = error instanceof Error ? error.message : String(error);
          record.durationMs = Math.round(now() - started);
          options.onRecord?.(record);
          throw error;
        }
        record.status = response.status;
        response.headers.forEach((value, key) => {
          if (RECORDED_HEADERS.test(key)) record.headers[key] = value;
        });
        const retry = (response.status === 429 || response.status >= 500) && attempt < maxRetries;
        const body = await readBody(response);
        record.durationMs = Math.round(now() - started);
        if (!retry) record.body = body;
        if (!response.ok) record.error = errorMessage(body, response.status);
        options.onRecord?.(record);
        if (retry) {
          await sleep(retryDelay(response.headers, attempt));
          continue;
        }
        if (response.status === 401) {
          throw new ApiError(
            'The token has expired or was rejected. Refresh the Power Automate tab, then try again.',
            401,
            url,
          );
        }
        if (!response.ok)
          throw new ApiError(errorMessage(body, response.status), response.status, url);
        return body as T;
      }
    });
  }

  /** Follows `nextLink` pages until `maxItems` items or `maxPages` pages. */
  async function getAll<T>(
    url: string,
    label: string,
    maxItems = 1000,
    maxPages = 20,
  ): Promise<T[]> {
    const items: T[] = [];
    let next: string | undefined = url;
    for (let page = 1; next && page <= maxPages && items.length < maxItems; page++) {
      const body: ApiList<T> = await get<ApiList<T>>(
        next,
        page === 1 ? label : `${label} (page ${page})`,
      );
      items.push(...(body.value ?? []));
      next = body.nextLink;
    }
    return items.slice(0, maxItems);
  }

  return { get, getAll };
}

export type ApiClient = ReturnType<typeof createApiClient>;
