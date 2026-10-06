"""JSON-backed repository registry for RepoLens.

Uploaded repositories are extracted under ``data/repos/<id>/`` and tracked in
``data/registry.json``. All file operations are guarded by a process-wide lock
(the app is a single-user local tool).
"""

from __future__ import annotations

import json
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

BASE_DIR = Path(__file__).resolve().parents[1]
DATA_DIR = BASE_DIR / "data"
REPOS_DIR = DATA_DIR / "repos"
TMP_DIR = DATA_DIR / "tmp"
REGISTRY_FILE = DATA_DIR / "registry.json"

_LOCK = threading.Lock()


def init_dirs() -> None:
    for directory in (DATA_DIR, REPOS_DIR, TMP_DIR):
        directory.mkdir(parents=True, exist_ok=True)
    # Clear any stale upload staging files from a previous crash.
    for leftover in TMP_DIR.glob("upload-*.zip"):
        leftover.unlink(missing_ok=True)


def _load() -> dict[str, Any]:
    if not REGISTRY_FILE.exists():
        return {"repos": {}}
    try:
        with REGISTRY_FILE.open("r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, json.JSONDecodeError):
        return {"repos": {}}
    if not isinstance(data, dict) or not isinstance(data.get("repos"), dict):
        return {"repos": {}}
    return data


def _save(data: dict[str, Any]) -> None:
    REGISTRY_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = REGISTRY_FILE.with_name(REGISTRY_FILE.name + ".tmp")
    with tmp_path.open("w", encoding="utf-8") as handle:
        json.dump(data, handle, indent=2, ensure_ascii=False)
    tmp_path.replace(REGISTRY_FILE)


def list_repos() -> list[dict[str, Any]]:
    with _LOCK:
        repos = list(_load()["repos"].values())
    return sorted(repos, key=lambda repo: repo.get("added_at", ""), reverse=True)


def get_repo(repo_id: str) -> dict[str, Any] | None:
    with _LOCK:
        return _load()["repos"].get(repo_id)


def upsert_repo(repo: dict[str, Any]) -> None:
    with _LOCK:
        data = _load()
        data["repos"][repo["id"]] = repo
        _save(data)


def remove_repo(repo_id: str) -> dict[str, Any] | None:
    with _LOCK:
        data = _load()
        repo = data["repos"].pop(repo_id, None)
        if repo is not None:
            _save(data)
    return repo


def utcnow_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")
