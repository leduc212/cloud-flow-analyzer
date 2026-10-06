import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { plainPage } from './designer.ts';
import { ENV, FLOW, TOKEN, expect, paneText, test } from './fixtures.ts';

const bad = JSON.parse(
  readFileSync(
    resolve(import.meta.dirname, '../../../fixtures/flows/sync-contacts-bad.json'),
    'utf8',
  ),
);

const PARENT = 'bbbbbbbb-1111-2222-3333-444444444444';
const at = (seconds: number) => new Date(Date.UTC(2026, 8, 24) + seconds * 1000).toISOString();

test('shows the run that started the run on the page', async ({ openPortal, mockApi, analyse }) => {
  await mockApi({
    [`/flows/${FLOW}`]: {
      ...bad,
      name: FLOW,
      properties: { ...bad.properties, workflowEntityId: 'wf-child' },
    },
    [`/flows/${FLOW}/runs/R1`]: {
      name: 'R1',
      properties: {
        status: 'Succeeded',
        startTime: at(10),
        endTime: at(15),
        correlation: { clientTrackingId: 'P1' },
        trigger: { name: 'manual', originHistoryName: 'R1' },
      },
    },
    [`/flows/${FLOW}/runs/R1/actions`]: { value: [] },
    '/environments/Default-11111111-2222-3333-4444-555555555555/flows': {
      value: [
        {
          name: PARENT,
          properties: {
            displayName: 'Read the mailbox',
            definitionSummary: { actions: [{ type: 'Workflow' }] },
          },
        },
      ],
    },
    [`/flows/${PARENT}`]: {
      name: PARENT,
      properties: {
        displayName: 'Read the mailbox',
        definition: {
          triggers: { manual: { type: 'Request', kind: 'Button', inputs: {} } },
          actions: {
            Sync_contacts: {
              type: 'Workflow',
              inputs: { host: { workflowReferenceName: 'WF-CHILD' } },
              runAfter: {},
            },
          },
        },
      },
    },
    [`/flows/${PARENT}/runs`]: {
      value: [
        {
          name: 'P1',
          properties: {
            status: 'Succeeded',
            startTime: at(0),
            endTime: at(60),
            correlation: { clientTrackingId: 'P1' },
            trigger: { name: 'manual', originHistoryName: 'P1' },
          },
        },
      ],
    },
  });
  const portal = await openPortal(
    plainPage('Run details', TOKEN),
    `/environments/${ENV}/flows/${FLOW}/runs/R1`,
  );
  await analyse(portal);

  await expect
    .poll(() => paneText(portal, '.links summary'), { timeout: 15_000 })
    .toBe('This run · Succeeded · 5.0 s');
  const parent = portal.locator('#cfa-pane-host .links a.run-link');
  await expect(parent).toHaveAttribute(
    'href',
    `https://make.powerautomate.com/environments/${ENV}/flows/${PARENT}/runs/P1`,
  );
  await expect(parent).toContainText('Read the mailbox');
  expect(await paneText(portal, '.links')).toContain('Called by Sync contacts in that flow.');
  expect(await paneText(portal, '.links')).toContain("This flow doesn't call any child flows.");
});
