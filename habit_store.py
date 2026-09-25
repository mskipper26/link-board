"""Habit tracker storage: config in habits.json, records in one CSV per habit.

Pure Python (no FastAPI) so it can be unit tested directly. Errors are raised
as HabitError(status, message); main.py turns them into HTTP responses.

habits.json maps display name -> config (key order = display order). Each
config carries a server-managed `slug` naming its CSV (habits/<slug>.csv); it
is assigned once, on create/rename, so reordering or adding habits can never
change which file belongs to which habit.
"""

import csv
import io
import json
import math
import re
import shutil
from datetime import datetime, timedelta, timezone
from pathlib import Path

HABIT_TYPES = {"POSITIVE", "NEGATIVE"}
OCCURS = {"daily", "periodic"}
METRIC_KINDS = {"number", "duration"}
PERIODS = {"day", "week", "month", "year", "all"}
GOAL_TYPES = {"raw", "ratio"}
AGGS = {"sum", "avg", "max", "min"}
RESERVED_METRICS = {"count", "timestamp"}
COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")
MAX_NAME_LEN = 60
MAX_UNIT_LEN = 20
FUTURE_SKEW = timedelta(minutes=5)


class HabitError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


def bad(message: str):
    raise HabitError(400, message)


def atomic_write(path: Path, text: str):
    """Write to a sibling temp file, then rename over the target."""
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    tmp.replace(path)


def slugify(name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return slug[:40].strip("-") or "habit"


def _clean_str(value, field: str, max_len: int, required: bool = True) -> str:
    if value is None:
        value = ""
    if not isinstance(value, str):
        bad(f"{field} must be a string")
    value = value.strip()
    if required and not value:
        bad(f"{field} is required")
    if len(value) > max_len:
        bad(f"{field} must be at most {max_len} characters")
    return value


def _number(value, field: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        bad(f"{field} must be a number")
    if not math.isfinite(value):
        bad(f"{field} must be finite")
    return value


# ─── Config validation ──────────────────────────────────────────────────────

def validate_name(value) -> str:
    name = _clean_str(value, "Name", MAX_NAME_LEN)
    # Names appear as a URL path segment; "/" can't round-trip and "order"
    # would collide with PUT /api/habits/order.
    if "/" in name:
        bad('Name cannot contain "/"')
    if name.lower() == "order":
        bad('"order" is a reserved name')
    return name


def validate_metrics(raw) -> list:
    if not isinstance(raw, list):
        bad("metrics must be a list")
    metrics, seen = [], set()
    for m in raw:
        if not isinstance(m, dict):
            bad("each metric must be an object")
        name = _clean_str(m.get("name"), "Metric name", MAX_NAME_LEN)
        if name.lower() in RESERVED_METRICS:
            bad(f'"{name}" is a reserved metric name')
        if name.lower() in seen:
            bad(f'Duplicate metric name "{name}"')
        seen.add(name.lower())
        kind = m.get("kind", "number")
        if kind not in METRIC_KINDS:
            bad(f'Metric "{name}" has an invalid kind')
        unit = _clean_str(m.get("unit"), "Unit", MAX_UNIT_LEN, required=False)
        metrics.append({"name": name, "kind": kind, "unit": unit})
    return metrics


def validate_goals(raw, metrics: list) -> list:
    if not isinstance(raw, list):
        bad("goals must be a list")
    names = {m["name"] for m in metrics} | {"count"}
    goals = []
    for g in raw:
        if not isinstance(g, dict):
            bad("each goal must be an object")
        period = g.get("period")
        if period not in PERIODS:
            bad("Goal period is invalid")
        gtype = g.get("type")
        if gtype not in GOAL_TYPES:
            bad("Goal type must be raw or ratio")
        m1 = g.get("metric1")
        if m1 not in names:
            bad(f'Goal references unknown metric "{m1}"')
        goal = {"period": period, "type": gtype, "metric1": m1}
        if gtype == "ratio":
            m2 = g.get("metric2")
            if m2 not in names:
                bad(f'Goal references unknown metric "{m2}"')
            goal["metric2"] = m2
        elif m1 != "count":
            agg = g.get("agg", "sum")
            if agg not in AGGS:
                bad("Goal aggregation is invalid")
            goal["agg"] = agg
        goal["target"] = _number(g.get("target"), "Goal target")
        color = g.get("color", "")
        if not isinstance(color, str) or not COLOR_RE.match(color):
            bad("Goal color must be #rrggbb")
        goal["color"] = color.lower()
        goals.append(goal)
    return goals


def validate_habit(body: dict, metrics: list, goals_raw) -> dict:
    htype = body.get("type")
    if htype not in HABIT_TYPES:
        bad("type must be POSITIVE or NEGATIVE")
    occurs = body.get("occurs")
    if occurs not in OCCURS:
        bad("occurs must be daily or periodic")
    return {
        "type": htype,
        "occurs": occurs,
        "metrics": metrics,
        "goals": validate_goals(goals_raw, metrics),
    }


# ─── Records ────────────────────────────────────────────────────────────────

def parse_timestamp(ts, now: datetime = None) -> str:
    """Validate an ISO timestamp with offset; return it normalised to seconds."""
    if not isinstance(ts, str):
        bad("timestamp is required")
    try:
        dt = datetime.fromisoformat(ts)
    except ValueError:
        bad("timestamp is not valid ISO 8601")
    if dt.tzinfo is None:
        bad("timestamp must include a UTC offset")
    now = now or datetime.now(timezone.utc)
    if dt > now + FUTURE_SKEW:
        bad("timestamp is in the future")
    return dt.isoformat(timespec="seconds")


def validate_record(body, metrics: list, now: datetime = None) -> dict:
    if not isinstance(body, dict):
        bad("record must be an object")
    ts = parse_timestamp(body.get("ts"), now)
    raw = body.get("values") or {}
    if not isinstance(raw, dict):
        bad("values must be an object")
    values = {}
    for m in metrics:
        if m["name"] not in raw:
            bad(f'Missing value for "{m["name"]}"')
        v = _number(raw[m["name"]], m["name"])
        if m["kind"] == "duration" and v < 0:
            bad(f'"{m["name"]}" cannot be negative')
        values[m["name"]] = v
    return {"ts": ts, "values": values}


def _fmt_num(v: float) -> str:
    return str(int(v)) if float(v).is_integer() else repr(float(v))


def records_to_csv(metrics: list, records: list) -> str:
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\n")
    names = [m["name"] for m in metrics]
    w.writerow(["timestamp", *names])
    for r in records:
        vals = r["values"]
        w.writerow([r["ts"], *(_fmt_num(vals[n]) if n in vals else "" for n in names)])
    return buf.getvalue()


def records_from_csv(text: str) -> list:
    rows = list(csv.reader(io.StringIO(text)))
    if not rows:
        return []
    header = rows[0][1:]
    records = []
    for row in rows[1:]:
        if not row or not row[0]:
            continue
        values = {}
        for name, cell in zip(header, row[1:]):
            if cell == "":
                continue
            try:
                values[name] = float(cell) if not re.fullmatch(r"-?\d+", cell) else int(cell)
            except ValueError:
                continue
        records.append({"ts": row[0], "values": values})
    return records


# ─── Store ──────────────────────────────────────────────────────────────────

class HabitStore:
    def __init__(self, base_dir: Path):
        self.config_file = Path(base_dir) / "habits.json"
        self.dir = Path(base_dir) / "habits"
        self.trash = self.dir / ".trash"
        self.dir.mkdir(exist_ok=True)

    # config ------------------------------------------------------------
    def load(self) -> dict:
        try:
            data = json.loads(self.config_file.read_text(encoding="utf-8"))
            return data if isinstance(data, dict) else {}
        except (OSError, ValueError):
            return {}

    def save(self, config: dict):
        atomic_write(self.config_file, json.dumps(config, indent=2, ensure_ascii=False))

    def _get(self, config: dict, name: str) -> dict:
        if name not in config:
            raise HabitError(404, f'No habit named "{name}"')
        return config[name]

    @staticmethod
    def _check_unique(config: dict, name: str, ignore: str = None):
        for existing in config:
            if existing != ignore and existing.lower() == name.lower():
                raise HabitError(409, f'A habit named "{existing}" already exists')

    def _new_slug(self, config: dict, name: str, ignore: str = None) -> str:
        taken = {c.get("slug") for n, c in config.items() if n != ignore}
        base = slugify(name)
        slug, i = base, 2
        while slug in taken or (self.dir / f"{slug}.csv").exists():
            slug = f"{base}-{i}"
            i += 1
        return slug

    def csv_path(self, habit: dict) -> Path:
        return self.dir / f"{habit['slug']}.csv"

    def _to_trash(self, path: Path, slug: str):
        if not path.exists():
            return
        self.trash.mkdir(exist_ok=True)
        stamp = datetime.now().strftime("%Y%m%dT%H%M%S")
        shutil.move(str(path), str(self.trash / f"{slug}-{stamp}.csv"))

    def _backup(self, path: Path, slug: str):
        if not path.exists():
            return
        self.trash.mkdir(exist_ok=True)
        stamp = datetime.now().strftime("%Y%m%dT%H%M%S")
        shutil.copy2(str(path), str(self.trash / f"{slug}-{stamp}.csv"))

    # records -----------------------------------------------------------
    def read_records(self, habit: dict) -> list:
        path = self.csv_path(habit)
        try:
            return records_from_csv(path.read_text(encoding="utf-8"))
        except OSError:
            return []

    def write_records(self, habit: dict, records: list):
        atomic_write(self.csv_path(habit), records_to_csv(habit["metrics"], records))

    def all_data(self) -> dict:
        config = self.load()
        public = {n: {k: v for k, v in c.items() if k != "slug"} for n, c in config.items()}
        return {
            "habits": public,
            "records": {n: self.read_records(c) for n, c in config.items()},
        }

    # habit CRUD --------------------------------------------------------
    def create(self, body: dict) -> dict:
        if not isinstance(body, dict):
            bad("Invalid habit")
        config = self.load()
        name = validate_name(body.get("name"))
        self._check_unique(config, name)
        metrics = validate_metrics(body.get("metrics", []))
        habit = validate_habit(body, metrics, body.get("goals", []))
        habit["slug"] = self._new_slug(config, name)
        self.write_records(habit, [])
        config[name] = habit
        self.save(config)
        return {"name": name}

    def update(self, name: str, body: dict) -> dict:
        """Replace a habit's config. Metrics may carry `was` (their previous
        name) to rename a column; goal refs are interpreted against the old
        metric names and follow renames. Dropped metrics back the CSV up to
        .trash first; a goal still using a dropped metric fails validation."""
        if not isinstance(body, dict):
            bad("Invalid habit")
        config = self.load()
        old = self._get(config, name)
        new_name = validate_name(body.get("newName", name))
        self._check_unique(config, new_name, ignore=name)

        raw_metrics = body.get("metrics", [])
        metrics = validate_metrics(raw_metrics)
        old_names = {m["name"] for m in old["metrics"]}
        renames = {}  # old name -> new name
        for raw, m in zip(raw_metrics, metrics):
            was = raw.get("was")
            if was is None and m["name"] in old_names:
                was = m["name"]
            if was is not None:
                if was not in old_names:
                    bad(f'Unknown metric "{was}"')
                if was in renames:
                    bad(f'Metric "{was}" appears twice')
                renames[was] = m["name"]
        dropped = old_names - set(renames)

        goals_raw = body.get("goals", old["goals"])
        if isinstance(goals_raw, list):
            goals_raw = [
                {**g, **{k: renames.get(g[k], g[k]) for k in ("metric1", "metric2")
                         if isinstance(g, dict) and g.get(k) in renames}}
                if isinstance(g, dict) else g
                for g in goals_raw
            ]
        habit = validate_habit(body, metrics, goals_raw)

        records = self.read_records(old)
        old_path = self.csv_path(old)
        if dropped:
            self._backup(old_path, old["slug"])
        for r in records:
            r["values"] = {renames[k]: v for k, v in r["values"].items() if k in renames}

        habit["slug"] = old["slug"] if new_name == name else self._new_slug(config, new_name, ignore=name)
        self.write_records(habit, records)
        if habit["slug"] != old["slug"] and old_path.exists():
            old_path.unlink()

        config = {(new_name if n == name else n): (habit if n == name else c) for n, c in config.items()}
        self.save(config)
        return {"name": new_name}

    def delete(self, name: str):
        config = self.load()
        habit = self._get(config, name)
        self._to_trash(self.csv_path(habit), habit["slug"])
        del config[name]
        self.save(config)

    def reorder(self, order) -> None:
        config = self.load()
        if not isinstance(order, list) or sorted(order) != sorted(config):
            bad("order must list every habit exactly once")
        self.save({n: config[n] for n in order})

    # record CRUD -------------------------------------------------------
    def _day_conflict(self, habit: dict, records: list, ts: str, skip: int = None):
        if habit["occurs"] != "daily":
            return None
        for i, r in enumerate(records):
            if i != skip and r["ts"][:10] == ts[:10]:
                return i
        return None

    def add_record(self, name: str, body: dict, now: datetime = None) -> dict:
        config = self.load()
        habit = self._get(config, name)
        record = validate_record(body, habit["metrics"], now)
        records = self.read_records(habit)
        conflict = self._day_conflict(habit, records, record["ts"])
        if conflict is not None:
            if not body.get("replace"):
                raise HabitError(409, f"A record already exists for {record['ts'][:10]}")
            records[conflict] = record
            self.write_records(habit, records)
            return {"index": conflict, "record": record}
        path = self.csv_path(habit)
        if not path.exists():
            self.write_records(habit, [record])
        else:
            with path.open("a", encoding="utf-8", newline="") as f:
                csv.writer(f, lineterminator="\n").writerow(
                    [record["ts"], *(_fmt_num(record["values"][m["name"]]) for m in habit["metrics"])]
                )
        return {"index": len(records), "record": record}

    def _check_index(self, records: list, idx: int, expected_ts) -> None:
        if idx < 0 or idx >= len(records):
            raise HabitError(404, "Record not found")
        if records[idx]["ts"] != expected_ts:
            raise HabitError(409, "Records changed since this page loaded; reload and try again")

    def update_record(self, name: str, idx: int, body: dict, now: datetime = None) -> dict:
        config = self.load()
        habit = self._get(config, name)
        if not isinstance(body, dict):
            bad("record must be an object")
        records = self.read_records(habit)
        self._check_index(records, idx, body.get("expectedTs"))
        record = validate_record(body, habit["metrics"], now)
        conflict = self._day_conflict(habit, records, record["ts"], skip=idx)
        if conflict is not None:
            if not body.get("replace"):
                raise HabitError(409, f"A record already exists for {record['ts'][:10]}")
            records[idx] = record
            del records[conflict]
        else:
            records[idx] = record
        self.write_records(habit, records)
        return {"record": record}

    def delete_record(self, name: str, idx: int, expected_ts) -> None:
        config = self.load()
        habit = self._get(config, name)
        records = self.read_records(habit)
        self._check_index(records, idx, expected_ts)
        del records[idx]
        self.write_records(habit, records)
