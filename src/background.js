'use strict';

importScripts('usage-format.js');

const BADGE_COLORS = { warn: '#e0a03d', danger: '#e05d4b' };
const BADGE_DEFAULT_COLOR = '#d97757';

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'GET_ORG_ID') return;

  chrome.cookies.get({ url: 'https://claude.ai', name: 'lastActiveOrg' }, (cookie) => {
    sendResponse({ orgId: cookie?.value ?? null });
  });
  return true;
});

async function activeSnapshot() {
  const { [UsageFormat.ACTIVE_ORG_KEY]: orgId } = await chrome.storage.local.get(UsageFormat.ACTIVE_ORG_KEY);
  if (!orgId) return null;

  const key = UsageFormat.snapshotKey(orgId);
  const { [key]: snapshot } = await chrome.storage.local.get(key);
  return snapshot ?? null;
}

async function updateBadge() {
  const current = UsageFormat.expire((await activeSnapshot())?.usage?.current);

  if (current?.pct == null) {
    await chrome.action.setBadgeText({ text: '' });
    return;
  }

  const pct = UsageFormat.clamp(Math.round(current.pct), 0, 100);
  await chrome.action.setBadgeText({ text: current.estimated ? '!' : String(pct) });
  await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLORS[UsageFormat.level(pct)] ?? BADGE_DEFAULT_COLOR });
  await chrome.action.setBadgeTextColor({ color: '#ffffff' });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (Object.keys(changes).some((key) => key === UsageFormat.ACTIVE_ORG_KEY || key.startsWith('usage:'))) {
    updateBadge().catch(() => {});
  }
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.remove(UsageFormat.LEGACY_SNAPSHOT_KEY).catch(() => {});
  updateBadge().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  updateBadge().catch(() => {});
});
