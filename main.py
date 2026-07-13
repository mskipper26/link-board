import os
import json
import hmac
import secrets
from pathlib import Path
from urllib.parse import urlparse

import httpx
from fastapi import FastAPI, HTTPException, Request, Response, UploadFile, File
from fastapi.responses import HTMLResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.base import BaseHTTPMiddleware
from bs4 import BeautifulSoup
from itsdangerous import URLSafeTimedSerializer, BadSignature, SignatureExpired
import aiofiles
from dotenv import load_dotenv

load_dotenv()

BASE_DIR = Path(os.environ.get("LINK_BOARD_DIR") or Path(__file__).resolve().parent)
LINKS_FILE = BASE_DIR / "links.json"
ICONS_DIR = BASE_DIR / "icons"
STATIC_DIR = BASE_DIR / "static"

ICONS_DIR.mkdir(exist_ok=True)

PASSKEY = os.environ["LINK_BOARD_PASSKEY"]
SECRET_KEY = os.environ.get("SECRET_KEY", secrets.token_hex(32))
SESSION_MAX_AGE = 86400 * 7  # 7 days

serializer = URLSafeTimedSerializer(SECRET_KEY)

app = FastAPI()


class NoCacheMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        return response


app.add_middleware(NoCacheMiddleware)

if not LINKS_FILE.exists():
    LINKS_FILE.write_text("{}")


def load_links() -> dict:
    try:
        return json.loads(LINKS_FILE.read_text())
    except Exception:
        return {}


def save_links(links: dict):
    tmp = LINKS_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(links, indent=2, ensure_ascii=False))
    tmp.rename(LINKS_FILE)


def is_authenticated(request: Request) -> bool:
    token = request.cookies.get("session")
    if not token:
        return False
    try:
        serializer.loads(token, max_age=SESSION_MAX_AGE)
        return True
    except (BadSignature, SignatureExpired):
        return False


def require_auth(request: Request):
    if not is_authenticated(request):
        raise HTTPException(status_code=401, detail="Unauthorized")


app.mount("/icons", StaticFiles(directory=str(ICONS_DIR)), name="icons")
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


@app.get("/favicon.ico", include_in_schema=False)
async def favicon():
    return FileResponse(str(STATIC_DIR / "favicon.svg"), media_type="image/svg+xml")


@app.get("/", response_class=HTMLResponse)
async def index():
    return HTMLResponse((STATIC_DIR / "index.html").read_text())


@app.post("/api/auth")
async def authenticate(request: Request, response: Response):
    body = await request.json()
    passkey = body.get("passkey", "")
    if not hmac.compare_digest(passkey.encode(), PASSKEY.encode()):
        raise HTTPException(status_code=401, detail="Invalid passkey")
    token = serializer.dumps("ok")
    response.set_cookie(
        "session",
        token,
        httponly=True,
        max_age=SESSION_MAX_AGE,
        samesite="lax",
    )
    return {"ok": True}


@app.get("/api/auth/check")
async def check_auth(request: Request):
    if not is_authenticated(request):
        raise HTTPException(status_code=401, detail="Unauthorized")
    return {"ok": True}


@app.get("/api/links")
async def get_links(request: Request):
    require_auth(request)
    return load_links()


@app.put("/api/links")
async def update_links(request: Request):
    require_auth(request)
    links = await request.json()
    if not isinstance(links, dict):
        raise HTTPException(status_code=400, detail="Invalid format")
    save_links(links)
    return {"ok": True}


@app.post("/api/icon")
async def upload_icon(request: Request, file: UploadFile = File(...)):
    require_auth(request)
    suffix = Path(file.filename).suffix.lower()
    allowed = {".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".ico"}
    if suffix not in allowed:
        raise HTTPException(status_code=400, detail="Invalid file type")
    stem = Path(file.filename).stem
    # Sanitize stem: keep only alphanumeric, dash, underscore
    safe_stem = "".join(c for c in stem if c.isalnum() or c in "-_")[:40] or "icon"
    filename = f"{safe_stem}_{secrets.token_hex(4)}{suffix}"
    dest = ICONS_DIR / filename
    content = await file.read()
    async with aiofiles.open(dest, "wb") as f:
        await f.write(content)
    return {"path": f"/icons/{filename}"}


@app.get("/api/favicon")
async def proxy_favicon(url: str):
    parsed = urlparse(url if "://" in url else f"https://{url}")
    domain = parsed.netloc or parsed.path
    try:
        async with httpx.AsyncClient(timeout=5.0, follow_redirects=True) as client:
            r = await client.get(
                f"https://www.google.com/s2/favicons?domain={domain}&sz=64"
            )
            if r.status_code == 200:
                ct = r.headers.get("content-type", "image/png")
                return Response(content=r.content, media_type=ct)
    except Exception:
        pass
    raise HTTPException(status_code=404, detail="Not found")


@app.get("/api/preview")
async def get_preview(url: str):
    try:
        async with httpx.AsyncClient(timeout=7.0, follow_redirects=True) as client:
            r = await client.get(
                url,
                headers={"User-Agent": "Mozilla/5.0 (compatible; LinkBoard/1.0)"},
            )
            soup = BeautifulSoup(r.text, "html.parser")

            def meta_content(prop=None, name=None):
                if prop:
                    tag = soup.find("meta", property=prop)
                    if tag and tag.get("content"):
                        return tag["content"]
                if name:
                    tag = soup.find("meta", attrs={"name": name})
                    if tag and tag.get("content"):
                        return tag["content"]
                return ""

            title = (
                meta_content("og:title")
                or (soup.title.get_text(strip=True) if soup.title else "")
            )
            description = meta_content("og:description") or meta_content(name="description")
            image = meta_content("og:image")

            return {
                "title": title[:200],
                "description": description[:300],
                "image": image,
            }
    except Exception:
        return {"title": "", "description": "", "image": ""}


if __name__ == "__main__":
    import uvicorn

    host = os.environ.get("HOST", "0.0.0.0")
    port = int(os.environ.get("PORT", "8186"))
    uvicorn.run(app, host=host, port=port)
