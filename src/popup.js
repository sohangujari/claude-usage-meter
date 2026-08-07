'use strict';

const { clamp, countdown, level, value: formatValue } = UsageFormat;

const STORAGE_KEY = 'usageSnapshot';
const COUNTDOWN_REFRESH_MS = 30000;
const REFRESH_TIMEOUT_MS = 4000;

const refreshButton = document.getElementById('refresh');
const refreshIcon = document.getElementById('refresh-icon');
const stalenessLabel = document.getElementById('staleness');

function renderBucket(bucket, data) {
  const pct = data ? clamp(Math.round(data.pct), 0, 100) : 0;
  const severity = data ? level(pct) : null;
  const remaining = data ? countdown(data.resetsAt) : null;

  const fill = document.getElementById(`${bucket}-fill`);
  fill.style.width = `${pct}%`;
  fill.classList.toggle('warn', severity === 'warn');
  fill.classList.toggle('danger', severity === 'danger');

  document.getElementById(`${bucket}-value`).textContent = data ? formatValue(data) : '—';
  document.getElementById(`${bucket}-reset`).textContent = remaining ? `Resets in ${remaining}` : '';
}

function formatAge(lastUpdated) {
  const minutes = Math.round((Date.now() - lastUpdated) / 60000);
  return minutes < 1 ? '· live' : `· ${minutes}m ago`;
}

async function render() {
  const { [STORAGE_KEY]: snapshot } = await chrome.storage.local.get(STORAGE_KEY);

  renderBucket('current', snapshot?.usage?.current);
  renderBucket('weekly', snapshot?.usage?.weekly);
  stalenessLabel.textContent = snapshot ? formatAge(snapshot.lastUpdated) : '· open claude.ai';
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
  if (changes[STORAGE_KEY]) render();
});

setInterval(render, COUNTDOWN_REFRESH_MS);
render();
