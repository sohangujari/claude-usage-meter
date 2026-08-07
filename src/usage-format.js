'use strict';

const UsageFormat = {
  WARN_PCT: 75,
  DANGER_PCT: 90,

  clamp(n, min, max) {
    return Math.max(min, Math.min(max, n));
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

  value(bucket) {
    const pct = Math.round(bucket.pct);
    return bucket.used != null && bucket.limit != null
      ? `${bucket.used}/${bucket.limit} · ${pct}%`
      : `${pct}%`;
  },
};
