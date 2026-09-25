import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { resolve } from 'node:path';
import { designerPage, plainPage, type DesignerItem } from './designer.ts';
import {
  ENV,
  FLOW,
  TOKEN,
  VISIBLE_CENTRE,
  expect,
  nodeCentre,
  paneText,
  test,
} from './fixtures.ts';

const bad = JSON.parse(
  readFileSync(
    resolve(import.meta.dirname, '../../../fixtures/flows/sync-contacts-bad.json'),
    'utf8',
  ),
);

/** Waits until a click on a target has finished searching. */
async function settled(page: Page): Promise<string> {
  await expect
    .poll(() => paneText(page, '.toast'), { timeout: 30_000 })
    .not.toMatch(/^(Searching|Looking)/);
  return paneText(page, '.toast');
}

test('analyses the open flow and jumps to actions', async ({ openPortal, mockApi, analyse }) => {
  const items: DesignerItem[] = [
    { id: 'When_a_row_is_added,_modified_or_deleted' },
    { id: 'Initialize_emails' },
    { id: 'Initialize_count' },
    { id: 'List_accounts' },
    { id: 'Apply_to_each', container: true, collapsed: false },
    { id: 'Get_primary_contact', depth: 1, parent: 'Apply_to_each' },
    { id: 'Append_email', depth: 1, parent: 'Apply_to_each' },
    { id: 'Increment_count', depth: 1, parent: 'Apply_to_each' },
    { id: 'Update_account', depth: 1, parent: 'Apply_to_each' },
    { id: 'Send_summary' },
  ];
  await mockApi({ [`/flows/${FLOW}`]: bad });
  const portal = await openPortal(designerPage(items, TOKEN));
  await analyse(portal);

  await expect(portal.locator('#cfa-pane-host .finding').first()).toBeVisible({ timeout: 15_000 });
  expect(await paneText(portal, '.flow-name')).toBe('Sync account contacts (before)');
  expect(await portal.locator('#cfa-pane-host .finding .rule').allTextContents()).toContain(
    'Data read one item at a time inside a loop',
  );

  await portal.locator('#cfa-pane-host .target', { hasText: 'Get primary contact' }).click();
  expect(await settled(portal)).toBe('Showing "Get primary contact".');
  expect(await nodeCentre(portal, 'Get_primary_contact')).toEqual(VISIBLE_CENTRE);

  await portal.locator('#cfa-pane-host .target', { hasText: 'When a row is added' }).click();
  expect(await settled(portal)).toBe('Showing "When a row is added, modified or deleted".');
  expect(await nodeCentre(portal, 'When_a_row_is_added,_modified_or_deleted')).toEqual(
    VISIBLE_CENTRE,
  );
});

test('finds an undrawn action in collapsed containers and opens only what is needed', async ({
  openPortal,
  mockApi,
  analyse,
}) => {
  const SCOPE = 'Scope_-_Using_OCR_to_classify_and_extract_PO';
  const LOOP = 'Apply_to_each_-_Email_attachment_1';
  const CHILD = 'Create_Non-PO_4';
  const filler = Array.from({ length: 30 }, (_, i) => `Initialize_variable_${i + 1}`);
  const actions: Record<string, unknown> = {};
  filler.forEach((name, i) => {
    actions[name] = {
      type: 'InitializeVariable',
      runAfter: i ? { [filler[i - 1]!]: ['Succeeded'] } : {},
      inputs: { variables: [{ name: `v${i}`, type: 'string' }] },
    };
  });
  actions[SCOPE] = {
    type: 'Scope',
    runAfter: { [filler[29]!]: ['Succeeded'] },
    actions: {
      Compose_1: { type: 'Compose', runAfter: {}, inputs: 1 },
      [LOOP]: {
        type: 'Foreach',
        foreach: "@triggerBody()?['attachments']",
        runAfter: { Compose_1: ['Succeeded'] },
        actions: {
          [CHILD]: {
            type: 'Workflow',
            runAfter: {},
            inputs: { host: { workflowReferenceName: 'abc' }, body: {} },
          },
        },
      },
    },
  };
  const flow = {
    properties: {
      displayName: 'Read OCR outcome',
      definition: { triggers: { manual: { type: 'Request', inputs: {} } }, actions },
    },
  };
  const items: DesignerItem[] = [
    { id: 'manual' },
    ...filler.map((id) => ({ id })),
    { id: SCOPE, container: true, collapsed: true },
    { id: 'Compose_1', depth: 1, parent: SCOPE },
    { id: LOOP, depth: 1, parent: SCOPE, container: true, collapsed: true },
    { id: CHILD, depth: 2, parent: LOOP },
  ];
  await mockApi({ [`/flows/${FLOW}`]: flow });
  const portal = await openPortal(designerPage(items, TOKEN));
  await analyse(portal);
  await expect(portal.locator('#cfa-pane-host .finding').first()).toBeVisible({ timeout: 15_000 });

  expect(await nodeCentre(portal, CHILD)).toBeNull();
  await portal.locator('#cfa-pane-host .target', { hasText: 'Create Non-PO 4' }).click();
  expect(await settled(portal)).toBe(
    'Showing "Create Non-PO 4" (opened "Scope - Using OCR to classify and extract PO" › "Apply to each - Email attachment 1").',
  );
  expect(await nodeCentre(portal, CHILD)).toEqual(VISIBLE_CENTRE);
  expect(
    await portal.evaluate(() => (window as unknown as { toggleClicks: number }).toggleClicks),
  ).toBe(2);

  // A second click finds it open and clicks no toggles.
  await portal.locator('#cfa-pane-host .target', { hasText: 'Create Non-PO 4' }).click();
  expect(await settled(portal)).toBe('Showing "Create Non-PO 4".');
  expect(
    await portal.evaluate(() => (window as unknown as { toggleClicks: number }).toggleClicks),
  ).toBe(2);
});

test('dismisses findings, rescoring and remembering them, and copies a report', async ({
  context,
  openPortal,
  mockApi,
  analyse,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
    origin: 'https://make.powerautomate.com',
  });
  await mockApi({ [`/flows/${FLOW}`]: bad });
  const portal = await openPortal(designerPage([{ id: 'List_accounts' }], TOKEN));
  await analyse(portal);
  const findings = portal.locator('#cfa-pane-host .finding');
  await expect(findings.first()).toBeVisible({ timeout: 15_000 });
  const total = await findings.count();

  const rel02 = findings.filter({ hasText: 'No error handling' });
  await rel02.locator('.dismiss').click();
  await expect(findings).toHaveCount(total - 1);
  await expect(portal.locator('#cfa-pane-host .chip', { hasText: 'Dismissed 1' })).toBeVisible();

  // Analysing again keeps the dismissal.
  await analyse(portal);
  await expect(portal.locator('#cfa-pane-host .chip', { hasText: 'Dismissed 1' })).toBeVisible({
    timeout: 15_000,
  });
  await expect(findings).toHaveCount(total - 1);

  await portal.locator('#cfa-pane-host button[aria-label="Copy report"]').click();
  await expect.poll(() => paneText(portal, '.toast')).toBe('Report copied as Markdown.');
  const report = await portal.evaluate(() => navigator.clipboard.readText());
  expect(report).toContain('# Flow analysis: Sync account contacts (before)');
  expect(report).not.toContain('REL02');
});

test('reads recent runs, rescores with them and jumps to the busiest loop', async ({
  openPortal,
  mockApi,
  analyse,
}) => {
  const at = (seconds: number) => new Date(Date.UTC(2026, 0, 1) + seconds * 1000).toISOString();
  const step = (name: string, start: number, end: number) => ({
    name,
    properties: { status: 'Succeeded', startTime: at(start), endTime: at(end) },
  });
  const repetitions = {
    value: Array.from({ length: 12 }, (_, i) => ({
      properties: {
        repetitionIndexes: [{ scopeName: 'Apply_to_each', itemIndex: i }],
        status: 'Succeeded',
        startTime: at(1 + i * 0.5),
        endTime: at(1.2 + i * 0.5),
      },
    })),
  };
  await mockApi({
    [`/flows/${FLOW}`]: bad,
    '/runs': {
      value: [
        { name: 'r1', properties: { status: 'Succeeded', startTime: at(0), endTime: at(10) } },
      ],
    },
    '/runs/r1/actions': { value: [step('List_accounts', 0, 1), step('Apply_to_each', 1, 9)] },
    '/runs/r1/actions/Get_primary_contact/repetitions': repetitions,
    '/runs/r1/actions/Update_account/repetitions': repetitions,
  });
  const items: DesignerItem[] = [
    { id: 'When_a_row_is_added,_modified_or_deleted' },
    { id: 'List_accounts' },
    { id: 'Apply_to_each', container: true, collapsed: false },
    { id: 'Get_primary_contact', depth: 1, parent: 'Apply_to_each' },
    { id: 'Update_account', depth: 1, parent: 'Apply_to_each' },
  ];
  const portal = await openPortal(designerPage(items, TOKEN));
  await analyse(portal);
  await expect(portal.locator('#cfa-pane-host .finding').first()).toBeVisible({ timeout: 15_000 });

  await portal.locator('#cfa-pane-host .runs-button', { hasText: 'Analyse recent runs' }).click();
  await expect
    .poll(() => paneText(portal, '.runs summary'), { timeout: 15_000 })
    .toBe('Recent runs · 1 · median 10.0 s');
  expect(await paneText(portal, '.runs')).toContain('12 items (max 12)');
  const spd01 = portal.locator('#cfa-pane-host .finding', {
    hasText: 'Loop runs one item at a time',
  });
  await expect(spd01).toContainText(
    '"Apply to each" took 80% of the run time (8.0 s) over 12 items',
  );

  await portal
    .locator('#cfa-pane-host .runs .target', { hasText: 'Apply to each' })
    .first()
    .click();
  expect(await settled(portal)).toBe('Showing "Apply to each".');
  expect(await nodeCentre(portal, 'Apply_to_each-#scope')).toEqual(VISIBLE_CENTRE);
});

test('explains what to do when the flow page is not a flow', async ({ openPortal, analyse }) => {
  const portal = await openPortal(plainPage('Flows list', TOKEN), `/environments/${ENV}/flows`);
  await analyse(portal);
  await expect
    .poll(() => paneText(portal, '.state.error'), { timeout: 15_000 })
    .toContain('Open a flow first');
});
