(function () {
  'use strict';

  const { clamp, countdown, level, value: formatValue } = UsageFormat;

  const LOG_PREFIX = '[Claude Usage Meter]';
  const STORAGE_KEY = 'usageSnapshot';
  const SNIFFER_EVENT = '__claude_usage_meter__';
  const BAR_ID = 'cu-usage-bar';

  const POLL_INTERVAL_MS = 20000;
  const MIN_POLL_GAP_MS = 5000;
  const RENDER_INTERVAL_MS = 1000;
  const ORG_ID_RETRY_MS = 2000;
  const ORG_ID_ATTEMPTS = 8;
  const POST_TURN_POLL_DELAY_MS = 1500;

  const BUCKET_KEYS = {
    current: ['five_hour', 'fiveHour', 'session'],
    weekly: ['seven_day', 'sevenDay', 'weekly'],
  };
  const RESET_KEYS = ['resets_at', 'resetsAt', 'resets_in_seconds', 'resetsInSeconds'];

  const state = { orgId: null, usage: null, lastPollAt: 0 };
  const timers = [];
  const unload = new AbortController();
  let alive = true;

  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // ---------------------------------------------------------------- lifecycle

  function isAlive() {
    if (!alive) return false;
    try {
      return Boolean(chrome.runtime?.id);
    } catch {
      return false;
    }
  }

  function teardown() {
    if (!alive) return;
    alive = false;
    timers.forEach(clearInterval);
    unload.abort();
    window.removeEventListener('message', onSnifferMessage);
    document.removeEventListener('visibilitychange', pollIfVisible);
  }

  function interval(fn, ms) {
    const id = setInterval(() => (isAlive() ? fn() : teardown()), ms);
    timers.push(id);
  }

  // ------------------------------------------------------------ chrome access

  function sendMessage(message) {
    if (!isAlive()) return Promise.resolve(null);
    try {
      return chrome.runtime.sendMessage(message).catch(() => null);
    } catch {
      teardown();
      return Promise.resolve(null);
    }
  }

  function readSnapshot() {
    if (!isAlive()) return Promise.resolve(null);
    try {
      return chrome.storage.local
        .get(STORAGE_KEY)
        .then((stored) => stored[STORAGE_KEY] ?? null)
        .catch(() => null);
    } catch {
      teardown();
      return Promise.resolve(null);
    }
  }

  function writeSnapshot(snapshot) {
    if (!isAlive()) return;
    try {
      chrome.storage.local.set({ [STORAGE_KEY]: snapshot }).catch(() => {});
    } catch {
      teardown();
    }
  }

  // -------------------------------------------------------------- usage feeds

  function injectSniffer() {
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('src/injected.js');
    script.onload = () => script.remove();
    (document.head ?? document.documentElement).appendChild(script);
  }

  async function resolveOrgId() {
    for (let attempt = 0; attempt < ORG_ID_ATTEMPTS; attempt++) {
      const response = await sendMessage({ type: 'GET_ORG_ID' });
      if (response?.orgId) return response.orgId;

      const cookie = document.cookie.match(/lastActiveOrg=([a-f0-9-]{36})/i);
      if (cookie) return cookie[1];

      await delay(ORG_ID_RETRY_MS);
      if (!isAlive()) break;
    }
    return null;
  }

  function setOrgId(orgId) {
    if (!orgId || orgId === state.orgId) return;
    state.orgId = orgId;
    pollUsage({ force: true });
  }

  async function pollUsage({ force = false } = {}) {
    if (!isAlive() || !state.orgId) return;

    const now = Date.now();
    if (!force && now - state.lastPollAt < MIN_POLL_GAP_MS) return;
    state.lastPollAt = now;

    try {
      const response = await fetch(`https://claude.ai/api/organizations/${state.orgId}/usage`, {
        credentials: 'include',
        signal: unload.signal,
      });

      if (!response.ok) {
        console.warn(`${LOG_PREFIX} usage request returned ${response.status}`);
        return;
      }
      applyUsage(await response.json());
    } catch (error) {
      if (error.name !== 'AbortError') console.warn(`${LOG_PREFIX} usage request failed`, error);
    }
  }

  function onSnifferMessage(event) {
    if (event.source !== window || event.data?.type !== SNIFFER_EVENT) return;

    const { channel, payload } = event.data;
    if (channel === 'orgId') setOrgId(payload);
    else if (channel === 'usage') applyUsage(payload);
    else if (channel === 'messageLimit') applyMessageLimit(payload);
  }

  function pollIfVisible() {
    if (document.visibilityState === 'visible') pollUsage();
  }

  // ------------------------------------------------------------ normalisation

  function pick(source, keys) {
    for (const key of keys) {
      if (source?.[key] != null) return source[key];
    }
    return null;
  }

  function parseResetTime(raw) {
    const value = typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? Number(raw) : raw;
    if (value == null) return null;

    if (typeof value === 'number') {
      if (value > 1e12) return new Date(value); // epoch milliseconds
      if (value > 1e9) return new Date(value * 1000); // epoch seconds
      return new Date(Date.now() + value * 1000); // seconds from now
    }

    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  // `utilization` arrives as a whole-number percentage. A value below 1 with a
  // fractional part is the only reliable signal that it is a 0-1 ratio instead.
  function toPercent(utilization) {
    return !Number.isInteger(utilization) && utilization > 0 && utilization < 1
      ? utilization * 100
      : utilization;
  }

  function toBucket(node, previous) {
    if (!node || typeof node !== 'object') return null;

    const resetsAt = parseResetTime(pick(node, RESET_KEYS)) ?? previous?.resetsAt ?? null;
    const limit = typeof node.limit === 'number' ? node.limit : null;

    let used = typeof node.used === 'number' ? node.used : null;
    if (used == null && limit != null && typeof node.remaining === 'number') {
      used = limit - node.remaining;
    }

    if (used != null && limit != null) {
      return {
        used,
        limit,
        remaining: limit - used,
        pct: limit > 0 ? clamp((used / limit) * 100, 0, 100) : 0,
        resetsAt,
      };
    }

    if (typeof node.utilization === 'number') {
      const pct = clamp(toPercent(node.utilization), 0, 100);
      return { used: null, limit: null, remaining: null, pct, resetsAt };
    }

    return null;
  }

  function reviveResetDates(usage) {
    for (const bucket of Object.values(usage)) {
      if (bucket?.resetsAt) bucket.resetsAt = parseResetTime(bucket.resetsAt);
    }
    return usage;
  }

  function applyUsage(payload) {
    if (!payload || typeof payload !== 'object') return;

    const current = toBucket(pick(payload, BUCKET_KEYS.current), state.usage?.current);
    const weekly = toBucket(pick(payload, BUCKET_KEYS.weekly), state.usage?.weekly);

    if (!current && !weekly) {
      console.warn(`${LOG_PREFIX} unrecognised usage payload`, payload);
      return;
    }

    setUsage({
      current: current ?? state.usage?.current ?? null,
      weekly: weekly ?? state.usage?.weekly ?? null,
    });
  }

  function applyMessageLimit(payload) {
    const current = toBucket(payload, state.usage?.current);
    if (!current) return;

    setUsage({ current, weekly: state.usage?.weekly ?? null });
    setTimeout(() => pollUsage({ force: true }), POST_TURN_POLL_DELAY_MS);
  }

  function setUsage(usage) {
    state.usage = usage;
    writeSnapshot({ usage, lastUpdated: Date.now() });
    render();
  }

  // ------------------------------------------------------------------ the bar

  const METERS = [
    { bucket: 'current', label: 'Session' },
    { bucket: 'weekly', label: 'Weekly' },
  ];

  let bar = null;

  function findComposerRoot() {
    const chatInput = document.querySelector('[data-testid="chat-input"]');
    if (!chatInput) return null;

    const modelSelector = document.querySelector('[data-testid="model-selector-dropdown"]');
    if (modelSelector) {
      const ancestors = new Set();
      for (let node = chatInput; node; node = node.parentElement) ancestors.add(node);
      for (let node = modelSelector; node; node = node.parentElement) {
        if (ancestors.has(node)) return node;
      }
    }
    return chatInput.parentElement?.parentElement?.parentElement ?? chatInput.parentElement;
  }

  function createBar() {
    const element = document.createElement('div');
    element.id = BAR_ID;
    element.innerHTML = METERS.map(
      ({ bucket, label }) => `
        <div class="cu-meter" data-bucket="${bucket}">
          <div class="cu-meter-head">
            <span class="cu-meter-label">${label}</span>
            <span class="cu-meter-value">—</span>
          </div>
          <div class="cu-track"><div class="cu-fill"></div></div>
          <div class="cu-reset"></div>
        </div>`,
    ).join('<div class="cu-divider"></div>');
    return element;
  }

  function attachBar() {
    const root = findComposerRoot();
    if (!root) return;

    bar ??= createBar();
    if (bar.parentElement !== root) root.appendChild(bar);
  }

  function renderBucket(bucket, data) {
    const meter = bar.querySelector(`.cu-meter[data-bucket="${bucket}"]`);
    if (!meter) return;

    const pct = data ? clamp(Math.round(data.pct), 0, 100) : 0;
    const severity = data ? level(pct) : null;
    const remaining = data ? countdown(data.resetsAt) : null;

    const fill = meter.querySelector('.cu-fill');
    fill.style.width = `${pct}%`;
    fill.classList.toggle('cu-fill--warn', severity === 'warn');
    fill.classList.toggle('cu-fill--danger', severity === 'danger');

    meter.querySelector('.cu-meter-value').textContent = data ? formatValue(data) : '—';
    meter.querySelector('.cu-reset').textContent = remaining ? `Resets in ${remaining}` : '';
  }

  function render() {
    attachBar();
    if (!bar) return;

    renderBucket('current', state.usage?.current);
    renderBucket('weekly', state.usage?.weekly);
  }

  // ------------------------------------------------------------------- start

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== 'REFRESH_USAGE') return;
    pollUsage({ force: true }).then(() => sendResponse({ ok: true }));
    return true;
  });

  window.addEventListener('message', onSnifferMessage);
  document.addEventListener('visibilitychange', pollIfVisible);
  window.addEventListener('pagehide', (event) => {
    // A persisted pagehide is a bfcache entry: the page may come back running.
    if (!event.persisted) teardown();
  });

  interval(pollIfVisible, POLL_INTERVAL_MS);
  interval(render, RENDER_INTERVAL_MS);

  injectSniffer();

  (async () => {
    const snapshot = await readSnapshot();
    if (snapshot?.usage) {
      state.usage = reviveResetDates(snapshot.usage);
      render();
    }
    setOrgId(await resolveOrgId());
  })();
})();
