'use strict';

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'GET_ORG_ID') return;

  chrome.cookies.get({ url: 'https://claude.ai', name: 'lastActiveOrg' }, (cookie) => {
    sendResponse({ orgId: cookie?.value ?? null });
  });
  return true;
});
