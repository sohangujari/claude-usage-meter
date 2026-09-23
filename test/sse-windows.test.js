'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const src = (name) => fs.readFileSync(path.join(__dirname, '..', 'src', name), 'utf8');

const ORG = '00000000-0000-4000-8000-000000000000';
const OTHER_ORG = '11111111-1111-4111-8111-111111111111';
const HOUR = 3600;

const listeners = new Map();
const posted = [];
const store = {};
let writes = [];

const chromeSerialize = (value) =>
  JSON.parse(JSON.stringify(value, function (key, v) {
    return this[key] instanceof Date ? {} : v;
  }));

globalThis.setInterval = () => 0;
globalThis.clearInterval = () => {};
globalThis.fetch = () => Promise.reject(new Error('no network in test'));
console.warn = () => {};
globalThis.window = {
  addEventListener: (type, fn) => listeners.set(type, fn),
  removeEventListener: () => {},
  postMessage: (message) => posted.push(message),
  location: { origin: 'https://claude.ai' },
};
globalThis.document = {
  addEventListener: () => {},
  removeEventListener: () => {},
  querySelector: () => null,
  querySelectorAll: () => [],
  cookie: '',
};
globalThis.chrome = {
  runtime: {
    id: 'test',
    sendMessage: () => Promise.resolve({ orgId: ORG }),
    onMessage: { addListener: () => {} },
  },
  storage: {
    local: {
      get: (keys) =>
        Promise.resolve(
          Object.fromEntries([].concat(keys).filter((k) => k in store).map((k) => [k, chromeSerialize(store[k])])),
        ),
      set: (items) => {
        const serialized = chromeSerialize(items);
        writes.push(serialized);
        Object.assign(store, serialized);
        return Promise.resolve();
      },
      remove: () => Promise.resolve(),
    },
  },
};

const now = Math.floor(Date.now() / 1000);
const resetsAt = now + HOUR;
const seededWeeklyReset = new Date((now + 50 * HOUR) * 1000).toISOString();

vm.runInThisContext(src('usage-format.js'));
const { snapshotKey, ACTIVE_ORG_KEY } = UsageFormat;

store[ACTIVE_ORG_KEY] = OTHER_ORG;
store[snapshotKey(ORG)] = {
  usage: {
    current: null,
    weekly: { used: null, limit: null, remaining: null, pct: 30, resetsAt: seededWeeklyReset },
  },
  lastUpdated: Date.now(),
};
store[snapshotKey(OTHER_ORG)] = {
  usage: { current: { used: null, limit: null, remaining: null, pct: 99, resetsAt: null }, weekly: null },
  lastUpdated: Date.now(),
};

vm.runInThisContext(src('content.js'));

const tick = () => new Promise((resolve) => setImmediate(resolve));

async function settle(done) {
  for (let i = 0; i < 50 && !done(); i++) await tick();
  assert.ok(done(), 'timed out waiting for content script');
}

function send(channel, payload) {
  writes = [];
  listeners.get('message')({
    source: globalThis.window,
    data: { type: '__claude_usage_meter__', channel, payload },
  });
  const write = writes.find((w) => Object.keys(w).some((k) => k.startsWith('usage:')));
  return write ? Object.values(write).find((v) => v && typeof v === 'object' && 'usage' in v) : null;
}

const sendMessageLimit = (payload) => send('messageLimit', payload);

(async () => {
  await settle(() => posted.some((m) => m.channel === 'fetchUsage'));

  const fetches = posted.filter((m) => m.channel === 'fetchUsage');
  assert.strictEqual(fetches[0].type, '__claude_usage_meter__');
  assert.strictEqual(fetches[0].payload, ORG);
  assert.strictEqual(store[ACTIVE_ORG_KEY], ORG);
  console.log('ok - usage fetch is delegated to the page world');

  let snapshot = sendMessageLimit({ type: 'within_limit', windows: { '5h': { utilization: 0.1, resets_at: resetsAt } } });
  assert.strictEqual(Math.round(snapshot.usage.weekly.pct), 30);
  assert.strictEqual(snapshot.usage.weekly.resetsAt, seededWeeklyReset);
  assert.strictEqual(store[snapshotKey(OTHER_ORG)].usage.current.pct, 99);
  console.log('ok - saved usage survives a reload and stays per account');

  // A free plan's only figures arrive here: ratios, not percentages, and epoch
  // seconds, not ISO strings.
  snapshot = sendMessageLimit({
    type: 'within_limit',
    windows: {
      '5h': { utilization: 0.42, resets_at: resetsAt },
      '7d': { utilization: 0.07, resets_at: resetsAt + 86400 },
    },
  });

  assert.ok(snapshot, 'no snapshot written');
  assert.strictEqual(Math.round(snapshot.usage.current.pct), 42);
  assert.strictEqual(Math.round(snapshot.usage.weekly.pct), 7);
  assert.strictEqual(snapshot.usage.current.resetsAt, new Date(resetsAt * 1000).toISOString());
  assert.strictEqual(snapshot.usage.weekly.resetsAt, new Date((resetsAt + 86400) * 1000).toISOString());
  assert.strictEqual(UsageFormat.value(snapshot.usage.current), '42%');

  // Renamed window keys must not silently zero the meters.
  snapshot = sendMessageLimit({
    type: 'within_limit',
    windows: {
      five_hour: { utilization: 0.5, resets_at: resetsAt },
      seven_day: { utilization: 0.25, resets_at: resetsAt },
    },
  });
  assert.strictEqual(Math.round(snapshot.usage.current.pct), 50);
  assert.strictEqual(Math.round(snapshot.usage.weekly.pct), 25);

  // A value above 1 cannot be a ratio, so it is read as an already-scaled percent.
  snapshot = sendMessageLimit({
    type: 'within_limit',
    windows: { '5h': { utilization: 63, resets_at: resetsAt } },
  });
  assert.strictEqual(Math.round(snapshot.usage.current.pct), 63);

  // That event carried no weekly window, so the last known weekly figure stands
  // rather than collapsing to zero.
  assert.strictEqual(Math.round(snapshot.usage.weekly.pct), 25);

  // An event with no windows at all falls back to the coarse state.
  snapshot = sendMessageLimit({ type: 'exceeded_limit', resets_at: resetsAt });
  assert.strictEqual(snapshot.usage.current.pct, 100);
  assert.strictEqual(snapshot.usage.current.label, 'limit reached');

  // Junk must not overwrite a good reading.
  assert.strictEqual(sendMessageLimit({ type: 'nonsense_state' }), null);
  assert.strictEqual(sendMessageLimit(null), null);
  console.log('ok - free-plan SSE windows render as percentages');

  sendMessageLimit({ type: 'within_limit', windows: { '5h': { utilization: 0.8, resets_at: now - 60 } } });
  snapshot = send('usage', { five_hour: { utilization: 5 } });
  assert.strictEqual(snapshot.usage.current.pct, 5);
  assert.strictEqual(snapshot.usage.current.resetsAt, null);

  const past = new Date((now - 60) * 1000).toISOString();
  const future = new Date((now + HOUR) * 1000).toISOString();
  assert.deepStrictEqual(
    UsageFormat.expire({ used: 8, limit: 10, remaining: 2, pct: 80, resetsAt: past, label: 'limit reached' }),
    { used: 0, limit: 10, remaining: 10, pct: 0, resetsAt: null, label: null, estimated: false },
  );
  const live = { used: null, limit: null, remaining: null, pct: 80, resetsAt: future };
  assert.strictEqual(UsageFormat.expire(live), live);
  assert.strictEqual(UsageFormat.expire(null), null);
  assert.strictEqual(UsageFormat.expire({ pct: 40, resetsAt: 'garbage' }).pct, 40);
  assert.strictEqual(typeof UsageFormat.resetClock(future), 'string');
  assert.strictEqual(UsageFormat.resetClock(past), null);
  console.log('ok - passed resets clear stale figures');

  const orgUsageBefore = JSON.stringify(store[snapshotKey(ORG)]);
  send('orgId', OTHER_ORG);
  assert.strictEqual(store[ACTIVE_ORG_KEY], OTHER_ORG);
  await settle(() => posted.filter((m) => m.channel === 'fetchUsage' && m.payload === OTHER_ORG).length > 0);
  snapshot = sendMessageLimit({ type: 'within_limit', windows: { '5h': { utilization: 0.1, resets_at: resetsAt } } });
  assert.strictEqual(Math.round(store[snapshotKey(OTHER_ORG)].usage.current.pct), 10);
  assert.strictEqual(store[snapshotKey(OTHER_ORG)].usage.weekly, null);
  assert.strictEqual(JSON.stringify(store[snapshotKey(ORG)]), orgUsageBefore);
  console.log('ok - switching accounts never mixes usage');

  process.exit(0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
