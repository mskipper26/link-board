// ─── State ────────────────────────────────────────────────────────────────────
const state = {
  links: {},
  authenticated: false,
  hoverTimeout: null,
  previewCache: {},
  activePreviewUrl: null,
  viewMode: "all", // "all" | "grouped" | "filter"
  selectedCategories: new Set(),
  dragUrl: null,
  dragOrigin: null,
  page: "links", // "links" | "habits"
};

const UNCATEGORIZED = "Uncategorized";

// ─── API ──────────────────────────────────────────────────────────────────────
async function apiFetch(path, options = {}) {
  const res = await fetch(path, options);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(text || res.statusText);
  }
  return res.json();
}

async function loadLinks() {
  state.links = await apiFetch("/api/links");
}

async function authenticate(passkey) {
  await apiFetch("/api/auth", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ passkey }),
  });
  state.authenticated = true;
}

async function saveLinks(links) {
  await apiFetch("/api/links", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(links),
  });
}

async function uploadIcon(file) {
  const fd = new FormData();
  fd.append("file", file);
  const res = await fetch("/api/icon", { method: "POST", body: fd });
  if (!res.ok) throw new Error("Upload failed");
  return (await res.json()).path;
}

async function fetchPreview(url) {
  if (state.previewCache[url]) return state.previewCache[url];
  try {
    const data = await apiFetch(`/api/preview?url=${encodeURIComponent(url)}`);
    state.previewCache[url] = data;
    return data;
  } catch {
    return { title: "", description: "", image: "" };
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function getHostname(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function resolveImageUrl(imgUrl, pageUrl) {
  if (!imgUrl) return "";
  try {
    return new URL(imgUrl, pageUrl).href;
  } catch {
    return imgUrl;
  }
}

function getIconSrc(url, iconPath) {
  if (iconPath) return iconPath;
  return `/api/favicon?url=${encodeURIComponent(url)}`;
}

function escapeHtml(str) {
  if (!str) return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function normalizeUrl(url) {
  const trimmed = url.trim();
  if (!trimmed) return "";
  if (!/^https?:\/\//i.test(trimmed)) return "https://" + trimmed;
  return trimmed;
}

// A link's categories as a clean array. `category` may be a string (single) or
// an array (multiple) in the JSON; both are supported. Empty → [UNCATEGORIZED].
function getCategoriesOf(data) {
  const raw = Array.isArray(data.category) ? data.category : [data.category];
  const cats = raw.map((c) => (c || "").trim()).filter(Boolean);
  return cats.length ? cats : [UNCATEGORIZED];
}

// Distinct categories in first-appearance order, with Uncategorized last.
function getCategories() {
  const cats = [];
  for (const data of Object.values(state.links)) {
    for (const c of getCategoriesOf(data)) {
      if (!cats.includes(c)) cats.push(c);
    }
  }
  const idx = cats.indexOf(UNCATEGORIZED);
  if (idx !== -1) cats.splice(idx, 1), cats.push(UNCATEGORIZED);
  return cats;
}

const DRAG_HANDLE_SVG = `
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <circle cx="5" cy="3" r="1.4"/><circle cx="11" cy="3" r="1.4"/>
    <circle cx="5" cy="8" r="1.4"/><circle cx="11" cy="8" r="1.4"/>
    <circle cx="5" cy="13" r="1.4"/><circle cx="11" cy="13" r="1.4"/>
  </svg>`;

// ─── Grid ─────────────────────────────────────────────────────────────────────
function renderGrid() {
  const board = document.getElementById("linkGrid");
  board.innerHTML = "";
  const entries = Object.entries(state.links);
  if (entries.length === 0) {
    board.innerHTML = `<div class="empty-state">No links yet. Click <strong>Edit</strong> to add some.</div>`;
    return;
  }
  if (state.viewMode === "grouped") {
    renderGrouped(board);
  } else {
    renderFlat(board);
  }
}

// "all" and "filter" modes: a single grid.
function renderFlat(board) {
  const grid = document.createElement("div");
  grid.className = "link-grid";
  setupDropZone(grid);
  const filtering = state.viewMode === "filter";
  let shown = 0;
  for (const [url, data] of Object.entries(state.links)) {
    if (filtering && !getCategoriesOf(data).some((c) => state.selectedCategories.has(c))) continue;
    grid.appendChild(createCard(url, data));
    shown++;
  }
  board.appendChild(grid);
  if (shown === 0) {
    board.insertAdjacentHTML(
      "beforeend",
      `<div class="empty-state">No links match the selected categories.</div>`
    );
  }
}

// "grouped" mode: one section per category.
function renderGrouped(board) {
  const groups = new Map();
  for (const [url, data] of Object.entries(state.links)) {
    for (const c of getCategoriesOf(data)) {
      if (!groups.has(c)) groups.set(c, []);
      groups.get(c).push([url, data]);
    }
  }
  for (const cat of getCategories()) {
    const items = groups.get(cat) || [];
    const section = document.createElement("section");
    section.className = "category-section";

    const heading = document.createElement("h2");
    heading.className = "category-heading";
    heading.textContent = cat;
    const count = document.createElement("span");
    count.className = "category-count";
    count.textContent = items.length;
    heading.appendChild(count);
    section.appendChild(heading);

    const grid = document.createElement("div");
    grid.className = "link-grid";
    setupDropZone(grid);
    for (const [url, data] of items) grid.appendChild(createCard(url, data));
    section.appendChild(grid);
    board.appendChild(section);
  }
}

function createCard(url, data) {
  const card = document.createElement("a");
  card.href = url;
  card.target = "_blank";
  card.rel = "noopener noreferrer";
  card.className = "card";
  card.dataset.url = url;
  card.setAttribute("draggable", "false"); // only the handle initiates drag

  const name = data.name || getHostname(url);
  const iconSrc = getIconSrc(url, data.icon);
  const chipCats =
    state.viewMode === "grouped"
      ? []
      : getCategoriesOf(data).filter((c) => c !== UNCATEGORIZED);

  card.innerHTML = `
    <div class="card-icon-wrap">
      <img class="card-icon" src="${escapeHtml(iconSrc)}" alt="" loading="lazy">
    </div>
    <div class="card-info">
      <div class="card-name">${escapeHtml(name)}</div>
      ${data.description ? `<div class="card-desc">${escapeHtml(data.description)}</div>` : ""}
      ${chipCats.length ? `<div class="card-cats">${chipCats.map((c) => `<div class="card-cat">${escapeHtml(c)}</div>`).join("")}</div>` : ""}
    </div>
    <div class="drag-handle" draggable="true" title="Drag to reorder">${DRAG_HANDLE_SVG}</div>
  `;

  card.querySelector(".card-icon").addEventListener("error", function () {
    this.src = "/static/icon-default.svg";
  });

  card.addEventListener("mouseenter", () => onCardHover(url, card));
  card.addEventListener("mouseleave", onCardLeave);

  setupDragHandle(card, url);
  setupCardDropTarget(card);

  return card;
}

// ─── Drag reorder ─────────────────────────────────────────────────────────────
function setupDragHandle(card, url) {
  const handle = card.querySelector(".drag-handle");

  // A plain click on the handle must not follow the link.
  handle.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
  });

  handle.addEventListener("dragstart", (e) => {
    state.dragUrl = url;
    state.dragOrigin = card.parentElement;
    card.classList.add("dragging");
    clearTimeout(state.hoverTimeout);
    hidePreview();
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", url);
    try {
      e.dataTransfer.setDragImage(card, 24, 24);
    } catch {}
  });

  handle.addEventListener("dragend", finishDrag);
}

// Ends a drag and saves the new order. Idempotent, and wired to several events
// (handle `dragend`, document-level `drop`/`dragend`): swap-through reordering
// moves the dragged card in the DOM mid-drag, and browsers don't reliably fire
// `dragend` on a source node that has been moved, so any one of them may be
// the only signal we get.
function finishDrag() {
  if (!state.dragUrl) return;
  state.dragUrl = null;
  state.dragOrigin = null;
  document.querySelectorAll(".card.dragging").forEach((c) => c.classList.remove("dragging"));
  clearTimeout(state.hoverTimeout);
  hidePreview();
  persistOrder();
}

// Allow drops anywhere in the origin grid so `dragend` fires cleanly, but the
// actual reordering happens per-card in setupCardDropTarget (see below).
function setupDropZone(container) {
  container.addEventListener("dragover", (e) => {
    if (state.dragUrl && container === state.dragOrigin) e.preventDefault();
  });
  container.addEventListener("drop", (e) => {
    if (state.dragUrl) e.preventDefault();
  });
}

// Swap-through reordering: when the dragged card enters another card, it takes
// that card's slot and pushes the other one back toward the dragged card's old
// position. Reacting on `dragenter` (once per card entry) instead of on every
// `dragover` avoids the jitter you get from continuously re-sorting by nearest
// center — after each move the dragged card lands under the pointer, so it
// can't immediately re-trigger and flip back.
function setupCardDropTarget(card) {
  card.addEventListener("dragover", (e) => {
    if (state.dragUrl && card.parentElement === state.dragOrigin) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    }
  });

  card.addEventListener("dragenter", (e) => {
    if (!state.dragUrl) return;
    const origin = state.dragOrigin;
    if (!origin || card.parentElement !== origin) return;
    const dragging = origin.querySelector(".card.dragging");
    if (!dragging || dragging === card) return;

    const cards = [...origin.querySelectorAll(".card")];
    const di = cards.indexOf(dragging);
    const ti = cards.indexOf(card);
    if (di < ti) {
      // Dragged sits before the target → move it just after the target.
      origin.insertBefore(dragging, card.nextSibling);
    } else {
      // Dragged sits after the target → move it just before the target.
      origin.insertBefore(dragging, card);
    }
  });
}

// Rebuild links.json order from the current DOM, keeping filtered-out links
// pinned to the positions their (visible) neighbours occupied originally.
async function persistOrder() {
  // A link can appear in multiple category sections (multi-category links in
  // grouped mode), so collapse the DOM to first-occurrence order per URL.
  const visible = new Set();
  const domOrder = [];
  for (const c of document.querySelectorAll("#linkGrid .card")) {
    if (!visible.has(c.dataset.url)) {
      visible.add(c.dataset.url);
      domOrder.push(c.dataset.url);
    }
  }
  const queue = [...domOrder];
  const newOrder = [];
  for (const url of Object.keys(state.links)) {
    newOrder.push(visible.has(url) ? queue.shift() : url);
  }

  // No change → nothing to save.
  const prevKeys = Object.keys(state.links);
  if (newOrder.every((u, i) => u === prevKeys[i])) return;

  const newLinks = {};
  for (const url of newOrder) newLinks[url] = state.links[url];
  const prev = state.links;
  state.links = newLinks;
  try {
    await saveLinks(newLinks);
  } catch {
    state.links = prev;
    renderGrid();
    alert("Failed to save new order.");
  }
}

// ─── View controls ────────────────────────────────────────────────────────────
const VIEW_STORAGE_KEY = "linkBoard.view";

// Remember the view (mode + filter selection) so a reload returns to it.
function saveViewState() {
  try {
    localStorage.setItem(
      VIEW_STORAGE_KEY,
      JSON.stringify({
        viewMode: state.viewMode,
        selectedCategories: [...state.selectedCategories],
      })
    );
  } catch {}
}

function restoreViewState() {
  try {
    const saved = JSON.parse(localStorage.getItem(VIEW_STORAGE_KEY) || "null");
    if (!saved) return;
    if (["all", "grouped", "filter"].includes(saved.viewMode)) {
      state.viewMode = saved.viewMode;
    }
    if (Array.isArray(saved.selectedCategories)) {
      state.selectedCategories = new Set(saved.selectedCategories);
    }
  } catch {}
}

function setViewMode(mode) {
  state.viewMode = mode;
  document
    .querySelectorAll(".view-mode-btn[data-mode]")
    .forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
  const filters = document.getElementById("categoryFilters");
  if (mode === "filter") {
    renderCategoryFilters();
    filters.classList.remove("hidden");
  } else {
    filters.classList.add("hidden");
  }
  saveViewState();
  renderGrid();
}

function renderCategoryFilters() {
  const wrap = document.getElementById("categoryFilters");
  wrap.innerHTML = "";
  const cats = getCategories();
  // Keep selection in sync with categories that still exist.
  state.selectedCategories = new Set(
    cats.filter((c) => state.selectedCategories.has(c))
  );
  if (state.selectedCategories.size === 0) {
    cats.forEach((c) => state.selectedCategories.add(c));
  }
  for (const cat of cats) {
    const label = document.createElement("label");
    label.className = "cat-filter";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = state.selectedCategories.has(cat);
    cb.addEventListener("change", () => {
      if (cb.checked) state.selectedCategories.add(cat);
      else state.selectedCategories.delete(cat);
      saveViewState();
      renderGrid();
    });
    label.appendChild(cb);
    label.append(" " + cat);
    wrap.appendChild(label);
  }
}

// ─── Preview ──────────────────────────────────────────────────────────────────
function onCardHover(url, el) {
  clearTimeout(state.hoverTimeout);
  state.hoverTimeout = setTimeout(async () => {
    state.activePreviewUrl = url;
    const data = await fetchPreview(url);
    if (state.activePreviewUrl === url) showPreview(url, data, el);
  }, 400);
}

function onCardLeave() {
  clearTimeout(state.hoverTimeout);
  state.activePreviewUrl = null;
  hidePreview();
}

function showPreview(url, data, cardEl) {
  const popup = document.getElementById("previewPopup");
  const imgWrap = document.getElementById("previewImageWrap");
  const img = document.getElementById("previewImg");
  const resolvedImg = resolveImageUrl(data.image, url);

  if (resolvedImg) {
    img.src = resolvedImg;
    imgWrap.classList.remove("hidden");
  } else {
    imgWrap.classList.add("hidden");
  }

  document.getElementById("previewTitle").textContent = data.title || getHostname(url);
  document.getElementById("previewDesc").textContent = data.description || "";
  document.getElementById("previewUrl").textContent = url;

  popup.classList.remove("hidden");
  positionPreview(popup, cardEl);
}

function positionPreview(popup, cardEl) {
  const rect = cardEl.getBoundingClientRect();
  const pw = 300;
  const ph = popup.offsetHeight || 260;
  const margin = 12;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  let left = rect.right + margin;
  if (left + pw > vw - margin) left = rect.left - pw - margin;
  if (left < margin) left = margin;

  let top = rect.top;
  if (top + ph > vh - margin) top = vh - ph - margin;
  if (top < margin) top = margin;

  popup.style.left = `${left}px`;
  popup.style.top = `${top}px`;
}

function hidePreview() {
  document.getElementById("previewPopup").classList.add("hidden");
}

// ─── Auth Modal ───────────────────────────────────────────────────────────────
let authCallback = null;

function showAuthModal(onSuccess, allowCancel = true) {
  authCallback = onSuccess;
  const modal = document.getElementById("authModal");
  const input = document.getElementById("passkeyInput");
  const error = document.getElementById("authError");
  const cancelBtn = document.getElementById("authCancelBtn");
  modal.classList.remove("hidden");
  input.value = "";
  error.classList.add("hidden");
  if (allowCancel) {
    cancelBtn.classList.remove("hidden");
  } else {
    cancelBtn.classList.add("hidden");
  }
  requestAnimationFrame(() => input.focus());
}

function hideAuthModal() {
  document.getElementById("authModal").classList.add("hidden");
  authCallback = null;
}

async function submitAuth() {
  const input = document.getElementById("passkeyInput");
  const error = document.getElementById("authError");
  error.classList.add("hidden");
  try {
    await authenticate(input.value);
    const callback = authCallback;
    hideAuthModal();
    callback && (await callback());
  } catch {
    error.classList.remove("hidden");
    input.select();
  }
}

// ─── Edit Overlay ─────────────────────────────────────────────────────────────
function onEditButtonClick() {
  if (state.authenticated) {
    openEditOverlay();
  } else {
    showAuthModal(() => openEditOverlay());
  }
}

function openEditOverlay() {
  renderEditList();
  document.getElementById("editOverlay").classList.remove("hidden");
  document.getElementById("saveError").classList.add("hidden");
}

function closeEditOverlay() {
  document.getElementById("editOverlay").classList.add("hidden");
}

function renderEditList() {
  const list = document.getElementById("editList");
  list.innerHTML = "";
  for (const [url, data] of Object.entries(state.links)) {
    list.appendChild(createEditItem(url, data));
  }
  refreshCategoryOptions();
}

// Populate the <datalist> suggesting existing categories in the edit overlay.
function refreshCategoryOptions() {
  const dl = document.getElementById("categoryOptions");
  if (!dl) return;
  const cats = new Set();
  for (const data of Object.values(state.links)) {
    for (const c of getCategoriesOf(data)) {
      if (c !== UNCATEGORIZED) cats.add(c);
    }
  }
  dl.innerHTML = [...cats]
    .map((c) => `<option value="${escapeHtml(c)}"></option>`)
    .join("");
}

function createEditItem(url, data) {
  const item = document.createElement("div");
  item.className = "edit-item";
  item.dataset.iconPath = data.icon || "";

  const iconSrc = getIconSrc(url, data.icon);
  const descLen = (data.description || "").length;
  const name = data.name || "";
  const category = Array.isArray(data.category)
    ? data.category.join(", ")
    : data.category || "";

  item.innerHTML = `
    <div class="edit-icon-wrap">
      <img class="edit-icon" src="${escapeHtml(iconSrc)}" alt="" loading="lazy">
      <div class="edit-icon-overlay">
        <svg viewBox="0 0 24 24"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
      </div>
      <input type="file" class="icon-file-input" accept="image/*">
    </div>
    <div class="edit-fields">
      <div class="edit-row">
        <input type="url" class="edit-input edit-url" value="${escapeHtml(url)}" placeholder="https://example.com">
        <input type="text" class="edit-input edit-name" value="${escapeHtml(name)}" placeholder="Name (optional)" style="flex:0 0 170px">
      </div>
      <div class="edit-row">
        <input type="text" class="edit-input edit-category" value="${escapeHtml(category)}" placeholder="Categories (comma-separated, optional)" list="categoryOptions">
      </div>
      <div class="edit-desc-wrap">
        <textarea class="edit-input edit-desc" placeholder="Description (optional)" maxlength="200">${escapeHtml(data.description || "")}</textarea>
        <span class="char-count${descLen >= 200 ? " at-limit" : descLen >= 160 ? " near-limit" : ""}">${descLen}/200</span>
      </div>
    </div>
    <button class="remove-btn" title="Remove link">✕</button>
  `;

  // Icon upload
  const fileInput = item.querySelector(".icon-file-input");
  const iconImg = item.querySelector(".edit-icon");
  item.querySelector(".edit-icon-wrap").addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", async () => {
    if (!fileInput.files[0]) return;
    try {
      const path = await uploadIcon(fileInput.files[0]);
      item.dataset.iconPath = path;
      iconImg.src = path;
    } catch {
      alert("Failed to upload icon.");
    }
  });

  // Fix fallback icon
  iconImg.addEventListener("error", function () {
    this.src = "/static/icon-default.svg";
  });

  // Auto-update favicon when URL changes
  const urlInput = item.querySelector(".edit-url");
  urlInput.addEventListener("blur", () => {
    if (item.dataset.iconPath) return;
    const val = normalizeUrl(urlInput.value);
    if (val) iconImg.src = `/api/favicon?url=${encodeURIComponent(val)}`;
  });

  // Char counter
  const textarea = item.querySelector(".edit-desc");
  const counter = item.querySelector(".char-count");
  textarea.addEventListener("input", () => {
    const len = textarea.value.length;
    counter.textContent = `${len}/200`;
    counter.className = "char-count" + (len >= 200 ? " at-limit" : len >= 160 ? " near-limit" : "");
  });

  // Remove
  item.querySelector(".remove-btn").addEventListener("click", () => item.remove());

  return item;
}

function addNewLink() {
  const list = document.getElementById("editList");
  const item = createEditItem("", { name: "", icon: "", description: "" });
  list.appendChild(item);
  item.querySelector(".edit-url").focus();
  item.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

async function onSave() {
  const items = document.querySelectorAll(".edit-item");
  const newLinks = {};

  for (const item of items) {
    const rawUrl = item.querySelector(".edit-url").value.trim();
    if (!rawUrl) continue;
    const url = normalizeUrl(rawUrl);
    if (!url) continue;

    const name = item.querySelector(".edit-name").value.trim();
    const desc = item.querySelector(".edit-desc").value.trim();
    const icon = item.dataset.iconPath || "";

    // Categories are entered comma-separated. Store a bare string for a single
    // category (keeps existing data shape) and an array for multiple. Dedupe.
    const cats = [
      ...new Set(
        item
          .querySelector(".edit-category")
          .value.split(",")
          .map((c) => c.trim())
          .filter(Boolean)
      ),
    ];

    const entry = {};
    if (name) entry.name = name;
    if (icon) entry.icon = icon;
    if (cats.length === 1) entry.category = cats[0];
    else if (cats.length > 1) entry.category = cats;
    if (desc) entry.description = desc;
    newLinks[url] = entry;
  }

  const errEl = document.getElementById("saveError");
  errEl.classList.add("hidden");

  try {
    await saveLinks(newLinks);
    state.links = newLinks;
    if (state.viewMode === "filter") renderCategoryFilters();
    renderGrid();
    closeEditOverlay();
  } catch (e) {
    errEl.classList.remove("hidden");
  }
}

// ─── Pages (Links | Habits) ───────────────────────────────────────────────────
// Client-side tab swap. The page lives in the URL hash (#habits) so a reload or
// bookmark lands on it; localStorage covers a bare URL.
const PAGE_STORAGE_KEY = "linkBoard.page";

function initialPage() {
  if (location.hash === "#habits") return "habits";
  if (location.hash === "#links") return "links";
  try {
    return localStorage.getItem(PAGE_STORAGE_KEY) === "habits" ? "habits" : "links";
  } catch {
    return "links";
  }
}

function setPage(page) {
  state.page = page;
  const habits = page === "habits";
  document
    .querySelectorAll(".page-tabs .view-mode-btn")
    .forEach((b) => b.classList.toggle("active", b.dataset.page === page));
  try {
    localStorage.setItem(PAGE_STORAGE_KEY, page);
  } catch {}
  const hash = habits ? "#habits" : "";
  if (location.hash !== hash) {
    history.replaceState(null, "", location.pathname + location.search + hash);
  }
  // Only touch the content areas once auth has revealed the app.
  if (document.getElementById("appHeader").classList.contains("hidden")) return;
  document.getElementById("editBtn").classList.toggle("hidden", habits);
  document.getElementById("addHabitBtn").classList.toggle("hidden", !habits);
  document.getElementById("viewControls").classList.toggle("hidden", habits);
  document.getElementById("linkGrid").classList.toggle("hidden", habits);
  document.getElementById("habitBoard").classList.toggle("hidden", !habits);
  clearTimeout(state.hoverTimeout);
  hidePreview();
  if (habits) Habits.show();
}

function showApp() {
  document.getElementById("appHeader").classList.remove("hidden");
  setPage(state.page);
}

// ─── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  // Wire up event listeners before any async work
  document.getElementById("editBtn").addEventListener("click", onEditButtonClick);
  document.getElementById("addLinkBtn").addEventListener("click", addNewLink);

  document.querySelectorAll(".view-modes:not(.page-tabs) .view-mode-btn").forEach((btn) => {
    btn.addEventListener("click", () => setViewMode(btn.dataset.mode));
  });
  document.querySelectorAll(".page-tabs .view-mode-btn").forEach((btn) => {
    btn.addEventListener("click", () => setPage(btn.dataset.page));
  });
  window.addEventListener("hashchange", () => {
    const page = location.hash === "#habits" ? "habits" : "links";
    if (page !== state.page) setPage(page);
  });
  state.page = initialPage();
  document.getElementById("saveBtn").addEventListener("click", onSave);
  document.getElementById("cancelEditBtn").addEventListener("click", closeEditOverlay);
  document.getElementById("authSubmitBtn").addEventListener("click", submitAuth);
  document.getElementById("authCancelBtn").addEventListener("click", hideAuthModal);

  document.getElementById("passkeyInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") submitAuth();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      // Only close edit overlay on Escape; never dismiss the auth gate
      closeEditOverlay();
    }
  });

  document.getElementById("editOverlay").addEventListener("click", (e) => {
    if (e.target.id === "editOverlay") closeEditOverlay();
  });

  // Backstops for finishDrag(); see its comment.
  document.addEventListener("drop", finishDrag);
  document.addEventListener("dragend", finishDrag);

  // Load links, then render in the view the user last left (setViewMode renders).
  const loadAndShow = async () => {
    await loadLinks();
    restoreViewState();
    setViewMode(state.viewMode);
    showApp();
  };

  // Check existing session; if valid, load content directly
  try {
    await apiFetch("/api/auth/check");
    state.authenticated = true;
    await loadAndShow();
  } catch {
    // Not authenticated — require passkey before showing anything
    showAuthModal(loadAndShow, false);
  }
}

document.addEventListener("DOMContentLoaded", init);
