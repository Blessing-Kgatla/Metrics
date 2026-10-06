"""Per-commit facts, rollups and derived metrics (Phases 2-5).

Walks non-merge history once with ``git log --no-merges --numstat`` and writes
one JSON line per commit to ``analysis/facts.jsonl``:

    {"h": <hash>, "an": <author name>, "ae": <author email>,
     "cd": <committer date>, "ad": <author date>, "s": <subject>,
     "f": [[<path>, <lines added>, <lines removed>], ...]}

The same pass accumulates per-file and per-directory rollups over the commit
set H-bar into ``analysis/aggregates.json``: raw sums (added, removed,
modifications n) per path, files ordered by churn and directories
path-ascending (pre-order tree). Directory sums are bottom-up over immediate
children (direct files plus subdirectories), so a changed or deleted file
contributes to every ancestor directory; a directory counts a modification
once per commit in which any descendant changed. The root row "/" carries the
repository metrics.

Rollups are additionally keyed by raw author identity (the author name/email
stored verbatim on each fact): per-author commits and root modifications n,
added/removed sums, plus per-file and per-directory rows. Author metrics
follow the brief's section 3.7 (authorship indicator, author modifications,
author churn, ownership omega = author churn / total churn); raw identities
stay immutable so a later author merge can re-resolve every author metric
additively at query time.

Derived metrics (growth delta, churn lambda, frequency
eta, rate rho) are computed when read and divided by |H|, so a later
commit-set filter can re-derive them for an arbitrary subset of H-bar.

Rules applied here, per the assignment's commit model:
- merge commits are excluded (the facts store covers H-bar);
- binary files (numstat "-" counts) are skipped;
- rename detection is off in this phase, so a pure rename appears as a
  deletion plus an addition until the dedicated rename phase adds -M50%.
"""

from __future__ import annotations

import json
import subprocess
import time
from pathlib import Path

from . import git_service, store

FACTS_NAME = "facts.jsonl"
META_NAME = "meta.json"
AGG_NAME = "aggregates.json"
_MAX_BUILD_SECONDS = 900

_HEADER_MARK = "\x01"
_FIELD_SEP = "\x1f"
_HEADER_FORMAT = (
    f"%x01%H{_FIELD_SEP}%an{_FIELD_SEP}%ae{_FIELD_SEP}%cI{_FIELD_SEP}%aI{_FIELD_SEP}%s"
)


def _ancestor_dirs(path: str) -> list[str]:
    """Return every ancestor directory of a repo-relative path (root "/" last)."""
    dirs: list[str] = []
    idx = path.rfind("/")
    while idx != -1:
        dirs.append(path[:idx])
        idx = path.rfind("/", 0, idx)
    dirs.append("/")
    return dirs


class AnalysisError(Exception):
    """Raised when the per-commit facts build fails."""


def build_facts(repo_root: Path, out_dir: Path, commit_count: int) -> dict:
    """Build ``facts.jsonl`` + ``meta.json`` for a repository; return the meta."""
    started = time.perf_counter()
    out_dir.mkdir(parents=True, exist_ok=True)
    facts_path = out_dir / FACTS_NAME
    tmp_path = out_dir / (FACTS_NAME + ".tmp")
    stderr_path = out_dir / "git-stderr.tmp"

    records = 0
    files_touched: set[str] = set()
    per_file: dict[str, dict] = {}
    dir_sums: dict[str, dict] = {}
    dir_commits: dict[str, int] = {}
    authors: dict[tuple[str, str], dict] = {}
    author_files: dict[tuple[str, str], dict[str, dict]] = {}
    author_dirs: dict[tuple[str, str], dict[str, dict]] = {}
    binary_skipped = 0
    total_added = 0
    total_removed = 0
    current: dict | None = None

    def flush(out) -> None:
        nonlocal records
        out.write(json.dumps(current, ensure_ascii=False, separators=(",", ":")) + "\n")
        records += 1
        ident = (current["an"], current["ae"])
        author = authors.get(ident)
        if author is None:
            author = authors[ident] = {
                "name": ident[0],
                "email": ident[1],
                "commits": 0,
                "n": 0,
                "added": 0,
                "removed": 0,
            }
        author["commits"] += 1
        a_files = author_files.setdefault(ident, {})
        a_dirs = author_dirs.setdefault(ident, {})
        touched: set[str] = set()
        for fpath, f_added, f_removed in current["f"]:
            changed = f_added + f_removed > 0
            author["added"] += f_added
            author["removed"] += f_removed
            for directory in _ancestor_dirs(fpath):
                sums = dir_sums.get(directory)
                if sums is None:
                    sums = dir_sums[directory] = {"added": 0, "removed": 0}
                sums["added"] += f_added
                sums["removed"] += f_removed
                a_row = a_dirs.get(directory)
                if a_row is None:
                    a_row = a_dirs[directory] = {"added": 0, "removed": 0, "n": 0}
                a_row["added"] += f_added
                a_row["removed"] += f_removed
                if changed:
                    touched.add(directory)
            f_row = a_files.get(fpath)
            if f_row is None:
                f_row = a_files[fpath] = {"added": 0, "removed": 0, "n": 0}
            f_row["added"] += f_added
            f_row["removed"] += f_removed
            if changed:
                f_row["n"] += 1
        if touched:
            author["n"] += 1
        for directory in touched:
            dir_commits[directory] = dir_commits.get(directory, 0) + 1
            a_dirs[directory]["n"] += 1

    if commit_count > 0:
        cmd = [
            "git", "-C", str(repo_root),
            "log", "--no-merges", "--numstat",
            f"--format={_HEADER_FORMAT}", "HEAD",
        ]
        deadline = started + _MAX_BUILD_SECONDS
        try:
            with stderr_path.open("wb") as err_fh, tmp_path.open("w", encoding="utf-8") as out:
                try:
                    proc = subprocess.Popen(
                        cmd,
                        stdout=subprocess.PIPE,
                        stderr=err_fh,
                        text=True,
                        encoding="utf-8",
                        errors="replace",
                        bufsize=1,
                    )
                except FileNotFoundError as exc:
                    raise AnalysisError("git executable not found on PATH") from exc
                try:
                    for raw_line in proc.stdout:  # type: ignore[union-attr]
                        if time.perf_counter() > deadline:
                            proc.kill()
                            raise AnalysisError(
                                f"analysis exceeded {_MAX_BUILD_SECONDS}s and was aborted"
                            )
                        line = raw_line.rstrip("\n").rstrip("\r")
                        if not line:
                            continue
                        if line.startswith(_HEADER_MARK):
                            if current is not None:
                                flush(out)
                            parts = line[1:].split(_FIELD_SEP, 5)
                            if len(parts) != 6:
                                current = None
                                continue
                            current = {
                                "h": parts[0],
                                "an": parts[1],
                                "ae": parts[2],
                                "cd": parts[3],
                                "ad": parts[4],
                                "s": parts[5],
                                "f": [],
                            }
                        else:
                            if current is None:
                                continue
                            cols = line.split("\t", 2)
                            if len(cols) != 3:
                                continue
                            added_s, removed_s, path = cols
                            if added_s == "-" or removed_s == "-":
                                binary_skipped += 1
                                continue
                            if not added_s.isdigit() or not removed_s.isdigit():
                                continue
                            added, removed = int(added_s), int(removed_s)
                            path = git_service.decode_path(path)
                            current["f"].append([path, added, removed])
                            files_touched.add(path)
                            total_added += added
                            total_removed += removed
                            rollup = per_file.get(path)
                            if rollup is None:
                                rollup = per_file[path] = {"added": 0, "removed": 0, "n": 0}
                            rollup["added"] += added
                            rollup["removed"] += removed
                            if added + removed > 0:
                                rollup["n"] += 1
                    if current is not None:
                        flush(out)
                    proc.wait()
                finally:
                    if proc.poll() is None:
                        proc.kill()
                        proc.wait()
                returncode = proc.returncode
                err_text = stderr_path.read_text(encoding="utf-8", errors="replace").strip()
                if returncode != 0:
                    raise AnalysisError(err_text or f"git log exited with code {returncode}")
        except AnalysisError:
            tmp_path.unlink(missing_ok=True)
            raise
        finally:
            stderr_path.unlink(missing_ok=True)
    else:
        tmp_path.write_text("", encoding="utf-8")

    tmp_path.replace(facts_path)

    meta = {
        "version": 1,
        "built_at": store.utcnow_iso(),
        "duration_ms": int((time.perf_counter() - started) * 1000),
        "commit_count": records,
        "files_touched": len(files_touched),
        "binary_skipped": binary_skipped,
        "total_added": total_added,
        "total_removed": total_removed,
        "rename_detection": False,
    }
    (out_dir / META_NAME).write_text(json.dumps(meta, indent=2), encoding="utf-8")

    ident_order = sorted(
        authors.items(),
        key=lambda item: (-(item[1]["added"] + item[1]["removed"]), item[0][0], item[0][1]),
    )
    aggregates = {
        "version": 3,
        "commit_count": records,
        "files": sorted(
            (
                {
                    "path": path,
                    "added": rollup["added"],
                    "removed": rollup["removed"],
                    "n": rollup["n"],
                }
                for path, rollup in per_file.items()
            ),
            key=lambda row: (-(row["added"] + row["removed"]), row["path"]),
        ),
        "dirs": sorted(
            (
                {
                    "path": directory,
                    "added": sums["added"],
                    "removed": sums["removed"],
                    "n": dir_commits.get(directory, 0),
                }
                for directory, sums in dir_sums.items()
            ),
            key=lambda row: row["path"],
        ),
        "authors": [entry for _ident, entry in ident_order],
        "author_files": [
            {
                "a": index,
                "path": path,
                "added": row["added"],
                "removed": row["removed"],
                "n": row["n"],
            }
            for index, (ident, _entry) in enumerate(ident_order)
            for path, row in sorted(author_files.get(ident, {}).items())
        ],
        "author_dirs": [
            {
                "a": index,
                "path": directory,
                "added": row["added"],
                "removed": row["removed"],
                "n": row["n"],
            }
            for index, (ident, _entry) in enumerate(ident_order)
            for directory, row in sorted(author_dirs.get(ident, {}).items())
        ],
    }
    (out_dir / AGG_NAME).write_text(
        json.dumps(aggregates, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
    )
    return meta


def _to_api_item(rec: dict) -> dict:
    files = [
        {"path": p, "added": a, "removed": r, "churn": a + r, "growth": a - r}
        for p, a, r in rec.get("f", [])
    ]
    return {
        "hash": rec.get("h", ""),
        "short": (rec.get("h") or "")[:7],
        "author_name": rec.get("an", ""),
        "author_email": rec.get("ae", ""),
        "date": rec.get("ad") or rec.get("cd"),
        "committer_date": rec.get("cd"),
        "subject": rec.get("s", ""),
        "added": sum(f["added"] for f in files),
        "removed": sum(f["removed"] for f in files),
        "file_count": len(files),
        "files": files,
    }


def read_facts_page(out_dir: Path, offset: int, limit: int) -> list[dict]:
    """Return a page of per-commit facts (newest first) in API shape."""
    facts_path = out_dir / FACTS_NAME
    if not facts_path.exists():
        return []
    items: list[dict] = []
    with facts_path.open("r", encoding="utf-8") as fh:
        for idx, line in enumerate(fh):
            if idx < offset:
                continue
            if idx >= offset + limit:
                break
            line = line.strip()
            if not line:
                continue
            try:
                items.append(_to_api_item(json.loads(line)))
            except json.JSONDecodeError:
                continue
    return items


def _metric_item(row: dict, commit_count: int) -> dict:
    """Convert a stored raw aggregate row into API shape with derived metrics.

    Derived metrics follow the assignment's formulas: delta = added - removed,
    lambda = added + removed, eta = n / |H| and rho = churn / |H|, computed
    against the stored commit-set size (H = H-bar until the filtering phase).
    """
    added = int(row.get("added", 0))
    removed = int(row.get("removed", 0))
    n = int(row.get("n", 0))
    churn = added + removed
    return {
        "path": row.get("path", ""),
        "added": added,
        "removed": removed,
        "growth": added - removed,
        "churn": churn,
        "n": n,
        "eta": (n / commit_count) if commit_count else 0.0,
        "rho": (churn / commit_count) if commit_count else 0.0,
    }


def _read_aggregate_page(out_dir: Path, key: str, offset: int, limit: int) -> dict:
    """Return a page of stored aggregate rows (``"files"`` or ``"dirs"``)."""
    agg_path = out_dir / AGG_NAME
    if not agg_path.exists():
        return {"total": 0, "commit_count": 0, "items": []}
    try:
        data = json.loads(agg_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"total": 0, "commit_count": 0, "items": []}
    rows = data.get(key) or []
    commit_count = int(data.get("commit_count") or 0)
    return {
        "total": len(rows),
        "commit_count": commit_count,
        "items": [_metric_item(row, commit_count) for row in rows[offset : offset + limit]],
    }


def read_file_metrics(out_dir: Path, offset: int, limit: int) -> dict:
    """Return a page of per-file aggregate metrics over the commit set H-bar.

    Rows are stored churn-descending at build time (read_file_metrics mirrors
    _metric_item's formulas; see its docstring for the derived metrics).
    """
    return _read_aggregate_page(out_dir, "files", offset, limit)


def read_dir_metrics(out_dir: Path, offset: int, limit: int) -> dict:
    """Return a page of per-directory rollups over the commit set H-bar.

    Each directory sums its immediate children (direct files plus
    subdirectories, bottom-up), so a changed or deleted file contributes to
    every ancestor directory. Rows are stored path-ascending (pre-order tree)
    and the root row ("/") carries the repository metrics.
    """
    return _read_aggregate_page(out_dir, "dirs", offset, limit)


def read_author_metrics(out_dir: Path) -> dict:
    """Return per-author aggregates over the commit set H-bar.

    Follows the assignment's section 3.7: commits counts how many h in H-bar
    have h[a] = a (including empty commits), n is the author-modifications
    count for the repository root (commits by a with any churn), and omega is
    the author's share of total churn. Rows stay keyed by the raw name/email
    identity so a later author merge can re-resolve every author metric
    additively at query time.
    """
    agg_path = out_dir / AGG_NAME
    if not agg_path.exists():
        return {"total": 0, "commit_count": 0, "items": []}
    try:
        data = json.loads(agg_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"total": 0, "commit_count": 0, "items": []}
    rows = data.get("authors") or []
    commit_count = int(data.get("commit_count") or 0)
    file_counts: dict[int, int] = {}
    for row in data.get("author_files") or []:
        index = int(row.get("a", -1))
        file_counts[index] = file_counts.get(index, 0) + 1
    total_churn = sum(int(row.get("added", 0)) + int(row.get("removed", 0)) for row in rows)
    items: list[dict] = []
    for index, row in enumerate(rows):
        added = int(row.get("added", 0))
        removed = int(row.get("removed", 0))
        churn = added + removed
        items.append(
            {
                "name": row.get("name", ""),
                "email": row.get("email", ""),
                "commits": int(row.get("commits", 0)),
                "n": int(row.get("n", 0)),
                "added": added,
                "removed": removed,
                "growth": added - removed,
                "churn": churn,
                "files": file_counts.get(index, 0),
                "omega": (churn / total_churn) if total_churn else 0.0,
            }
        )
    return {"total": len(items), "commit_count": commit_count, "items": items}
