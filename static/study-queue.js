// ─── Study session queue ──────────────────────────────────────────────────────
// DOM-free so it can be unit tested under Node (tests/study-queue.test.js).
// UMD: browser global `StudyQueue`, or module.exports under Node.
//
// A session starts with every card in the deck, most-failed first (ties
// shuffled). "Knew it" removes the front card; "new to me" sends it to the back
// to come around again. The session is done when the queue is empty.
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
      known: 0,
      misses: {}, // card id -> times marked "new" this session
    };
  }

  function current(session) {
    return session.queue.length ? session.queue[0] : null;
  }

  function answer(session, knew) {
    const card = session.queue.shift();
    if (!card) return;
    if (knew) {
      session.known += 1;
    } else {
      session.misses[card.id] = (session.misses[card.id] || 0) + 1;
      session.queue.push(card);
    }
  }

  function done(session) {
    return session.queue.length === 0;
  }

  return { order, start, current, answer, done };
});
