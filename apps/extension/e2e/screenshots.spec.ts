import { mkdirSync, readFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { designerPage, type DesignerItem } from './designer.ts';
import { ENV, FLOW, FLOW_API, TOKEN, expect, paneText, test } from './fixtures.ts';

// Refreshes the README images in docs/images: SCREENSHOTS=1 pnpm test:e2e screenshots
test.skip(!process.env.SCREENSHOTS, 'Set SCREENSHOTS=1 to refresh docs/images.');

const OUT = resolve(import.meta.dirname, '../../../docs/images');
const fixture = (name: string) =>
  JSON.parse(
    readFileSync(resolve(import.meta.dirname, `../../../fixtures/flows/${name}.json`), 'utf8'),
  );
const bad = fixture('sync-contacts-bad');
const good = fixture('sync-contacts-good');

test.beforeAll(() => mkdirSync(OUT, { recursive: true }));

test('pane: findings, then recent runs', async ({ openPortal, mockApi, analyse }) => {
  const start = Date.now() - 3_600_000;
  const at = (seconds: number) => new Date(start + seconds * 1000).toISOString();
  const step = (name: string, from: number, to: number) => ({
    name,
    properties: { status: 'Succeeded', startTime: at(from), endTime: at(to) },
  });
  const repetitions = {
    value: Array.from({ length: 40 }, (_, i) => ({
      properties: {
        repetitionIndexes: [{ scopeName: 'Apply_to_each', itemIndex: i }],
        status: 'Succeeded',
        startTime: at(2 + i * 0.4),
        endTime: at(2.3 + i * 0.4),
      },
    })),
  };
  await mockApi({
    [`/flows/${FLOW}`]: bad,
    '/runs': {
      value: [
        { name: 'r1', properties: { status: 'Succeeded', startTime: at(0), endTime: at(20) } },
      ],
    },
    '/runs/r1/actions': { value: [step('List_accounts', 0, 2), step('Apply_to_each', 2, 18)] },
    '/runs/r1/actions/Get_primary_contact/repetitions': repetitions,
    '/runs/r1/actions/Update_account/repetitions': repetitions,
  });
  const items: DesignerItem[] = [
    'When_a_row_is_added,_modified_or_deleted',
    'Initialize_emails',
    'Initialize_count',
    'List_accounts',
    'Apply_to_each',
    'Send_summary',
  ].map((id) => ({ id }));
  const portal = await openPortal(designerPage(items, TOKEN));
  await analyse(portal);
  await expect(portal.locator('#cfa-pane-host .finding').first()).toBeVisible({ timeout: 15_000 });
  await portal.locator('#cfa-pane-host .finding summary').nth(1).click();
  await portal.screenshot({ path: join(OUT, 'pane.png') });

  await portal.locator('#cfa-pane-host .runs-button', { hasText: 'Analyse recent runs' }).click();
  await expect
    .poll(() => paneText(portal, '.runs summary'), { timeout: 15_000 })
    .toContain('Recent runs');
  await portal.screenshot({ path: join(OUT, 'pane-runs.png') });
});

test('All flows page', async ({ context, openPortal, extensionId }) => {
  await openPortal(designerPage([{ id: 'A' }], TOKEN));
  const summary = (name: string, displayName: string, trigger: object) => ({
    name,
    properties: {
      displayName,
      state: 'Started',
      lastModifiedTime: '2026-09-20T00:00:00Z',
      definitionSummary: { triggers: [trigger] },
    },
  });
  await context.route(FLOW_API, (route) => {
    const path = decodeURIComponent(new URL(route.request().url()).pathname);
    const body = path.endsWith('/environments')
      ? { value: [{ name: ENV, properties: { displayName: 'Contoso Dev', isDefault: true } }] }
      : path.endsWith(`/environments/${ENV}/flows`)
        ? {
            value: [
              summary(FLOW, 'Sync account contacts', {
                type: 'OpenApiConnectionWebhook',
                swaggerOperationId: 'SubscribeWebhookTrigger',
                api: { name: 'shared_commondataserviceforapps' },
              }),
              summary('tidy', 'Sync account contacts (fixed)', { type: 'Recurrence' }),
              summary('orders', 'Poll open orders', { type: 'Recurrence' }),
            ],
          }
        : path.endsWith(`/flows/${FLOW}`)
          ? bad
          : path.endsWith('/flows/tidy')
            ? good
            : path.endsWith('/flows/orders')
              ? fixture('poll-orders-clientdata')
              : undefined;
    return route.fulfill({
      status: body ? 200 : 403,
      contentType: 'application/json',
      body: JSON.stringify(body ?? { error: { message: 'no' } }),
    });
  });
  const page = await context.newPage();
  await page.setViewportSize({ width: 1280, height: 560 });
  await page.goto(`chrome-extension://${extensionId}/flows.html?env=${ENV}`);
  await page.click('#analyse');
  await expect(page.locator('tbody .grade')).toHaveCount(3);
  await page.screenshot({ path: join(OUT, 'all-flows.png') });
});

test('project site', async ({ context }) => {
  const site = resolve(import.meta.dirname, '../../web/dist');
  const types: Record<string, string> = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.png': 'image/png',
  };
  await context.route('https://site.test/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    return route.fulfill({
      body: readFileSync(join(site, path)),
      contentType: types[extname(path)] ?? 'application/octet-stream',
    });
  });
  const page = await context.newPage();
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('https://site.test/index.html');
  await page.selectOption('#sample', 'before');
  await expect(page.locator('.finding').first()).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: join(OUT, 'site.png') });
});
