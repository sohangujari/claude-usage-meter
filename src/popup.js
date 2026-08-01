const SNAPSHOT_KEY = 'cum_snapshot';

function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }

// Tiered countdown, identical logic to content.js:
// >=24h -> "6d 8h", >=1h -> "12h 30m", else -> "10m"
function formatCountdown(resetsAt) {
  if (!resetsAt) return null;
  const target = new Date(resetsAt);
  const targetMs = target.getTime();
  if (isNaN(targetMs)) return null;

  const diffMs = targetMs - Date.now();
  if (diffMs <= 0) return 'soon';

  const totalMinutes = Math.floor(diffMs / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;

  if (days >= 1) return `${days}d ${hours}h`;
  if (hours >= 1) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function renderBucket(prefix, data) {
  const valueEl = document.getElementById(`${prefix}-value`);
  const fillEl = document.getElementById(`${prefix}-fill`);
  const resetEl = document.getElementById(`${prefix}-reset`);

  if (!data) {
    valueEl.textContent = '-';
    fillEl.style.width = '0%';
    resetEl.textContent = '';
    return;
  }

  const pct = Math.round(data.pct);
  valueEl.textContent = data.used != null && data.limit != null
    ? `${data.used}/${data.limit} (${pct}%)`
    : `${pct}%`;
  fillEl.style.width = `${clamp(pct, 0, 100)}%`;
  fillEl.classList.toggle('warn', pct >= 75 && pct < 90);
  fillEl.classList.toggle('danger', pct >= 90);

  // Reset time is a fixed schedule - show it for BOTH buckets whenever known,
  // regardless of usage percentage.
  const cd = formatCountdown(data.resetsAt);
  resetEl.textContent = cd ? `Resets in ${cd}` : '';
}

function renderFromCache() {
  chrome.storage.local.get([SNAPSHOT_KEY], (res) => {
    const snap = res[SNAPSHOT_KEY];
    if (!snap || !snap.usage) return;
    renderBucket('current', snap.usage.current);
    renderBucket('weekly', snap.usage.weekly);
    const ageMin = Math.round((Date.now() - snap.lastUpdated) / 60000);
    document.getElementById('staleness').textContent = ageMin < 1 ? '· live' : `· ${ageMin}m ago`;
  });
}

chrome.storage.onChanged.addListener((changes) => {
  if (changes[SNAPSHOT_KEY]) renderFromCache();
});

// countdown ticks locally without any network calls
setInterval(renderFromCache, 30000);

// ---- refresh icon + spinner ----
const refreshBtn = document.getElementById('refresh');
const refreshIcon = document.getElementById('refresh-icon');

function startSpin() {
  refreshIcon.classList.add('spinning');
  refreshBtn.disabled = true;
}
function stopSpin() {
  refreshIcon.classList.remove('spinning');
  refreshBtn.disabled = false;
}

refreshBtn.addEventListener('click', () => {
  startSpin();
  const safetyTimeout = setTimeout(stopSpin, 4000);

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (!tab || !tab.url || !tab.url.includes('claude.ai')) {
      clearTimeout(safetyTimeout);
      stopSpin();
      return;
    }
    chrome.tabs.sendMessage(tab.id, { type: 'CUM_FORCE_REFRESH' }, () => {
      void chrome.runtime.lastError;
      clearTimeout(safetyTimeout);
      renderFromCache();
      stopSpin();
    });
  });
});

renderFromCache();