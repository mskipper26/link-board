// ─── Study session queue ──────────────────────────────────────────────────────
// DOM-free so it can be unit tested under Node (tests/study-queue.test.js).
// UMD: browser global `StudyQueue`, or module.exports under Node.
//
// A session starts with every card in the deck, most-failed first (ties
// shuffled). "Knew it" removes the front card; "new to me" sends it to the back
// to come around again. The session is done when the queue is empty.
//
// snapshot()/resume() convert to and from the saved form (card ids only), so
// a session can be stored with the deck and picked up later.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.StudyQueue = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Most-failed first; cards with equal counts are shuffled (Fisher–Yates,
  // then a stable sort keeps the shuffle within each group).
  function order(cards, random = Math.random) {
    const out = cards.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out.sort((a, b) => (b.fails || 0) - (a.fails || 0));
  }

  function start(cards, random = Math.random) {
    return {
      queue: order(cards, random),
      total: cards.length,
      known: [], // ids marked "knew it" this session
      misses: {}, // card id -> times marked "new" this session
    };
  }

  // Saved form: {queue: [ids], known: [ids], misses}.
  function snapshot(session) {
    return {
      queue: session.queue.map((c) => c.id),
      known: session.known.slice(),
      misses: { ...session.misses },
    };
  }

  // Rebuild a saved session against the deck's current cards: deleted cards
  // drop out, edited ones show their latest text, and cards added since go to
  // the back of the queue (most-failed first).
  function resume(saved, cards, random = Math.random) {
    const byId = new Map(cards.map((c) => [c.id, c]));
    const known = [...new Set((saved.known || []).filter((id) => byId.has(id)))];
    const queue = [];
    const seen = new Set(known);
    for (const id of saved.queue || []) {
      if (byId.has(id) && !seen.has(id)) {
        queue.push(byId.get(id));
        seen.add(id);
      }
    }
    queue.push(...order(cards.filter((c) => !seen.has(c.id)), random));
    const misses = {};
    for (const [id, n] of Object.entries(saved.misses || {})) if (byId.has(id)) misses[id] = n;
    return { queue, total: known.length + queue.length, known, misses };
  }

  function current(session) {
    return session.queue.length ? session.queue[0] : null;
  }

  function answer(session, knew) {
    const card = session.queue.shift();
    if (!card) return;
    if (knew) {
      session.known.push(card.id);
    } else {
      session.misses[card.id] = (session.misses[card.id] || 0) + 1;
      session.queue.push(card);
    }
  }

  function done(session) {
    return session.queue.length === 0;
  }

  return { order, start, snapshot, resume, current, answer, done };
});
