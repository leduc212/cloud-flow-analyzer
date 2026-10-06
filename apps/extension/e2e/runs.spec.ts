import { designerPage } from './designer.ts';
import { ENV, FLOW, TOKEN, expect, test } from './fixtures.ts';
import { bad, routeRuns } from './runs-api.ts';

test('filters a flow’s runs by duration and status, and analyses the matching ones', async ({
  context,
  openPortal,
  extensionId,
}) => {
  await openPortal(designerPage([{ id: 'A' }], TOKEN));
  await routeRuns(context);
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/runs.html?env=${ENV}&flow=${FLOW}`);

  await expect(page.locator('#status')).toHaveText('6 runs from the last 7 days.');
  await expect(page.locator('#flow')).toContainText('Sync account contacts (before)');
  await expect(page.locator('tbody tr')).toHaveCount(6);
  // Longest first: the run still going (an hour so far), then 10 min.
  await expect(page.locator('tbody tr').first()).toHaveAttribute('data-run', 'r6');
  await expect(page.locator('tbody tr').nth(1)).toHaveAttribute('data-run', 'r4');
  await expect(page.locator('.bar-slot')).not.toHaveCount(0);

  // At least 1 minute.
  await page.fill('#min', '1');
  await expect(page.locator('#summary')).toContainText('3 of 6 runs match');
  await expect(page.locator('tbody tr')).toHaveCount(3);

  // Hide the run still going.
  await page.click('#statuses button:has-text("Running")');
  await expect(page.locator('tbody tr')).toHaveCount(2);
  await expect(page.locator('#analyse')).toHaveText('Analyse the 2 matching runs');

  // A bar sets the threshold to its lower bound.
  const tenMinutes = page.locator('.bar-slot[aria-label^="10–30 min"]');
  await tenMinutes.hover();
  await expect(page.locator('.chart-tooltip')).toHaveText('10–30 min: 1 run');
  await tenMinutes.click();
  await expect(page.locator('#min')).toHaveValue('10');
  await expect(page.locator('#min-unit')).toHaveValue('min');
  await expect(page.locator('tbody tr')).toHaveCount(1);

  await page.click('#presets button:has-text("Clear filters")');
  await expect(page.locator('tbody tr')).toHaveCount(6);
  await page.click('#presets button:has-text("Slowest 5%")');
  await expect(page.locator('tbody tr')).toHaveCount(2);

  const download = page.waitForEvent('download');
  await page.click('#csv');
  expect((await download).suggestedFilename()).toBe('runs-Sync-account-contacts-before-.csv');

  await page.click('#analyse');
  await expect(page.locator('#analysis')).toBeVisible();
  await expect(page.locator('#analysis')).toContainText('Where the time goes in these runs');
  await expect(page.locator('#analysis')).toContainText('List accounts');
  await expect(page.locator('#status')).toHaveText('Analysed 1 run.');
});

test('the pane opens the Runs page of its flow', async ({
  context,
  openPortal,
  mockApi,
  analyse,
  extensionId,
}) => {
  await mockApi({ [`/flows/${FLOW}`]: bad });
  const portal = await openPortal(designerPage([{ id: 'List_accounts' }], TOKEN));
  await analyse(portal);
  await routeRuns(context);
  const opened = context.waitForEvent('page');
  await portal.locator('#cfa-pane-host .runs-button', { hasText: 'All runs' }).click();
  const page = await opened;
  await expect(page).toHaveURL(
    `chrome-extension://${extensionId}/runs.html?env=${ENV}&flow=${FLOW}`,
  );
  await expect(page.locator('#status')).toHaveText('6 runs from the last 7 days.');
});
