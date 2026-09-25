// ─── Habits page ──────────────────────────────────────────────────────────────
// Loaded after app.js and shares its globals (escapeHtml, DRAG_HANDLE_SVG).
// All period/aggregation math lives in habit-math.js (HabitMath).
const Habits = (() => {
  const H = HabitMath;

  const hs = {
    loaded: false,
    habits: {},   // name -> config (key order = display order)
    records: {},  // name -> [{ts, values}] in CSV order (index = record id)
    calMonth: {}, // name -> {y, m} month shown in that row's calendar
    layers: { overlay: null, dialog: null }, // open menus: {refresh?}
    dragName: null,
    dragOrigin: null,
  };

  const GOAL_COLORS = ["#58a6ff", "#3fb950", "#d29922", "#f85149", "#bc8cff", "#39c5cf", "#f778ba", "#ffa657"];
  const PERIOD_OPTS = [["day", "Day"], ["week", "Week"], ["month", "Month"], ["year", "Year"], ["all", "All time"]];
  const AGG_OPTS = [["sum", "Sum"], ["avg", "Average"], ["max", "Max"], ["min", "Min"]];
  const DAY_INITIALS = ["S", "M", "T", "W", "T", "F", "S"];

  const esc = (v) => escapeHtml(v === null || v === undefined ? "" : String(v));
  const enc = encodeURIComponent;
  const pad = (n) => String(n).padStart(2, "0");

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
    const data = await api("/api/habits");
    hs.habits = data.habits;
    hs.records = data.records;
    hs.loaded = true;
  }

  // Re-fetch after any change, then redraw the board and any open menu that
  // knows how to refresh itself.
  async function refresh() {
    await load();
    render();
    for (const which of ["overlay", "dialog"]) {
      const layer = hs.layers[which];
      if (layer && layer.refresh) layer.refresh();
    }
  }

  // Whole-habit config for PUT /api/habits/{name}; metrics carry `was` so the
  // server keeps their CSV columns.
  function habitBody(habit, patch = {}) {
    return {
      type: habit.type,
      occurs: habit.occurs,
      metrics: habit.metrics.map((m) => ({ ...m, was: m.name })),
      goals: habit.goals,
      ...patch,
    };
  }

  // ─── Board ──────────────────────────────────────────────────────────────────
  function render() {
    const board = document.getElementById("habitBoard");
    board.innerHTML = "";
    const names = Object.keys(hs.habits);
    if (!names.length) {
      board.innerHTML = `<div class="empty-state">No habits yet. Click <strong>+ Add Habit</strong> to start tracking one.</div>`;
      return;
    }
    const today = H.todayKey();
    for (const name of names) board.appendChild(createRow(name, today));
  }

  function createRow(name, today) {
    const habit = hs.habits[name];
    const records = hs.records[name] || [];
    const row = document.createElement("section");
    row.className = "habit-row";
    row.dataset.name = name;

    const metrics = habit.metrics.length
      ? habit.metrics
          .map((m) => `<li>${esc(m.name)}<span>${m.kind === "duration" ? "h:mm:ss" : esc(m.unit)}</span></li>`)
          .join("")
      : `<li class="muted">Count only</li>`;

    row.innerHTML = `
      <div class="habit-info">
        <h2 class="habit-name">${esc(name)}</h2>
        <div class="habit-badges">
          <span class="badge ${habit.type === "POSITIVE" ? "badge-pos" : "badge-neg"}">${habit.type === "POSITIVE" ? "Positive" : "Negative"}</span>
          <span class="badge">${habit.occurs === "daily" ? "Daily" : "Periodic"}</span>
        </div>
        <ul class="habit-metrics">${metrics}</ul>
        <div class="habit-actions">
          <button class="btn-add btn-sm" data-act="record">+ Record</button>
          <button class="btn-secondary btn-sm" data-act="records">Records</button>
          <button class="icon-btn" data-act="edit" title="Edit habit" aria-label="Edit habit">✎</button>
        </div>
      </div>
      <div class="habit-goals"></div>
      <div class="habit-calendar"></div>
      <div class="drag-handle habit-drag" draggable="true" title="Drag to reorder">${DRAG_HANDLE_SVG}</div>
    `;

    const goalsEl = row.querySelector(".habit-goals");
    habit.goals.forEach((goal, gi) => goalsEl.appendChild(createGoalCell(name, habit, records, goal, gi, today)));
    if (!habit.goals.length) {
      goalsEl.insertAdjacentHTML("beforeend", `<div class="goals-empty">No goals yet — add one to track progress.</div>`);
    }
    const addGoal = document.createElement("button");
    addGoal.className = "add-goal-btn";
    addGoal.textContent = "+ Add goal";
    addGoal.addEventListener("click", () => openGoalForm(name));
    goalsEl.appendChild(addGoal);

    renderCalendar(row, name);

    row.querySelector('[data-act="record"]').addEventListener("click", () => openRecordForm(name));
    row.querySelector('[data-act="records"]').addEventListener("click", () => openRecordsList(name));
    row.querySelector('[data-act="edit"]').addEventListener("click", () => openHabitForm(name));
    setupHabitDrag(row);
    return row;
  }

  // ─── Goal cell: label, MET pill, streak, this week's bars ───────────────────
  function createGoalCell(name, habit, records, goal, gi, today) {
    const cell = document.createElement("div");
    cell.className = "goal-cell";
    cell.dataset.gi = gi;
    cell.style.setProperty("--goal-color", goal.color);
    cell.tabIndex = 0;

    const status = H.currentStatus(goal, habit, records, today);
    const streak = H.streak(goal, habit, records, today);
    const periodWord = goal.period === "all" ? "all time" : `this ${goal.period}`;

    cell.innerHTML = `
      <div class="goal-main">
        <div class="goal-label"><span class="goal-dot"></span><span>${esc(H.goalLabel(goal, habit))}</span></div>
        <div class="goal-status">
          <span class="pill ${status.met ? "pill-met" : "pill-miss"}">${status.met ? "MET" : "NOT MET"}</span>
          <span class="goal-value" title="Value ${periodWord}">${esc(H.formatValue(goal, habit, status.value))}</span>
          ${streak === null ? "" : `<span class="goal-streak" title="Consecutive completed ${goal.period}s met">streak ${esc(H.streakLabel(goal.period, streak))}</span>`}
        </div>
      </div>
      ${weekBarsSvg(goal, habit, records, today)}
    `;

    cell.addEventListener("click", () => openGoalDetail(name, gi));
    cell.addEventListener("keydown", (e) => {
      if (e.key === "Enter") openGoalDetail(name, gi);
    });
    // Hovering a goal isolates its bubbles in the calendar (class toggle only).
    cell.addEventListener("mouseenter", () => isolateGoal(cell.closest(".habit-row"), gi));
    cell.addEventListener("mouseleave", () => isolateGoal(cell.closest(".habit-row"), null));
    return cell;
  }

  // Rounded-top bar: flat bottom at y+h, corners of radius r on top.
  function barPath(x, y, w, h) {
    const r = Math.min(3, w / 2, h);
    return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
  }

  // Sun–Sat of the current week: each bar is that day's value for the goal's
  // metric. Future days are empty; days without records are gaps.
  function weekBarsSvg(goal, habit, records, today) {
    const start = H.weekStart(today);
    const days = [...Array(7)].map((_, i) => H.addDays(start, i));
    const values = H.dailyValues(goal, habit, records, days);
    const max = Math.max(0, ...values.filter((v) => v !== null));
    const W = 124, BAR_H = 34, bw = 12, gap = 17.5;
    const bars = days
      .map((d, i) => {
        const x = 2 + i * gap;
        const future = d > today;
        const v = values[i];
        const title = `${H.MONTHS[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8))}: ${future ? "—" : H.formatValue(goal, habit, v)}`;
        const h = !future && v !== null && v > 0 && max > 0 ? Math.max(2, (v / max) * BAR_H) : 0;
        const bar = h ? `<path d="${barPath(x, BAR_H - h, bw, h)}" class="week-bar${d === today ? " today" : ""}"/>` : "";
        const label = `<text x="${x + bw / 2}" y="${BAR_H + 13}" class="week-initial${d === today ? " today" : ""}">${DAY_INITIALS[i]}</text>`;
        return `<g><title>${esc(title)}</title><rect x="${x - 2}" y="0" width="${bw + 4}" height="${BAR_H + 16}" fill="transparent"/>
          <line x1="${x}" x2="${x + bw}" y1="${BAR_H + 0.5}" y2="${BAR_H + 0.5}" class="week-base"/>${bar}${label}</g>`;
      })
      .join("");
    return `<svg class="week-bars" viewBox="0 0 ${W} ${BAR_H + 16}" width="${W}" height="${BAR_H + 16}" aria-hidden="true">${bars}</svg>`;
  }

  // ─── Calendar ───────────────────────────────────────────────────────────────
  function renderCalendar(row, name) {}

  function isolateGoal(row, gi) {}

  // ─── Goal detail ────────────────────────────────────────────────────────────
  function openGoalDetail(name, gi) {}

  // ─── Drag reorder ───────────────────────────────────────────────────────────
  // Same swap-through-on-dragenter model as the link grid (see app.js), with
  // its own state so the two never interfere.
  function setupHabitDrag(row) {
    const handle = row.querySelector(".habit-drag");
    handle.addEventListener("dragstart", (e) => {
      hs.dragName = row.dataset.name;
      hs.dragOrigin = row.parentElement;
      row.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", row.dataset.name);
      try {
        e.dataTransfer.setDragImage(row, 24, 24);
      } catch {}
    });
    handle.addEventListener("dragend", finishHabitDrag);

    row.addEventListener("dragover", (e) => {
      if (hs.dragName && row.parentElement === hs.dragOrigin) {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
      }
    });
    row.addEventListener("dragenter", () => {
      if (!hs.dragName) return;
      const origin = hs.dragOrigin;
      if (!origin || row.parentElement !== origin) return;
      const dragging = origin.querySelector(".habit-row.dragging");
      if (!dragging || dragging === row) return;
      const rows = [...origin.querySelectorAll(".habit-row")];
      if (rows.indexOf(dragging) < rows.indexOf(row)) origin.insertBefore(dragging, row.nextSibling);
      else origin.insertBefore(dragging, row);
    });
  }

  // Idempotent; also wired to document-level drop/dragend (see init) because
  // the moved source node may never get its own dragend.
  async function finishHabitDrag() {
    if (!hs.dragName) return;
    hs.dragName = null;
    hs.dragOrigin = null;
    document.querySelectorAll(".habit-row.dragging").forEach((r) => r.classList.remove("dragging"));
    const order = [...document.querySelectorAll("#habitBoard .habit-row")].map((r) => r.dataset.name);
    const prev = Object.keys(hs.habits);
    if (order.every((n, i) => n === prev[i])) return;
    const reordered = {};
    for (const n of order) reordered[n] = hs.habits[n];
    hs.habits = reordered;
    try {
      await api("/api/habits/order", { method: "PUT", body: { order } });
    } catch {
      alert("Failed to save new order.");
      await refresh().catch(() => {});
    }
  }

  // ─── Menu layers ────────────────────────────────────────────────────────────
  // Two stacked layers reuse the edit overlay's look: #habitOverlay (z 500) and
  // #habitDialog (z 600). A menu opens in the overlay, or in the dialog when
  // opened from within another menu.
  function layerEl(which) {
    return document.getElementById(which === "dialog" ? "habitDialog" : "habitOverlay");
  }

  function isOpen(which) {
    return !layerEl(which).classList.contains("hidden");
  }

  function openLayer({ title, body, footer = "", headerExtra = "", wide = false }) {
    const which = isOpen("overlay") ? "dialog" : "overlay";
    const el = layerEl(which);
    const panel = el.querySelector(".overlay-panel");
    panel.className = "overlay-panel habit-panel" + (wide ? " wide" : "");
    panel.innerHTML = `
      <div class="overlay-header"><h2 class="overlay-title">${title}</h2>${headerExtra}</div>
      <div class="habit-form">${body}</div>
      <div class="overlay-footer"><span class="save-error hidden"></span>${footer}</div>`;
    el.classList.remove("hidden");
    hs.layers[which] = {};
    panel.dataset.layer = which;
    return panel;
  }

  function closeLayer(which) {
    const el = layerEl(which);
    el.classList.add("hidden");
    el.querySelector(".overlay-panel").innerHTML = "";
    hs.layers[which] = null;
  }

  function closePanel(panel) {
    closeLayer(panel.dataset.layer);
  }

  function setRefresh(panel, fn) {
    const layer = hs.layers[panel.dataset.layer];
    if (layer) layer.refresh = fn;
  }

  function showError(panel, msg) {
    const el = panel.querySelector(".save-error");
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

  function seg(name, options, value) {
    return `<div class="view-modes seg" data-seg="${name}">${options
      .map(([v, l]) => `<button type="button" class="view-mode-btn${v === value ? " active" : ""}" data-value="${v}">${l}</button>`)
      .join("")}</div>`;
  }

  function segValue(panel, name) {
    const b = panel.querySelector(`[data-seg="${name}"] .active`);
    return b ? b.dataset.value : null;
  }

  function wireSegs(panel, onChange) {
    panel.querySelectorAll(".seg").forEach((s) =>
      s.addEventListener("click", (e) => {
        const b = e.target.closest(".view-mode-btn");
        if (!b) return;
        s.querySelectorAll(".view-mode-btn").forEach((x) => x.classList.toggle("active", x === b));
        if (onChange) onChange();
      })
    );
  }

  // Wraps a single input in a <label>. Segmented controls get a <div>: a label
  // would forward clicks on its caption to the first segment button.
  function field(label, html, cls = "") {
    const tag = html.includes("view-modes seg") ? "div" : "label";
    return `<${tag} class="hfield ${cls}"><span class="hfield-label">${label}</span>${html}</${tag}>`;
  }

  // ─── Habit form ─────────────────────────────────────────────────────────────
  function metricRow(m, was) {
    return `
      <div class="metric-edit"${was !== undefined ? ` data-was="${esc(was)}"` : ""}>
        <input class="edit-input m-name" placeholder="Metric name (e.g. Distance)" maxlength="60" value="${esc(m.name)}">
        <select class="edit-input m-kind">
          <option value="number"${m.kind === "number" ? " selected" : ""}>Number</option>
          <option value="duration"${m.kind === "duration" ? " selected" : ""}>Duration</option>
        </select>
        <input class="edit-input m-unit" placeholder="Unit (e.g. mi)" maxlength="20" value="${esc(m.unit)}"${m.kind === "duration" ? " disabled" : ""}>
        <button type="button" class="remove-btn m-remove" title="Remove metric">✕</button>
      </div>`;
  }

  function wireMetricRow(el) {
    const kind = el.querySelector(".m-kind");
    const unit = el.querySelector(".m-unit");
    kind.addEventListener("change", () => {
      unit.disabled = kind.value === "duration";
      if (unit.disabled) unit.value = "";
    });
    el.querySelector(".m-remove").addEventListener("click", () => el.remove());
  }

  function openHabitForm(name = null) {
    const habit = name ? hs.habits[name] : { type: "POSITIVE", occurs: "periodic", metrics: [], goals: [] };
    const panel = openLayer({
      title: name ? `Edit “${esc(name)}”` : "New Habit",
      body: `
        ${field("Name", `<input class="edit-input h-name" maxlength="60" placeholder="e.g. Morning Run" value="${esc(name || "")}">`)}
        <div class="hfield-row">
          ${field("Type", seg("type", [["POSITIVE", "Positive"], ["NEGATIVE", "Negative"]], habit.type))}
          ${field("Occurs", seg("occurs", [["periodic", "Periodic"], ["daily", "Daily"]], habit.occurs))}
        </div>
        <p class="hint h-type-hint"></p>
        <div class="hfield">
          <span class="hfield-label">Metrics</span>
          <div class="metric-list">${habit.metrics.map((m) => metricRow(m, m.name)).join("")}</div>
          <button type="button" class="btn-add btn-sm m-add">+ Add metric</button>
          <p class="hint"><strong>count</strong> (number of records) is tracked automatically. Durations are entered as H:MM:SS.</p>
        </div>`,
      footer: `
        ${name ? `<button class="btn-danger h-delete">Delete habit</button>` : ""}
        <button class="btn-secondary h-cancel">Cancel</button>
        <button class="btn-primary h-save">${name ? "Save" : "Create"}</button>`,
    });

    const hint = panel.querySelector(".h-type-hint");
    const updateHint = () => {
      const pos = segValue(panel, "type") === "POSITIVE";
      const daily = segValue(panel, "occurs") === "daily";
      hint.textContent =
        (pos ? "Positive: goals are met at or above their target. " : "Negative: goals are met at or below their target; periods with no records count as met. ") +
        (daily ? "Daily: at most one record per day." : "Periodic: any number of records per day.");
    };
    wireSegs(panel, updateHint);
    updateHint();

    const list = panel.querySelector(".metric-list");
    list.querySelectorAll(".metric-edit").forEach(wireMetricRow);
    panel.querySelector(".m-add").addEventListener("click", () => {
      list.insertAdjacentHTML("beforeend", metricRow({ name: "", kind: "number", unit: "" }));
      const el = list.lastElementChild;
      wireMetricRow(el);
      el.querySelector(".m-name").focus();
    });

    panel.querySelector(".h-cancel").addEventListener("click", () => closePanel(panel));
    const del = panel.querySelector(".h-delete");
    if (del) del.addEventListener("click", () => deleteHabit(name, panel));

    const saveBtn = panel.querySelector(".h-save");
    saveBtn.addEventListener("click", () =>
      submit(panel, saveBtn, async () => {
        const newName = panel.querySelector(".h-name").value.trim();
        if (!newName) throw new Error("Name is required.");
        const metrics = [];
        for (const el of list.querySelectorAll(".metric-edit")) {
          const m = {
            name: el.querySelector(".m-name").value.trim(),
            kind: el.querySelector(".m-kind").value,
            unit: el.querySelector(".m-unit").value.trim(),
          };
          if (!m.name) throw new Error("Every metric needs a name.");
          if (el.dataset.was !== undefined) m.was = el.dataset.was;
          metrics.push(m);
        }
        const body = { type: segValue(panel, "type"), occurs: segValue(panel, "occurs"), metrics };
        if (!name) {
          await api("/api/habits", { method: "POST", body: { ...body, name: newName, goals: [] } });
        } else {
          // Refuse to drop a metric a goal still uses (the server would too).
          const kept = new Set(metrics.map((m) => m.was).filter((w) => w !== undefined));
          const used = habit.goals.flatMap((g) => [g.metric1, g.metric2]).filter((m) => m && m !== "count");
          const blocked = [...new Set(used.filter((m) => !kept.has(m)))];
          if (blocked.length) {
            throw new Error(`Remove or edit the goals using ${blocked.map((m) => `“${m}”`).join(", ")} first.`);
          }
          await api(`/api/habits/${enc(name)}`, {
            method: "PUT",
            body: { ...body, newName, goals: habit.goals },
          });
          if (newName !== name && hs.calMonth[name]) {
            hs.calMonth[newName] = hs.calMonth[name];
            delete hs.calMonth[name];
          }
        }
        closePanel(panel);
        await refresh();
      })
    );
    if (!name) panel.querySelector(".h-name").focus();
  }

  async function deleteHabit(name, panel) {
    const n = (hs.records[name] || []).length;
    if (!confirm(`Delete “${name}” and its ${n} record${n === 1 ? "" : "s"}? The CSV is kept in habits/.trash.`)) return;
    try {
      await api(`/api/habits/${enc(name)}`, { method: "DELETE" });
      closeLayer("dialog");
      closeLayer("overlay");
      delete hs.calMonth[name];
      await refresh();
    } catch (e) {
      showError(panel, e.message);
    }
  }

  // ─── Goal form ──────────────────────────────────────────────────────────────
  function metricOptions(habit, selected) {
    return [["count", "count (records)"], ...habit.metrics.map((m) => [m.name, m.name])]
      .map(([v, l]) => `<option value="${esc(v)}"${v === selected ? " selected" : ""}>${esc(l)}</option>`)
      .join("");
  }

  // Target shown in display units (see HabitMath.displayScale).
  function targetToInput(goal, habit) {
    const s = H.displayScale(goal, habit);
    if (s.kind === "duration") return H.formatDuration(goal.target);
    return String(Number((goal.target * s.factor).toPrecision(10)));
  }

  function inputToTarget(text, goal, habit) {
    const s = H.displayScale(goal, habit);
    const t = text.trim();
    if (!t) return NaN;
    const v = s.kind === "duration" ? H.parseDuration(t) : Number(t);
    return v / s.factor;
  }

  function openGoalForm(name, gi = null) {
    const habit = hs.habits[name];
    const editing = gi !== null;
    const used = new Set(habit.goals.map((g) => g.color));
    const goal = editing
      ? { ...habit.goals[gi] }
      : {
          period: "week",
          type: "raw",
          metric1: habit.metrics[0] ? habit.metrics[0].name : "count",
          agg: "sum",
          target: 0,
          color: GOAL_COLORS.find((c) => !used.has(c)) || GOAL_COLORS[0],
        };

    const panel = openLayer({
      title: editing ? `Edit goal · ${esc(name)}` : `New goal · ${esc(name)}`,
      body: `
        ${field("Period", seg("period", PERIOD_OPTS, goal.period))}
        ${field("Kind", seg("gtype", [["raw", "Raw value"], ["ratio", "Ratio"]], goal.type))}
        <div class="hfield-row">
          ${field("Metric", `<select class="edit-input g-m1">${metricOptions(habit, goal.metric1)}</select>`)}
          ${field("Divided by", `<select class="edit-input g-m2">${metricOptions(habit, goal.metric2 || "count")}</select>`, "g-m2-field")}
          ${field("Aggregate", `<select class="edit-input g-agg">${AGG_OPTS.map(([v, l]) => `<option value="${v}"${v === (goal.agg || "sum") ? " selected" : ""}>${l}</option>`).join("")}</select>`, "g-agg-field")}
        </div>
        ${field("Target", `<div class="target-wrap"><input class="edit-input g-target"><span class="target-unit"></span></div>`)}
        <div class="hfield">
          <span class="hfield-label">Color</span>
          <div class="swatches">
            ${GOAL_COLORS.map((c) => `<button type="button" class="swatch" data-color="${c}" style="--c:${c}" title="${c}"></button>`).join("")}
            <input type="color" class="g-color" value="${esc(goal.color)}" title="Custom color">
          </div>
        </div>
        <p class="goal-preview"></p>`,
      footer: `
        ${editing ? `<button class="btn-danger g-delete">Delete goal</button>` : ""}
        <button class="btn-secondary g-cancel">Cancel</button>
        <button class="btn-primary g-save">${editing ? "Save" : "Add goal"}</button>`,
    });

    const m1 = panel.querySelector(".g-m1");
    const m2 = panel.querySelector(".g-m2");
    const agg = panel.querySelector(".g-agg");
    const target = panel.querySelector(".g-target");
    const colorInput = panel.querySelector(".g-color");
    let color = goal.color;
    let targetKind = null;

    // Goal as currently entered (target may be NaN while typing).
    const draft = () => {
      const g = { period: segValue(panel, "period"), type: segValue(panel, "gtype"), metric1: m1.value, color };
      if (g.type === "ratio") g.metric2 = m2.value;
      else if (g.metric1 !== "count") g.agg = agg.value;
      g.target = inputToTarget(target.value, g, habit);
      return g;
    };

    const update = () => {
      const g = draft();
      const ratio = g.type === "ratio";
      panel.querySelector(".g-m2-field").classList.toggle("hidden", !ratio);
      panel.querySelector(".g-agg-field").classList.toggle("hidden", ratio || g.metric1 === "count");
      const s = H.displayScale(g, habit);
      // Switching between duration and number input clears the target.
      if (targetKind !== null && targetKind !== s.kind) target.value = "";
      targetKind = s.kind;
      target.type = s.kind === "duration" ? "text" : "number";
      target.step = "any";
      target.placeholder = s.kind === "duration" ? "H:MM:SS" : "0";
      panel.querySelector(".target-unit").textContent = s.unit;
      panel.querySelectorAll(".swatch").forEach((b) => b.classList.toggle("active", b.dataset.color === color));
      const preview = panel.querySelector(".goal-preview");
      preview.style.setProperty("--goal-color", color);
      preview.textContent = Number.isFinite(g.target)
        ? H.goalSentence(g, habit)
        : H.goalSentence({ ...g, target: null }, habit).replace(/—$/, "…");
    };

    if (editing) {
      target.value = targetToInput(goal, habit);
      targetKind = H.displayScale(goal, habit).kind;
    }
    wireSegs(panel, update);
    [m1, m2, agg].forEach((el) => el.addEventListener("change", update));
    target.addEventListener("input", update);
    panel.querySelectorAll(".swatch").forEach((b) =>
      b.addEventListener("click", () => {
        color = b.dataset.color;
        colorInput.value = color;
        update();
      })
    );
    colorInput.addEventListener("input", () => {
      color = colorInput.value.toLowerCase();
      update();
    });
    update();

    panel.querySelector(".g-cancel").addEventListener("click", () => closePanel(panel));
    const del = panel.querySelector(".g-delete");
    if (del) del.addEventListener("click", () => deleteGoal(name, gi, panel));

    const saveBtn = panel.querySelector(".g-save");
    saveBtn.addEventListener("click", () =>
      submit(panel, saveBtn, async () => {
        const g = draft();
        if (!Number.isFinite(g.target)) throw new Error("Enter a valid target.");
        const goals = [...habit.goals];
        if (editing) goals[gi] = g;
        else goals.push(g);
        await api(`/api/habits/${enc(name)}`, { method: "PUT", body: habitBody(habit, { goals }) });
        closePanel(panel);
        await refresh();
      })
    );
    if (!editing) target.focus();
  }

  async function deleteGoal(name, gi, panel) {
    const habit = hs.habits[name];
    if (!confirm(`Delete the goal “${H.goalLabel(habit.goals[gi], habit)}”?`)) return;
    try {
      const goals = habit.goals.filter((_, i) => i !== gi);
      await api(`/api/habits/${enc(name)}`, { method: "PUT", body: habitBody(habit, { goals }) });
      // The goal may be open in a detail view underneath; close everything.
      closeLayer("dialog");
      closeLayer("overlay");
      await refresh();
    } catch (e) {
      showError(panel, e.message);
    }
  }

  // ─── Record form ────────────────────────────────────────────────────────────
  function toLocalInput(d) {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  // "YYYY-MM-DDTHH:MM" (browser-local) → ISO with this browser's offset.
  function localIso(value) {
    const d = new Date(value);
    const off = -d.getTimezoneOffset();
    const a = Math.abs(off);
    return `${value}:00${off >= 0 ? "+" : "-"}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
  }

  function prettyDay(day) {
    return `${H.MONTHS[Number(day.slice(5, 7)) - 1]} ${Number(day.slice(8, 10))}, ${day.slice(0, 4)}`;
  }

  function openRecordForm(name, idx = null) {
    const habit = hs.habits[name];
    const records = hs.records[name] || [];
    const existing = idx !== null ? records[idx] : null;
    const now = toLocalInput(new Date());

    const inputs = habit.metrics
      .map((m, i) => {
        const v = existing ? existing.values[m.name] : undefined;
        const val = v === undefined ? "" : m.kind === "duration" ? H.formatDuration(v) : v;
        const input = m.kind === "duration"
          ? `<input class="edit-input r-val" data-i="${i}" placeholder="H:MM:SS" value="${esc(val)}">`
          : `<input class="edit-input r-val" data-i="${i}" type="number" step="any" placeholder="0" value="${esc(val)}">`;
        return field(`${esc(m.name)}${m.unit ? ` <span class="muted">(${esc(m.unit)})</span>` : ""}`, input);
      })
      .join("");

    const panel = openLayer({
      title: `${existing ? "Edit record" : "New record"} · ${esc(name)}`,
      body: `
        ${field("When", `<input type="datetime-local" class="edit-input r-when" max="${now}" value="${existing ? esc(existing.ts.slice(0, 16)) : now}">`)}
        ${inputs || `<p class="hint">This habit has no metrics — a record just counts one occurrence.</p>`}
        <p class="notice r-notice hidden"></p>`,
      footer: `
        <button class="btn-secondary r-cancel">Cancel</button>
        <button class="btn-primary r-save">${existing ? "Save" : "Add record"}</button>`,
    });

    const when = panel.querySelector(".r-when");
    const notice = panel.querySelector(".r-notice");
    let conflict = -1;
    const checkDay = () => {
      conflict = -1;
      if (habit.occurs === "daily" && when.value) {
        const day = when.value.slice(0, 10);
        conflict = records.findIndex((r, i) => i !== idx && r.ts.slice(0, 10) === day);
      }
      notice.textContent = conflict >= 0 ? `${prettyDay(when.value)} already has a record — saving will replace it.` : "";
      notice.classList.toggle("hidden", conflict < 0);
    };
    when.addEventListener("input", checkDay);
    checkDay();

    panel.querySelector(".r-cancel").addEventListener("click", () => closePanel(panel));
    const saveBtn = panel.querySelector(".r-save");
    const save = () =>
      submit(panel, saveBtn, async () => {
        if (!when.value) throw new Error("Pick a date and time.");
        if (new Date(when.value) > new Date()) throw new Error("The time can't be in the future.");
        const values = {};
        for (const el of panel.querySelectorAll(".r-val")) {
          const m = habit.metrics[Number(el.dataset.i)];
          const raw = el.value.trim();
          if (!raw) throw new Error(`Enter a value for ${m.name}.`);
          const v = m.kind === "duration" ? H.parseDuration(raw) : Number(raw);
          if (!Number.isFinite(v)) {
            throw new Error(m.kind === "duration" ? `${m.name} must be H:MM:SS.` : `${m.name} must be a number.`);
          }
          values[m.name] = v;
        }
        const body = { ts: localIso(when.value), values, replace: conflict >= 0 };
        if (existing) {
          await api(`/api/habits/${enc(name)}/records/${idx}`, {
            method: "PUT",
            body: { ...body, expectedTs: existing.ts },
          });
        } else {
          await api(`/api/habits/${enc(name)}/records`, { method: "POST", body });
        }
        closePanel(panel);
        await refresh();
      });
    saveBtn.addEventListener("click", save);
    panel.querySelector(".habit-form").addEventListener("keydown", (e) => {
      if (e.key === "Enter" && e.target.tagName === "INPUT") save();
    });
    const first = panel.querySelector(".r-val");
    if (first && !existing) first.focus();
  }

  // ─── Records list ───────────────────────────────────────────────────────────
  function openRecordsList(name) {
    const panel = openLayer({
      title: `Records · ${esc(name)}`,
      headerExtra: `<button class="btn-add rl-add">+ Record</button>`,
      body: `<div class="record-list"></div>`,
      footer: `<button class="btn-secondary rl-close">Close</button>`,
    });
    panel.querySelector(".rl-close").addEventListener("click", () => closePanel(panel));
    panel.querySelector(".rl-add").addEventListener("click", () => openRecordForm(name));

    const fill = () => {
      const habit = hs.habits[name];
      if (!habit) return closePanel(panel);
      const list = panel.querySelector(".record-list");
      const rows = (hs.records[name] || [])
        .map((r, idx) => ({ r, idx }))
        .sort((a, b) => (a.r.ts < b.r.ts ? 1 : a.r.ts > b.r.ts ? -1 : b.idx - a.idx));
      if (!rows.length) {
        list.innerHTML = `<div class="empty-state small">No records yet.</div>`;
        return;
      }
      list.innerHTML = rows
        .map(({ r, idx }) => {
          const vals = habit.metrics
            .map((m) => `<span class="rec-val"><span class="muted">${esc(m.name)}</span> ${esc(H.formatMetric(m, r.values[m.name]))}</span>`)
            .join("");
          return `
            <div class="record-item" data-idx="${idx}">
              <div class="rec-when">${esc(prettyDay(r.ts))}<span class="muted">${esc(r.ts.slice(11, 16))}</span></div>
              <div class="rec-vals">${vals}</div>
              <button class="icon-btn rec-edit" title="Edit record" aria-label="Edit record">✎</button>
              <button class="remove-btn rec-del" title="Delete record" aria-label="Delete record">✕</button>
            </div>`;
        })
        .join("");
      list.querySelectorAll(".record-item").forEach((el) => {
        const idx = Number(el.dataset.idx);
        el.querySelector(".rec-edit").addEventListener("click", () => openRecordForm(name, idx));
        el.querySelector(".rec-del").addEventListener("click", async () => {
          const r = hs.records[name][idx];
          if (!confirm(`Delete the record from ${prettyDay(r.ts)} ${r.ts.slice(11, 16)}?`)) return;
          try {
            await api(`/api/habits/${enc(name)}/records/${idx}?ts=${enc(r.ts)}`, { method: "DELETE" });
            await refresh();
          } catch (e) {
            showError(panel, e.message);
          }
        });
      });
    };
    setRefresh(panel, fill);
    fill();
  }

  // ─── Init ───────────────────────────────────────────────────────────────────
  function init() {
    document.getElementById("addHabitBtn").addEventListener("click", () => openHabitForm());

    for (const which of ["overlay", "dialog"]) {
      layerEl(which).addEventListener("click", (e) => {
        if (e.target === layerEl(which)) closeLayer(which);
      });
    }
    // Escape closes the topmost habit menu.
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if (isOpen("dialog")) closeLayer("dialog");
      else if (isOpen("overlay")) closeLayer("overlay");
    });

    const board = document.getElementById("habitBoard");
    board.addEventListener("dragover", (e) => {
      if (hs.dragName) e.preventDefault();
    });
    document.addEventListener("drop", finishHabitDrag);
    document.addEventListener("dragend", finishHabitDrag);
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

  document.addEventListener("DOMContentLoaded", init);

  return { show };
})();
