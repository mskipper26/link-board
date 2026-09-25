# PROJECT: WEB LINK BOARD
A simple app for quickly accessing important links for personal use, plus a habit tracker page.

## Overview
Single-page web app with a responsive grid of link cards. Each card shows an icon, site name, and optional description. Hovering a card shows a preview popup (OG metadata: title, description, og:image). Clicking opens the link in a new tab. An Edit button in the top-right opens an overlay panel for managing links. A **Links | Habits** tab switch in the header swaps to the habit tracker (see *Habits* below).

The entire app is behind a passkey gate — the grid and header are hidden on load and only revealed after successful authentication. Sessions persist for 7 days via a signed cookie.

---

## Architecture

### Tech Stack
- **Backend**: Python / FastAPI, served on port 8186
- **Frontend**: Vanilla HTML + CSS + JS (no framework), served as static files from FastAPI
- **Process management**: systemd user service (`~/.config/systemd/user/link-board.service`)
- **Tunnel**: Cloudflare tunnel exposes the app at the public URL configured in `.env` as `LINK_BOARD_URL`

### File Structure
The project lives at the path configured in `.env` as `LINK_BOARD_DIR`:
```
<LINK_BOARD_DIR>/
├── main.py               # FastAPI app (links/auth logic + thin habit endpoints)
├── habit_store.py        # Habit storage & validation (FastAPI-free, unit-tested)
├── requirements.txt
├── requirements-dev.txt  # pytest
├── start.sh              # Entrypoint for systemd service
├── .env                  # Passkey, secret key, paths & URL (not in version control; see .env.example)
├── links.json            # Live data store
├── habits.json           # Habit config (not in version control)
├── habits/               # One CSV of records per habit; .trash/ holds deleted/backed-up CSVs
├── icons/                # Uploaded custom icons
├── tests/
│   ├── conftest.py            # Points main.py at a temp LINK_BOARD_DIR before import
│   ├── test_habits_api.py     # pytest: habit API
│   └── habit-math.test.js     # node --test: habit-math.js
└── static/
    ├── index.html
    ├── style.css
    ├── app.js            # Links page, auth, page tabs
    ├── habit-math.js     # DOM-free habit math (UMD: browser global HabitMath + Node)
    ├── habits.js         # Habits page UI
    ├── habits.css
    ├── favicon.svg
    └── icon-default.svg  # Fallback icon when favicon unavailable
```

### Tests
```bash
python3 -m pytest tests/      # API (uses a throwaway dir + passkey, never live data)
node --test tests/            # habit-math.js
```

### Service Management
```bash
systemctl --user start|stop|restart|status link-board.service
```
The service is enabled to start on login.

---

## API Endpoints

All endpoints return `Cache-Control: no-store` (applied by `NoCacheMiddleware`) to prevent Cloudflare from caching responses.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/` | — | Serves `index.html` |
| GET | `/favicon.ico` | — | Serves `static/favicon.svg` |
| POST | `/api/auth` | — | Verifies passkey, sets session cookie |
| GET | `/api/auth/check` | ✓ | Returns 200 if session is valid, 401 otherwise |
| GET | `/api/links` | ✓ | Returns `links.json` contents |
| PUT | `/api/links` | ✓ | Overwrites `links.json` (atomic write) |
| POST | `/api/icon` | ✓ | Uploads a custom icon to `icons/`; returns web path |
| GET | `/api/habits` | ✓ | `{habits: <config>, records: {name: [{ts, values}]}}` |
| POST | `/api/habits` | ✓ | Create habit (`name`, `type`, `occurs`, `metrics`, `goals`) + empty CSV |
| PUT | `/api/habits/order` | ✓ | `{order: [names]}` → rewrite key order (declared before `/{name}`) |
| PUT | `/api/habits/{name}` | ✓ | Replace config; optional `newName` (renames CSV); metrics may carry `was` to rename a column |
| DELETE | `/api/habits/{name}` | ✓ | Remove habit; CSV → `habits/.trash/<slug>-<stamp>.csv` |
| POST | `/api/habits/{name}/records` | ✓ | Add `{ts, values, replace?}`; daily habit + day taken → 409 unless `replace` |
| PUT | `/api/habits/{name}/records/{idx}` | ✓ | Edit record by CSV row index; body `expectedTs` must match (else 409) |
| DELETE | `/api/habits/{name}/records/{idx}?ts=` | ✓ | Delete record; `ts` must match (else 409) |
| GET | `/api/favicon?url=` | — | Proxies favicon from Google's favicon service |
| GET | `/api/preview?url=` | — | Fetches OG metadata (title, description, og:image) from a URL |
| GET | `/icons/{filename}` | — | Serves uploaded icons (StaticFiles mount) |
| GET | `/static/{file}` | — | Serves CSS/JS/SVG (StaticFiles mount) |

---

## Auth

- **Passkey** is stored in `.env` as `LINK_BOARD_PASSKEY` and read at startup via `python-dotenv`. Never embedded in client code.
- **Session tokens** are signed with `itsdangerous.URLSafeTimedSerializer` using `SECRET_KEY` from `.env`. Stored as an `HttpOnly; SameSite=lax` cookie. Max age: 7 days.
- **Comparison** uses `hmac.compare_digest` to prevent timing attacks.
- On page load, the frontend calls `GET /api/auth/check`. If valid session exists, content loads directly. If not, a non-dismissable passkey modal blocks all content until authenticated.

---

## Storage

**`links.json`** — the sole data store. Actual structure (extended from spec to include optional `name` and `category`):
```json
{
  "https://example.com": {
    "name": "Example Site",
    "icon": "/icons/example_abc1.png",
    "category": ["Tools", "Personal"],
    "description": "Up to 200 characters."
  }
}
```
All fields are optional. If `name` is absent, the frontend derives it from the URL hostname. If `icon` is absent, the favicon proxy is used at display time. **`category` may be a single string or an array of strings** — a link with multiple categories is sorted into all of them (shown once per section in By Category, and matched by any of them in Filter). The edit overlay accepts categories comma-separated and saves a bare string for one, an array for several. If `category` is absent/empty, the link is treated as `Uncategorized`. **Key order in the JSON is the display order** — the drag-to-reorder feature rewrites the object with keys in the new order.

**Atomic writes**: `atomic_write(path, text)` (in `habit_store.py`) writes to `<name>.tmp` then renames over the target, preventing partial reads. Used for `links.json`, `habits.json`, and CSV rewrites (new records are plain appends).

**`habits.json`** — habit config; key = display name (unique case-insensitively, no `/`, not `order`); key order = display order:
```json
{
  "Morning Run": {
    "type": "POSITIVE",
    "occurs": "periodic",
    "metrics": [
      {"name": "Distance", "kind": "number",   "unit": "mi"},
      {"name": "Time",     "kind": "duration", "unit": ""}
    ],
    "goals": [
      {"period": "week", "type": "raw",   "metric1": "Distance", "agg": "sum", "target": 15, "color": "#58a6ff"},
      {"period": "day",  "type": "ratio", "metric1": "Time", "metric2": "Distance", "target": 540, "color": "#3fb950"}
    ],
    "slug": "morning-run"
  }
}
```
- `type` POSITIVE (goals met when value `>=` target) / NEGATIVE (`<=`) — the default for each goal. A goal may override it with optional `direction` `atLeast` / `atMost` (omitted = follow the habit type; `HabitMath.goalDirection`). Empty periods count as met for `atMost` goals, not met for `atLeast`. `occurs` daily (one record per local day) / periodic.
- Metric `kind` number / duration (seconds; entered H:MM:SS). `count` (records in period) is a built-in metric; `count`/`timestamp` are reserved names.
- Goal `period` day/week/month/year/all; `type` raw (with `agg` sum/avg/max/min, omitted for `count`) or ratio (`sum(metric1)/sum(metric2)`). `target` is stored in raw units (seconds for durations, per-second for number÷duration rates).
- `slug` is server-managed (assigned on create/rename, numeric suffix on collision, stripped from `GET /api/habits`) and names the CSV, so reordering never changes which file belongs to a habit.

**`habits/<slug>.csv`** — header `timestamp,<metric names…>`, one row per record. `timestamp` is browser-local ISO with offset (`2026-09-25T14:30:00-04:00`); all bucketing uses its date part (`ts[:10]`), so the server needs no timezone logic. Timestamps more than 5 min in the future are rejected. Renaming a metric rewrites the header; removing one copies the CSV to `.trash/` first.

---

## Frontend Behaviour

### Auth gate
Header, view controls, and grid start with CSS class `hidden` (`display: none !important`). `showApp()` reveals the header and calls `setPage()`, which reveals the current page's content after the auth check passes.

### Pages (Links | Habits)
Segmented tabs in the header (`.page-tabs`). `setPage()` swaps `#viewControls`/`#linkGrid`/`#editBtn` (Links) for `#habitBoard`/`#addHabitBtn` (Habits). The page is kept in the URL hash (`#habits`) and `localStorage` (`linkBoard.page`). Habit data is fetched the first time the Habits tab is shown (`Habits.show()`).

### View modes
A controls bar (`#viewControls`) below the header offers three segmented modes (`state.viewMode`):
- **All** — every link in JSON order, one flat grid.
- **By Category** — one `.category-section` per category (heading + count + grid); category order is first-appearance, with `Uncategorized` last.
- **Filter** — reveals a row of category checkboxes (`#categoryFilters`); only checked categories render. All are checked by default (`state.selectedCategories`).

The view (mode + checked filter categories) is persisted in `localStorage` under `linkBoard.view` by `saveViewState()` and restored after links load (`restoreViewState()`), so a reload returns to the same view.

Categories are derived from each link's optional `category` field (string or array) via `getCategoriesOf()` (per-link list) / `getCategories()` (all distinct). A multi-category link appears in every one of its sections in By Category and matches if any of its categories is checked in Filter.

### Drag-to-reorder
Each card has a dot-grid drag handle (`.drag-handle`, visible on card hover) at its right end. Only the handle is `draggable` (the card anchor is `draggable="false"`), so clicks still open the link. Dragging is confined to its own grid container (`state.dragOrigin`) — you reorder within a section, not across categories. Reordering uses a **swap-through** model: `setupCardDropTarget()` listens for `dragenter` on each card and, when the dragged card enters another card, moves it into that card's slot (before or after, based on their relative index) and pushes the other card back. Reacting on `dragenter` (once per card entry) rather than on every `dragover` avoids the jitter of continuously re-sorting by nearest center — after each move the dragged card lands under the pointer, so it can't immediately re-trigger and flip back. The drag ends via the idempotent `finishDrag()`, called from the handle's `dragend` and from document-level `drop`/`dragend` backstops (moving the dragged card in the DOM mid-drag means browsers may not fire `dragend` on it). `finishDrag()` calls `persistOrder()`, which rebuilds `links.json` from the DOM order (merging in any filtered-out links at their original positions) and `PUT`s it.

### Hover preview
Triggered after 400 ms on mouseenter. Calls `GET /api/preview?url=...` (results cached in `state.previewCache`). Shows a popup with og:image, title, description, and URL. The popup is positioned right of the card, flipping left/above if it would overflow the viewport. **Not an iframe** — most sites send `X-Frame-Options: DENY`, so OG metadata was chosen instead.

### Edit overlay
- Opens only when authenticated. Session state persists across page loads.
- Each row: click-to-upload icon, URL input, name input, description textarea (with live 200-char counter), remove button.
- Favicon auto-updates when the URL field loses focus (if no custom icon is set).
- Save does a `PUT /api/links` with the collected state; on success updates `state.links` and re-renders the grid.

### Habits page (`habits.js`, math in `habit-math.js`)
- **Rows** (`.habit-row`): info (name, badges, metrics, + Record / Records / ✎) | goal stack | calendar | drag handle. Below 900px the row stacks (info → goals → calendar) with the handle top-right.
- **Goal cell**: label, MET/NOT MET for the current period so far, streak (consecutive *completed* periods met, walking back to the earliest record's period; empty periods count as met for “at most” goals, not met for “at least”; none for all-time), and 7 Sun–Sat bars of this week's daily values (no-data days are gaps). Click → detail overlay; hover → isolates that goal's calendar bubbles (class toggle).
- **Calendar**: per-habit month (in memory; › disabled at the current month). One bubble per goal per day, area relative to that goal's best day in the month, larger drawn first.
- **Detail overlay**: Week/Month (daily bars), Year (weekly), All (monthly), clipped to the first record. In-progress bucket drawn lighter and excluded from the least-squares trend (needs ≥2 complete buckets); trend projected ~25% forward. Target line: direct for avg/max/min/ratio; for sum/count, exact when bucket = goal period, else prorated "pace"; none for all-time sums.
- **Menus** open in `#habitOverlay` (z 500), or `#habitDialog` (z 600) when opened from another menu. Escape closes the topmost. After any change the page re-fetches `/api/habits` and redraws (open menus refresh themselves).
- **Record form**: `datetime-local` (default now, max now) + one required input per metric; for daily habits a notice appears when the day already has a record, and saving replaces it.
- **Drag reorder**: same swap-through model as links, with its own state (`hs.dragName`); persisted via `PUT /api/habits/order`.
- **Ratio display** (`HabitMath.displayScale`): duration÷number → pace (`9:00 /mi`), number÷duration → per hour (`mi/h`), duration÷duration → unitless. Goal target inputs use the same display units.

### Icon handling
1. If the link has a custom `icon` path → served from `/icons/`
2. Otherwise → `/api/favicon?url=...` (proxied from `https://www.google.com/s2/favicons?domain=...&sz=64`)
3. On `<img>` error → `/static/icon-default.svg` (link-chain SVG)

---

## Caching

Cloudflare caches static assets aggressively when the origin sends no `Cache-Control` header. To prevent stale JS/CSS from being served after code changes:
- `NoCacheMiddleware` adds `Cache-Control: no-store` to every response.
- Static asset links in `index.html` include a `?v=N` query string (currently `?v=10`). **Increment this (on every asset, including `habit-math.js`, `habits.js`, `habits.css`) any time any of them is updated** to force a Cloudflare cache miss for clients that may have an older version cached.

---

## Dependencies (`requirements.txt`)
| Package | Purpose |
|---------|---------|
| `fastapi` | Web framework |
| `uvicorn[standard]` | ASGI server |
| `python-multipart` | Multipart form / file upload parsing |
| `httpx` | Async HTTP client (favicon proxy, preview fetch) |
| `beautifulsoup4` | HTML parsing for OG metadata extraction |
| `python-dotenv` | Load `.env` at startup |
| `itsdangerous` | Signed session token serialization |
| `aiofiles` | Async file I/O for icon uploads |
