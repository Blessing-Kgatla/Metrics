"""Thin wrapper around the git CLI used by RepoLens.

Phase 1 only needs basic facts (branch, HEAD, commit/author/file counts and
the latest commit). Metric computation arrives in later phases.
"""

from __future__ import annotations

import subprocess
import time
from pathlib import Path

SEP = "\x1f"  # unit separator: safe against any character in names/subjects

_C_SIMPLE_ESCAPES = {"n": 10, "t": 9, "r": 13, '"': 34, "\\": 92, "a": 7, "b": 8, "f": 12, "v": 11}


def decode_path(raw: str) -> str:
    """Decode a git C-style quoted path (leading '"') into plain text.

    Git quotes paths containing non-ASCII, control, quote or backslash
    characters (e.g. ``"docs/\303\274ber.md"``); this restores the original
    UTF-8 path. Raw paths pass through unchanged.
    """
    if not raw.startswith('"'):
        return raw
    body = raw[1:]
    if body.endswith('"'):
        body = body[:-1]
    out = bytearray()
    i = 0
    while i < len(body):
        ch = body[i]
        if ch == "\\" and i + 1 < len(body):
            nxt = body[i + 1]
            if nxt in _C_SIMPLE_ESCAPES:
                out.append(_C_SIMPLE_ESCAPES[nxt])
                i += 2
                continue
            if nxt.isdigit():
                out.append(int(body[i + 1 : i + 4], 8) & 0xFF)
                i += 4
                continue
        out.extend(ch.encode("utf-8"))
        i += 1
    return out.decode("utf-8", "replace")


class GitError(Exception):
    """Raised when a git command fails."""


def _run(repo: Path, args: list[str], timeout: int = 300) -> str:
    try:
        proc = subprocess.run(
            ["git", "-C", str(repo), *args],
            capture_output=True,
            text=True,
            errors="replace",
            timeout=timeout,
        )
    except FileNotFoundError as exc:
        raise GitError("git executable not found on PATH") from exc
    except subprocess.TimeoutExpired as exc:
        raise GitError(f"git {' '.join(args)} timed out after {timeout}s") from exc
    if proc.returncode != 0:
        raise GitError(proc.stderr.strip() or f"git {' '.join(args)} failed")
    return proc.stdout


def validate_repository(repo: Path) -> None:
    """Raise :class:`GitError` unless ``repo`` is a usable git working tree."""
    output = _run(repo, ["rev-parse", "--is-inside-work-tree"]).strip()
    if output != "true":
        raise GitError("path is not a git working tree")


def scan_basic_stats(repo: Path) -> tuple[dict, int]:
    """Collect Phase 1 basic facts. Returns ``(stats, elapsed_ms)``.

    Handles freshly initialized repositories with no commits by zeroing the
    history-derived counters.
    """
    started = time.perf_counter()

    branch = "unknown"
    head = ""
    commit_count = 0
    merge_count = 0
    last_commit = None

    try:
        branch = _run(repo, ["rev-parse", "--abbrev-ref", "HEAD"]).strip()
        head = _run(repo, ["rev-parse", "--short", "HEAD"]).strip()
        commit_count = int(_run(repo, ["rev-list", "--count", "HEAD"]).strip() or 0)
        merge_count = int(
            _run(repo, ["rev-list", "--count", "--merges", "HEAD"]).strip() or 0
        )
    except (GitError, ValueError):
        try:
            branch = _run(repo, ["symbolic-ref", "--short", "HEAD"]).strip()
        except GitError:
            pass

    author_count = 0
    try:
        shortlog = _run(repo, ["shortlog", "-sne", "HEAD"])
        author_count = sum(1 for line in shortlog.splitlines() if line.strip())
    except GitError:
        author_count = 0

    file_count = 0
    try:
        files = _run(repo, ["ls-files"])
        file_count = sum(1 for line in files.splitlines() if line)
    except GitError:
        file_count = 0

    if commit_count:
        try:
            raw = _run(
                repo,
                ["log", "-1", f"--format=%H{SEP}%h{SEP}%an{SEP}%ae{SEP}%aI{SEP}%s"],
            ).strip()
            parts = raw.split(SEP)
            if len(parts) == 6:
                last_commit = {
                    "hash": parts[0],
                    "short": parts[1],
                    "author_name": parts[2],
                    "author_email": parts[3],
                    "date": parts[4],
                    "subject": parts[5],
                }
        except GitError:
            last_commit = None

    stats = {
        "branch": branch,
        "head": head,
        "commit_count": commit_count,
        "merge_count": merge_count,
        "author_count": author_count,
        "file_count": file_count,
        "last_commit": last_commit,
    }
    elapsed_ms = int((time.perf_counter() - started) * 1000)
    return stats, elapsed_ms


def list_commits(repo: Path, offset: int, limit: int) -> list[dict]:
    """Return a page of commits (newest first). Empty repositories give []."""
    fmt = SEP.join(["%H", "%h", "%an", "%ae", "%aI", "%P", "%s"])
    try:
        output = _run(
            repo,
            ["log", f"--max-count={limit}", f"--skip={offset}", f"--format={fmt}", "HEAD"],
        )
    except GitError:
        return []
    items: list[dict] = []
    for line in output.splitlines():
        parts = line.split(SEP)
        if len(parts) != 7:
            continue
        parents = parts[5].split()
        items.append(
            {
                "hash": parts[0],
                "short": parts[1],
                "author_name": parts[2],
                "author_email": parts[3],
                "date": parts[4],
                "subject": parts[6],
                "is_merge": len(parents) > 1,
            }
        )
    return items


def list_authors(repo: Path) -> list[dict]:
    """Aggregate commit counts per author (as seen by git shortlog)."""
    try:
        output = _run(repo, ["shortlog", "-sne", "HEAD"])
    except GitError:
        return []
    authors: list[dict] = []
    for line in output.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        count_part, _, identity = stripped.partition("\t")
        name, _, email = identity.rpartition("<")
        authors.append(
            {
                "name": name.strip() or identity.strip(),
                "email": email.rstrip(">").strip(),
                "commits": int(count_part.strip() or 0),
            }
        )
    authors.sort(key=lambda author: author["commits"], reverse=True)
    return authors


def list_files(repo: Path, cap: int = 5000) -> tuple[list[str], int]:
    """Return tracked files (capped) and the true total count."""
    try:
        output = _run(repo, ["-c", "core.quotepath=false", "ls-files"])
    except GitError:
        return [], 0
    files = [decode_path(line) for line in output.splitlines() if line]
    return files[:cap], len(files)
