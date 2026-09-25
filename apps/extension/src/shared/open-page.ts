/** Opens one of the extension's pages in a tab, or focuses it when it's already open. */
export async function openExtensionPage(page: string): Promise<void> {
  const url = chrome.runtime.getURL(page);
  const [open] = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.TAB],
    documentUrls: [url],
  });
  if (open && open.tabId >= 0) {
    await chrome.tabs.update(open.tabId, { active: true });
    if (open.windowId >= 0) await chrome.windows.update(open.windowId, { focused: true });
    return;
  }
  await chrome.tabs.create({ url });
}
