# PROJECT: WEB LINK BOARD
A simple app for quickly accessing important links for personal use.

## Overview
Single-page web app with a responsive grid of link cards. Each card shows an icon, site name, and optional description. Hovering a card shows a preview popup (OG metadata: title, description, og:image). Clicking opens the link in a new tab. An Edit button in the top-right opens an overlay panel for managing links.

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
├── main.py               # FastAPI app (all backend logic)
├── requirements.txt
├── start.sh              # Entrypoint for systemd service
├── .env                  # Passkey, secret key, paths & URL (not in version control; see .env.example)
├── links.json            # Live data store
├── icons/                # Uploaded custom icons
└── static/
    ├── index.html
    ├── style.css
    ├── app.js
    ├── favicon.svg
    └── icon-default.svg  # Fallback icon when favicon unavailable
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

**Atomic writes**: `save_links()` writes to `links.tmp` then renames to `links.json`, preventing partial reads.

---

## Frontend Behaviour

### Auth gate
Header, view controls, and grid start with CSS class `hidden` (`display: none !important`). `showApp()` removes `hidden` from all three after the auth check passes.

### View modes
A controls bar (`#viewControls`) below the header offers three segmented modes (`state.viewMode`):
- **All** — every link in JSON order, one flat grid.
- **By Category** — one `.category-section` per category (heading + count + grid); category order is first-appearance, with `Uncategorized` last.
- **Filter** — reveals a row of category checkboxes (`#categoryFilters`); only checked categories render. All are checked by default (`state.selectedCategories`).

Categories are derived from each link's optional `category` field (string or array) via `getCategoriesOf()` (per-link list) / `getCategories()` (all distinct). A multi-category link appears in every one of its sections in By Category and matches if any of its categories is checked in Filter.

### Drag-to-reorder
Each card has a dot-grid drag handle (`.drag-handle`, visible on card hover) at its right end. Only the handle is `draggable` (the card anchor is `draggable="false"`), so clicks still open the link. Dragging is confined to its own grid container (`state.dragOrigin`) — you reorder within a section, not across categories. Reordering uses a **swap-through** model: `setupCardDropTarget()` listens for `dragenter` on each card and, when the dragged card enters another card, moves it into that card's slot (before or after, based on their relative index) and pushes the other card back. Reacting on `dragenter` (once per card entry) rather than on every `dragover` avoids the jitter of continuously re-sorting by nearest center — after each move the dragged card lands under the pointer, so it can't immediately re-trigger and flip back. On drop, `persistOrder()` rebuilds `links.json` from the DOM order (merging in any filtered-out links at their original positions) and `PUT`s it.

### Hover preview
Triggered after 400 ms on mouseenter. Calls `GET /api/preview?url=...` (results cached in `state.previewCache`). Shows a popup with og:image, title, description, and URL. The popup is positioned right of the card, flipping left/above if it would overflow the viewport. **Not an iframe** — most sites send `X-Frame-Options: DENY`, so OG metadata was chosen instead.

### Edit overlay
- Opens only when authenticated. Session state persists across page loads.
- Each row: click-to-upload icon, URL input, name input, description textarea (with live 200-char counter), remove button.
- Favicon auto-updates when the URL field loses focus (if no custom icon is set).
- Save does a `PUT /api/links` with the collected state; on success updates `state.links` and re-renders the grid.

### Icon handling
1. If the link has a custom `icon` path → served from `/icons/`
2. Otherwise → `/api/favicon?url=...` (proxied from `https://www.google.com/s2/favicons?domain=...&sz=64`)
3. On `<img>` error → `/static/icon-default.svg` (link-chain SVG)

---

## Caching

Cloudflare caches static assets aggressively when the origin sends no `Cache-Control` header. To prevent stale JS/CSS from being served after code changes:
- `NoCacheMiddleware` adds `Cache-Control: no-store` to every response.
- Static asset links in `index.html` include a `?v=N` query string (currently `?v=7`). **Increment this any time `app.js` or `style.css` is updated** to force a Cloudflare cache miss for clients that may have an older version cached.

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
