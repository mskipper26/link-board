// Run with: node --test tests/
const test = require("node:test");
const assert = require("node:assert/strict");
const H = require("../static/habit-math.js");

const rec = (ts, values = {}) => ({ ts: ts.length === 10 ? ts + "T12:00:00-04:00" : ts, values });
const RUN = {
  type: "POSITIVE",
  occurs: "periodic",
  metrics: [
    { name: "Distance", kind: "number", unit: "mi" },
    { name: "Time", kind: "duration", unit: "" },
  ],
};
const SMOKE = { type: "NEGATIVE", occurs: "periodic", metrics: [] };

// ─── periods ───────────────────────────────────────────────────────────────
test("weekStart is the Sunday on or before", () => {
  assert.equal(H.weekStart("2026-09-20"), "2026-09-20"); // Sunday
  assert.equal(H.weekStart("2026-09-26"), "2026-09-20"); // Saturday
  assert.equal(H.weekStart("2026-10-01"), "2026-09-27"); // across month
  assert.equal(H.weekStart("2027-01-01"), "2026-12-27"); // across year
});

test("periodKey for each period", () => {
  assert.equal(H.periodKey("day", "2026-03-08"), "2026-03-08");
  assert.equal(H.periodKey("week", "2026-03-08"), "2026-03-08");
  assert.equal(H.periodKey("month", "2026-03-08"), "2026-03");
  assert.equal(H.periodKey("year", "2026-03-08"), "2026");
  assert.equal(H.periodKey("all", "2026-03-08"), "all");
});

test("prev/next period roll over month and year boundaries", () => {
  assert.equal(H.prevPeriod("month", "2026-01"), "2025-12");
  assert.equal(H.nextPeriod("month", "2025-12"), "2026-01");
  assert.equal(H.prevPeriod("day", "2026-03-01"), "2026-02-28");
  assert.equal(H.prevPeriod("day", "2024-03-01"), "2024-02-29");
  assert.equal(H.prevPeriod("week", "2026-01-04"), "2025-12-28");
  assert.equal(H.prevPeriod("year", "2026"), "2025");
  assert.equal(H.periodEnd("month", "2024-02"), "2024-02-29");
  assert.equal(H.periodEnd("week", "2026-12-27"), "2027-01-02");
});

test("DST transitions don't shift day arithmetic", () => {
  assert.equal(H.addDays("2026-03-07", 1), "2026-03-08");
  assert.equal(H.addDays("2026-03-08", 1), "2026-03-09");
  assert.equal(H.addDays("2026-11-01", 1), "2026-11-02");
});

test("record day comes from the stored local timestamp, not UTC", () => {
  // 23:30 at -04:00 is already the next day in UTC.
  assert.equal(H.recordDay({ ts: "2026-09-26T23:30:00-04:00" }), "2026-09-26");
  assert.equal(H.periodKey("week", H.recordDay({ ts: "2026-09-26T23:30:00-04:00" })), "2026-09-20");
});

// ─── aggregation ───────────────────────────────────────────────────────────
const runs = [
  rec("2026-09-21", { Distance: 3, Time: 1620 }),
  rec("2026-09-22", { Distance: 5, Time: 2700 }),
  rec("2026-09-23", { Distance: 4, Time: 2400 }),
];

test("sum / avg / max / min / count", () => {
  const g = (agg) => ({ period: "week", type: "raw", metric1: "Distance", agg, target: 0 });
  assert.equal(H.aggregate(g("sum"), RUN, runs), 12);
  assert.equal(H.aggregate(g("avg"), RUN, runs), 4);
  assert.equal(H.aggregate(g("max"), RUN, runs), 5);
  assert.equal(H.aggregate(g("min"), RUN, runs), 3);
  assert.equal(H.aggregate({ type: "raw", metric1: "count" }, RUN, runs), 3);
});

test("empty period: sum/count are 0, avg/max/min are null", () => {
  assert.equal(H.aggregate({ type: "raw", metric1: "Distance", agg: "sum" }, RUN, []), 0);
  assert.equal(H.aggregate({ type: "raw", metric1: "count" }, RUN, []), 0);
  for (const agg of ["avg", "max", "min"]) {
    assert.equal(H.aggregate({ type: "raw", metric1: "Distance", agg }, RUN, []), null);
  }
});

test("ratio is sum(m1)/sum(m2); zero denominator is null", () => {
  const pace = { type: "ratio", metric1: "Time", metric2: "Distance" };
  assert.equal(H.aggregate(pace, RUN, runs), (1620 + 2700 + 2400) / 12);
  assert.equal(H.aggregate(pace, RUN, []), null);
  assert.equal(H.aggregate(pace, RUN, [rec("2026-09-21", { Distance: 0, Time: 10 })]), null);
  const perRun = { type: "ratio", metric1: "Distance", metric2: "count" };
  assert.equal(H.aggregate(perRun, RUN, runs), 4);
});

test("records missing a metric (added later) are skipped", () => {
  const mixed = [...runs, rec("2026-09-24", { Distance: 2 })];
  assert.equal(H.aggregate({ type: "raw", metric1: "Time", agg: "avg" }, RUN, mixed), 2240);
  assert.equal(H.aggregate({ type: "ratio", metric1: "Time", metric2: "Distance" }, RUN, mixed), 6720 / 12);
});

test("isMet: atLeast >=, atMost <=, null depends on direction", () => {
  assert.equal(H.isMet("atLeast", 15, 15), true);
  assert.equal(H.isMet("atLeast", 14.9, 15), false);
  assert.equal(H.isMet("atMost", 3, 3), true);
  assert.equal(H.isMet("atMost", 4, 3), false);
  assert.equal(H.isMet("atLeast", null, 0), false);
  assert.equal(H.isMet("atMost", null, 0), true);
});

test("goalDirection: explicit direction overrides habit type", () => {
  assert.equal(H.goalDirection({}, RUN), "atLeast");
  assert.equal(H.goalDirection({}, SMOKE), "atMost");
  assert.equal(H.goalDirection({ direction: "atMost" }, RUN), "atMost");
  assert.equal(H.goalDirection({ direction: "atLeast" }, SMOKE), "atLeast");
});

test("per-goal direction drives status, streak and labels", () => {
  const g = { period: "week", type: "raw", metric1: "Distance", agg: "sum", target: 12, direction: "atMost" };
  // runs total 12 mi in the week of 2026-09-20, which is <= 12
  assert.equal(H.currentStatus(g, RUN, runs, "2026-09-25").met, true);
  assert.match(H.goalLabel(g, RUN), /≤/);
  assert.match(H.goalSentence(g, RUN), /≤/);
  const cap = { period: "day", type: "raw", metric1: "count", target: 1, direction: "atLeast" };
  // a NEGATIVE habit goal with "at least" treats an empty day as not met
  assert.equal(H.currentStatus(cap, SMOKE, [], "2026-09-25").met, false);
});

test("dailyValues gives null for days without records", () => {
  const g = { type: "raw", metric1: "Distance", agg: "sum" };
  const days = ["2026-09-20", "2026-09-21", "2026-09-22"];
  assert.deepEqual(H.dailyValues(g, RUN, runs, days), [null, 3, 5]);
});

test("currentStatus reflects progress so far", () => {
  const g = { period: "week", type: "raw", metric1: "Distance", agg: "sum", target: 10 };
  assert.deepEqual(H.currentStatus(g, RUN, runs, "2026-09-24"), { value: 12, met: true });
  assert.deepEqual(H.currentStatus({ ...g, target: 15 }, RUN, runs, "2026-09-24"), { value: 12, met: false });
  assert.deepEqual(H.currentStatus(g, RUN, runs, "2026-09-27"), { value: 0, met: false });
});

// ─── streaks ───────────────────────────────────────────────────────────────
test("streak counts completed periods only, back to first record", () => {
  const g = { period: "day", type: "raw", metric1: "count", target: 1 };
  const r = ["2026-09-20", "2026-09-21", "2026-09-22", "2026-09-23", "2026-09-25"].map((d) => rec(d));
  // today 2026-09-25 (met, but in progress) → yesterday 24th missing → 0
  assert.equal(H.streak(g, RUN, r, "2026-09-25"), 0);
  // today 24th → 23,22,21,20 met → 4 (stops at first record)
  assert.equal(H.streak(g, RUN, r, "2026-09-24"), 4);
});

test("streak with gaps breaks at the gap (POSITIVE)", () => {
  const g = { period: "week", type: "raw", metric1: "count", target: 1 };
  const r = ["2026-08-30", "2026-09-06", "2026-09-20"].map((d) => rec(d)); // week of 13th empty
  assert.equal(H.streak(g, RUN, r, "2026-09-28"), 1);
  assert.equal(H.streak(g, RUN, r, "2026-09-15"), 2);
});

test("NEGATIVE: empty periods count as met", () => {
  const g = { period: "day", type: "raw", metric1: "count", target: 0 };
  const r = [rec("2026-09-10")];
  // 11th..24th empty (14 days met); 10th had one (not met) → 14
  assert.equal(H.streak(g, SMOKE, r, "2026-09-25"), 14);
  const lenient = { ...g, target: 1 };
  assert.equal(H.streak(lenient, SMOKE, r, "2026-09-25"), 15);
});

test("streak with a single record in the current period is 0", () => {
  const g = { period: "week", type: "raw", metric1: "count", target: 1 };
  assert.equal(H.streak(g, RUN, [rec("2026-09-22")], "2026-09-24"), 0);
  assert.equal(H.streak(g, RUN, [], "2026-09-24"), 0);
});

test("streak crosses month and year boundaries", () => {
  const g = { period: "month", type: "raw", metric1: "count", target: 1 };
  const r = ["2025-11-15", "2025-12-31", "2026-01-01"].map((d) => rec(d));
  assert.equal(H.streak(g, RUN, r, "2026-02-10"), 3);
});

test("no streak for all-time goals", () => {
  assert.equal(H.streak({ period: "all", type: "raw", metric1: "count", target: 1 }, RUN, runs, "2026-09-24"), null);
});

// ─── calendar ──────────────────────────────────────────────────────────────
test("monthGrid pads to Sunday-start weeks", () => {
  const sep = H.monthGrid(2026, 8); // Sep 2026 starts on Tuesday
  assert.equal(sep.length, 5);
  assert.deepEqual(sep[0], [null, null, "2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-05"]);
  assert.equal(sep[4][3], "2026-09-30");
  assert.equal(sep[4][4], null);
  const feb = H.monthGrid(2026, 1); // Feb 2026 starts on Sunday, 28 days
  assert.equal(feb.length, 4);
  assert.equal(feb[0][0], "2026-02-01");
});

// ─── trend & detail ────────────────────────────────────────────────────────
test("linearTrend recovers slope and intercept", () => {
  const t = H.linearTrend([{ x: 0, y: 1 }, { x: 1, y: 3 }, { x: 2, y: 5 }]);
  assert.equal(t.slope, 2);
  assert.equal(t.intercept, 1);
  assert.equal(H.linearTrend([{ x: 0, y: 1 }]), null);
  assert.equal(H.linearTrend([{ x: 1, y: 1 }, { x: 1, y: 2 }]), null);
});

test("detailBuckets clips to earliest record, marks partial, fits complete buckets", () => {
  const g = { period: "day", type: "raw", metric1: "Distance", agg: "sum", target: 3 };
  const d = H.detailBuckets(g, RUN, runs, "week", "2026-09-24");
  assert.deepEqual(d.buckets.map((b) => b.key), ["2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24"]);
  assert.equal(d.buckets[3].partial, true);
  assert.equal(d.buckets[3].value, 0);
  // fit over 3,5,4 → slope 0.5
  assert.equal(d.trend.slope, 0.5);
  assert.deepEqual(d.targetLine, { value: 3, pace: false });
});

test("detail trend needs two complete buckets", () => {
  const g = { period: "day", type: "raw", metric1: "count", target: 1 };
  assert.equal(H.detailBuckets(g, RUN, [rec("2026-09-23")], "week", "2026-09-24").trend, null);
  assert.equal(H.detailBuckets(g, RUN, [], "all", "2026-09-24").buckets.length, 0);
});

test("targetLine: intensive direct, totals prorated, none for all-time sum", () => {
  const sumWeek = { period: "week", type: "raw", metric1: "Distance", agg: "sum", target: 14 };
  assert.deepEqual(H.targetLine(sumWeek, "week"), { value: 14, pace: false });
  assert.deepEqual(H.targetLine(sumWeek, "day"), { value: 2, pace: true });
  assert.equal(H.targetLine({ ...sumWeek, period: "all" }, "day"), null);
  assert.deepEqual(H.targetLine({ ...sumWeek, agg: "avg" }, "month"), { value: 14, pace: false });
  assert.deepEqual(H.targetLine({ type: "ratio", metric1: "Time", metric2: "Distance", period: "all", target: 540 }, "day"), { value: 540, pace: false });
});

// ─── formatting ────────────────────────────────────────────────────────────
test("duration format / parse", () => {
  assert.equal(H.formatDuration(3725), "1:02:05");
  assert.equal(H.formatDuration(540), "9:00");
  assert.equal(H.parseDuration("1:02:05"), 3725);
  assert.equal(H.parseDuration("09:00"), 540);
  assert.equal(H.parseDuration("45"), 45);
  assert.ok(Number.isNaN(H.parseDuration("1:xx")));
  assert.ok(Number.isNaN(H.parseDuration("")));
});

test("ratio display rules", () => {
  const pace = { type: "ratio", metric1: "Time", metric2: "Distance" };
  assert.equal(H.formatValue(pace, RUN, 540), "9:00 /mi");
  const speed = { type: "ratio", metric1: "Distance", metric2: "Time" };
  assert.equal(H.formatValue(speed, RUN, 6 / 3600), "6 mi/h");
  const both = { type: "ratio", metric1: "Time", metric2: "Time" };
  assert.equal(H.formatValue(both, RUN, 1), "1");
  assert.equal(H.formatValue({ type: "raw", metric1: "Distance", agg: "sum" }, RUN, 15), "15 mi");
  assert.equal(H.formatValue({ type: "raw", metric1: "Time", agg: "sum" }, RUN, 3600), "1:00:00");
  assert.equal(H.formatValue(pace, RUN, null), "—");
});

test("goal label and sentence", () => {
  const g = { period: "week", type: "raw", metric1: "Distance", agg: "sum", target: 15 };
  assert.equal(H.goalLabel(g, RUN), "Distance · sum · week ≥ 15 mi");
  assert.equal(H.goalSentence(g, RUN), "Met when weekly total of Distance ≥ 15 mi");
  assert.equal(H.goalSentence({ period: "day", type: "raw", metric1: "count", target: 0 }, SMOKE), "Met when daily number of records ≤ 0");
  assert.equal(H.streakLabel("week", 1), "1 week");
  assert.equal(H.streakLabel("day", 3), "3 days");
});
