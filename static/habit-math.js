// Habit tracker math: periods, aggregation, streaks, trends, formatting.
//
// DOM-free so it can run under `node --test` (see tests/habit-math.test.js).
// Days are "YYYY-MM-DD" strings taken straight from each record's stored local
// timestamp (`ts.slice(0, 10)`); date arithmetic is done in UTC on those keys,
// so there are no timezone or DST surprises. Weeks start on Sunday.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.HabitMath = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const DAY_MS = 86400000;
  const PERIOD_DAYS = { day: 1, week: 7, month: 30.44, year: 365.25 };
  const PERIOD_ADJ = { day: "daily", week: "weekly", month: "monthly", year: "yearly", all: "all-time" };
  const PERIOD_UNIT = { day: "day", week: "week", month: "month", year: "year" };
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  // ─── Day keys ──────────────────────────────────────────────────────────────
  const pad = (n) => String(n).padStart(2, "0");

  function parseDay(key) {
    const [y, m, d] = key.split("-").map(Number);
    return Date.UTC(y, m - 1, d);
  }

  function dayKey(ms) {
    const d = new Date(ms);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  }

  function addDays(key, n) {
    return dayKey(parseDay(key) + n * DAY_MS);
  }

  function daysBetween(a, b) {
    return Math.round((parseDay(b) - parseDay(a)) / DAY_MS);
  }

  // Browser-local calendar date of a Date (defaults to now).
  function todayKey(now = new Date()) {
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  }

  function dayOfWeek(key) {
    return new Date(parseDay(key)).getUTCDay();
  }

  function recordDay(record) {
    return record.ts.slice(0, 10);
  }

  // ─── Periods ───────────────────────────────────────────────────────────────
  function weekStart(key) {
    return addDays(key, -dayOfWeek(key));
  }

  function periodKey(period, day) {
    switch (period) {
      case "day": return day;
      case "week": return weekStart(day);
      case "month": return day.slice(0, 7);
      case "year": return day.slice(0, 4);
      default: return "all";
    }
  }

  // First day of the period identified by `pkey`.
  function periodStart(period, pkey) {
    if (period === "month") return pkey + "-01";
    if (period === "year") return pkey + "-01-01";
    return pkey;
  }

  function prevPeriod(period, pkey) {
    switch (period) {
      case "day": return addDays(pkey, -1);
      case "week": return addDays(pkey, -7);
      case "month": {
        let [y, m] = pkey.split("-").map(Number);
        if (--m === 0) (m = 12), y--;
        return `${y}-${pad(m)}`;
      }
      case "year": return String(Number(pkey) - 1);
      default: return null;
    }
  }

  function nextPeriod(period, pkey) {
    switch (period) {
      case "day": return addDays(pkey, 1);
      case "week": return addDays(pkey, 7);
      case "month": {
        let [y, m] = pkey.split("-").map(Number);
        if (++m === 13) (m = 1), y++;
        return `${y}-${pad(m)}`;
      }
      case "year": return String(Number(pkey) + 1);
      default: return null;
    }
  }

  // Last day of the period (inclusive).
  function periodEnd(period, pkey) {
    return addDays(periodStart(period, nextPeriod(period, pkey)), -1);
  }

  function groupByPeriod(period, records) {
    const groups = new Map();
    for (const r of records) {
      const k = periodKey(period, recordDay(r));
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(r);
    }
    return groups;
  }

  // ─── Metrics & aggregation ─────────────────────────────────────────────────
  const COUNT_METRIC = { name: "count", kind: "number", unit: "" };

  function metricInfo(habit, name) {
    if (name === "count") return COUNT_METRIC;
    return habit.metrics.find((m) => m.name === name) || { name, kind: "number", unit: "" };
  }

  function valueOf(record, metric) {
    if (metric === "count") return 1;
    const v = record.values[metric];
    return typeof v === "number" && isFinite(v) ? v : undefined;
  }

  // The goal's value over `records` (already limited to one period/bucket).
  // Returns null when there's no meaningful value: avg/max/min with nothing
  // recorded, or a ratio whose denominator sums to zero. A sum or count over
  // no records is a real 0.
  function aggregate(goal, habit, records) {
    if (goal.type === "ratio") {
      let num = 0, den = 0;
      for (const r of records) {
        const a = valueOf(r, goal.metric1);
        const b = valueOf(r, goal.metric2);
        if (a === undefined || b === undefined) continue;
        num += a;
        den += b;
      }
      return den === 0 ? null : num / den;
    }
    const vals = [];
    for (const r of records) {
      const v = valueOf(r, goal.metric1);
      if (v !== undefined) vals.push(v);
    }
    const agg = goal.metric1 === "count" ? "sum" : goal.agg || "sum";
    if (agg === "sum") return vals.reduce((a, b) => a + b, 0);
    if (!vals.length) return null;
    if (agg === "avg") return vals.reduce((a, b) => a + b, 0) / vals.length;
    if (agg === "max") return Math.max(...vals);
    return Math.min(...vals);
  }

  // "atLeast" (value >= target) or "atMost" (value <= target). A goal may set
  // its own direction; otherwise it follows the habit type.
  function goalDirection(goal, habit) {
    if (goal.direction === "atLeast" || goal.direction === "atMost") return goal.direction;
    return habit.type === "NEGATIVE" ? "atMost" : "atLeast";
  }

  // No value counts as success for "at most" goals (nothing happened) and
  // failure for "at least" ones.
  function isMet(dir, value, target) {
    if (value === null || value === undefined) return dir === "atMost";
    return dir === "atMost" ? value <= target : value >= target;
  }

  // Per-day values for the given day keys; null for days with no records.
  function dailyValues(goal, habit, records, days) {
    const byDay = groupByPeriod("day", records);
    return days.map((d) => (byDay.has(d) ? aggregate(goal, habit, byDay.get(d)) : null));
  }

  // Current-period progress: value so far and whether it's met right now.
  function currentStatus(goal, habit, records, today) {
    const pk = periodKey(goal.period, today);
    const inPeriod = records.filter((r) => periodKey(goal.period, recordDay(r)) === pk);
    const value = aggregate(goal, habit, inPeriod);
    return { value, met: isMet(goalDirection(goal, habit), value, goal.target) };
  }

  function earliestDay(records) {
    let min = null;
    for (const r of records) {
      const d = recordDay(r);
      if (min === null || d < min) min = d;
    }
    return min;
  }

  // Consecutive completed periods met, counting back from the one before the
  // current period and stopping at the period of the habit's earliest record.
  // Empty periods count normally (met for "at most", not for "at least").
  // Returns null for all-time goals.
  function streak(goal, habit, records, today) {
    if (goal.period === "all") return null;
    const first = earliestDay(records);
    if (first === null) return 0;
    const firstKey = periodKey(goal.period, first);
    const groups = groupByPeriod(goal.period, records);
    const dir = goalDirection(goal, habit);
    let pk = prevPeriod(goal.period, periodKey(goal.period, today));
    let n = 0;
    while (pk >= firstKey) {
      const value = aggregate(goal, habit, groups.get(pk) || []);
      if (!isMet(dir, value, goal.target)) break;
      n++;
      pk = prevPeriod(goal.period, pk);
    }
    return n;
  }

  // ─── Calendar ──────────────────────────────────────────────────────────────
  // Weeks (Sun–Sat) covering month `m` (0–11) of year `y`; days outside the
  // month are null.
  function monthGrid(y, m) {
    const first = `${y}-${pad(m + 1)}-01`;
    const days = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    const cells = Array(dayOfWeek(first)).fill(null);
    for (let d = 1; d <= days; d++) cells.push(`${y}-${pad(m + 1)}-${pad(d)}`);
    while (cells.length % 7) cells.push(null);
    const weeks = [];
    for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
    return weeks;
  }

  // ─── Trend ─────────────────────────────────────────────────────────────────
  // Least-squares fit y = slope·x + intercept. Null if fewer than 2 distinct x.
  function linearTrend(points) {
    const n = points.length;
    if (n < 2) return null;
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (const { x, y } of points) {
      sx += x; sy += y; sxx += x * x; sxy += x * y;
    }
    const den = n * sxx - sx * sx;
    if (den === 0) return null;
    const slope = (n * sxy - sx * sy) / den;
    return { slope, intercept: (sy - slope * sx) / n };
  }

  // ─── Detail chart buckets ──────────────────────────────────────────────────
  // Ranges: week = last 7 days, month = last 30 days (daily buckets);
  // year = last 52 weeks (weekly); all = every month since the first record.
  // Clipped to the earliest record. The bucket containing today is `partial`.
  const RANGE_BUCKET = { week: "day", month: "day", year: "week", all: "month" };
  const RANGE_COUNT = { week: 7, month: 30, year: 52 };

  function detailBuckets(goal, habit, records, range, today) {
    const bucket = RANGE_BUCKET[range];
    const first = earliestDay(records);
    const lastKey = periodKey(bucket, today);
    const keys = [];
    if (first !== null) {
      const firstKey = periodKey(bucket, first);
      let k = lastKey;
      const limit = RANGE_COUNT[range] || Infinity;
      while (k >= firstKey && keys.length < limit) {
        keys.unshift(k);
        k = prevPeriod(bucket, k);
      }
    }
    const groups = groupByPeriod(bucket, records);
    const buckets = keys.map((k, i) => ({
      key: k,
      start: periodStart(bucket, k),
      end: periodEnd(bucket, k),
      label: bucketLabel(bucket, k),
      value: aggregate(goal, habit, groups.get(k) || []),
      partial: k === lastKey,
      x: i,
    }));
    const complete = buckets.filter((b) => !b.partial && b.value !== null);
    const trend = complete.length >= 2 ? linearTrend(complete.map((b) => ({ x: b.x, y: b.value }))) : null;
    return { bucket, buckets, trend, targetLine: targetLine(goal, bucket) };
  }

  function bucketLabel(bucket, key) {
    if (bucket === "month") return `${MONTHS[Number(key.slice(5, 7)) - 1]} ${key.slice(2, 4)}`;
    return `${MONTHS[Number(key.slice(5, 7)) - 1]} ${Number(key.slice(8, 10))}`;
  }

  // Where to draw the target on a chart with the given bucket size. Intensive
  // goals (avg/max/min/ratio) compare directly; totals (sum/count) scale with
  // bucket length relative to the goal period ("pace"). None for all-time sums.
  function targetLine(goal, bucket) {
    const intensive = goal.type === "ratio" || (goal.metric1 !== "count" && (goal.agg || "sum") !== "sum");
    if (intensive) return { value: goal.target, pace: false };
    if (goal.period === "all") return null;
    if (bucket === goal.period) return { value: goal.target, pace: false };
    return { value: (goal.target * PERIOD_DAYS[bucket]) / PERIOD_DAYS[goal.period], pace: true };
  }

  // ─── Formatting ────────────────────────────────────────────────────────────
  // H:MM:SS, or M:SS under an hour.
  function formatDuration(sec) {
    const neg = sec < 0;
    let s = Math.round(Math.abs(sec));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    s %= 60;
    const body = h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
    return neg ? "-" + body : body;
  }

  // "HH:MM:SS", "MM:SS" or "SS" (fractional seconds allowed) → seconds; NaN if
  // malformed.
  function parseDuration(text) {
    const parts = String(text).trim().split(":");
    if (parts.length > 3 || parts.some((p) => !/^\d+(\.\d+)?$/.test(p))) return NaN;
    return parts.reduce((acc, p) => acc * 60 + Number(p), 0);
  }

  function formatNumber(v) {
    const abs = Math.abs(v);
    const digits = abs >= 100 ? 0 : abs >= 10 ? 1 : 2;
    return String(Number(v.toFixed(digits)));
  }

  // How a goal's raw value is displayed: `kind` (duration | number), a scale
  // `factor` (display = raw × factor) and a unit suffix.
  //   duration ÷ number → pace, e.g. 9:00 /mi
  //   number ÷ duration → per hour, e.g. 6.5 mi/h
  //   duration ÷ duration → unitless
  function displayScale(goal, habit) {
    const m1 = metricInfo(habit, goal.metric1);
    if (goal.type !== "ratio") {
      return { kind: m1.kind, factor: 1, unit: m1.kind === "duration" ? "" : m1.unit };
    }
    const m2 = metricInfo(habit, goal.metric2);
    const per = m2.unit || (m2.name === "count" ? "record" : m2.name);
    if (m1.kind === "duration" && m2.kind === "duration") return { kind: "number", factor: 1, unit: "" };
    if (m1.kind === "duration") return { kind: "duration", factor: 1, unit: `/${per}` };
    const top = m1.unit || (m1.name === "count" ? "" : m1.name);
    if (m2.kind === "duration") return { kind: "number", factor: 3600, unit: `${top}/h` };
    return { kind: "number", factor: 1, unit: top ? `${top}/${per}` : `/${per}` };
  }

  function formatValue(goal, habit, value) {
    if (value === null || value === undefined) return "—";
    const s = displayScale(goal, habit);
    const v = value * s.factor;
    const body = s.kind === "duration" ? formatDuration(v) : formatNumber(v);
    return s.unit ? `${body} ${s.unit}` : body;
  }

  function formatMetric(metric, value) {
    if (value === null || value === undefined) return "—";
    if (metric.kind === "duration") return formatDuration(value);
    return metric.unit ? `${formatNumber(value)} ${metric.unit}` : formatNumber(value);
  }

  function unitLabel(goal, habit) {
    return displayScale(goal, habit).unit;
  }

  const AGG_LABEL = { sum: "total", avg: "average", max: "max", min: "min" };

  // Short label, e.g. "Distance · sum · week ≥ 15 mi".
  function goalLabel(goal, habit) {
    const what = goal.type === "ratio"
      ? `${goal.metric1} / ${goal.metric2}`
      : goal.metric1 === "count" ? "count" : `${goal.metric1} · ${goal.agg || "sum"}`;
    const cmp = goalDirection(goal, habit) === "atMost" ? "≤" : "≥";
    const period = goal.period === "all" ? "all-time" : goal.period;
    return `${what} · ${period} ${cmp} ${formatValue(goal, habit, goal.target)}`;
  }

  // Sentence, e.g. "Met when weekly total of Distance ≥ 15 mi".
  function goalSentence(goal, habit) {
    const adj = PERIOD_ADJ[goal.period];
    let what;
    if (goal.type === "ratio") what = `${adj} ${goal.metric1} per ${goal.metric2}`;
    else if (goal.metric1 === "count") what = `${adj} number of records`;
    else what = `${adj} ${AGG_LABEL[goal.agg || "sum"]} of ${goal.metric1}`;
    const cmp = goalDirection(goal, habit) === "atMost" ? "≤" : "≥";
    return `Met when ${what} ${cmp} ${formatValue(goal, habit, goal.target)}`;
  }

  function streakLabel(period, n) {
    if (n === null) return "";
    return `${n} ${PERIOD_UNIT[period]}${n === 1 ? "" : "s"}`;
  }

  return {
    parseDay, dayKey, addDays, daysBetween, todayKey, dayOfWeek, recordDay,
    weekStart, periodKey, periodStart, periodEnd, prevPeriod, nextPeriod, groupByPeriod,
    metricInfo, aggregate, goalDirection, isMet, dailyValues, currentStatus, earliestDay, streak,
    monthGrid, linearTrend, detailBuckets, targetLine,
    formatDuration, parseDuration, formatNumber, displayScale, formatValue, formatMetric,
    unitLabel, goalLabel, goalSentence, streakLabel, MONTHS,
  };
});
