"""RepoLens web app: dashboard shell + ZIP ingestion (Phase 1), per-commit
file metrics and analysis pipeline (Phase 2).

Run with:  python3 -m uvicorn backend.main:app --port 8000
(or:       scripts/run.sh)
"""

from __future__ import annotations

import re
import shutil
import threading
import uuid
import zipfile
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, Response, UploadFile
from fastapi.staticfiles import StaticFiles

from . import analysis, git_service, store
from .ingest import IngestError, extract_zip, find_repo_root

MAX_UPLOAD_BYTES = 1024 * 1024 * 1024  # 1 GB
CHUNK_SIZE = 1 << 20  # 1 MiB

app = FastAPI(title="RepoLens", version="0.2.0")
store.init_dirs()

_RUNNING_LOCK = threading.Lock()
_RUNNING_ANALYSES: set[str] = set()


def _reset_stale_analysis() -> None:
    """A previous process may have died mid-analysis; never report 'running'."""
    for repo in store.list_repos():
        if (repo.get("analysis") or {}).get("state") == "running":
            repo["analysis"] = {"state": "none", "meta": None, "error": None}
            store.upsert_repo(repo)


_reset_stale_analysis()


def _slugify(value: str) -> str:
    slug = re.sub(r"[^a-zA-Z0-9._-]+", "-", value.strip()).strip("-").lower()
    return slug or "repository"


def _repo_or_404(repo_id: str) -> dict:
    repo = store.get_repo(repo_id)
    if repo is None:
        raise HTTPException(status_code=404, detail="repository not found")
    return repo


def _rescan(repo: dict) -> dict:
    """Re-read basic facts for an existing repository into its record."""
    root = Path(repo["path"])
    try:
        git_service.validate_repository(root)
        stats, analysis_ms = git_service.scan_basic_stats(root)
        repo.update(
            {"status": "ready", "error": None, "stats": stats, "analysis_ms": analysis_ms}
        )
    except git_service.GitError as exc:
        repo.update({"status": "error", "error": str(exc)})
    store.upsert_repo(repo)
    return repo


def _analysis_out_dir(repo: dict) -> Path:
    return Path(repo["root_dir"]) / "analysis"


# --------------------------------------------------------------------------
# API
# --------------------------------------------------------------------------


@app.get("/api/health")
def health() -> dict:
    return {"ok": True, "name": "RepoLens", "phase": 1}


@app.get("/api/repositories")
def list_repositories() -> dict:
    return {"repos": store.list_repos()}


@app.get("/api/repositories/{repo_id}")
def get_repository(repo_id: str) -> dict:
    return _repo_or_404(repo_id)


@app.post("/api/repositories", status_code=201)
async def upload_repository(file: UploadFile = File(...)) -> dict:
    """Ingest a ZIP archive containing a repository (.git file or directory)."""
    filename = (file.filename or "").strip()
    if not filename.lower().endswith(".zip"):
        raise HTTPException(status_code=400, detail="expected a .zip archive")

    tmp_zip = store.TMP_DIR / f"upload-{uuid.uuid4().hex}.zip"
    try:
        size = 0
        with tmp_zip.open("wb") as out:
            while True:
                chunk = await file.read(CHUNK_SIZE)
                if not chunk:
                    break
                size += len(chunk)
                if size > MAX_UPLOAD_BYTES:
                    raise HTTPException(
                        status_code=413, detail="archive exceeds the 1 GB upload limit"
                    )
                out.write(chunk)

        if size == 0:
            raise HTTPException(status_code=400, detail="uploaded file is empty")
        if not zipfile.is_zipfile(tmp_zip):
            raise HTTPException(
                status_code=400, detail="uploaded file is not a valid ZIP archive"
            )

        repo_id = f"{_slugify(Path(filename).stem)}-{uuid.uuid4().hex[:6]}"
        root_dir = store.REPOS_DIR / repo_id
        try:
            extract_zip(tmp_zip, root_dir)
            repo_root = find_repo_root(root_dir)
            if repo_root is None:
                raise IngestError(
                    "no .git file or directory found in the archive - "
                    "upload a ZIP of a repository"
                )
            git_service.validate_repository(repo_root)
        except (IngestError, zipfile.BadZipFile) as exc:
            shutil.rmtree(root_dir, ignore_errors=True)
            status = exc.status_code if isinstance(exc, IngestError) else 400
            detail = (
                str(exc)
                if isinstance(exc, IngestError)
                else "uploaded file is not a valid ZIP archive"
            )
            raise HTTPException(status_code=status, detail=detail) from exc
        except git_service.GitError as exc:
            shutil.rmtree(root_dir, ignore_errors=True)
            raise HTTPException(
                status_code=422, detail=f"archive does not contain a valid git repository: {exc}"
            ) from exc

        repo = {
            "id": repo_id,
            "name": repo_root.name,
            "source": f"zip: {filename}",
            "added_at": store.utcnow_iso(),
            "status": "scanning",
            "error": None,
            "root_dir": str(root_dir),
            "path": str(repo_root),
            "stats": None,
            "analysis_ms": None,
        }
        _rescan(repo)
        return repo
    finally:
        tmp_zip.unlink(missing_ok=True)


@app.post("/api/repositories/{repo_id}/refresh")
def refresh_repository(repo_id: str) -> dict:
    return _rescan(_repo_or_404(repo_id))


@app.delete("/api/repositories/{repo_id}")
def remove_repository(repo_id: str) -> dict:
    repo = store.remove_repo(repo_id)
    if repo is None:
        raise HTTPException(status_code=404, detail="repository not found")
    shutil.rmtree(repo.get("root_dir", ""), ignore_errors=True)
    return {"ok": True}


@app.get("/api/repositories/{repo_id}/commits")
def repository_commits(repo_id: str, offset: int = 0, limit: int = 50) -> dict:
    repo = _repo_or_404(repo_id)
    offset = max(0, offset)
    limit = max(1, min(limit, 200))
    items = git_service.list_commits(Path(repo["path"]), offset, limit)
    total = (repo.get("stats") or {}).get("commit_count", len(items))
    return {"total": total, "offset": offset, "limit": limit, "items": items}


@app.get("/api/repositories/{repo_id}/authors")
def repository_authors(repo_id: str) -> dict:
    repo = _repo_or_404(repo_id)
    return {"items": git_service.list_authors(Path(repo["path"]))}


@app.get("/api/repositories/{repo_id}/files")
def repository_files(repo_id: str) -> dict:
    repo = _repo_or_404(repo_id)
    items, total = git_service.list_files(Path(repo["path"]))
    return {"total": total, "truncated": total > len(items), "items": items}


@app.get("/api/repositories/{repo_id}/analysis")
def get_analysis(repo_id: str) -> dict:
    repo = _repo_or_404(repo_id)
    return repo.get("analysis") or {"state": "none", "meta": None, "error": None}


@app.post("/api/repositories/{repo_id}/analyze")
def analyze_repository(repo_id: str) -> dict:
    """Build the per-commit facts store (Phase 2) for a repository."""
    repo = _repo_or_404(repo_id)
    if repo.get("status") != "ready":
        raise HTTPException(status_code=409, detail="repository is not ready for analysis")
    with _RUNNING_LOCK:
        if repo_id in _RUNNING_ANALYSES:
            raise HTTPException(status_code=409, detail="analysis is already running for this repository")
        _RUNNING_ANALYSES.add(repo_id)
    try:
        repo["analysis"] = {"state": "running", "meta": None, "error": None}
        store.upsert_repo(repo)
        commit_count = int((repo.get("stats") or {}).get("commit_count") or 0)
        meta = analysis.build_facts(Path(repo["path"]), _analysis_out_dir(repo), commit_count)
        repo["analysis"] = {"state": "ready", "meta": meta, "error": None}
        store.upsert_repo(repo)
        return repo["analysis"]
    except analysis.AnalysisError as exc:
        repo["analysis"] = {"state": "error", "meta": None, "error": str(exc)}
        store.upsert_repo(repo)
        raise HTTPException(status_code=500, detail=f"analysis failed: {exc}") from exc
    finally:
        with _RUNNING_LOCK:
            _RUNNING_ANALYSES.discard(repo_id)


@app.get("/api/repositories/{repo_id}/analysis/commits")
def analysis_commits(repo_id: str, offset: int = 0, limit: int = 50) -> dict:
    """Paged per-commit file metrics (newest first, merge commits excluded)."""
    repo = _repo_or_404(repo_id)
    analysis_state = repo.get("analysis") or {}
    if analysis_state.get("state") != "ready":
        raise HTTPException(status_code=409, detail="analysis has not been built yet")
    offset = max(0, offset)
    limit = max(1, min(limit, 200))
    meta = analysis_state.get("meta") or {}
    items = analysis.read_facts_page(_analysis_out_dir(repo), offset, limit)
    return {
        "total": meta.get("commit_count", len(items)),
        "offset": offset,
        "limit": limit,
        "items": items,
    }


# --------------------------------------------------------------------------
# Static frontend (mounted last so /api/* wins)
# --------------------------------------------------------------------------


class NoCacheStaticFiles(StaticFiles):
    """Revalidate static assets on every request.

    Without this, browsers apply heuristic caching to the zero-build frontend
    and keep serving stale CSS/JS after edits; ``no-cache`` forces an
    ETag/Last-Modified revalidation (a cheap 304 when the file is unchanged).
    """

    async def get_response(self, path: str, scope) -> Response:
        response = await super().get_response(path, scope)
        response.headers["Cache-Control"] = "no-cache"
        return response


_FRONTEND_DIR = store.BASE_DIR / "frontend"
if _FRONTEND_DIR.exists():
    app.mount("/", NoCacheStaticFiles(directory=str(_FRONTEND_DIR), html=True), name="frontend")
