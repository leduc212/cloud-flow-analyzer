// Content script, injected into a maker portal tab when the user asks to analyse a flow.
// It only draws the pane and moves the designer's canvas; it never sees the token.
import type { BackgroundMessage, ContentMessage } from '../shared/messages.ts';
import { Pane } from './pane.ts';

declare global {
  interface Window {
    cfaPane?: Pane;
  }
}

function send(message: BackgroundMessage): void {
  void chrome.runtime.sendMessage(message);
}

// The script can be injected more than once into the same page; set up only once.
if (!window.cfaPane) {
  window.cfaPane = new Pane(send);
  chrome.runtime.onMessage.addListener((message: ContentMessage) => {
    let pane = window.cfaPane;
    if (!pane) return;
    if (!pane.isAttached()) {
      // The user closed the pane earlier: start a fresh one.
      pane = window.cfaPane = new Pane(send);
    }
    if (message.type === 'cfa:loading') pane.showLoading(message.runs);
    else if (message.type === 'cfa:runs-progress')
      pane.showRunsProgress(message.done, message.total);
    else if (message.type === 'cfa:result') void pane.showResult(message.result);
    else if (message.type === 'cfa:error') pane.showError(message.message);
  });
}
