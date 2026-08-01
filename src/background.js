// ---- Org ID resolution via cookie ----
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'GET_ORG_ID') {
    chrome.cookies.get({ url: 'https://claude.ai', name: 'lastActiveOrg' }, (cookie) => {
      sendResponse({ orgId: cookie ? cookie.value : null });
    });
    return true; // async response
  }

  if (msg.type === 'SET_BADGE') {
    return;
  }
});