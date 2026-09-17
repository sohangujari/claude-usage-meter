(function () {
  'use strict';

  const { clamp, countdown, level, pace, value: formatValue, WINDOW_MS } = UsageFormat;

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
  const COMPOSER_CONTAINERS = [
    '[data-cds="ChatComposer"]',
    'fieldset[data-perf-region="composer"]',
    '[data-chat-input-container="true"]',
  ];
  const COMPOSER_CLIMB_LIMIT = 6;
  const COMPOSER_WIDTH_TOLERANCE = 1.5;
  const ANCHOR_WARN_DELAY_MS = 30000;

  const BUCKET_KEYS = {
    current: ['five_hour', 'fiveHour', 'session'],
    weekly: ['seven_day', 'sevenDay', 'weekly'],
  };
  const LIMIT_GROUPS = { current: 'session', weekly: 'weekly' };
  const SSE_WINDOW_KEYS = {
    current: ['5h', 'five_hour', 'fiveHour'],
    weekly: ['7d', 'seven_day', 'sevenDay'],
  };

  const RESET_KEYS = ['resets_at', 'resetsAt', 'resets_in_seconds', 'resetsInSeconds'];

  const LIMIT_STATES = {
    within_limit: { pct: null, label: null },
    approaching_limit: { pct: UsageFormat.WARN_PCT, estimated: true, label: 'approaching limit' },
    exceeded_limit: { pct: 100, label: 'limit reached' },
  };

  const state = { orgId: null, usage: null, unavailable: false, lastPollAt: 0 };
  const timers = [];
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
      chrome.storage.local.set({ [STORAGE_KEY]: JSON.parse(JSON.stringify(snapshot)) }).catch(() => {});
    } catch {
      teardown();
    }
  }

  // -------------------------------------------------------------- usage feeds

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

  function pollUsage({ force = false } = {}) {
    if (!isAlive() || !state.orgId) return;

    const now = Date.now();
    if (!force && now - state.lastPollAt < MIN_POLL_GAP_MS) return;
    state.lastPollAt = now;

    window.postMessage(
      { type: SNIFFER_EVENT, channel: 'fetchUsage', payload: state.orgId },
      window.location.origin,
    );
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

  function toBucket(node, previous) {
    if (!node || typeof node !== 'object') return null;

    const ownReset = parseResetTime(pick(node, RESET_KEYS));
    const resetsAt = ownReset ?? previous?.resetsAt ?? null;
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

    const percent = typeof node.utilization === 'number' ? node.utilization : node.percent;
    if (typeof percent === 'number') {
      const pct = clamp(percent, 0, 100);
      return { used: null, limit: null, remaining: null, pct, resetsAt };
    }

    const limitState = LIMIT_STATES[node.type];
    if (limitState) {
      return { used: null, limit: null, remaining: null, ...limitState, resetsAt };
    }

    if (ownReset) {
      return { used: null, limit: null, remaining: null, pct: 0, resetsAt: ownReset };
    }

    return null;
  }

  function reviveResetDates(usage) {
    for (const bucket of Object.values(usage)) {
      if (bucket?.resetsAt) bucket.resetsAt = parseResetTime(bucket.resetsAt);
    }
    return usage;
  }

  function limitEntry(payload, group) {
    if (!Array.isArray(payload.limits)) return null;
    return payload.limits.find((entry) => entry?.group === group) ?? null;
  }

  function bucketFor(payload, name) {
    const previous = state.usage?.[name];
    return (
      toBucket(pick(payload, BUCKET_KEYS[name]), previous) ??
      toBucket(limitEntry(payload, LIMIT_GROUPS[name]), previous)
    );
  }

  let emptyPayloadWarned = false;
  let hydrated = false;

  function applyUsage(payload) {
    if (!payload || typeof payload !== 'object') return;

    const current = bucketFor(payload, 'current');
    const weekly = bucketFor(payload, 'weekly');

    if (!current && !weekly) {
      if (Array.isArray(payload.limits) || 'five_hour' in payload) {
        setUnavailable();
        return;
      }
      if (!emptyPayloadWarned) {
        emptyPayloadWarned = true;
        const seen = { five_hour: payload.five_hour, seven_day: payload.seven_day, limits: payload.limits };
        console.warn(`${LOG_PREFIX} unrecognised payload for org ${state.orgId}:`, JSON.stringify(seen).slice(0, 400));
      }
      return;
    }

    setUsage({
      current: current ?? state.usage?.current ?? null,
      weekly: weekly ?? state.usage?.weekly ?? null,
    });
  }

  function windowBucket(node) {
    if (typeof node?.utilization !== 'number') return null;
    const { utilization } = node;
    return {
      used: null,
      limit: null,
      remaining: null,
      pct: clamp(utilization > 1 ? utilization : utilization * 100, 0, 100),
      resetsAt: parseResetTime(pick(node, RESET_KEYS)),
    };
  }

  function applyMessageLimit(payload) {
    if (!payload || typeof payload !== 'object') return;

    const windows = payload.windows;
    const current =
      windowBucket(pick(windows, SSE_WINDOW_KEYS.current)) ?? toBucket(payload, state.usage?.current);
    const weekly = windowBucket(pick(windows, SSE_WINDOW_KEYS.weekly));
    if (!current && !weekly) return;

    setUsage({
      current: current ?? state.usage?.current ?? null,
      weekly: weekly ?? state.usage?.weekly ?? null,
    });
    setTimeout(() => pollUsage({ force: true }), POST_TURN_POLL_DELAY_MS);
  }

  function mergeBucket(next, previous) {
    if (!next) return previous ?? null;
    if (next.resetsAt || !previous?.resetsAt) return next;
    return { ...next, resetsAt: previous.resetsAt };
  }

  function setUsage(usage) {
    state.usage = {
      current: mergeBucket(usage.current, state.usage?.current),
      weekly: mergeBucket(usage.weekly, state.usage?.weekly),
    };
    state.unavailable = false;
    writeSnapshot({ usage: state.usage, lastUpdated: Date.now() });
    render();
  }

  function setUnavailable() {
    if (!hydrated || state.unavailable || state.usage) return;
    state.usage = null;
    state.unavailable = true;
    writeSnapshot({ usage: null, unavailable: true, lastUpdated: Date.now() });
    render();
  }

  // ------------------------------------------------------------------ the bar

  const METERS = [
    { bucket: 'current', label: 'Session' },
    { bucket: 'weekly', label: 'Weekly' },
  ];

  let bar = null;

  function findComposerInput() {
    const tagged = document.querySelector('[data-testid="chat-input"]');
    if (tagged) return tagged;

    const editable = document.querySelectorAll('div[contenteditable="true"]');
    return editable[editable.length - 1] ?? null;
  }

  function clips(element) {
    const style = getComputedStyle(element);
    return style.overflow !== 'visible' || style.clipPath !== 'none';
  }

  function unclipped(element) {
    for (let node = element; node && node !== document.body; node = node.parentElement) {
      if (!clips(node)) return node;
    }
    return null;
  }

  function widestSameWidthAncestor(node) {
    for (let hops = 0; hops < COMPOSER_CLIMB_LIMIT; hops++) {
      const parent = node.parentElement;
      if (!parent || parent === document.body) break;
      if (parent.offsetWidth > node.offsetWidth * COMPOSER_WIDTH_TOLERANCE) break;
      node = parent;
    }
    return node;
  }

  function findComposerRoot() {
    const chatInput = findComposerInput();
    if (!chatInput) return null;

    for (const selector of COMPOSER_CONTAINERS) {
      const container = chatInput.closest(selector);
      if (container && !clips(container)) return container;
    }

    const modelSelector = document.querySelector('[data-testid="model-selector-dropdown"]');
    if (modelSelector) {
      const ancestors = new Set();
      for (let node = chatInput; node; node = node.parentElement) ancestors.add(node);
      for (let node = modelSelector; node; node = node.parentElement) {
        if (ancestors.has(node)) return unclipped(node);
      }
    }
    return unclipped(widestSameWidthAncestor(chatInput));
  }

  function createBar() {
    const element = document.createElement('div');
    element.id = BAR_ID;
    element.innerHTML = METERS.map(
      ({ bucket, label }) => `
        <div class="cu-meter" data-bucket="${bucket}">
          <span class="cu-meter-label">${label}</span>
          <div class="cu-track" role="progressbar" aria-label="${label} usage" aria-valuemin="0" aria-valuemax="100"><div class="cu-fill"></div></div>
          <span class="cu-meter-meta">
            <span class="cu-meter-value">—</span>
            <span class="cu-reset"></span>
          </span>
        </div>`,
    ).join('');
    return element;
  }

  const startedAt = Date.now();
  let anchorWarned = false;

  function backdropColor(element) {
    for (let node = element; node && node !== document.documentElement; node = node.parentElement) {
      const color = getComputedStyle(node).backgroundColor;
      if (color && !/^transparent$|,\s*0\)$|\/\s*0\)$/.test(color)) return color;
    }
    return getComputedStyle(document.body).backgroundColor || '';
  }

  function attachBar() {
    if (bar?.isConnected && bar.parentElement?.contains(findComposerInput())) return;

    const root = findComposerRoot();
    if (!root) {
      if (!anchorWarned && Date.now() - startedAt > ANCHOR_WARN_DELAY_MS) {
        anchorWarned = true;
        console.warn(`${LOG_PREFIX} no composer found - claude.ai's markup may have changed`);
      }
      return;
    }

    bar ??= createBar();
    if (bar.parentElement !== root) root.appendChild(bar);
  }

  function renderBucket(bucket, data) {
    const meter = bar.querySelector(`.cu-meter[data-bucket="${bucket}"]`);
    if (!meter) return;

    meter.hidden = Boolean(state.usage) && !data;
    if (meter.hidden) return;

    if (!data) {
      meter.querySelector('.cu-meter-value').textContent = '—';
      meter.querySelector('.cu-fill').style.width = '0%';
      meter.querySelector('.cu-reset').textContent = '';
      return;
    }

    const pct = data.pct != null ? clamp(Math.round(data.pct), 0, 100) : 0;
    const severity = data.pct != null ? level(pct) : null;
    const remaining = countdown(data.resetsAt);
    const paceLabel = pace(data, WINDOW_MS[bucket]);

    const fill = meter.querySelector('.cu-fill');
    fill.style.width = `${pct}%`;
    fill.parentElement.setAttribute('aria-valuenow', String(pct));
    fill.classList.toggle('cu-fill--warn', severity === 'warn');
    fill.classList.toggle('cu-fill--danger', severity === 'danger');

    const reset = meter.querySelector('.cu-reset');
    const notes = [remaining, data.label, paceLabel].filter(Boolean);
    reset.textContent = notes.length ? `· ${notes.join(' · ')}` : '';
    reset.classList.toggle('cu-reset--alert', Boolean(paceLabel || data.label));

    meter.querySelector('.cu-meter-value').textContent = formatValue(data);
    const name = meter.querySelector('.cu-meter-label').textContent;
    meter.title = remaining ? `${name} ${formatValue(data)} · resets in ${remaining}` : '';
  }

  function setVar(name, value) {
    if (value && bar.style.getPropertyValue(name) !== value) bar.style.setProperty(name, value);
  }

  function matchChin() {
    const note = bar.parentElement.querySelector('[data-disclaimer]');
    const row = note?.closest('[data-size]');
    if (!row) return;

    const rowStyle = getComputedStyle(row);
    setVar('--cu-secondary', rowStyle.color);
    setVar('--cu-muted', getComputedStyle(note).color);
    setVar('--cu-font-size', rowStyle.fontSize);

    const barRect = bar.getBoundingClientRect();
    const text = (note.querySelector('a') ?? note).getBoundingClientRect();
    const model = row.querySelector('[data-testid="model-selector-dropdown"] .truncate')?.getBoundingClientRect();
    const inset = (px) => (px >= 0 && px < barRect.width / 4 ? `${Math.round(px)}px` : null);
    if (text.width) setVar('--cu-inset-start', inset(text.left - barRect.left));
    if (model?.width) setVar('--cu-inset-end', inset(barRect.right - model.right));
  }

  function render() {
    if (state.unavailable) {
      bar?.remove();
      return;
    }

    attachBar();
    if (!bar) return;

    renderBucket('current', state.usage?.current);
    renderBucket('weekly', state.usage?.weekly);

    matchChin();

    const backdrop = backdropColor(bar.parentElement);
    if (backdrop && backdrop !== bar.style.backgroundColor) {
      bar.style.backgroundColor = backdrop;
      bar.style.boxShadow = `0 0 0 32px ${backdrop}`;
    }
  }

  // ------------------------------------------------------------------- start

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== 'REFRESH_USAGE') return;
    pollUsage({ force: true });
    sendResponse({ ok: true });
  });

  window.addEventListener('message', onSnifferMessage);
  document.addEventListener('visibilitychange', pollIfVisible);
  window.addEventListener('pagehide', (event) => {
    if (!event.persisted) teardown();
  });

  interval(pollIfVisible, POLL_INTERVAL_MS);
  interval(render, RENDER_INTERVAL_MS);

  (async () => {
    const snapshot = await readSnapshot();
    if (snapshot?.usage) {
      const live = state.usage;
      state.usage = reviveResetDates(snapshot.usage);
      if (live) setUsage(live);
      else render();
    }
    hydrated = true;
    setOrgId(await resolveOrgId());
  })();
})();
