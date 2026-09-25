import { analyseFlow } from '@cfa/core';
import { ApiError, NoTokenError, type ApiClient } from '../api/client.ts';
import type { FlowApi } from '../api/flows.ts';
import { friendlyError } from '../shared/errors.ts';
import { summariseAnalysis, type FlowRow, type RowAnalysis } from './model.ts';

/**
 * Analyses already done in this browser session, keyed by flow and last-modified time, so
 * reopening the page is instant and an edited flow is analysed again.
 */
export interface AnalysisCache {
  get(key: string): Promise<RowAnalysis | undefined>;
  set(key: string, value: RowAnalysis): Promise<void>;
}

/** chrome.storage.session: memory only, gone when the browser closes. */
export const sessionAnalysisCache: AnalysisCache = {
  async get(key) {
    const stored = (await chrome.storage.session.get(`analysis:${key}`))[`analysis:${key}`];
    return stored as RowAnalysis | undefined;
  },
  async set(key, value) {
    await chrome.storage.session.set({ [`analysis:${key}`]: value });
  },
};

export interface AnalyseAllOptions {
  signal?: AbortSignal;
  cache?: AnalysisCache;
  /** Called after each flow, with its row updated in place. */
  onRow?(row: FlowRow): void;
}

function isFatal(error: unknown): boolean {
  return error instanceof NoTokenError || (error instanceof ApiError && error.status === 401);
}

const notReadable = (error: unknown) =>
  error instanceof ApiError && (error.status === 403 || error.status === 404);

/**
 * Fetches and analyses each flow's definition (definition rules only, no runs), filling in
 * `row.analysis` or `row.error`. The client caps parallel calls. Stops early when the signal
 * aborts, or when the sign-in is missing or expired (that error is thrown).
 */
export async function analyseAll(
  client: ApiClient,
  api: FlowApi,
  environment: string,
  rows: FlowRow[],
  options: AnalyseAllOptions = {},
): Promise<{ analysed: number; cancelled: boolean }> {
  let analysed = 0;
  const one = async (row: FlowRow): Promise<void> => {
    if (options.signal?.aborted) return;
    const key = `${environment}/${row.name}/${row.lastModified ?? ''}`;
    try {
      const cached = await options.cache?.get(key);
      if (cached) {
        row.analysis = cached;
      } else {
        let definition: unknown;
        try {
          definition = await client.get(api.flow(environment, row.name), 'flow');
        } catch (error) {
          // Flows only listed for admins are read through the admin endpoint.
          if (!notReadable(error) || !row.sources.includes('admin')) throw error;
          definition = await client.get(api.flow(environment, row.name, true), 'flow (admin)');
        }
        row.analysis = summariseAnalysis(analyseFlow(definition));
        await options.cache?.set(key, row.analysis);
      }
      delete row.error;
      analysed += 1;
    } catch (error) {
      if (isFatal(error)) throw error;
      if (options.signal?.aborted) return;
      row.error = friendlyError(error);
    }
    options.onRow?.(row);
  };
  await Promise.all(rows.map(one));
  return { analysed, cancelled: options.signal?.aborted === true };
}
