from datetime import datetime, timedelta, timezone

import pytest

RUN = {
    "name": "Morning Run",
    "type": "POSITIVE",
    "occurs": "periodic",
    "metrics": [
        {"name": "Distance", "kind": "number", "unit": "mi"},
        {"name": "Time", "kind": "duration", "unit": ""},
    ],
    "goals": [
        {"period": "week", "type": "raw", "metric1": "Distance", "agg": "sum", "target": 15, "color": "#58a6ff"},
        {"period": "day", "type": "ratio", "metric1": "Time", "metric2": "Distance", "target": 540, "color": "#3fb950"},
    ],
}

WATER = {"name": "Water", "type": "POSITIVE", "occurs": "daily", "metrics": [], "goals": []}


def ts(days_ago=0, hour=8):
    tz = timezone(timedelta(hours=-4))
    d = datetime.now(tz) - timedelta(days=days_ago)
    return d.replace(hour=hour, minute=0, second=0, microsecond=0).isoformat()


def rec(t, **values):
    return {"ts": t, "values": values}


def data(client):
    r = client.get("/api/habits")
    assert r.status_code == 200
    return r.json()


# ─── auth ───────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("method,path", [
    ("get", "/api/habits"),
    ("post", "/api/habits"),
    ("put", "/api/habits/order"),
    ("put", "/api/habits/X"),
    ("delete", "/api/habits/X"),
    ("post", "/api/habits/X/records"),
    ("put", "/api/habits/X/records/0"),
    ("delete", "/api/habits/X/records/0?ts=a"),
])
def test_requires_auth(anon, method, path):
    assert getattr(anon, method)(path).status_code == 401


def test_no_store_header(client):
    assert client.get("/api/habits").headers["cache-control"] == "no-store"


# ─── create / validation ────────────────────────────────────────────────────

def test_create_and_get(client, base_dir):
    assert client.post("/api/habits", json=RUN).status_code == 200
    d = data(client)
    assert list(d["habits"]) == ["Morning Run"]
    assert "slug" not in d["habits"]["Morning Run"]
    assert d["habits"]["Morning Run"]["goals"][0]["target"] == 15
    assert d["records"] == {"Morning Run": []}
    assert (base_dir / "habits" / "morning-run.csv").read_text() == "timestamp,Distance,Time\n"


def test_duplicate_name_case_insensitive(client):
    client.post("/api/habits", json=RUN)
    r = client.post("/api/habits", json={**RUN, "name": "morning run"})
    assert r.status_code == 409


def test_slug_collision_gets_suffix(client, base_dir):
    client.post("/api/habits", json={**WATER, "name": "Run!"})
    client.post("/api/habits", json={**WATER, "name": "Run?"})
    assert (base_dir / "habits" / "run.csv").exists()
    assert (base_dir / "habits" / "run-2.csv").exists()


@pytest.mark.parametrize("patch", [
    {"name": ""},
    {"name": "a/b"},
    {"name": "order"},
    {"type": "MAYBE"},
    {"occurs": "hourly"},
    {"metrics": [{"name": "count", "kind": "number"}]},
    {"metrics": [{"name": "A"}, {"name": "a"}]},
    {"metrics": [{"name": "A", "kind": "weight"}]},
    {"goals": [{**RUN["goals"][0], "metric1": "Nope"}]},
    {"goals": [{**RUN["goals"][0], "target": "15"}]},
    {"goals": [{**RUN["goals"][0], "color": "blue"}]},
    {"goals": [{**RUN["goals"][0], "agg": "median"}]},
    {"goals": [{**RUN["goals"][0], "period": "fortnight"}]},
    {"goals": [{**RUN["goals"][1], "metric2": None}]},
])
def test_create_validation(client, patch):
    assert client.post("/api/habits", json={**RUN, **patch}).status_code == 400


def test_count_goal_drops_agg(client):
    goal = {"period": "day", "type": "raw", "metric1": "count", "agg": "max", "target": 8, "color": "#ffffff"}
    client.post("/api/habits", json={**WATER, "goals": [goal]})
    assert "agg" not in data(client)["habits"]["Water"]["goals"][0]


# ─── records ────────────────────────────────────────────────────────────────

def test_csv_round_trip(client, base_dir):
    client.post("/api/habits", json={**RUN, "metrics": RUN["metrics"] + [{"name": 'Notes, "quoted"', "kind": "number"}]})
    t = ts(1)
    r = client.post("/api/habits/Morning Run/records", json=rec(t, Distance=3.1, Time=1650, **{'Notes, "quoted"': 2}))
    assert r.status_code == 200 and r.json()["index"] == 0
    got = data(client)["records"]["Morning Run"]
    assert got == [{"ts": t, "values": {"Distance": 3.1, "Time": 1650, 'Notes, "quoted"': 2}}]
    header = (base_dir / "habits" / "morning-run.csv").read_text().splitlines()[0]
    assert header == 'timestamp,Distance,Time,"Notes, ""quoted"""'


def test_record_requires_all_metrics(client):
    client.post("/api/habits", json=RUN)
    r = client.post("/api/habits/Morning Run/records", json=rec(ts(), Distance=3))
    assert r.status_code == 400


def test_record_rejects_negative_duration(client):
    client.post("/api/habits", json=RUN)
    r = client.post("/api/habits/Morning Run/records", json=rec(ts(), Distance=3, Time=-1))
    assert r.status_code == 400


def test_future_timestamp_rejected(client):
    client.post("/api/habits", json=WATER)
    future = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()
    assert client.post("/api/habits/Water/records", json=rec(future)).status_code == 400
    near = (datetime.now(timezone.utc) + timedelta(minutes=2)).isoformat()
    assert client.post("/api/habits/Water/records", json=rec(near)).status_code == 200


def test_timestamp_needs_offset(client):
    client.post("/api/habits", json=WATER)
    assert client.post("/api/habits/Water/records", json=rec("2026-01-01T10:00:00")).status_code == 400


def test_daily_duplicate_409_and_replace(client):
    client.post("/api/habits", json=WATER)
    assert client.post("/api/habits/Water/records", json=rec(ts(1, 8))).status_code == 200
    assert client.post("/api/habits/Water/records", json=rec(ts(1, 20))).status_code == 409
    r = client.post("/api/habits/Water/records", json={**rec(ts(1, 20)), "replace": True})
    assert r.status_code == 200 and r.json()["index"] == 0
    assert [x["ts"] for x in data(client)["records"]["Water"]] == [ts(1, 20)]


def test_periodic_allows_same_day(client):
    client.post("/api/habits", json=RUN)
    for h in (7, 18):
        assert client.post("/api/habits/Morning Run/records", json=rec(ts(1, h), Distance=1, Time=600)).status_code == 200
    assert len(data(client)["records"]["Morning Run"]) == 2


def test_edit_and_delete_record(client):
    client.post("/api/habits", json=RUN)
    a, b = ts(2), ts(1)
    client.post("/api/habits/Morning Run/records", json=rec(a, Distance=1, Time=600))
    client.post("/api/habits/Morning Run/records", json=rec(b, Distance=2, Time=1200))
    # stale expected ts → 409
    r = client.put("/api/habits/Morning Run/records/0", json={**rec(a, Distance=5, Time=1), "expectedTs": b})
    assert r.status_code == 409
    r = client.put("/api/habits/Morning Run/records/0", json={**rec(a, Distance=5, Time=1), "expectedTs": a})
    assert r.status_code == 200
    assert data(client)["records"]["Morning Run"][0]["values"] == {"Distance": 5, "Time": 1}
    assert client.delete("/api/habits/Morning Run/records/0", params={"ts": b}).status_code == 409
    assert client.delete("/api/habits/Morning Run/records/0", params={"ts": a}).status_code == 200
    assert [x["ts"] for x in data(client)["records"]["Morning Run"]] == [b]
    assert client.delete("/api/habits/Morning Run/records/5", params={"ts": b}).status_code == 404


def test_daily_edit_onto_taken_day(client):
    client.post("/api/habits", json=WATER)
    a, b = ts(2), ts(1)
    client.post("/api/habits/Water/records", json=rec(a))
    client.post("/api/habits/Water/records", json=rec(b))
    body = {**rec(ts(1, 15)), "expectedTs": a}
    assert client.put("/api/habits/Water/records/0", json=body).status_code == 409
    assert client.put("/api/habits/Water/records/0", json={**body, "replace": True}).status_code == 200
    assert [x["ts"] for x in data(client)["records"]["Water"]] == [ts(1, 15)]


# ─── update / rename / delete ───────────────────────────────────────────────

def test_rename_habit_moves_csv_and_keeps_position(client, base_dir):
    client.post("/api/habits", json=RUN)
    client.post("/api/habits", json=WATER)
    client.post("/api/habits/Morning Run/records", json=rec(ts(), Distance=1, Time=60))
    body = {**RUN, "newName": "Evening Run"}
    assert client.put("/api/habits/Morning Run", json=body).status_code == 200
    d = data(client)
    assert list(d["habits"]) == ["Evening Run", "Water"]
    assert len(d["records"]["Evening Run"]) == 1
    assert not (base_dir / "habits" / "morning-run.csv").exists()
    assert (base_dir / "habits" / "evening-run.csv").exists()


def test_rename_to_existing_name_conflicts(client):
    client.post("/api/habits", json=RUN)
    client.post("/api/habits", json=WATER)
    assert client.put("/api/habits/Water", json={**WATER, "newName": "MORNING RUN"}).status_code == 409


def test_case_only_rename_allowed(client):
    client.post("/api/habits", json=WATER)
    assert client.put("/api/habits/Water", json={**WATER, "newName": "WATER"}).status_code == 200
    assert list(data(client)["habits"]) == ["WATER"]


def test_rename_metric_updates_header_and_goals(client, base_dir):
    client.post("/api/habits", json=RUN)
    client.post("/api/habits/Morning Run/records", json=rec(ts(), Distance=3, Time=900))
    metrics = [{"name": "Miles", "kind": "number", "unit": "mi", "was": "Distance"}, RUN["metrics"][1]]
    r = client.put("/api/habits/Morning Run", json={**RUN, "metrics": metrics})
    assert r.status_code == 200, r.text
    d = data(client)
    goals = d["habits"]["Morning Run"]["goals"]
    assert goals[0]["metric1"] == "Miles" and goals[1]["metric2"] == "Miles"
    assert d["records"]["Morning Run"][0]["values"] == {"Miles": 3, "Time": 900}
    assert (base_dir / "habits" / "morning-run.csv").read_text().startswith("timestamp,Miles,Time\n")


def test_remove_metric_blocked_by_goal(client):
    client.post("/api/habits", json=RUN)
    r = client.put("/api/habits/Morning Run", json={**RUN, "metrics": [RUN["metrics"][1]]})
    assert r.status_code == 400


def test_remove_metric_backs_up_csv(client, base_dir):
    client.post("/api/habits", json=RUN)
    client.post("/api/habits/Morning Run/records", json=rec(ts(), Distance=3, Time=900))
    body = {**RUN, "metrics": [RUN["metrics"][0]], "goals": [RUN["goals"][0]]}
    assert client.put("/api/habits/Morning Run", json=body).status_code == 200
    assert data(client)["records"]["Morning Run"][0]["values"] == {"Distance": 3}
    backups = list((base_dir / "habits" / ".trash").glob("morning-run-*.csv"))
    assert len(backups) == 1 and "Time" in backups[0].read_text()


def test_add_metric_old_rows_blank(client):
    client.post("/api/habits", json=RUN)
    client.post("/api/habits/Morning Run/records", json=rec(ts(), Distance=3, Time=900))
    body = {**RUN, "metrics": RUN["metrics"] + [{"name": "HR", "kind": "number", "unit": "bpm"}]}
    assert client.put("/api/habits/Morning Run", json=body).status_code == 200
    assert data(client)["records"]["Morning Run"][0]["values"] == {"Distance": 3, "Time": 900}


def test_update_missing_habit_404(client):
    assert client.put("/api/habits/Nope", json=WATER).status_code == 404


def test_delete_moves_csv_to_trash(client, base_dir):
    client.post("/api/habits", json=RUN)
    assert client.delete("/api/habits/Morning Run").status_code == 200
    assert data(client)["habits"] == {}
    assert not (base_dir / "habits" / "morning-run.csv").exists()
    assert len(list((base_dir / "habits" / ".trash").glob("morning-run-*.csv"))) == 1
    assert client.delete("/api/habits/Morning Run").status_code == 404


def test_reorder(client):
    for n in ("A", "B", "C"):
        client.post("/api/habits", json={**WATER, "name": n})
    assert client.put("/api/habits/order", json={"order": ["C", "A", "B"]}).status_code == 200
    assert list(data(client)["habits"]) == ["C", "A", "B"]
    assert client.put("/api/habits/order", json={"order": ["C", "A"]}).status_code == 400
    assert client.put("/api/habits/order", json={"order": ["C", "A", "A"]}).status_code == 400


def test_links_still_work(client):
    assert client.put("/api/links", json={"https://a.com": {"name": "A"}}).status_code == 200
    assert client.get("/api/links").json() == {"https://a.com": {"name": "A"}}
