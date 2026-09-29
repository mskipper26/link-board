import json

import pytest


def decks(client):
    r = client.get("/api/decks")
    assert r.status_code == 200
    return r.json()


def make_deck(client, name="Spanish"):
    r = client.post("/api/decks", json={"name": name})
    assert r.status_code == 200
    return r.json()["slug"]


def add(client, slug, front="hola", back="hello"):
    r = client.post(f"/api/decks/{slug}/cards", json={"front": front, "back": back})
    assert r.status_code == 200
    return r.json()


def on_disk(base_dir, slug):
    return json.loads((base_dir / "decks" / f"{slug}.json").read_text())


# ─── auth ───────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("method,path", [
    ("get", "/api/decks"),
    ("post", "/api/decks"),
    ("put", "/api/decks/x"),
    ("delete", "/api/decks/x"),
    ("post", "/api/decks/x/reset"),
    ("post", "/api/decks/x/cards"),
    ("put", "/api/decks/x/cards/abc"),
    ("delete", "/api/decks/x/cards/abc"),
    ("post", "/api/decks/x/cards/abc/fail"),
])
def test_requires_auth(anon, method, path):
    assert getattr(anon, method)(path).status_code == 401


# ─── decks ──────────────────────────────────────────────────────────────────

def test_create_and_list(client, base_dir):
    assert make_deck(client, "Spanish Verbs") == "spanish-verbs"
    assert decks(client) == [{"slug": "spanish-verbs", "name": "Spanish Verbs", "cards": []}]
    assert on_disk(base_dir, "spanish-verbs") == {"name": "Spanish Verbs", "cards": []}


def test_list_sorted_by_name(client):
    for n in ["beta", "Alpha", "gamma"]:
        make_deck(client, n)
    assert [d["name"] for d in decks(client)] == ["Alpha", "beta", "gamma"]


def test_duplicate_name_case_insensitive(client):
    make_deck(client, "Spanish")
    assert client.post("/api/decks", json={"name": "spanish"}).status_code == 409


def test_slug_collision_and_fallback(client):
    assert make_deck(client, "C++") == "c"
    assert make_deck(client, "C#") == "c-2"
    assert make_deck(client, "日本語") == "deck"
    assert make_deck(client, "Habit") == "habit"


@pytest.mark.parametrize("body", [{}, {"name": ""}, {"name": "   "}, {"name": 5}, {"name": "x" * 61}])
def test_create_validation(client, body):
    assert client.post("/api/decks", json=body).status_code == 400


def test_rename_keeps_slug_and_cards(client, base_dir):
    slug = make_deck(client)
    add(client, slug)
    r = client.put(f"/api/decks/{slug}", json={"name": "Español"})
    assert r.status_code == 200 and r.json() == {"slug": slug, "name": "Español"}
    d = on_disk(base_dir, slug)
    assert d["name"] == "Español" and len(d["cards"]) == 1


def test_rename_conflict_and_self_case_change(client):
    a = make_deck(client, "A")
    make_deck(client, "B")
    assert client.put(f"/api/decks/{a}", json={"name": "b"}).status_code == 409
    assert client.put(f"/api/decks/{a}", json={"name": "a"}).status_code == 200


def test_delete_moves_to_trash(client, base_dir):
    slug = make_deck(client)
    assert client.delete(f"/api/decks/{slug}").status_code == 200
    assert decks(client) == []
    assert not (base_dir / "decks" / f"{slug}.json").exists()
    assert len(list((base_dir / "decks" / ".trash").glob(f"{slug}-*.json"))) == 1


@pytest.mark.parametrize("slug", ["nope", "..", "a_b", "Upper", "-x"])
def test_unknown_or_malformed_slug_404(client, slug):
    assert client.put(f"/api/decks/{slug}", json={"name": "Z"}).status_code == 404
    assert client.post(f"/api/decks/{slug}/cards", json={"front": "a", "back": "b"}).status_code == 404


def test_unreadable_deck_file_skipped(client, base_dir):
    make_deck(client)
    (base_dir / "decks" / "broken.json").write_text("{not json")
    assert [d["slug"] for d in decks(client)] == ["spanish"]


# ─── cards ──────────────────────────────────────────────────────────────────

def test_add_card(client, base_dir):
    slug = make_deck(client)
    card = add(client, slug, "  hola ", "hello")
    assert card["front"] == "hola" and card["back"] == "hello" and card["fails"] == 0
    assert on_disk(base_dir, slug)["cards"] == [card]


def test_card_ids_unique(client):
    slug = make_deck(client)
    ids = {add(client, slug)["id"] for _ in range(20)}
    assert len(ids) == 20


@pytest.mark.parametrize("body", [
    {"front": "", "back": "b"},
    {"front": "a", "back": "  "},
    {"front": "a"},
    {"front": 1, "back": "b"},
    {"front": "a" * 2001, "back": "b"},
])
def test_card_validation(client, body):
    slug = make_deck(client)
    assert client.post(f"/api/decks/{slug}/cards", json=body).status_code == 400


def test_edit_card_keeps_fails(client):
    slug = make_deck(client)
    card = add(client, slug)
    client.post(f"/api/decks/{slug}/cards/{card['id']}/fail")
    r = client.put(f"/api/decks/{slug}/cards/{card['id']}", json={"front": "adiós", "back": "bye"})
    assert r.status_code == 200
    assert r.json() == {"id": card["id"], "front": "adiós", "back": "bye", "fails": 1}


def test_delete_card(client):
    slug = make_deck(client)
    a, b = add(client, slug, "a"), add(client, slug, "b")
    assert client.delete(f"/api/decks/{slug}/cards/{a['id']}").status_code == 200
    assert decks(client)[0]["cards"] == [b]
    assert client.delete(f"/api/decks/{slug}/cards/{a['id']}").status_code == 404


def test_fail_increments_and_reset(client):
    slug = make_deck(client)
    a, b = add(client, slug, "a"), add(client, slug, "b")
    for expected in (1, 2, 3):
        r = client.post(f"/api/decks/{slug}/cards/{a['id']}/fail")
        assert r.json() == {"fails": expected}
    client.post(f"/api/decks/{slug}/cards/{b['id']}/fail")
    assert [c["fails"] for c in decks(client)[0]["cards"]] == [3, 1]
    assert client.post(f"/api/decks/{slug}/reset").status_code == 200
    assert [c["fails"] for c in decks(client)[0]["cards"]] == [0, 0]


def test_fail_unknown_card_404(client):
    slug = make_deck(client)
    assert client.post(f"/api/decks/{slug}/cards/deadbeef/fail").status_code == 404
