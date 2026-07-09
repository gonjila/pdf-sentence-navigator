// Background service worker.
// Responsible only for opening viewer.html — never touches PDF content
// itself and never talks to the network on its own.

const CONTEXT_MENU_ID = 'open-pdf-with-sentence-navigator';

function openViewer(query) {
  const url = chrome.runtime.getURL('viewer.html') + (query ? `?${query}` : '');
  chrome.tabs.create({ url });
}

// Toolbar icon click -> open an empty viewer where the user can pick a
// local PDF file or paste a PDF URL.
chrome.action.onClicked.addListener(() => {
  openViewer('');
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: CONTEXT_MENU_ID,
    title: 'PDF-ის გახსნა Sentence Navigator-ში',
    contexts: ['link'],
    targetUrlPatterns: ['*://*/*.pdf*', '*://*/*.PDF*'],
  });
});

// Right-click a link to a PDF -> open it directly in our viewer.
chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId === CONTEXT_MENU_ID && info.linkUrl) {
    openViewer(`url=${encodeURIComponent(info.linkUrl)}`);
  }
});
