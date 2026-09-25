import { designerPage } from './designer.ts';
import { FLOW_API, TOKEN, expect, test } from './fixtures.ts';

test('popup shows the sign-in and offers the capture tool', async ({
  context,
  openPortal,
  extensionId,
}) => {
  await openPortal(designerPage([{ id: 'A' }], TOKEN));
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(popup.locator('#status')).toHaveText('Signed in as jane@contoso.com.');
  // Opened as a tab, its "current tab" is itself, which is not a flow.
  await expect(popup.locator('#analyse')).toBeDisabled();
  await expect(popup.locator('#open-capture')).toBeEnabled();
});

test('capture tool loads environments and flows through the captured token', async ({
  context,
  openPortal,
  extensionId,
}) => {
  await openPortal(designerPage([{ id: 'A' }], TOKEN));
  // Extension pages are covered by Playwright's routing (unlike the service worker).
  await context.route(FLOW_API, (route) => {
    const path = new URL(route.request().url()).pathname;
    const body = path.endsWith('/environments')
      ? { value: [{ name: 'Default-1', properties: { displayName: 'Contoso', isDefault: true } }] }
      : path.endsWith('/flows')
        ? { value: [{ name: 'flow-1', properties: { displayName: 'Sync', state: 'Started' } }] }
        : { error: { message: 'no' } };
    return route.fulfill({
      status: 'error' in body ? 403 : 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  });
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/capture.html`);
  await expect(page.locator('#tokens .ok').first()).toBeVisible();
  await page.click('#load-envs');
  await expect(page.locator('#env-status')).toHaveText('1 environment.');
  await page.click('#load-flows');
  await expect(page.locator('#flows-status')).toContainText('1 flow in total');
  await expect(page.locator('#flow-table tbody tr')).toHaveCount(1);
});
