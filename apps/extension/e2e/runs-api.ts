// The runs API the Runs page reads, for the browser tests.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { BrowserContext } from '@playwright/test';
import { FLOW, FLOW_API } from './fixtures.ts';

export const bad = {
  ...JSON.parse(
    readFileSync(
      resolve(import.meta.dirname, '../../../fixtures/flows/sync-contacts-bad.json'),
      'utf8',
    ),
  ),
  name: FLOW,
};

const HOUR = 3_600_000;
/** Six runs in the last day, newest first: [name, hours ago, seconds taken, status]. */
const RUNS: [string, number, number | undefined, string][] = [
  ['r6', 1, undefined, 'Running'],
  ['r5', 2, 0.5, 'Succeeded'],
  ['r4', 3, 600, 'Succeeded'],
  ['r3', 4, 45, 'Failed'],
  ['r2', 5, 90, 'Succeeded'],
  ['r1', 6, 3, 'Succeeded'],
];

/** The runs API for the Runs page (extension pages are reached by Playwright's routing). */
export async function routeRuns(context: BrowserContext): Promise<void> {
  const now = Date.now();
  await context.route(FLOW_API, (route) => {
    const path = decodeURIComponent(new URL(route.request().url()).pathname);
    const body = path.endsWith(`/flows/${FLOW}`)
      ? bad
      : path.endsWith(`/flows/${FLOW}/runs`)
        ? {
            value: RUNS.map(([name, hoursAgo, seconds, status]) => {
              const start = now - hoursAgo * HOUR;
              return {
                name,
                properties: {
                  status,
                  startTime: new Date(start).toISOString(),
                  ...(seconds !== undefined
                    ? { endTime: new Date(start + seconds * 1000).toISOString() }
                    : {}),
                },
              };
            }),
          }
        : path.endsWith('/actions')
          ? {
              value: [
                {
                  name: 'List_accounts',
                  properties: {
                    status: 'Succeeded',
                    startTime: new Date(now).toISOString(),
                    endTime: new Date(now + 4000).toISOString(),
                  },
                },
              ],
            }
          : path.includes('/repetitions')
            ? { value: [] }
            : undefined;
    return route.fulfill({
      status: body ? 200 : 404,
      contentType: 'application/json',
      body: JSON.stringify(body ?? { error: { message: 'not mocked' } }),
    });
  });
}
