import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { designerPage } from './designer.ts';
import { ENV, FLOW, FLOW_API, TOKEN, expect, paneText, test } from './fixtures.ts';

const fixture = (name: string) =>
  JSON.parse(
    readFileSync(resolve(import.meta.dirname, `../../../fixtures/flows/${name}.json`), 'utf8'),
  );
const bad = fixture('sync-contacts-bad');
const good = fixture('sync-contacts-good');

const summary = (name: string, displayName: string) => ({
  name,
  properties: {
    displayName,
    state: 'Started',
    lastModifiedTime: '2026-09-01T00:00:00Z',
    definitionSummary: { triggers: [{ type: 'Recurrence' }] },
  },
});

test('lists, analyses and opens every flow in an environment', async ({
  context,
  openPortal,
  mockApi,
  extensionId,
}) => {
  await openPortal(designerPage([{ id: 'A' }], TOKEN));
  // Extension pages are covered by Playwright's routing (unlike the service worker).
  await context.route(FLOW_API, (route) => {
    const path = decodeURIComponent(new URL(route.request().url()).pathname);
    const body = path.endsWith('/environments')
      ? {
          value: [
            { name: 'Other', properties: { displayName: 'Other', isDefault: true } },
            { name: ENV, properties: { displayName: 'Contoso Dev' } },
          ],
        }
      : path.endsWith(`/environments/${ENV}/flows`)
        ? { value: [summary(FLOW, 'Sync contacts'), summary('good-flow', 'Tidy flow')] }
        : path.endsWith(`/flows/${FLOW}`)
          ? bad
          : path.endsWith('/flows/good-flow')
            ? good
            : undefined;
    return route.fulfill({
      status: body ? 200 : 403,
      contentType: 'application/json',
      body: JSON.stringify(body ?? { error: { code: 'Forbidden', message: 'Not an admin' } }),
    });
  });

  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/flows.html?env=${ENV}`);
  await expect(page.locator('#env')).toHaveValue(ENV);
  await expect(page.locator('#status')).toContainText('2 flows. not an environment admin');
  await expect(page.locator('tbody tr')).toHaveCount(2);

  await page.click('#analyse');
  await expect(page.locator('#status')).toHaveText('Done: 2 of 2 flows analysed.');
  // Worst grade first.
  const firstRow = page.locator('tbody tr').first();
  await expect(firstRow).toContainText('Sync contacts');
  await expect(firstRow.locator('.grade')).not.toHaveText('A');
  await expect(page.locator('tbody tr').nth(1).locator('.grade')).toHaveText('A');
  await expect(firstRow.locator('.top')).toContainText('SPD03');

  await page.click('#filters button:has-text("Grade C or lower")');
  await expect(page.locator('tbody tr')).toHaveCount(1);

  // Reopening the page shows the analyses at once (kept for the browser session).
  await page.reload();
  await expect(page.locator('#status')).toContainText('2 already analysed');

  // Open: the flow's page in the portal, with the analysis pane.
  await mockApi({ [`/flows/${FLOW}`]: bad });
  const opened = context.waitForEvent('page');
  await page.locator('tbody tr', { hasText: 'Sync contacts' }).locator('button').click();
  const portal = await opened;
  const flowPage = `https://make.powerautomate.com/environments/${ENV}/flows/${FLOW}/details`;
  await portal.waitForLoadState();
  // Playwright attaches to the new tab after its first request went out unrouted, so that
  // load fails; the worker waits for the flow's page, which this reload serves.
  if (portal.url() !== flowPage) await portal.goto(flowPage);
  expect(portal.url()).toBe(flowPage);
  await expect
    .poll(() => paneText(portal, '.flow-name').catch(() => ''), { timeout: 15_000 })
    .toBe('Sync account contacts (before)');
});

test('the popup opens All flows on the current environment', async ({
  context,
  openPortal,
  extensionId,
}) => {
  await openPortal(designerPage([{ id: 'A' }], TOKEN));
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  const opened = context.waitForEvent('page');
  await popup.click('#all-flows');
  const page = await opened;
  // Opened as a tab, the popup's "current tab" is itself: no environment to pass on.
  await expect(page).toHaveURL(`chrome-extension://${extensionId}/flows.html`);
});
