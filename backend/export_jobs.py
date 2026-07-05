"""Gestion des exports vidéo en arrière-plan."""

from __future__ import annotations

import threading
import time
import uuid
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from backend.ffmpeg_utils import (
    build_reframe_filter_keyframes,
    compute_output_size,
    export_copy,
    export_video,
    is_identity_export,
    probe_video,
    _normalize_export_range,
)

EXPORTS_DIR: Path | None = None
LOGS_DIR: Path | None = None
MAX_LOG_LINES = 500

_ROOT = Path(__file__).resolve().parent.parent
_DEFAULT_EXPORTS_DIR = _ROOT / "data" / "exports"
_DEFAULT_LOGS_DIR = _ROOT / "data" / "logs"
_DEFAULT_EXPORTS_DIR.mkdir(parents=True, exist_ok=True)
_DEFAULT_LOGS_DIR.mkdir(parents=True, exist_ok=True)


def _exports_dir() -> Path:
    return EXPORTS_DIR or _DEFAULT_EXPORTS_DIR


def _logs_dir() -> Path:
    return LOGS_DIR or _DEFAULT_LOGS_DIR


@dataclass
class ExportJob:
    status: str = "pending"  # pending | running | done | error
    detail: str = ""
    url: str = ""
    output_width: int = 0
    output_height: int = 0
    filter: str = ""
    ffmpeg_command: str = ""
    started_at: float = field(default_factory=time.time)
    finished_at: float | None = None
    progress_percent: float = 0.0
    out_time: str = ""
    fps: str = ""
    speed: str = ""
    frame: int = 0
    log: deque[str] = field(default_factory=lambda: deque(maxlen=MAX_LOG_LINES))


_jobs: dict[str, ExportJob] = {}
_lock = threading.Lock()


def _log_path(job_id: str) -> Path:
    return _logs_dir() / f"{job_id}.log"


def _append_log(job_id: str, line: str) -> None:
    with _lock:
        job = _jobs[job_id]
        job.log.append(line)

    path = _log_path(job_id)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(line + "\n")


def _set_job(job_id: str, **kwargs: Any) -> None:
    with _lock:
        job = _jobs[job_id]
        for key, value in kwargs.items():
            setattr(job, key, value)


def _progress_callback(job_id: str, update: dict[str, Any]) -> None:
    if "log" in update:
        _append_log(job_id, str(update["log"]))

    fields: dict[str, Any] = {}
    if "progress_percent" in update:
        fields["progress_percent"] = float(update["progress_percent"])
    if "out_time" in update:
        fields["out_time"] = str(update["out_time"])
    if "fps" in update:
        fields["fps"] = str(update["fps"])
    if "speed" in update:
        fields["speed"] = str(update["speed"])
    if "frame" in update:
        try:
            fields["frame"] = int(update["frame"])
        except (TypeError, ValueError):
            pass

    if fields:
        _set_job(job_id, **fields)


def _run_export(
    job_id: str,
    input_path: Path,
    output_path: Path,
    payload: dict[str, Any],
) -> None:
    _set_job(job_id, status="running", started_at=time.time())
    log_file = _log_path(job_id)
    log_file.write_text("", encoding="utf-8")

    try:
        meta = probe_video(input_path)
        out_w, out_h = compute_output_size(
            meta["width"],
            meta["height"],
            payload["aspect_w"],
            payload["aspect_h"],
            payload["resolution_mode"],
        )
        source_bitrate = int(meta.get("bit_rate") or 0)

        def on_progress(update: dict[str, Any]) -> None:
            _progress_callback(job_id, update)

        if is_identity_export(meta, payload):
            ex_start = float(payload.get("export_start", 0.0))
            export_end_raw = payload.get("export_end")
            export_end = float(export_end_raw) if export_end_raw is not None else None
            ex_start, ex_end, is_partial = _normalize_export_range(
                ex_start, export_end, meta["duration"]
            )
            _append_log(job_id, f"Source : {meta['width']}×{meta['height']}, {meta['duration']:.1f}s")
            if is_partial:
                _append_log(
                    job_id,
                    f"Plage export : {ex_start:.2f}s → {ex_end:.2f}s ({ex_end - ex_start:.1f}s)",
                )
            _append_log(job_id, "Aucun recadrage — copie directe sans ré-encodage.")
            export_copy(
                input_path,
                output_path,
                export_start=ex_start,
                export_end=ex_end if is_partial else None,
                on_progress=on_progress,
            )
            video_filter = "(copie directe)"
            export_duration = ex_end - ex_start if is_partial else meta["duration"]
        else:
            keyframes = payload.get("keyframes") or []
            if not keyframes and payload.get("frame"):
                keyframes = [{"time": 0.0, "frame": payload["frame"]}]

            interpolate = payload.get("interpolate_keyframes", True)
            transition_sec = float(payload.get("transition_sec", 1.0))
            export_start = float(payload.get("export_start", 0.0))
            export_end_raw = payload.get("export_end")
            export_end = float(export_end_raw) if export_end_raw is not None else None
            ex_start, ex_end, is_partial = _normalize_export_range(
                export_start, export_end, meta["duration"]
            )
            filter_spec = build_reframe_filter_keyframes(
                source_w=meta["width"],
                source_h=meta["height"],
                output_w=out_w,
                output_h=out_h,
                keyframes=keyframes,
                pad_color=payload.get("pad_color", "black"),
                duration_sec=meta["duration"],
                fps=float(meta.get("fps") or 30.0),
                interpolate_keyframes=interpolate,
                transition_sec=transition_sec,
                export_start=ex_start,
                export_end=ex_end if is_partial else None,
            )
            export_duration = ex_end - ex_start if is_partial else meta["duration"]
            _append_log(job_id, f"Source : {meta['width']}×{meta['height']}, {meta['duration']:.1f}s")
            if is_partial:
                _append_log(
                    job_id,
                    f"Plage export : {ex_start:.2f}s → {ex_end:.2f}s ({export_duration:.1f}s)",
                )
            n_seg = filter_spec.get("segment_count", "?")
            if interpolate:
                interp_label = f"fondu {transition_sec:g}s · {n_seg} segments"
            else:
                interp_label = "palier (sans interpolation)"
            _append_log(job_id, f"Sortie : {out_w}×{out_h} · {len(keyframes)} cadrage(s) · {interp_label}")
            if source_bitrate > 0:
                _append_log(job_id, f"Débit source : {source_bitrate // 1000} kb/s")
            filter_label = filter_spec.get("filter_complex") or filter_spec.get("vf", "")
            _append_log(job_id, f"Filtre : {filter_label[:200]}{'…' if len(filter_label) > 200 else ''}")

            export_video(
                input_path,
                output_path,
                filter_spec.get("vf", ""),
                filter_complex=filter_spec.get("filter_complex", ""),
                audio_filter=filter_spec.get("audio_filter", ""),
                input_seek=float(filter_spec.get("input_seek") or 0.0),
                duration_sec=export_duration,
                crf=payload.get("crf", 23),
                source_bitrate=source_bitrate,
                on_progress=on_progress,
            )
            video_filter = filter_label
        export_id = output_path.stem
        _set_job(
            job_id,
            status="done",
            url=f"/api/exports/{export_id}/file",
            output_width=out_w,
            output_height=out_h,
            filter=video_filter,
            progress_percent=100.0,
            finished_at=time.time(),
        )
        _append_log(job_id, "Export terminé.")
    except Exception as exc:  # noqa: BLE001 - remontée vers le client
        output_path.unlink(missing_ok=True)
        _append_log(job_id, f"ERREUR: {exc}")
        _set_job(
            job_id,
            status="error",
            detail=str(exc),
            finished_at=time.time(),
        )


def start_export(input_path: Path, payload: dict[str, Any]) -> str:
    exports_dir = _exports_dir()

    job_id = uuid.uuid4().hex
    export_id = uuid.uuid4().hex
    output_path = exports_dir / f"{export_id}.mp4"

    with _lock:
        _jobs[job_id] = ExportJob(status="pending")

    thread = threading.Thread(
        target=_run_export,
        args=(job_id, input_path, output_path, payload),
        daemon=True,
        name=f"export-{job_id[:8]}",
    )
    thread.start()
    return job_id


def get_job(job_id: str) -> ExportJob | None:
    with _lock:
        return _jobs.get(job_id)


def has_active_exports() -> bool:
    with _lock:
        return any(job.status in ("pending", "running") for job in _jobs.values())


def clear_jobs_registry() -> None:
    with _lock:
        _jobs.clear()


def read_job_log(job_id: str, job: ExportJob | None = None) -> list[str]:
    """Lit les logs depuis le fichier (source de vérité), sinon la mémoire."""
    log_path = _logs_dir() / f"{job_id}.log"
    if log_path.exists():
        text = log_path.read_text(encoding="utf-8").strip()
        if text:
            return text.splitlines()

    if job is None:
        job = get_job(job_id)
    if job is not None and job.log:
        return list(job.log)
    return []
