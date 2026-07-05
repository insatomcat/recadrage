"""API locale pour recadrer des vidéos avec ffmpeg."""

from __future__ import annotations

import shutil
import time
import uuid
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from backend.export_jobs import (
    clear_jobs_registry,
    get_job,
    has_active_exports,
    read_job_log,
    start_export,
    _logs_dir,
)
from backend.ffmpeg_utils import build_browser_preview, needs_browser_preview, probe_video

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
UPLOADS_DIR = DATA_DIR / "uploads"
EXPORTS_DIR = DATA_DIR / "exports"
LOGS_DIR = DATA_DIR / "logs"
TMP_DIR = DATA_DIR / "tmp"
FRONTEND_DIR = ROOT / "frontend"

for directory in (UPLOADS_DIR, EXPORTS_DIR, LOGS_DIR, TMP_DIR):
    directory.mkdir(parents=True, exist_ok=True)

_STORAGE_DIRS: dict[str, Path] = {
    "uploads": UPLOADS_DIR,
    "exports": EXPORTS_DIR,
    "logs": LOGS_DIR,
    "tmp": TMP_DIR,
}

import backend.export_jobs as export_jobs_module

export_jobs_module.EXPORTS_DIR = EXPORTS_DIR
export_jobs_module.LOGS_DIR = LOGS_DIR

app = FastAPI(title="Recadrage", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class FramePayload(BaseModel):
    x: float
    y: float
    width: float
    height: float


class KeyframePayload(BaseModel):
    time: float = Field(ge=0)
    frame: FramePayload


class ExportRequest(BaseModel):
    video_id: str
    aspect_w: float = Field(gt=0)
    aspect_h: float = Field(gt=0)
    frame: FramePayload | None = None
    keyframes: list[KeyframePayload] = Field(default_factory=list)
    resolution_mode: str = Field(default="source", pattern="^(source|fit_aspect)$")
    pad_color: str = "black"
    crf: int = Field(default=23, ge=0, le=51)
    interpolate_keyframes: bool = True
    transition_sec: float = Field(default=1.0, ge=0.0, le=30.0)
    export_start: float = Field(default=0.0, ge=0.0)
    export_end: float | None = Field(default=None, ge=0.0)


def _preview_path(video_id: str) -> Path:
    return UPLOADS_DIR / f"{video_id}.preview.mp4"


def _source_video_path(video_id: str) -> Path | None:
    matches = [
        p
        for p in UPLOADS_DIR.glob(f"{video_id}.*")
        if not p.name.endswith(".preview.mp4")
    ]
    return matches[0] if matches else None


def _playback_url(video_id: str) -> str:
    if _preview_path(video_id).exists():
        return f"/api/videos/{video_id}/preview"
    return f"/api/videos/{video_id}/file"


def _dir_stats(path: Path) -> dict[str, int]:
    files = 0
    nbytes = 0
    if not path.is_dir():
        return {"files": 0, "bytes": 0}
    for child in path.rglob("*"):
        if child.is_file():
            files += 1
            try:
                nbytes += child.stat().st_size
            except OSError:
                pass
    return {"files": files, "bytes": nbytes}


def _clear_directory(path: Path) -> dict[str, int]:
    files = 0
    nbytes = 0
    if not path.is_dir():
        return {"files": 0, "bytes": 0}
    for child in list(path.iterdir()):
        if child.is_file():
            try:
                nbytes += child.stat().st_size
            except OSError:
                pass
            child.unlink(missing_ok=True)
            files += 1
        elif child.is_dir():
            sub = _dir_stats(child)
            files += sub["files"]
            nbytes += sub["bytes"]
            shutil.rmtree(child, ignore_errors=True)
    return {"files": files, "bytes": nbytes}


@app.get("/api/health")
def health() -> JSONResponse:
    return JSONResponse(
        content={"status": "ok", "api_version": 5, "logs_dir": str(_logs_dir())},
        headers={"Cache-Control": "no-store"},
    )


@app.get("/api/data/stats")
def data_stats() -> dict:
    return {name: _dir_stats(path) for name, path in _STORAGE_DIRS.items()}


@app.post("/api/data/cleanup")
def data_cleanup() -> dict:
    if has_active_exports():
        raise HTTPException(
            status_code=409,
            detail="Un export est en cours. Attendez la fin avant de nettoyer.",
        )
    removed: dict[str, dict[str, int]] = {}
    total_files = 0
    total_bytes = 0
    for name, path in _STORAGE_DIRS.items():
        stats = _clear_directory(path)
        removed[name] = stats
        total_files += stats["files"]
        total_bytes += stats["bytes"]
    clear_jobs_registry()
    return {
        "removed": removed,
        "total_files": total_files,
        "total_bytes": total_bytes,
    }


@app.post("/api/upload")
async def upload_video(file: UploadFile = File(...)) -> dict:
    if not file.filename:
        raise HTTPException(status_code=400, detail="Fichier manquant.")

    suffix = Path(file.filename).suffix.lower()
    if suffix not in {".mp4", ".mov", ".m4v"}:
        raise HTTPException(
            status_code=400,
            detail="Format non supporté. Utilisez MP4 ou MOV.",
        )

    video_id = uuid.uuid4().hex
    dest = UPLOADS_DIR / f"{video_id}{suffix}"
    with dest.open("wb") as out:
        shutil.copyfileobj(file.file, out)

    try:
        meta = probe_video(dest)
    except RuntimeError as exc:
        dest.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    playback_url = f"/api/videos/{video_id}/file"
    preview = False
    if needs_browser_preview(dest, meta):
        preview_dest = _preview_path(video_id)
        try:
            build_browser_preview(dest, preview_dest)
            playback_url = f"/api/videos/{video_id}/preview"
            preview = True
        except RuntimeError as exc:
            preview_dest.unlink(missing_ok=True)
            raise HTTPException(
                status_code=400,
                detail=f"Impossible de préparer l'aperçu : {exc}",
            ) from exc

    return {
        "id": video_id,
        "filename": file.filename,
        "url": playback_url,
        "preview": preview,
        **meta,
    }


@app.get("/api/videos/{video_id}")
def get_video_meta(video_id: str) -> dict:
    source = _source_video_path(video_id)
    if source is None:
        raise HTTPException(status_code=404, detail="Vidéo introuvable.")
    meta = probe_video(source)
    preview_path = _preview_path(video_id)
    if needs_browser_preview(source, meta) and not preview_path.exists():
        try:
            build_browser_preview(source, preview_path)
        except RuntimeError:
            preview_path.unlink(missing_ok=True)
    return {
        "id": video_id,
        "filename": source.name,
        "url": _playback_url(video_id),
        "preview": preview_path.exists(),
        **meta,
    }


@app.get("/api/videos/{video_id}/file")
def stream_video(video_id: str) -> FileResponse:
    path = _source_video_path(video_id)
    if path is None:
        raise HTTPException(status_code=404, detail="Vidéo introuvable.")
    media_type = "video/quicktime" if path.suffix.lower() == ".mov" else "video/mp4"
    return FileResponse(path, media_type=media_type, filename=path.name)


@app.get("/api/videos/{video_id}/preview")
def stream_preview(video_id: str) -> FileResponse:
    path = _preview_path(video_id)
    if not path.exists():
        raise HTTPException(status_code=404, detail="Aperçu introuvable.")
    return FileResponse(
        path,
        media_type="video/mp4",
        filename=f"{video_id}.preview.mp4",
        headers={"Cache-Control": "no-store"},
    )


@app.post("/api/export")
def export_reframed(payload: ExportRequest) -> dict:
    input_path = _source_video_path(payload.video_id)
    if input_path is None:
        raise HTTPException(status_code=404, detail="Vidéo introuvable.")
    try:
        probe_video(input_path)
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    keyframes = [kf.model_dump() for kf in payload.keyframes]
    if not keyframes and payload.frame:
        keyframes = [{"time": 0.0, "frame": payload.frame.model_dump()}]
    if not keyframes:
        raise HTTPException(status_code=400, detail="Aucun cadrage défini.")

    job_id = start_export(
        input_path,
        {
            "aspect_w": payload.aspect_w,
            "aspect_h": payload.aspect_h,
            "keyframes": keyframes,
            "resolution_mode": payload.resolution_mode,
            "pad_color": payload.pad_color,
            "crf": payload.crf,
            "interpolate_keyframes": payload.interpolate_keyframes,
            "transition_sec": payload.transition_sec,
            "export_start": payload.export_start,
            "export_end": payload.export_end,
        },
    )
    return {"job_id": job_id}


@app.get("/api/export/jobs/{job_id}")
def export_job_status(job_id: str) -> JSONResponse:
    job = get_job(job_id)
    log_path = _logs_dir() / f"{job_id}.log"

    if job is None:
        if not log_path.exists():
            raise HTTPException(status_code=404, detail="Export introuvable.")
        return JSONResponse(
            content={
                "status": "done",
                "detail": "",
                "url": "",
                "output_width": 0,
                "output_height": 0,
                "filter": "",
                "elapsed_seconds": 0,
                "progress_percent": 100,
                "out_time": "",
                "fps": "",
                "speed": "",
                "frame": 0,
                "log": read_job_log(job_id, None),
            },
            headers={"Cache-Control": "no-store"},
        )

    elapsed = int(time.time() - job.started_at)
    return JSONResponse(
        content={
            "status": job.status,
            "detail": job.detail,
            "url": job.url,
            "output_width": job.output_width,
            "output_height": job.output_height,
            "filter": job.filter,
            "elapsed_seconds": elapsed,
            "progress_percent": job.progress_percent,
            "out_time": job.out_time,
            "fps": job.fps,
            "speed": job.speed,
            "frame": job.frame,
            "log": read_job_log(job_id, job),
        },
        headers={"Cache-Control": "no-store"},
    )


@app.get("/api/export/jobs/{job_id}/log")
def export_job_log(job_id: str) -> JSONResponse:
    job = get_job(job_id)
    log_path = _logs_dir() / f"{job_id}.log"
    if job is None and not log_path.exists():
        raise HTTPException(status_code=404, detail="Export introuvable.")
    return JSONResponse(
        content={"log": read_job_log(job_id, job)},
        headers={"Cache-Control": "no-store"},
    )


@app.get("/api/export/jobs/{job_id}/log.txt")
def export_job_log_text(job_id: str) -> PlainTextResponse:
    log_path = _logs_dir() / f"{job_id}.log"
    if not log_path.exists():
        raise HTTPException(status_code=404, detail="Log introuvable.")
    return PlainTextResponse(
        content=log_path.read_text(encoding="utf-8"),
        headers={"Cache-Control": "no-store"},
    )


@app.get("/api/exports/{export_id}/file")
def download_export(export_id: str) -> FileResponse:
    path = EXPORTS_DIR / f"{export_id}.mp4"
    if not path.exists():
        raise HTTPException(status_code=404, detail="Export introuvable.")
    return FileResponse(
        path,
        media_type="video/mp4",
        filename=f"recadrage-{export_id}.mp4",
    )


@app.get("/")
def serve_index() -> FileResponse:
    return FileResponse(
        FRONTEND_DIR / "index.html",
        media_type="text/html",
        headers={"Cache-Control": "no-store"},
    )


@app.get("/app.js")
def serve_app_js() -> FileResponse:
    return FileResponse(
        FRONTEND_DIR / "app.js",
        media_type="application/javascript",
        headers={"Cache-Control": "no-cache"},
    )


app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
