"""Flash-card storage: one JSON file per deck in decks/<slug>.json.

Pure Python (no FastAPI) so it can be unit tested directly. Errors are raised
as StudyError(status, message); main.py turns them into HTTP responses.

A deck file holds {"name": ..., "cards": [{"id", "front", "back", "fails"}]}.
The slug is assigned once, on create, and never changes (renaming only edits
"name"), so it doubles as the deck's id in URLs. Card ids are random hex,
stable across edits. `fails` counts every time the card was marked "new to
me" during study; it only goes back to 0 via an explicit reset.

An optional "session" key holds the in-progress study session as card ids
({"queue", "known", "misses", "started"}) so it can be resumed later.
"""

import json
import re
import secrets
import shutil
from datetime import datetime
from pathlib import Path

from habit_store import atomic_write

MAX_NAME_LEN = 60
MAX_SIDE_LEN = 2000
SLUG_RE = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")


class StudyError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


def bad(message: str):
    raise StudyError(400, message)


def slugify(name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return slug[:40].strip("-") or "deck"


def _clean_text(value, field: str, max_len: int) -> str:
    if not isinstance(value, str):
        bad(f"{field} must be a string")
    value = value.strip()
    if not value:
        bad(f"{field} is required")
    if len(value) > max_len:
        bad(f"{field} must be at most {max_len} characters")
    return value


def validate_card_text(body) -> dict:
    if not isinstance(body, dict):
        bad("card must be an object")
    return {
        "front": _clean_text(body.get("front"), "Front", MAX_SIDE_LEN),
        "back": _clean_text(body.get("back"), "Back", MAX_SIDE_LEN),
    }


def validate_session(body, deck: dict) -> dict:
    """An in-progress study session, reduced to cards the deck still has.

    Unknown ids are dropped silently (a card may have been deleted in another
    tab mid-session); a card marked known is never also queued.
    """
    if not isinstance(body, dict):
        bad("session must be an object")
    ids = {c.get("id") for c in deck["cards"]}

    def id_list(field):
        value = body.get(field, [])
        if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
            bad(f"{field} must be a list of card ids")
        return list(dict.fromkeys(v for v in value if v in ids))

    known = id_list("known")
    queue = [i for i in id_list("queue") if i not in known]
    misses = body.get("misses", {})
    if not isinstance(misses, dict) or not all(
        isinstance(n, int) and not isinstance(n, bool) and n > 0 for n in misses.values()
    ):
        bad("misses must map card ids to positive counts")
    session = {"queue": queue, "known": known, "misses": {k: n for k, n in misses.items() if k in ids}}
    started = body.get("started")
    if started is not None:
        if not isinstance(started, str) or len(started) > 40:
            bad("started must be a short timestamp string")
        session["started"] = started
    return session


class StudyStore:
    def __init__(self, base_dir: Path):
        self.dir = Path(base_dir) / "decks"
        self.trash = self.dir / ".trash"
        self.dir.mkdir(exist_ok=True)

    # files -------------------------------------------------------------
    def _path(self, slug: str) -> Path:
        # Slugs come from the URL; only accept the shape slugify() produces.
        if not isinstance(slug, str) or not SLUG_RE.match(slug):
            raise StudyError(404, "Deck not found")
        return self.dir / f"{slug}.json"

    def _read(self, path: Path):
        try:
            deck = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        if not isinstance(deck, dict) or not isinstance(deck.get("cards"), list):
            return None
        return deck

    def _load(self, slug: str) -> dict:
        deck = self._read(self._path(slug))
        if deck is None:
            raise StudyError(404, "Deck not found")
        return deck

    def _save(self, slug: str, deck: dict):
        atomic_write(self._path(slug), json.dumps(deck, indent=2, ensure_ascii=False))

    def _all(self) -> dict:
        """slug -> deck for every readable deck file."""
        decks = {}
        for path in sorted(self.dir.glob("*.json")):
            deck = self._read(path)
            if deck is not None:
                decks[path.stem] = deck
        return decks

    def _check_unique(self, name: str, ignore: str = None):
        for slug, deck in self._all().items():
            if slug != ignore and str(deck.get("name", "")).lower() == name.lower():
                raise StudyError(409, f'A deck named "{deck["name"]}" already exists')

    @staticmethod
    def _card(deck: dict, card_id: str) -> dict:
        for card in deck["cards"]:
            if card.get("id") == card_id:
                return card
        raise StudyError(404, "Card not found")

    # decks -------------------------------------------------------------
    def all_decks(self) -> list:
        """Every deck, sorted by name: [{slug, name, cards, session}]."""
        decks = [
            {"slug": s, "name": d.get("name") or s, "cards": d["cards"], "session": d.get("session")}
            for s, d in self._all().items()
        ]
        return sorted(decks, key=lambda d: d["name"].lower())

    def create(self, body) -> dict:
        if not isinstance(body, dict):
            bad("Invalid deck")
        name = _clean_text(body.get("name"), "Name", MAX_NAME_LEN)
        self._check_unique(name)
        base = slugify(name)
        slug, i = base, 2
        while (self.dir / f"{slug}.json").exists():
            slug = f"{base}-{i}"
            i += 1
        self._save(slug, {"name": name, "cards": []})
        return {"slug": slug, "name": name}

    def rename(self, slug: str, body) -> dict:
        deck = self._load(slug)
        if not isinstance(body, dict):
            bad("Invalid deck")
        name = _clean_text(body.get("name"), "Name", MAX_NAME_LEN)
        self._check_unique(name, ignore=slug)
        deck["name"] = name
        self._save(slug, deck)
        return {"slug": slug, "name": name}

    def delete(self, slug: str):
        path = self._path(slug)
        self._load(slug)
        self.trash.mkdir(exist_ok=True)
        stamp = datetime.now().strftime("%Y%m%dT%H%M%S")
        shutil.move(str(path), str(self.trash / f"{slug}-{stamp}.json"))

    def reset_fails(self, slug: str):
        deck = self._load(slug)
        for card in deck["cards"]:
            card["fails"] = 0
        self._save(slug, deck)

    # study session -----------------------------------------------------
    def save_session(self, slug: str, body) -> dict:
        deck = self._load(slug)
        deck["session"] = validate_session(body, deck)
        self._save(slug, deck)
        return deck["session"]

    def clear_session(self, slug: str):
        deck = self._load(slug)
        if deck.pop("session", None) is not None:
            self._save(slug, deck)

    # cards -------------------------------------------------------------
    def add_card(self, slug: str, body) -> dict:
        deck = self._load(slug)
        taken = {c.get("id") for c in deck["cards"]}
        card_id = secrets.token_hex(4)
        while card_id in taken:
            card_id = secrets.token_hex(4)
        card = {"id": card_id, **validate_card_text(body), "fails": 0}
        deck["cards"].append(card)
        self._save(slug, deck)
        return card

    def update_card(self, slug: str, card_id: str, body) -> dict:
        deck = self._load(slug)
        card = self._card(deck, card_id)
        card.update(validate_card_text(body))
        self._save(slug, deck)
        return card

    def delete_card(self, slug: str, card_id: str):
        deck = self._load(slug)
        card = self._card(deck, card_id)
        deck["cards"].remove(card)
        self._save(slug, deck)

    def record_fail(self, slug: str, card_id: str) -> dict:
        """Increment server-side so a stale client can't clobber the count."""
        deck = self._load(slug)
        card = self._card(deck, card_id)
        card["fails"] = int(card.get("fails") or 0) + 1
        self._save(slug, deck)
        return {"fails": card["fails"]}
