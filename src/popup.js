'use strict';

const {
  ACTIVE_ORG_KEY,
  clamp,
  countdown,
  expire,
  level,
  pace,
  resetClock,
  snapshotKey,
  value: formatValue,
  WINDOW_MS,
} = UsageFormat;
const COUNTDOWN_REFRESH_MS = 30000;
const REFRESH_TIMEOUT_MS = 4000;

const refreshButton = document.getElementById('refresh');
const refreshIcon = document.getElementById('refresh-icon');
const stalenessLabel = document.getElementById('staleness');

function renderBucket(bucket, stored) {
  const data = expire(stored);
  const pct = data?.pct != null ? clamp(Math.round(data.pct), 0, 100) : 0;
  const severity = data?.pct != null ? level(pct) : null;
  const remaining = data ? countdown(data.resetsAt) : null;
  const paceLabel = data ? pace(data, WINDOW_MS[bucket]) : null;

  const fill = document.getElementById(`${bucket}-fill`);
  fill.style.width = `${pct}%`;
  fill.classList.toggle('warn', severity === 'warn');
  fill.classList.toggle('danger', severity === 'danger');

  const reset = document.getElementById(`${bucket}-reset`);
  const clock = data ? resetClock(data.resetsAt) : null;
  const resetNote = remaining && `Resets in ${remaining}${clock ? ` (${clock})` : ''}`;
  const notes = [resetNote, data?.label, paceLabel].filter(Boolean);
  reset.textContent = notes.join(' · ');
  reset.classList.toggle('alert', Boolean(paceLabel || data?.label));

  document.getElementById(`${bucket}-value`).textContent = data ? formatValue(data) : '—';
}

function formatAge(lastUpdated) {
  const minutes = Math.round((Date.now() - lastUpdated) / 60000);
  return minutes < 1 ? '· live' : `· ${minutes}m ago`;
}

async function render() {
  const { [ACTIVE_ORG_KEY]: orgId } = await chrome.storage.local.get(ACTIVE_ORG_KEY);
  const key = orgId ? snapshotKey(orgId) : null;
  const snapshot = key ? (await chrome.storage.local.get(key))[key] : null;

  renderBucket('current', snapshot?.usage?.current);
  renderBucket('weekly', snapshot?.usage?.weekly);

  if (snapshot?.unavailable) stalenessLabel.textContent = '· no usage data yet';
  else stalenessLabel.textContent = snapshot ? formatAge(snapshot.lastUpdated) : '· open claude.ai';
}

async function requestRefresh() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url?.startsWith('https://claude.ai/')) return;

  await Promise.race([
    chrome.tabs.sendMessage(tab.id, { type: 'REFRESH_USAGE' }).catch(() => null),
    new Promise((resolve) => setTimeout(resolve, REFRESH_TIMEOUT_MS)),
  ]);
}

refreshButton.addEventListener('click', async () => {
  refreshIcon.classList.add('spinning');
  refreshButton.disabled = true;

  try {
    await requestRefresh();
    await render();
  } finally {
    refreshIcon.classList.remove('spinning');
    refreshButton.disabled = false;
  }
});

chrome.storage.onChanged.addListener((changes) => {
  if (Object.keys(changes).some((key) => key === ACTIVE_ORG_KEY || key.startsWith('usage:'))) render();
});

setInterval(render, COUNTDOWN_REFRESH_MS);
render();
