"""Remote URL cloning helpers (Phase 6).

Wraps ``git clone --progress`` for a public remote: git's stderr progress
output is parsed into a coarse 0-100 estimate that the API layer persists on
the repository record, and failures surface as :class:`CloneError` with a
cleaned git message. The clone target is a fresh per-repository directory, so
the resulting checkout is indistinguishable from a ZIP-ingested repository
downstream.
"""

from __future__ import annotations

import os
import re
import subprocess
from pathlib import Path
from urllib.parse import unquote, urlsplit

ALLOWED_SCHEMES = ("http", "https", "git", "file")

# git reports several progress phases; map each to a slice of the overall bar
# so a long "Receiving objects" phase dominates the displayed progress.
_PHASES = (
    ("enumerating", "Enumerating objects", 0, 2),
    ("counting", "Counting objects", 2, 5),
    ("compressing", "Compressing objects", 5, 10),
    ("receiving", "Receiving objects", 10, 85),
    ("resolving", "Resolving deltas", 85, 92),
    ("checking", "Checking out files", 92, 99),
    ("updating", "Updating files", 92, 99),
)

_PROGRESS_RE = re.compile(r"^(?:remote:\s*)?([A-Za-z][A-Za-z _-]*?):\s*(\d{1,3})%")


class CloneError(Exception):
    """Clone failure with an HTTP status code for the API layer."""

    def __init__(self, message: str, status_code: int = 422):
        super().__init__(message)
        self.status_code = status_code


def validate_url(raw: str) -> str:
    """Return the normalized URL or raise :class:`CloneError`.

    Only public-remote schemes are accepted; ``file://`` stays available for
    local repositories (useful for testing and offline use).
    """
    url = (raw or "").strip()
    if not url:
        raise CloneError("enter a repository URL", 400)
    if len(url) > 2048:
        raise CloneError("URL is too long", 400)
    if any(ch.isspace() for ch in url):
        raise CloneError("URL must not contain spaces", 400)
    parts = urlsplit(url)
    scheme = parts.scheme.lower()
    if scheme not in ALLOWED_SCHEMES:
        raise CloneError("URL must start with https://, http://, git:// or file://", 400)
    if scheme == "file":
        if parts.netloc not in ("", "localhost"):
            raise CloneError("file:// URL must not carry a host", 400)
        if not parts.path.startswith("/"):
            raise CloneError("file:// URL must point to an absolute path", 400)
    elif not parts.netloc:
        raise CloneError("URL is missing a host name", 400)
    return url


def repo_name_from_url(url: str) -> str:
    """Derive a display name from a clone URL (".../owner/repo.git" -> "repo")."""
    parts = urlsplit(url)
    path = parts.path if parts.scheme else url
    segment = unquote(path.rstrip("/").rpartition("/")[2])
    if segment.lower().endswith(".git"):
        segment = segment[:-4]
    return segment or "repository"


def _split_progress(buffer: bytes) -> tuple[list[str], bytes]:
    """Split a raw stderr buffer on both newlines and carriage returns."""
    lines: list[str] = []
    start = 0
    for idx, byte in enumerate(buffer):
        if byte in (0x0A, 0x0D):
            if idx > start:
                lines.append(buffer[start:idx].decode("utf-8", "replace"))
            start = idx + 1
    return lines, buffer[start:]


def _scale(phase: str, percent: int) -> int:
    """Map a git phase percent onto the overall 0-100 clone progress."""
    key = phase.strip().lower()
    for prefix, _label, low, high in _PHASES:
        if key.startswith(prefix):
            percent = max(0, min(percent, 100))
            return min(100, low + (high - low) * percent // 100)
    return max(0, min(percent, 100))


def _label(phase: str) -> str:
    key = phase.strip().lower()
    for prefix, label, _low, _high in _PHASES:
        if key.startswith(prefix):
            return label
    return phase.strip().capitalize()


def _clean(text: str) -> str:
    return " ".join(text.split())[:300]


def _error_message(tail: list[str]) -> str:
    """Pick the most informative failure line from git's stderr tail."""
    for line in reversed(tail):
        lowered = line.lower()
        if lowered.startswith(("fatal:", "error:")):
            return _clean(line)
    if tail:
        return _clean(tail[-1])
    return "clone failed for an unknown reason"


def clone(url: str, dest: Path, on_progress=None, on_start=None) -> None:
    """Clone ``url`` into ``dest``, streaming progress to ``on_progress``.

    ``on_progress(percent, label)`` receives a coarse 0-100 estimate and the
    current phase ("Receiving objects", ...); ``on_start(proc)`` exposes the
    running process so the caller can terminate it (e.g. on delete). Raises
    :class:`CloneError` with a cleaned git message on failure.
    """
    env = dict(os.environ)
    env.setdefault("GIT_TERMINAL_PROMPT", "0")  # fail fast instead of prompting
    env.setdefault("GIT_ASKPASS", "echo")
    try:
        proc = subprocess.Popen(
            ["git", "clone", "--progress", "--", url, str(dest)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            env=env,
        )
    except FileNotFoundError as exc:
        raise CloneError("git executable not found on PATH", 500) from exc
    if on_start is not None:
        on_start(proc)

    tail: list[str] = []
    buffer = b""
    try:
        assert proc.stderr is not None
        while True:
            chunk = proc.stderr.read(4096)
            if not chunk:
                break
            buffer += chunk
            lines, buffer = _split_progress(buffer)
            for line in lines:
                _handle_line(line, tail, on_progress)
        if buffer:
            _handle_line(buffer.decode("utf-8", "replace"), tail, on_progress)
        code = proc.wait()
    finally:
        if proc.stderr is not None:
            proc.stderr.close()
    if code != 0:
        raise CloneError(_error_message(tail))
    if on_progress is not None:
        on_progress(100, "Complete")


def _handle_line(line: str, tail: list[str], on_progress) -> None:
    text = line.strip()
    if not text:
        return
    match = _PROGRESS_RE.match(text)
    if match:
        phase, percent = match.group(1), int(match.group(2))
        if on_progress is not None and percent <= 100:
            on_progress(_scale(phase, percent), _label(phase))
        return
    if text.lower().startswith("remote: "):
        text = text[len("remote: "):].strip()
        if not text:
            return
    tail.append(text)
    del tail[:-8]
