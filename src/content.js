(function () {
  'use strict';

  const STORAGE_KEY = 'cum_snapshot';

  const STATE = {
    orgId: null,
    usage: null,
    lastPollAt: 0,
  };

  let CONTEXT_ALIVE = true;
  const activeIntervals = [];

  const unloadController = new AbortController();

  function isContextValid() {
    if (!CONTEXT_ALIVE) return false;
    try {
      return !!(chrome.runtime && chrome.runtime.id);
    } catch (e) {
      return false;
    }
  }

  function teardown() {
    if (!CONTEXT_ALIVE) return;
    CONTEXT_ALIVE = false;
    activeIntervals.forEach((id) => clearInterval(id));
    if (typeof mo !== 'undefined' && mo) mo.disconnect();
    try { unloadController.abort(); } catch (e) {}
    try { history.pushState = origPush; } catch (e) {}
    try { history.replaceState = origReplace; } catch (e) {}
    try { window.removeEventListener('popstate', onRoute); } catch (e) {}
    try { window.removeEventListener('message', onMessage); } catch (e) {}
    try { document.removeEventListener('visibilitychange', onVisibility); } catch (e) {}
    console.info('[Claude Usage Meter] Context ended (page unload or extension reload) - cleaning up.');
  }

  window.addEventListener('pagehide', teardown, { once: true });
  window.addEventListener('beforeunload', teardown, { once: true });

  function safeInterval(fn, ms) {
    const id = setInterval(() => {
      if (!isContextValid()) { clearInterval(id); teardown(); return; }
      fn();
    }, ms);
    activeIntervals.push(id);
    return id;
  }

  function safeSendMessage(msg, cb) {
    if (!isContextValid()) return;
    try {
      chrome.runtime.sendMessage(msg, (res) => {
        if (chrome.runtime.lastError) return;
        cb && cb(res);
      });
    } catch (e) {
      teardown();
    }
  }

  function safeStorageGet(keys, cb) {
    if (!isContextValid()) return;
    try {
      chrome.storage.local.get(keys, (res) => {
        if (chrome.runtime.lastError) return;
        cb(res);
      });
    } catch (e) {
      teardown();
    }
  }

  function safeStorageSet(obj) {
    if (!isContextValid()) return;
    try {
      chrome.storage.local.set(obj, () => { void chrome.runtime.lastError; });
    } catch (e) {
      teardown();
    }
  }

  // ---------------- inject page-context sniffer ----------------
  function injectScript() {
    if (!isContextValid()) return;
    try {
      const s = document.createElement('script');
      s.src = chrome.runtime.getURL('injected.js');
      s.onload = function () { this.remove(); };
      (document.head || document.documentElement).appendChild(s);
      console.log('[CUM] injected.js injected into page context');
    } catch (e) {
      console.warn('[CUM] failed to inject injected.js', e);
      teardown();
    }
  }
  injectScript();

  // ---------------- load cached snapshot immediately ----------------
  safeStorageGet([STORAGE_KEY], (res) => {
    const snap = res[STORAGE_KEY];
    if (snap && snap.usage) {
      console.log('[CUM] loaded cached snapshot from storage:', snap);
      STATE.usage = reviveDates(snap.usage);
      render();
    } else {
      console.log('[CUM] no cached snapshot found in storage yet');
    }
  });

  function reviveDates(usage) {
    ['current', 'weekly'].forEach((k) => {
      if (usage[k] && usage[k].resetsAt) {
        const d = new Date(usage[k].resetsAt);
        usage[k].resetsAt = isNaN(d.getTime()) ? null : d;
      }
    });
    return usage;
  }

  // ---------------- resolve org id ----------------
  let orgResolveAttempts = 0;

  function resolveOrgId(cb) {
    safeSendMessage({ type: 'GET_ORG_ID' }, (res) => {
      if (res && res.orgId) {
        console.log('[CUM] orgId from cookie (via background):', res.orgId);
        cb(res.orgId);
        return;
      }
      const m = document.cookie.match(/lastActiveOrg=([a-f0-9-]{36})/i);
      if (m) {
        console.log('[CUM] orgId from document.cookie fallback:', m[1]);
        cb(m[1]);
        return;
      }
      console.warn('[CUM] orgId not found yet (attempt', orgResolveAttempts + 1, ') - waiting for network sniff / retry');
      cb(null);

      orgResolveAttempts++;
      if (orgResolveAttempts < 8 && isContextValid()) {
        setTimeout(() => resolveOrgId(cb), 2000);
      }
    });
  }
  resolveOrgId((id) => { if (id) setOrgId(id); });

  function setOrgId(id) {
    if (!id || id === STATE.orgId) return;
    console.log('[CUM] setOrgId ->', id);
    STATE.orgId = id;
    pollUsage(true);
  }

  // ---------------- active usage polling ----------------
  async function pollUsage(force) {
    if (!isContextValid()) return;
    if (!STATE.orgId) {
      console.warn('[CUM] pollUsage skipped - no orgId yet');
      return;
    }
    const now = Date.now();
    if (!force && now - STATE.lastPollAt < 5000) return;
    STATE.lastPollAt = now;

    const url = `https://claude.ai/api/organizations/${STATE.orgId}/usage`;
    console.log('[CUM] polling', url);

    try {
      const res = await fetch(url, {
        method: 'GET',
        credentials: 'include',
        signal: unloadController.signal,
      });

      if (!isContextValid()) return;
      console.log('[CUM] usage response status:', res.status);

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        console.warn('[CUM] usage fetch not ok:', res.status, text.slice(0, 300));
        return;
      }

      const data = await res.json();
      if (!isContextValid()) return;

      console.log('[CUM] usage payload keys:', Object.keys(data));
      console.log('[CUM] usage payload (full):', data);
      window.__cumLastPayload = data;

      applyRawUsage(data);
    } catch (e) {
      if (e.name === 'AbortError') return;
      if (!isContextValid()) return;
      console.warn('[Claude Usage Meter] usage poll failed', e);
    }
  }

  // ---------------- messages from injected.js ----------------
  function onMessage(event) {
    if (!isContextValid()) return;
    if (event.source !== window) return;
    const { type, source, payload } = event.data || {};
    if (type !== '__cum_evt__') return;
    if (source === 'orgId') { console.log('[CUM] orgId sniffed from network:', payload); setOrgId(payload); return; }
    if (source === 'usage') { console.log('[CUM] usage sniffed from network:', payload); applyRawUsage(payload); return; }
    if (source === 'message_limit') { console.log('[CUM] message_limit sniffed from SSE:', payload); applyMessageLimit(payload); return; }
  }
  window.addEventListener('message', onMessage);

  // ---------------- force refresh from popup ----------------
  if (isContextValid()) {
    try {
      chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        if (!isContextValid()) return;
        if (msg.type === 'CUM_FORCE_REFRESH') {
          pollUsage(true).finally(() => {
            try { sendResponse({ ok: true }); } catch (e) {}
          });
          return true;
        }
      });
    } catch (e) {
      teardown();
    }
  }

  // ---------------- reset-time parsing ----------------
  function parseResetTime(raw) {
    if (raw == null) return null;
    if (typeof raw === 'string' && /^-?\d+$/.test(raw.trim())) raw = Number(raw.trim());
    if (typeof raw === 'number') {
      if (raw > 1e12) return new Date(raw);
      if (raw > 1e9) return new Date(raw * 1000);
      return new Date(Date.now() + raw * 1000);
    }
    const d = new Date(raw);
    return isNaN(d.getTime()) ? null : d;
  }

  // ---------------- normalization ----------------
  function toBucket(node, previous) {
    if (!node || typeof node !== 'object') return null;

    let used = typeof node.used === 'number' ? node.used : null;
    let limit = typeof node.limit === 'number' ? node.limit : null;
    let remaining = typeof node.remaining === 'number' ? node.remaining : null;

    if (used == null && remaining != null && limit != null) used = limit - remaining;
    if (remaining == null && used != null && limit != null) remaining = limit - used;

    const rawReset =
      node.resets_at ?? node.reset_at ?? node.resetsAt ?? node.resetAt ??
      node.reset_time ?? node.resets_in_seconds ?? node.resetsInSeconds ?? null;

    let resetsAt = parseResetTime(rawReset);
    if (!resetsAt && previous && previous.resetsAt) resetsAt = previous.resetsAt;

    if (used == null && limit == null && typeof node.utilization === 'number') {
      const pct = node.utilization <= 1 ? node.utilization * 100 : node.utilization;
      return { used: null, limit: null, remaining: null, pct: clamp(pct, 0, 100), resetsAt };
    }
    if (used == null || limit == null) return null;

    return {
      used, limit, remaining,
      pct: limit > 0 ? clamp((used / limit) * 100, 0, 100) : 0,
      resetsAt,
    };
  }

  function applyRawUsage(raw) {
    if (!raw || typeof raw !== 'object') return;

    let currentNode = raw.five_hour || raw.fiveHour || raw.current || raw.session;
    let weeklyNode = raw.seven_day || raw.sevenDay || raw.weekly || raw.week;

    if (!currentNode || !weeklyNode) {
      const found = {};
      (function visit(node, path) {
        if (!node || typeof node !== 'object') return;
        const key = path.join('.');
        if (!found.current && /five.?hour|session|current/i.test(key)) found.current = node;
        if (!found.weekly && /seven.?day|weekly|week/i.test(key)) found.weekly = node;
        for (const [k, v] of Object.entries(node)) if (v && typeof v === 'object') visit(v, [...path, k]);
      })(raw, []);
      currentNode = currentNode || found.current;
      weeklyNode = weeklyNode || found.weekly;
    }

    console.log('[CUM] matched currentNode:', currentNode);
    console.log('[CUM] matched weeklyNode:', weeklyNode);

    const current = toBucket(currentNode, STATE.usage?.current);
    const weekly = toBucket(weeklyNode, STATE.usage?.weekly);

    console.log('[CUM] normalized current bucket:', current);
    console.log('[CUM] normalized weekly bucket:', weekly);

    if (!current && !weekly) {
      console.warn('[CUM] Neither bucket normalized - payload shape mismatch. Inspect window.__cumLastPayload');
      return;
    }

    STATE.usage = {
      current: current || STATE.usage?.current || null,
      weekly: weekly || STATE.usage?.weekly || null,
    };
    persistSnapshot();
    render();
  }

  function applyMessageLimit(payload) {
    const bucket = toBucket(payload, STATE.usage?.current);
    if (!bucket) return;
    STATE.usage = { current: bucket, weekly: STATE.usage?.weekly || null };
    persistSnapshot();
    render();
    setTimeout(() => { if (isContextValid()) pollUsage(true); }, 1500);
  }

  function persistSnapshot() {
    if (!STATE.usage) return;
    safeStorageSet({ [STORAGE_KEY]: { usage: STATE.usage, lastUpdated: Date.now() } });
  }

  function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }

  safeInterval(() => { if (document.visibilityState === 'visible') pollUsage(false); }, 20000);
  function onVisibility() { if (document.visibilityState === 'visible') pollUsage(false); }
  document.addEventListener('visibilitychange', onVisibility);
  safeInterval(() => { if (barEl) refreshBarUI(); }, 30000);

  // ==================================================================
  // UI - embedded inline inside Claude's own composer card
  // ==================================================================
  let barEl = null;

  function findComposerRoot() {
    const chatInput = document.querySelector('[data-testid="chat-input"]');
    if (!chatInput) return null;
    const modelBtn = document.querySelector('[data-testid="model-selector-dropdown"]');
    if (modelBtn) {
      const ancestors = new Set();
      let a = chatInput;
      while (a) { ancestors.add(a); a = a.parentElement; }
      let b = modelBtn;
      while (b) { if (ancestors.has(b)) return b; b = b.parentElement; }
    }
    return chatInput.parentElement?.parentElement?.parentElement || chatInput.parentElement || null;
  }

  function ensureBar() {
    if (barEl) return barEl;
    barEl = document.createElement('div');
    barEl.id = 'cum-inline-bar';
    barEl.innerHTML = `
      <div class="cum-meter" data-bucket="current">
        <div class="cum-meter-head"><span class="cum-meter-label">Session</span><span class="cum-meter-value">-</span></div>
        <div class="cum-track"><div class="cum-fill"></div></div>
        <div class="cum-reset"></div>
      </div>
      <div class="cum-divider"></div>
      <div class="cum-meter" data-bucket="weekly">
        <div class="cum-meter-head"><span class="cum-meter-label">Weekly</span><span class="cum-meter-value">-</span></div>
        <div class="cum-track"><div class="cum-fill"></div></div>
        <div class="cum-reset"></div>
      </div>`;
    return barEl;
  }

  function attachBar() {
    if (!isContextValid()) return;
    const root = findComposerRoot();
    if (!root) return;
    const bar = ensureBar();
    if (bar.parentElement !== root) root.appendChild(bar);
  }

  function formatCountdown(resetsAt) {
    if (!resetsAt) return null;
    const target = resetsAt instanceof Date ? resetsAt : new Date(resetsAt);
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

  function updateBucketUI(root, bucket, data) {
    const wrap = root.querySelector(`.cum-meter[data-bucket="${bucket}"]`);
    if (!wrap) return;
    const valueEl = wrap.querySelector('.cum-meter-value');
    const fillEl = wrap.querySelector('.cum-fill');
    const resetEl = wrap.querySelector('.cum-reset');

    if (!data) {
      valueEl.textContent = '-';
      fillEl.style.width = '0%';
      fillEl.classList.remove('cum-fill--warn', 'cum-fill--danger');
      resetEl.textContent = '';
      return;
    }

    const pct = Math.round(data.pct);
    valueEl.textContent = data.used != null && data.limit != null
      ? `${data.used}/${data.limit} · ${pct}%`
      : `${pct}%`;
    fillEl.style.width = `${clamp(pct, 0, 100)}%`;
    fillEl.classList.toggle('cum-fill--warn', pct >= 75 && pct < 90);
    fillEl.classList.toggle('cum-fill--danger', pct >= 90);

    const cd = formatCountdown(data.resetsAt);
    resetEl.textContent = cd ? `Resets in ${cd}` : '';
  }

  function refreshBarUI() {
    if (!barEl) return;
    updateBucketUI(barEl, 'current', STATE.usage?.current);
    updateBucketUI(barEl, 'weekly', STATE.usage?.weekly);
  }

  function render() {
    attachBar();
    refreshBarUI();
    safeSendMessage({ type: 'SET_BADGE', pct: STATE.usage?.current?.pct ?? null });
  }

  // SPA route change handling
  const origPush = history.pushState;
  const origReplace = history.replaceState;
  function onRoute() {
    if (!isContextValid()) return;
    setTimeout(() => { if (isContextValid()) attachBar(); }, 50);
    setTimeout(() => { if (isContextValid()) attachBar(); }, 300);
    setTimeout(() => { if (isContextValid()) attachBar(); }, 800);
  }
  history.pushState = function (...a) { const r = origPush.apply(this, a); onRoute(); return r; };
  history.replaceState = function (...a) { const r = origReplace.apply(this, a); onRoute(); return r; };
  window.addEventListener('popstate', onRoute);

  let mo = new MutationObserver(() => attachBar());
  mo.observe(document.documentElement, { childList: true, subtree: true });
  safeInterval(attachBar, 1000);

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', render);
  else render();
})();