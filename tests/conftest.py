import os
import sys
import tempfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
PASSKEY = "test-passkey"

# main.py reads its paths and passkey at import time, so point it at a
# throwaway directory (with the real static/ symlinked in) before importing.
_tmp = Path(tempfile.mkdtemp(prefix="link-board-test-"))
(_tmp / "static").symlink_to(ROOT / "static")
os.environ["LINK_BOARD_DIR"] = str(_tmp)
os.environ["LINK_BOARD_PASSKEY"] = PASSKEY
os.environ["SECRET_KEY"] = "test-secret"
sys.path.insert(0, str(ROOT))

import main  # noqa: E402
from habit_store import HabitStore  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402


@pytest.fixture
def base_dir(tmp_path, monkeypatch):
    """Give each test a fresh habit store."""
    monkeypatch.setattr(main, "habits", HabitStore(tmp_path))
    return tmp_path


@pytest.fixture
def client(base_dir):
    c = TestClient(main.app)
    assert c.post("/api/auth", json={"passkey": PASSKEY}).status_code == 200
    return c


@pytest.fixture
def anon(base_dir):
    return TestClient(main.app)
