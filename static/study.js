// ─── Study page (flash cards) ─────────────────────────────────────────────────
// Loaded after app.js and shares its globals (escapeHtml). Session ordering
// lives in study-queue.js (StudyQueue). Decks are addressed by their stable
// slug; the server keeps one JSON file per deck.
const Study = (() => {
  const Q = StudyQueue;

  const ss = {
    loaded: false,
    decks: [],       // [{slug, name, cards: [{id, front, back, fails}]}], sorted by name
    session: null,   // {slug, name, q: StudyQueue session, flipped, error}
    menu: null,      // open overlay: {refresh?}
  };

  const esc = (v) => escapeHtml(v === null || v === undefined ? "" : String(v));
  const enc = encodeURIComponent;
  const plural = (n, word, many = word + "s") => `${n} ${n === 1 ? word : many}`;

  // ─── API ────────────────────────────────────────────────────────────────────
  async function api(path, options = {}) {
    if (options.body && typeof options.body !== "string") {
      options = {
        ...options,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(options.body),
      };
    }
    const res = await fetch(path, options);
    if (!res.ok) {
      let detail = res.statusText;
      try {
        detail = (await res.json()).detail || detail;
      } catch {}
      const err = new Error(typeof detail === "string" ? detail : "Request failed");
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  async function load() {
    ss.decks = await api("/api/decks");
    ss.loaded = true;
  }

  // Re-fetch after any change, then redraw the board and the open menu.
  async function refresh() {
    await load();
    render();
    if (ss.menu && ss.menu.refresh) ss.menu.refresh();
  }

  function deck(slug) {
    return ss.decks.find((d) => d.slug === slug) || null;
  }

  function board() {
    return document.getElementById("studyBoard");
  }

  // ─── Board: deck grid, or the running session ───────────────────────────────
  function render() {
    if (ss.session) return renderSession();
    const el = board();
    el.innerHTML = "";
    if (!ss.decks.length) {
      el.innerHTML = `<div class="empty-state">No decks yet. Click <strong>+ New Deck</strong> to make one.</div>`;
      return;
    }
    const grid = document.createElement("div");
    grid.className = "deck-grid";
    for (const d of ss.decks) grid.appendChild(createDeckTile(d));
    el.appendChild(grid);
  }

  function createDeckTile(d) {
    const tile = document.createElement("section");
    tile.className = "deck-tile";
    const tricky = d.cards.filter((c) => c.fails > 0).length;
    tile.innerHTML = `
      <div class="deck-head">
        <h2 class="deck-name">${esc(d.name)}</h2>
        <button class="icon-btn" data-act="edit" title="Rename or delete deck" aria-label="Rename or delete deck">✎</button>
      </div>
      <div class="deck-meta">
        <span>${plural(d.cards.length, "card")}</span>
        ${tricky ? `<span class="badge badge-neg" title="Cards you've marked “new to me” at least once — they come first">${tricky} tricky</span>` : ""}
      </div>
      <div class="deck-actions">
        <button class="btn-primary btn-sm" data-act="study"${d.cards.length ? "" : " disabled"}>Study</button>
        <button class="btn-secondary btn-sm" data-act="cards">${d.cards.length ? "Cards" : "+ Add cards"}</button>
      </div>`;
    tile.querySelector('[data-act="study"]').addEventListener("click", () => startSession(d.slug));
    tile.querySelector('[data-act="cards"]').addEventListener("click", () => openCards(d.slug));
    tile.querySelector('[data-act="edit"]').addEventListener("click", () => openDeckForm(d.slug));
    return tile;
  }

  // ─── Session ────────────────────────────────────────────────────────────────
  function startSession(slug) {
    const d = deck(slug);
    if (!d || !d.cards.length) return;
    ss.session = { slug, name: d.name, q: Q.start(d.cards), flipped: false, error: "" };
    render();
  }

  // Leaving re-fetches so the deck tiles show the updated fail counts.
  function endSession() {
    ss.session = null;
    refresh().catch(() => render());
  }

  function renderSession() {
    const s = ss.session;
    const el = board();
    if (Q.done(s.q)) return renderSummary();
    const card = Q.current(s.q);
    const retry = s.q.misses[card.id];
    const pct = s.q.total ? (s.q.known / s.q.total) * 100 : 0;
    const retries = s.q.queue.filter((c) => s.q.misses[c.id]).length;

    el.innerHTML = `
      <div class="study-session">
        <div class="session-head">
          <button class="btn-secondary btn-sm" data-act="quit">← Decks</button>
          <h2 class="session-title">${esc(s.name)}</h2>
          <span class="session-count">${s.q.known} / ${s.q.total} known${retries ? ` · ${retries} to retry` : ""}</span>
        </div>
        <div class="session-track"><div class="session-fill" style="width:${pct.toFixed(1)}%"></div></div>
        <div class="flashcard${s.flipped ? " flipped" : ""}" tabindex="0">
          <div class="fc-tags">
            ${retry ? `<span class="badge badge-neg">retry</span>` : ""}
            ${card.fails ? `<span class="fc-fails">missed ${plural(card.fails, "time")}</span>` : ""}
          </div>
          <div class="fc-side">
            <div class="fc-label">Front</div>
            <div class="fc-text">${esc(card.front)}</div>
          </div>
          ${s.flipped ? `
          <div class="fc-side fc-back">
            <div class="fc-label">Back</div>
            <div class="fc-text">${esc(card.back)}</div>
          </div>` : `<div class="fc-reveal">Click or press Space to show the answer</div>`}
        </div>
        <div class="session-actions">
          ${s.flipped ? `
            <button class="btn-miss" data-act="new">New to me <kbd>1</kbd></button>
            <button class="btn-knew" data-act="knew">Knew it <kbd>2</kbd></button>` : `
            <button class="btn-primary" data-act="flip">Show answer <kbd>Space</kbd></button>`}
        </div>
        <div class="save-error${s.error ? "" : " hidden"}">${esc(s.error)}</div>
      </div>`;

    el.querySelector('[data-act="quit"]').addEventListener("click", endSession);
    const fc = el.querySelector(".flashcard");
    if (!s.flipped) {
      fc.addEventListener("click", flip);
      el.querySelector('[data-act="flip"]').addEventListener("click", flip);
    } else {
      el.querySelector('[data-act="new"]').addEventListener("click", () => respond(false));
      el.querySelector('[data-act="knew"]').addEventListener("click", () => respond(true));
    }
  }

  function flip() {
    if (!ss.session || ss.session.flipped) return;
    ss.session.flipped = true;
    renderSession();
  }

  function respond(knew) {
    const s = ss.session;
    if (!s || !s.flipped || Q.done(s.q)) return;
    const card = Q.current(s.q);
    Q.answer(s.q, knew);
    s.flipped = false;
    s.error = "";
    if (!knew) {
      // Save in the background; the session carries on either way.
      api(`/api/decks/${enc(s.slug)}/cards/${enc(card.id)}/fail`, { method: "POST" })
        .then((r) => {
          card.fails = r.fails;
        })
        .catch((e) => {
          if (ss.session !== s) return;
          s.error = `Couldn't save the miss for this card: ${e.message}`;
          renderSession();
        });
    }
    renderSession();
  }

  function renderSummary() {
    const s = ss.session;
    const missed = Object.entries(s.q.misses).sort((a, b) => b[1] - a[1]);
    const byId = Object.fromEntries(deck(s.slug)?.cards.map((c) => [c.id, c]) || []);
    const rows = missed
      .map(([id, n]) => {
        const c = byId[id];
        if (!c) return "";
        return `<li><span class="sum-front">${esc(c.front)}</span><span class="muted">${plural(n, "miss", "misses")}</span></li>`;
      })
      .join("");
    board().innerHTML = `
      <div class="study-session">
        <div class="session-head">
          <button class="btn-secondary btn-sm" data-act="quit">← Decks</button>
          <h2 class="session-title">${esc(s.name)}</h2>
        </div>
        <div class="session-summary">
          <div class="sum-title">Deck complete</div>
          <div class="sum-line">${plural(s.q.total, "card")} ·
            ${missed.length ? `${missed.length} new to you this session` : "you knew every one first try"}</div>
          ${rows ? `<ul class="sum-list">${rows}</ul>` : ""}
          <div class="sum-actions">
            <button class="btn-secondary" data-act="quit2">Back to decks</button>
            <button class="btn-primary" data-act="again">Study again</button>
          </div>
        </div>
        <div class="save-error${s.error ? "" : " hidden"}">${esc(s.error)}</div>
      </div>`;
    board().querySelector('[data-act="quit"]').addEventListener("click", endSession);
    board().querySelector('[data-act="quit2"]').addEventListener("click", endSession);
    board().querySelector('[data-act="again"]').addEventListener("click", async () => {
      // Re-fetch first so the new session orders by the updated fail counts.
      const slug = s.slug;
      ss.session = null;
      try {
        await load();
      } catch {}
      if (deck(slug)?.cards.length) startSession(slug);
      else render();
    });
  }

  // ─── Menu (one overlay, same look as the habit menus) ───────────────────────
  function menuEl() {
    return document.getElementById("studyOverlay");
  }

  function openMenu({ title, body, footer = "", wide = false }) {
    const el = menuEl();
    const panel = el.querySelector(".overlay-panel");
    panel.className = "overlay-panel habit-panel" + (wide ? " wide" : "");
    panel.innerHTML = `
      <div class="overlay-header"><h2 class="overlay-title">${title}</h2></div>
      <div class="habit-form">${body}</div>
      <div class="overlay-footer"><span class="save-error hidden"></span>${footer}</div>`;
    el.classList.remove("hidden");
    ss.menu = {};
    return panel;
  }

  function closeMenu() {
    const el = menuEl();
    el.classList.add("hidden");
    el.querySelector(".overlay-panel").innerHTML = "";
    ss.menu = null;
  }

  function isMenuOpen() {
    return !menuEl().classList.contains("hidden");
  }

  function showError(panel, msg) {
    const el = panel.querySelector(".overlay-footer .save-error");
    el.textContent = msg;
    el.classList.toggle("hidden", !msg);
  }

  // Run a save: disable the button, surface server errors in the footer.
  async function submit(panel, btn, fn) {
    showError(panel, "");
    btn.disabled = true;
    try {
      await fn();
    } catch (e) {
      showError(panel, e.message || "Failed to save. Please try again.");
    } finally {
      btn.disabled = false;
    }
  }

  // ─── Deck form: create / rename / delete ────────────────────────────────────
  function openDeckForm(slug = null) {
    const d = slug ? deck(slug) : null;
    const panel = openMenu({
      title: d ? `Edit “${esc(d.name)}”` : "New Deck",
      body: `
        <label class="hfield"><span class="hfield-label">Name</span>
          <input class="edit-input d-name" maxlength="60" placeholder="e.g. Spanish Verbs" value="${esc(d ? d.name : "")}">
        </label>`,
      footer: `
        ${d ? `<button class="btn-danger d-delete">Delete deck</button>` : ""}
        <button class="btn-secondary d-cancel">Cancel</button>
        <button class="btn-primary d-save">${d ? "Save" : "Create"}</button>`,
    });
    const input = panel.querySelector(".d-name");
    const saveBtn = panel.querySelector(".d-save");
    const save = () =>
      submit(panel, saveBtn, async () => {
        const name = input.value.trim();
        if (!name) throw new Error("Name is required.");
        if (d) {
          await api(`/api/decks/${enc(slug)}`, { method: "PUT", body: { name } });
          closeMenu();
          await refresh();
        } else {
          const created = await api("/api/decks", { method: "POST", body: { name } });
          await refresh();
          openCards(created.slug); // straight into adding cards
        }
      });
    saveBtn.addEventListener("click", save);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !saveBtn.disabled) save();
    });
    panel.querySelector(".d-cancel").addEventListener("click", closeMenu);
    const del = panel.querySelector(".d-delete");
    if (del) {
      del.addEventListener("click", async () => {
        if (!confirm(`Delete “${d.name}” and its ${plural(d.cards.length, "card")}? The file is kept in decks/.trash.`)) return;
        try {
          await api(`/api/decks/${enc(slug)}`, { method: "DELETE" });
          if (ss.session && ss.session.slug === slug) ss.session = null;
          closeMenu();
          await refresh();
        } catch (e) {
          showError(panel, e.message);
        }
      });
    }
    input.focus();
    input.select();
  }

  // ─── Cards: add / edit / remove, reset fail counts ──────────────────────────
  function openCards(slug) {
    const d = deck(slug);
    if (!d) return;
    const panel = openMenu({
      title: `Cards · ${esc(d.name)}`,
      wide: true,
      body: `
        <div class="card-add">
          <div class="card-sides">
            <label class="hfield"><span class="hfield-label">Front</span>
              <textarea class="edit-input c-front" maxlength="2000" rows="2" placeholder="Question / term"></textarea></label>
            <label class="hfield"><span class="hfield-label">Back</span>
              <textarea class="edit-input c-back" maxlength="2000" rows="2" placeholder="Answer / definition"></textarea></label>
          </div>
          <div class="card-add-row">
            <span class="hint">Ctrl+Enter to add</span>
            <button class="btn-add btn-sm c-add">+ Add card</button>
          </div>
        </div>
        <div class="fc-list"></div>`,
      footer: `
        <button class="btn-danger c-reset">Reset fail counts</button>
        <button class="btn-secondary c-close">Close</button>`,
    });

    const front = panel.querySelector(".c-front");
    const back = panel.querySelector(".c-back");
    const addBtn = panel.querySelector(".c-add");
    const add = () =>
      submit(panel, addBtn, async () => {
        const body = { front: front.value.trim(), back: back.value.trim() };
        if (!body.front || !body.back) throw new Error("Both sides need text.");
        await api(`/api/decks/${enc(slug)}/cards`, { method: "POST", body });
        front.value = "";
        back.value = "";
        front.focus();
        await refresh();
      });
    addBtn.addEventListener("click", add);
    for (const ta of [front, back]) {
      ta.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          add();
        }
      });
    }

    panel.querySelector(".c-close").addEventListener("click", closeMenu);
    const resetBtn = panel.querySelector(".c-reset");
    resetBtn.addEventListener("click", () => {
      const cur = deck(slug);
      if (!cur || !confirm(`Reset the fail count of every card in “${cur.name}” to 0?`)) return;
      submit(panel, resetBtn, async () => {
        await api(`/api/decks/${enc(slug)}/reset`, { method: "POST" });
        await refresh();
      });
    });

    const list = panel.querySelector(".fc-list");
    let editing = null; // id of the card being edited inline

    const fill = () => {
      const cur = deck(slug);
      if (!cur) return closeMenu();
      resetBtn.disabled = !cur.cards.some((c) => c.fails > 0);
      if (!cur.cards.length) {
        list.innerHTML = `<div class="empty-state small">No cards yet — add the first one above.</div>`;
        return;
      }
      list.innerHTML = `<div class="hfield-label">${plural(cur.cards.length, "card")}</div>` +
        cur.cards
          .map((c) =>
            c.id === editing
              ? `
            <div class="fc-item editing" data-id="${esc(c.id)}">
              <div class="card-sides">
                <textarea class="edit-input e-front" maxlength="2000" rows="2">${esc(c.front)}</textarea>
                <textarea class="edit-input e-back" maxlength="2000" rows="2">${esc(c.back)}</textarea>
              </div>
              <div class="fc-item-actions">
                <button class="btn-secondary btn-sm e-cancel">Cancel</button>
                <button class="btn-primary btn-sm e-save">Save</button>
              </div>
            </div>`
              : `
            <div class="fc-item" data-id="${esc(c.id)}">
              <div class="fc-item-text">${esc(c.front)}</div>
              <div class="fc-item-text muted">${esc(c.back)}</div>
              <span class="fc-item-fails${c.fails ? " has" : ""}" title="Times marked “new to me”">${c.fails ? `✕${c.fails}` : ""}</span>
              <button class="icon-btn e-edit" title="Edit card" aria-label="Edit card">✎</button>
              <button class="remove-btn e-del" title="Remove card" aria-label="Remove card">✕</button>
            </div>`
          )
          .join("");

      list.querySelectorAll(".fc-item").forEach((el) => {
        const id = el.dataset.id;
        const c = cur.cards.find((x) => x.id === id);
        if (el.classList.contains("editing")) {
          const ef = el.querySelector(".e-front");
          const eb = el.querySelector(".e-back");
          const saveBtn = el.querySelector(".e-save");
          const save = () =>
            submit(panel, saveBtn, async () => {
              const body = { front: ef.value.trim(), back: eb.value.trim() };
              if (!body.front || !body.back) throw new Error("Both sides need text.");
              await api(`/api/decks/${enc(slug)}/cards/${enc(id)}`, { method: "PUT", body });
              editing = null;
              await refresh();
            });
          saveBtn.addEventListener("click", save);
          for (const ta of [ef, eb]) {
            ta.addEventListener("keydown", (e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                save();
              } else if (e.key === "Escape") {
                e.stopPropagation(); // cancel the edit, not the whole menu
                editing = null;
                fill();
              }
            });
          }
          el.querySelector(".e-cancel").addEventListener("click", () => {
            editing = null;
            fill();
          });
          ef.focus();
          return;
        }
        el.querySelector(".e-edit").addEventListener("click", () => {
          editing = id;
          fill();
        });
        el.querySelector(".e-del").addEventListener("click", async () => {
          if (!confirm(`Remove the card “${c.front.slice(0, 60)}”?`)) return;
          try {
            await api(`/api/decks/${enc(slug)}/cards/${enc(id)}`, { method: "DELETE" });
            await refresh();
          } catch (e) {
            showError(panel, e.message);
          }
        });
      });
    };
    ss.menu.refresh = fill;
    fill();
    front.focus();
  }

  // ─── Init ───────────────────────────────────────────────────────────────────
  function isShown() {
    return !board().classList.contains("hidden");
  }

  function init() {
    document.getElementById("addDeckBtn").addEventListener("click", () => openDeckForm());
    menuEl().addEventListener("click", (e) => {
      if (e.target === menuEl()) closeMenu();
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        if (isMenuOpen()) closeMenu();
        return;
      }
      // Session shortcuts: Space/Enter flip, 1/← new, 2/→ knew.
      if (!ss.session || !isShown() || isMenuOpen() || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.target.closest && e.target.closest("input, textarea, select, button")) {
        // Let buttons handle their own Space/Enter; other keys still count.
        if (e.key === " " || e.key === "Enter") return;
      }
      const s = ss.session;
      if (!s.flipped && (e.key === " " || e.key === "Enter")) {
        e.preventDefault();
        flip();
      } else if (s.flipped && (e.key === "1" || e.key === "ArrowLeft")) {
        e.preventDefault();
        respond(false);
      } else if (s.flipped && (e.key === "2" || e.key === "ArrowRight")) {
        e.preventDefault();
        respond(true);
      }
    });
  }

  // Called by setPage() whenever the Study tab is shown; data is fetched the
  // first time only.
  async function show() {
    if (ss.loaded) return render();
    try {
      await load();
      render();
    } catch {
      board().innerHTML = `<div class="empty-state">Couldn't load decks.</div>`;
    }
  }

  document.addEventListener("DOMContentLoaded", init);

  return { show };
})();
