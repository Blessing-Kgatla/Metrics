"""ZIP ingestion helpers with path-traversal safety.

Uploads are extracted into a private per-repository directory; the shallowest
directory containing a ``.git`` file or directory becomes the repository root
(handles both "zip the repo folder" and "zip the repo contents" archives).
"""

from __future__ import annotations

import os
import zipfile
from pathlib import Path

_SKIP_PREFIXES = ("__MACOSX/",)


class IngestError(Exception):
    """Ingestion failure with an HTTP status code for the API layer."""

    def __init__(self, message: str, status_code: int = 422):
        super().__init__(message)
        self.status_code = status_code


def _safe_members(zf: zipfile.ZipFile) -> list[zipfile.ZipInfo]:
    members: list[zipfile.ZipInfo] = []
    for info in zf.infolist():
        name = info.filename.replace("\\", "/")
        if not name or name.endswith("/"):
            continue
        if any(name.startswith(prefix) for prefix in _SKIP_PREFIXES):
            continue
        if name.startswith("/") or ".." in Path(name).parts:
            raise IngestError(f"unsafe path in archive: {name}", 400)
        members.append(info)
    return members


def extract_zip(zip_path: Path, dest: Path) -> None:
    """Extract ``zip_path`` into ``dest``, refusing traversal entries."""
    dest.mkdir(parents=True, exist_ok=True)
    dest_resolved = dest.resolve()
    with zipfile.ZipFile(zip_path) as zf:  # BadZipFile propagates to the caller
        for info in _safe_members(zf):
            name = info.filename.replace("\\", "/")
            target = (dest / name).resolve()
            if not str(target).startswith(str(dest_resolved) + os.sep):
                raise IngestError(f"unsafe path in archive: {name}", 400)
            target.parent.mkdir(parents=True, exist_ok=True)
            with zf.open(info) as src, target.open("wb") as out:
                while True:
                    chunk = src.read(1 << 20)
                    if not chunk:
                        break
                    out.write(chunk)


def find_repo_root(base: Path, max_depth: int = 2) -> Path | None:
    """Find the shallowest directory containing a ``.git`` file or directory."""
    base = base.resolve()
    candidates: list[tuple[int, str, Path]] = []
    for root, dirs, _files in os.walk(base):
        try:
            depth = len(Path(root).relative_to(base).parts)
        except ValueError:
            continue
        if depth > max_depth:
            dirs[:] = []
            continue
        if ".git" in dirs or ".git" in _files:
            candidates.append((depth, str(root), Path(root)))
            dirs[:] = []  # found the repo; do not descend further
    if not candidates:
        return None
    candidates.sort(key=lambda item: (item[0], item[1]))
    return candidates[0][2]
