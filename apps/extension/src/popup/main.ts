import './popup.css';
import { parseEnvironment, parseFlowUrl } from '../shared/flow-url.ts';
import type { BackgroundMessage } from '../shared/messages.ts';
import { isExpired, loadTokens } from '../shared/token.ts';

const status = document.getElementById('status') as HTMLParagraphElement;
const analyse = document.getElementById('analyse') as HTMLButtonElement;
const flowHint = document.getElementById('flow-hint') as HTMLParagraphElement;
const openCapture = document.getElementById('open-capture') as HTMLButtonElement;
const allFlows = document.getElementById('all-flows') as HTMLButtonElement;

/** Sends a message to the worker, then closes the popup (closing first can lose the message). */
async function sendAndClose(message: BackgroundMessage): Promise<void> {
  try {
    await chrome.runtime.sendMessage(message);
  } catch {
    // No reply is expected; the worker got the message.
  }
  window.close();
}

async function init(): Promise<void> {
  const [tokens, [tab]] = await Promise.all([
    loadTokens(),
    chrome.tabs.query({ active: true, currentWindow: true }),
  ]);

  const token = tokens.flow ?? tokens.powerplatform;
  if (!token) {
    status.textContent = 'Not signed in yet. Open make.powerautomate.com and sign in.';
    status.className = 'status warn';
  } else if (isExpired(token)) {
    status.textContent = 'Your sign-in has expired. Refresh the Power Automate tab.';
    status.className = 'status warn';
  } else {
    status.textContent = `Signed in${token.account ? ` as ${token.account}` : ''}.`;
    status.className = 'status ok';
  }

  // The tab URL is only visible on the maker portals (host permission), which is all we need.
  const ref = parseFlowUrl(tab?.url);
  if (tab?.id !== undefined && ref) {
    const tabId = tab.id;
    analyse.disabled = false;
    flowHint.textContent = 'Shows the findings in a pane next to the designer.';
    analyse.addEventListener('click', () => {
      void sendAndClose({ type: 'cfa:analyse-tab', tabId });
    });
  } else {
    flowHint.textContent = 'Open a flow (its details page or the designer) to analyse it.';
  }

  const environment = parseEnvironment(tab?.url);
  allFlows.addEventListener('click', () => {
    void sendAndClose({ type: 'cfa:open-flows', ...(environment ? { environment } : {}) });
  });
}

openCapture.addEventListener('click', () => {
  void sendAndClose({ type: 'cfa:open-capture' });
});

void init();
