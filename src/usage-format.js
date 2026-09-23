'use strict';

const UsageFormat = {
  ACTIVE_ORG_KEY: 'activeOrgId',
  LEGACY_SNAPSHOT_KEY: 'usageSnapshot',

  WARN_PCT: 75,
  DANGER_PCT: 90,

  WINDOW_MS: {
    current: 5 * 60 * 60 * 1000,
  },

  PACE_MIN_ELAPSED: 0.1,
  PACE_THRESHOLD: 1.1,

  clamp(n, min, max) {
    return Math.max(min, Math.min(max, n));
  },

  snapshotKey(orgId) {
    return `usage:${orgId}`;
  },

  isFuture(date) {
    return Boolean(date) && new Date(date).getTime() > Date.now();
  },

  expire(bucket) {
    if (!bucket?.resetsAt || !(new Date(bucket.resetsAt).getTime() <= Date.now())) return bucket;

    const expired = { ...bucket, pct: 0, resetsAt: null, label: null, estimated: false };
    if (bucket.limit != null) Object.assign(expired, { used: 0, remaining: bucket.limit });
    return expired;
  },

  resetClock(resetsAt) {
    if (!UsageFormat.isFuture(resetsAt)) return null;

    const date = new Date(resetsAt);
    const time = { hour: 'numeric', minute: '2-digit' };
    if (date.toDateString() === new Date().toDateString()) return date.toLocaleTimeString([], time);

    const withinWeek = date.getTime() - Date.now() < 6 * 24 * 60 * 60 * 1000;
    const day = withinWeek ? { weekday: 'short' } : { month: 'short', day: 'numeric' };
    return date.toLocaleString([], { ...day, ...time });
  },

  countdown(resetsAt) {
    if (!resetsAt) return null;

    const remainingMs = new Date(resetsAt).getTime() - Date.now();
    if (Number.isNaN(remainingMs)) return null;
    if (remainingMs <= 0) return 'soon';

    const minutes = Math.floor(remainingMs / 60000);
    const days = Math.floor(minutes / 1440);
    const hours = Math.floor((minutes % 1440) / 60);

    if (days >= 1) return `${days}d ${hours}h`;
    if (hours >= 1) return `${hours}h ${minutes % 60}m`;
    return `${minutes}m`;
  },

  level(pct) {
    if (pct >= UsageFormat.DANGER_PCT) return 'danger';
    if (pct >= UsageFormat.WARN_PCT) return 'warn';
    return null;
  },

  pace(bucket, windowMs) {
    if (bucket?.pct == null || !bucket.resetsAt || !windowMs) return null;
    if (bucket.pct >= UsageFormat.DANGER_PCT) return null;

    const remainingMs = new Date(bucket.resetsAt).getTime() - Date.now();
    if (Number.isNaN(remainingMs) || remainingMs <= 0) return null;

    const elapsed = UsageFormat.clamp((windowMs - remainingMs) / windowMs, 0, 1);
    if (elapsed < UsageFormat.PACE_MIN_ELAPSED) return null;

    const projected = bucket.pct / 100 / elapsed;
    return projected >= UsageFormat.PACE_THRESHOLD ? 'ahead of pace' : null;
  },

  value(bucket) {
    if (bucket.pct == null || bucket.estimated) return '—';
    const pct = Math.round(bucket.pct);
    return bucket.used != null && bucket.limit != null
      ? `${bucket.used}/${bucket.limit} · ${pct}%`
      : `${pct}%`;
  },
};
