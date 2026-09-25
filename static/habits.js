// ─── Habits page ──────────────────────────────────────────────────────────────
// Loaded after app.js and shares its globals (escapeHtml, DRAG_HANDLE_SVG).
const Habits = (() => {
  const hs = {
    loaded: false,
    habits: {},
    records: {},
  };

  async function api(path, options = {}) {
    const res = await fetch(path, options);
    if (!res.ok) {
      let detail = res.statusText;
      try {
        detail = (await res.json()).detail || detail;
      } catch {}
      const err = new Error(detail);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  async function load() {
    const data = await api("/api/habits");
    hs.habits = data.habits;
    hs.records = data.records;
    hs.loaded = true;
  }

  function render() {
    const board = document.getElementById("habitBoard");
    const names = Object.keys(hs.habits);
    if (!names.length) {
      board.innerHTML = `<div class="empty-state">No habits yet. Click <strong>+ Add Habit</strong> to start tracking one.</div>`;
      return;
    }
    board.innerHTML = names.map((n) => `<div class="habit-row">${escapeHtml(n)}</div>`).join("");
  }

  // Called by setPage() whenever the Habits tab is shown; data is fetched the
  // first time only.
  async function show() {
    if (hs.loaded) return render();
    try {
      await load();
      render();
    } catch {
      document.getElementById("habitBoard").innerHTML =
        `<div class="empty-state">Couldn't load habits.</div>`;
    }
  }

  return { show };
})();
