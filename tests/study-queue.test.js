// Run with: node --test tests/
const test = require("node:test");
const assert = require("node:assert/strict");
const Q = require("../static/study-queue.js");

const card = (id, fails = 0) => ({ id, front: id, back: id, fails });

// Deterministic PRNG so shuffles are reproducible.
function seeded(seed) {
  return () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
}

// ─── order ─────────────────────────────────────────────────────────────────
test("order puts most-failed cards first", () => {
  const cards = [card("a", 0), card("b", 5), card("c", 2), card("d", 5), card("e")];
  const ids = Q.order(cards, seeded(1)).map((c) => c.id);
  assert.deepEqual(new Set(ids.slice(0, 2)), new Set(["b", "d"]));
  assert.equal(ids[2], "c");
  assert.deepEqual(new Set(ids.slice(3)), new Set(["a", "e"]));
});

test("order shuffles within a fail group", () => {
  const cards = "abcdefgh".split("").map((id) => card(id));
  const seen = new Set();
  for (let s = 1; s <= 20; s++) seen.add(Q.order(cards, seeded(s)).map((c) => c.id).join(""));
  assert.ok(seen.size > 1, "different seeds should give different orders");
});

test("order treats missing fails as 0 and does not mutate input", () => {
  const cards = [{ id: "x" }, card("y", 1)];
  const copy = JSON.parse(JSON.stringify(cards));
  assert.deepEqual(Q.order(cards, seeded(3)).map((c) => c.id), ["y", "x"]);
  assert.deepEqual(cards, copy);
});

// ─── session ───────────────────────────────────────────────────────────────
test("knew removes the card; session ends when all are known", () => {
  const s = Q.start([card("a"), card("b")], seeded(1));
  assert.equal(s.total, 2);
  const first = Q.current(s).id;
  Q.answer(s, true);
  assert.deepEqual(s.known, [first]);
  assert.ok(!Q.done(s));
  Q.answer(s, true);
  assert.ok(Q.done(s));
  assert.equal(Q.current(s), null);
  assert.deepEqual(s.misses, {});
});

test("new sends the card to the back and counts the miss", () => {
  const s = Q.start([card("a", 3), card("b", 1), card("c", 0)], seeded(1));
  assert.equal(Q.current(s).id, "a");
  Q.answer(s, false);
  assert.deepEqual(s.queue.map((c) => c.id), ["b", "c", "a"]);
  Q.answer(s, true); // b
  Q.answer(s, true); // c
  assert.equal(Q.current(s).id, "a");
  Q.answer(s, false); // a again, alone: comes straight back
  assert.equal(Q.current(s).id, "a");
  Q.answer(s, true);
  assert.ok(Q.done(s));
  assert.deepEqual(s.misses, { a: 2 });
  assert.deepEqual(s.known, ["b", "c", "a"]);
});

test("answer on an empty session is a no-op", () => {
  const s = Q.start([]);
  Q.answer(s, false);
  assert.ok(Q.done(s));
  assert.deepEqual(s.known, []);
});

// ─── snapshot / resume ─────────────────────────────────────────────────────
test("snapshot and resume round-trip a session", () => {
  const cards = [card("a", 2), card("b", 1), card("c")];
  const s = Q.start(cards, seeded(1));
  Q.answer(s, false); // a to the back
  Q.answer(s, true); // b known
  const saved = JSON.parse(JSON.stringify(Q.snapshot(s)));
  assert.deepEqual(saved, { queue: ["c", "a"], known: ["b"], misses: { a: 1 } });
  const r = Q.resume(saved, cards);
  assert.deepEqual(r.queue.map((c) => c.id), ["c", "a"]);
  assert.equal(r.queue[1], cards[0], "queue holds the deck's card objects");
  assert.deepEqual(r.known, ["b"]);
  assert.deepEqual(r.misses, { a: 1 });
  assert.equal(r.total, 3);
});

test("snapshot does not share state with the session", () => {
  const s = Q.start([card("a"), card("b")], seeded(1));
  const saved = Q.snapshot(s);
  Q.answer(s, false);
  assert.deepEqual(saved.misses, {});
  Q.answer(s, true);
  assert.deepEqual(saved.known, []);
});

test("resume reconciles deleted and added cards", () => {
  const saved = { queue: ["b", "gone1", "c"], known: ["a", "gone2"], misses: { b: 1, gone1: 3 } };
  const cards = [card("a"), card("b"), card("c"), card("new1"), card("new2", 4)];
  const r = Q.resume(saved, cards, seeded(1));
  assert.deepEqual(r.queue.map((c) => c.id), ["b", "c", "new2", "new1"]);
  assert.deepEqual(r.known, ["a"]);
  assert.deepEqual(r.misses, { b: 1 });
  assert.equal(r.total, 5);
});

test("resume ignores duplicates and ids both known and queued", () => {
  const r = Q.resume({ queue: ["a", "b", "b"], known: ["a", "a"] }, [card("a"), card("b")]);
  assert.deepEqual(r.queue.map((c) => c.id), ["b"]);
  assert.deepEqual(r.known, ["a"]);
  assert.deepEqual(r.misses, {});
  assert.equal(r.total, 2);
});

test("resume with every remaining card deleted is done", () => {
  const r = Q.resume({ queue: ["x"], known: ["a"] }, [card("a")]);
  assert.ok(Q.done(r));
  assert.equal(r.total, 1);
});
