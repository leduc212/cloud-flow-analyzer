import './popup.css';
import { parseFlowUrl } from '../shared/flow-url.ts';
import type { BackgroundMessage } from '../shared/messages.ts';
import { isExpired, loadTokens } from '../shared/token.ts';

const status = document.getElementById('status') as HTMLParagraphElement;
const analyse = document.getElementById('analyse') as HTMLButtonElement;
const flowHint = document.getElementById('flow-hint') as HTMLParagraphElement;
const openCapture = document.getElementById('open-capture') as HTMLButtonElement;

function send(message: BackgroundMessage): void {
  void chrome.runtime.sendMessage(message);
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
      send({ type: 'cfa:analyse-tab', tabId });
      window.close();
    });
  } else {
    flowHint.textContent = 'Open a flow (its details page or the designer) to analyse it.';
  }
}

openCapture.addEventListener('click', () => {
  send({ type: 'cfa:open-capture' });
  window.close();
});

void init();
