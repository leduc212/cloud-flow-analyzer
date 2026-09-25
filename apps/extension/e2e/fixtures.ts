import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  chromium,
  test as base,
  type BrowserContext,
  type Page,
  type Worker,
} from '@playwright/test';

const EXTENSION = resolve(import.meta.dirname, '../dist');

/** Every Power Automate API host, with or without a region prefix. */
export const FLOW_API = /^https:\/\/([a-z0-9-]+\.)*api\.flow\.microsoft\.com\//;

export const ENV = 'Default-11111111-2222-3333-4444-555555555555';
export const FLOW = 'aaaaaaaa-1111-2222-3333-444444444444';

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
export const TOKEN = `${b64({ alg: 'none' })}.${b64({
  aud: 'https://service.flow.microsoft.com/',
  exp: Math.floor(Date.now() / 1000) + 3600,
  upn: 'jane@contoso.com',
})}.sig`;

interface Fixtures {
  context: BrowserContext;
  worker: Worker;
  extensionId: string;
  /** Opens a maker portal URL that serves the given HTML (and a mocked API). */
  openPortal: (html: string, path?: string) => Promise<Page>;
  /** Makes the extension's service worker answer API calls with these bodies (by path suffix). */
  mockApi: (routes: Record<string, unknown>) => Promise<void>;
  /** Asks the worker to analyse a portal tab, as the popup's button does. */
  analyse: (page: Page) => Promise<void>;
}

export const test = base.extend<Fixtures>({
  // Playwright requires an object pattern here, even an empty one.
  // eslint-disable-next-line no-empty-pattern
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext(
      mkdtempSync(join(tmpdir(), 'cfa-e2e-')),
      {
        channel: 'chromium',
        headless: true,
        viewport: { width: 1400, height: 900 },
        args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
      },
    );
    // The fake portal's own API call (for token capture) and extension pages' calls.
    await context.route(FLOW_API, (route) =>
      route.fulfill({
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' },
        body: '{"value":[]}',
      }),
    );
    await use(context);
    await context.close();
  },
  worker: async ({ context }, use) => {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    await worker.evaluate(() => true);
    await use(worker);
  },
  extensionId: async ({ worker }, use) => {
    await use(new URL(worker.url()).host);
  },
  openPortal: async ({ context, worker }, use) => {
    void worker;
    await use(async (html, path = `/environments/${ENV}/flows/${FLOW}/edit`) => {
      await context.route('https://make.powerautomate.com/**', (route) =>
        route.fulfill({ contentType: 'text/html', body: html }),
      );
      const page = await context.newPage();
      await page.goto(`https://make.powerautomate.com${path}`);
      // Wait until the extension has picked up the portal's token.
      await expectTokenCaptured(worker);
      return page;
    });
  },
  mockApi: async ({ worker }, use) => {
    // Playwright's routing doesn't reach an extension's service worker, so replace its fetch.
    await use(async (routes) => {
      await worker.evaluate((routes) => {
        const self = globalThis as unknown as { fetch: typeof fetch };
        self.fetch = async (input) => {
          const path = new URL(String(input)).pathname;
          const match = Object.entries(routes).find(([suffix]) => path.endsWith(suffix));
          return new Response(
            JSON.stringify(match ? match[1] : { error: { message: 'not mocked' } }),
            {
              status: match ? 200 : 404,
              headers: { 'content-type': 'application/json' },
            },
          );
        };
      }, routes);
    });
  },
  analyse: async ({ context, extensionId }, use) => {
    await use(async (portal) => {
      const helper = await context.newPage();
      await helper.goto(`chrome-extension://${extensionId}/popup.html`);
      await helper.evaluate(async () => {
        const [tab] = await chrome.tabs.query({ url: 'https://make.powerautomate.com/*' });
        await chrome.runtime.sendMessage({ type: 'cfa:analyse-tab', tabId: tab?.id });
      });
      await helper.close();
      await portal.bringToFront();
    });
  },
});

async function expectTokenCaptured(worker: Worker): Promise<void> {
  for (let i = 0; i < 50; i++) {
    const stored = await worker.evaluate(() => chrome.storage.session.get('token:flow'));
    if (stored['token:flow']) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('The extension did not capture the portal token.');
}

/** Text of an element inside the pane's shadow root. */
export function paneText(page: Page, selector: string): Promise<string> {
  return page.$eval(
    '#cfa-pane-host',
    (host, selector) => host.shadowRoot?.querySelector(selector)?.textContent ?? '',
    selector,
  );
}

/** Centre of a designer node on screen, or null when it isn't drawn. */
export function nodeCentre(page: Page, id: string): Promise<{ x: number; y: number } | null> {
  return page.evaluate((id) => {
    const node = document.querySelector(`[data-id="${id}"]`);
    if (!node) return null;
    const box = node.getBoundingClientRect();
    return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) };
  }, id);
}

/** Middle of the canvas area left of the pane (1400 × 900 window, 48 px header, 400 px pane). */
export const VISIBLE_CENTRE = { x: 500, y: 474 };

export { expect } from '@playwright/test';
