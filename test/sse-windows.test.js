'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const src = (name) => fs.readFileSync(path.join(__dirname, '..', 'src', name), 'utf8');

const listeners = new Map();
let written = null;

globalThis.setInterval = () => 0;
globalThis.clearInterval = () => {};
globalThis.fetch = () => Promise.reject(new Error('no network in test'));
console.warn = () => {}; // the stubbed network is expected to fail here
globalThis.window = {
  addEventListener: (type, fn) => listeners.set(type, fn),
  removeEventListener: () => {},
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
    sendMessage: () => Promise.resolve({ orgId: '00000000-0000-4000-8000-000000000000' }),
    onMessage: { addListener: () => {} },
  },
  storage: {
    local: {
      get: () => Promise.resolve({}),
      set: (items) => {
        written = items.usageSnapshot;
        return Promise.resolve();
      },
    },
  },
};

vm.runInThisContext(src('usage-format.js'));
vm.runInThisContext(src('content.js'));

const resetsAt = Math.floor(Date.now() / 1000) + 3600;

function sendMessageLimit(payload) {
  written = null;
  listeners.get('message')({
    source: globalThis.window,
    data: { type: '__claude_usage_meter__', channel: 'messageLimit', payload },
  });
  return written;
}

// A free plan's only figures arrive here: ratios, not percentages, and epoch
// seconds, not ISO strings.
let snapshot = sendMessageLimit({
  type: 'within_limit',
  windows: {
    '5h': { utilization: 0.42, resets_at: resetsAt },
    '7d': { utilization: 0.07, resets_at: resetsAt + 86400 },
  },
});

assert.ok(snapshot, 'no snapshot written');
assert.strictEqual(Math.round(snapshot.usage.current.pct), 42);
assert.strictEqual(Math.round(snapshot.usage.weekly.pct), 7);
assert.strictEqual(snapshot.usage.current.resetsAt.getTime(), resetsAt * 1000);
assert.strictEqual(snapshot.usage.weekly.resetsAt.getTime(), (resetsAt + 86400) * 1000);
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
const good = snapshot;
assert.strictEqual(sendMessageLimit({ type: 'nonsense_state' }), null);
assert.strictEqual(sendMessageLimit(null), null);
void good;

console.log('ok - free-plan SSE windows render as percentages');
