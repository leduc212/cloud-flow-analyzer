import { readFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { designerPage } from './designer.ts';
import { ENV, FLOW, FLOW_API, TOKEN, expect, test } from './fixtures.ts';

// Accessibility checks (WCAG 2.1 A and AA) with axe on everything the extension and the
// site show. Serious and critical problems fail the test.
const bad = JSON.parse(
  readFileSync(
    resolve(import.meta.dirname, '../../../fixtures/flows/sync-contacts-bad.json'),
    'utf8',
  ),
);

async function violations(page: Page, include?: string) {
  let builder = new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']);
  if (include) builder = builder.include(include);
  const { violations } = await builder.analyze();
  return violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join(', ')})`);
}

test('the analysis pane', async ({ openPortal, mockApi, analyse }) => {
  await mockApi({ [`/flows/${FLOW}`]: bad });
  const portal = await openPortal(designerPage([{ id: 'List_accounts' }], TOKEN));
  await analyse(portal);
  await expect(portal.locator('#cfa-pane-host .finding').first()).toBeVisible({ timeout: 15_000 });
  // Open one finding's details too.
  await portal.locator('#cfa-pane-host .finding summary').first().click();
  expect(await violations(portal, '#cfa-pane-host')).toEqual([]);
});

test('the popup, All flows page and capture tool', async ({ context, openPortal, extensionId }) => {
  await openPortal(designerPage([{ id: 'A' }], TOKEN));
  await context.route(FLOW_API, (route) => {
    const path = decodeURIComponent(new URL(route.request().url()).pathname);
    const body = path.endsWith('/environments')
      ? { value: [{ name: ENV, properties: { displayName: 'Contoso Dev', isDefault: true } }] }
      : path.endsWith(`/environments/${ENV}/flows`)
        ? {
            value: [
              {
                name: FLOW,
                properties: {
                  displayName: 'Sync contacts',
                  state: 'Started',
                  definitionSummary: { triggers: [{ type: 'Recurrence' }] },
                },
              },
            ],
          }
        : path.endsWith(`/flows/${FLOW}`)
          ? bad
          : undefined;
    return route.fulfill({
      status: body ? 200 : 403,
      contentType: 'application/json',
      body: JSON.stringify(body ?? { error: { message: 'no' } }),
    });
  });
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(page.locator('#status')).not.toBeEmpty();
  expect(await violations(page)).toEqual([]);

  await page.goto(`chrome-extension://${extensionId}/flows.html?env=${ENV}`);
  await page.click('#analyse');
  await expect(page.locator('tbody .grade')).toHaveCount(1);
  expect(await violations(page)).toEqual([]);

  await page.goto(`chrome-extension://${extensionId}/capture.html`);
  await expect(page.locator('#tokens .ok').first()).toBeVisible();
  expect(await violations(page)).toEqual([]);
});

const SITE = resolve(import.meta.dirname, '../../web/dist');
const TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
};

for (const scheme of ['light', 'dark'] as const) {
  test(`the project site (${scheme})`, async ({ context }) => {
    await context.route('https://site.test/**', (route) => {
      const path = new URL(route.request().url()).pathname;
      try {
        return route.fulfill({
          body: readFileSync(join(SITE, path)),
          contentType: TYPES[extname(path)] ?? 'application/octet-stream',
        });
      } catch {
        return route.fulfill({ status: 404, body: 'Not found' });
      }
    });
    const page = await context.newPage();
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto('https://site.test/index.html');
    await page.selectOption('#sample', 'before');
    await expect(page.locator('.finding').first()).toBeVisible();
    await page.locator('.finding summary').first().click();
    expect(await violations(page)).toEqual([]);
    for (const path of ['rules.html', 'privacy.html']) {
      await page.goto(`https://site.test/${path}`);
      expect(await violations(page)).toEqual([]);
    }
  });
}
