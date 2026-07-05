"""Utilitaires ffprobe / ffmpeg pour le recadrage vidéo."""

from __future__ import annotations

import json
import math
import re
import subprocess
import sys
import threading
from collections.abc import Callable
from pathlib import Path

_TIME_RE = re.compile(r"time=(\d+):(\d+):(\d+(?:\.\d+)?)")


def run_command(args: list[str]) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        args,
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        stderr = result.stderr.strip() or result.stdout.strip()
        raise RuntimeError(stderr or f"Commande échouée: {' '.join(args)}")
    return result


def _read_rotation(stream: dict) -> int:
    for side in stream.get("side_data_list") or []:
        if side and "rotation" in side:
            return int(side["rotation"])
    tags = stream.get("tags") or {}
    if "rotate" in tags:
        return int(tags["rotate"])
    return 0


def _display_size(width: int, height: int, rotation: int) -> tuple[int, int]:
    """Dimensions affichées après rotation (lecteur HTML5 / ffmpeg -vf)."""
    if abs(rotation) % 180 == 90:
        return height, width
    return width, height


def probe_video(path: Path) -> dict:
    """Retourne métadonnées vidéo via ffprobe."""
    result = run_command(
        [
            "ffprobe",
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=width,height,duration,r_frame_rate,codec_name,bit_rate:stream_side_data=rotation:stream_tags=rotate",
            "-show_entries",
            "format=duration,bit_rate",
            "-of",
            "json",
            str(path),
        ]
    )
    data = json.loads(result.stdout)
    stream = data["streams"][0]
    duration = stream.get("duration") or data.get("format", {}).get("duration")
    fps_raw = stream.get("r_frame_rate", "30/1")
    num, den = fps_raw.split("/")
    fps = float(num) / float(den) if float(den) else 30.0

    stored_w = int(stream["width"])
    stored_h = int(stream["height"])
    rotation = _read_rotation(stream)
    display_w, display_h = _display_size(stored_w, stored_h, rotation)

    fmt = data.get("format") or {}
    bit_rate = stream.get("bit_rate") or fmt.get("bit_rate")
    try:
        bit_rate = int(bit_rate) if bit_rate else 0
    except (TypeError, ValueError):
        bit_rate = 0

    return {
        "width": display_w,
        "height": display_h,
        "stored_width": stored_w,
        "stored_height": stored_h,
        "rotation": rotation,
        "duration": float(duration) if duration else 0.0,
        "fps": round(fps, 3),
        "codec": stream.get("codec_name", "unknown"),
        "bit_rate": bit_rate,
    }


_BROWSER_H264 = {"h264", "avc1", "avc3"}


def needs_browser_preview(source: Path, meta: dict) -> bool:
    """MOV / codecs exotiques : le lecteur HTML5 (Firefox…) gère mal le seek."""
    if source.suffix.lower() in {".mov", ".m4v"}:
        return True
    return meta.get("codec", "").lower() not in _BROWSER_H264


def build_browser_preview(source: Path, dest: Path) -> None:
    """
    MP4 optimisé pour la lecture navigateur (faststart, H.264 si besoin).
    L'original sert toujours à l'export.
    """
    meta = probe_video(source)
    codec = meta.get("codec", "").lower()
    base = [
        "ffmpeg",
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        str(source),
        "-map",
        "0:v:0",
        "-map",
        "0:a:0?",
        "-movflags",
        "+faststart",
    ]

    if codec in _BROWSER_H264:
        run_command([*base, "-c", "copy", str(dest)])
    else:
        run_command(
            [
                *base,
                "-c:v",
                "libx264",
                "-preset",
                "veryfast",
                "-crf",
                "23",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
                "-b:a",
                "128k",
                str(dest),
            ]
        )


def _even(value: int) -> int:
    """ffmpeg exige des dimensions paires pour de nombreux codecs."""
    value = max(2, int(round(value)))
    return value if value % 2 == 0 else value + 1


def _even_pos(value: float) -> int:
    """Coordonnée paire (arrondi vers le bas)."""
    v = max(0, int(math.floor(value)))
    return v - (v % 2)


def compute_output_size(
    source_w: int,
    source_h: int,
    aspect_w: float,
    aspect_h: float,
    mode: str,
) -> tuple[int, int]:
    """
    Calcule la résolution de sortie.

    mode:
      - "source": garde la résolution source (canvas fixe)
      - "fit_aspect": dimensionne pour coller au ratio (max côté = max source)
    """
    if mode == "source":
        return _even(source_w), _even(source_h)

    ratio = aspect_w / aspect_h
    if source_w / source_h >= ratio:
        out_h = source_h
        out_w = source_h * ratio
    else:
        out_w = source_w
        out_h = source_w / ratio
    return _even(out_w), _even(out_h)


def build_reframe_filter(
    source_w: int,
    source_h: int,
    output_w: int,
    output_h: int,
    frame_x: float,
    frame_y: float,
    frame_w: float,
    frame_h: float,
    pad_color: str = "black",
) -> str:
    """
    Construit le filtre vidéo ffmpeg pour un recadrage avec bandes optionnelles.

    Le cadre (frame_*) est exprimé en pixels source. Il peut dépasser la vidéo ;
    les zones hors image deviennent des bandes de la couleur pad_color.
    """
    fx = frame_x
    fy = frame_y
    fw = max(2.0, frame_w)
    fh = max(2.0, frame_h)

    pad_left = max(0, int(math.ceil(-fx)))
    pad_top = max(0, int(math.ceil(-fy)))
    pad_right = max(0, int(math.ceil(fx + fw - source_w)))
    pad_bottom = max(0, int(math.ceil(fy + fh - source_h)))

    padded_w = _even(source_w + pad_left + pad_right)
    padded_h = _even(source_h + pad_top + pad_bottom)
    crop_x = fx + pad_left
    crop_y = fy + pad_top

    crop_w = _even(fw)
    crop_h = _even(fh)
    crop_x = _even_pos(crop_x)
    crop_y = _even_pos(crop_y)

    out_w = _even(output_w)
    out_h = _even(output_h)

    filters = []
    if pad_left or pad_top or pad_right or pad_bottom:
        filters.append(
            f"pad={padded_w}:{padded_h}:{pad_left}:{pad_top}:{pad_color}"
        )

    filters.append(f"crop={crop_w}:{crop_h}:{crop_x}:{crop_y}")
    # Préserve le ratio du crop : scale sans déformation puis bandes si besoin
    filters.append(f"scale={out_w}:{out_h}:force_original_aspect_ratio=decrease")
    filters.append(f"pad={out_w}:{out_h}:(ow-iw)/2:(oh-ih)/2:{pad_color}")
    filters.append("format=yuv420p")

    return ",".join(filters)


def normalize_pad_color(color: str) -> str:
    """Convertit #RRGGBB en format ffmpeg 0xRRGGBB."""
    color = (color or "black").strip()
    if color.startswith("#"):
        hexpart = color[1:]
        if len(hexpart) == 3:
            hexpart = "".join(c * 2 for c in hexpart)
        return f"0x{hexpart.lower()}"
    return color


# Limite pratique split+trim+concat (swscaler). Budget réparti sur les fondus.
MAX_EXPORT_SEGMENTS = 200


def _interp_frame(f0: dict, f1: dict, ratio: float) -> dict:
    return {
        "x": float(f0["x"]) + (float(f1["x"]) - float(f0["x"])) * ratio,
        "y": float(f0["y"]) + (float(f1["y"]) - float(f0["y"])) * ratio,
        "width": float(f0["width"]) + (float(f1["width"]) - float(f0["width"])) * ratio,
        "height": float(f0["height"]) + (float(f1["height"]) - float(f0["height"])) * ratio,
    }


def _fade_substep_count(fade_sec: float, fps: float, *, cap: int) -> int:
    """Pas de fondu : ~1 pas / 2 frames, plafonné pour rester sous MAX_EXPORT_SEGMENTS."""
    ideal = max(10, min(40, int(round(fade_sec * fps / 2))))
    return max(6, min(ideal, cap))


def _keyframe_interp_ratio(
    time: float,
    t0: float,
    t1: float,
    transition_sec: float,
    *,
    interpolate: bool,
) -> float:
    if not interpolate:
        return 0.0
    span = t1 - t0
    if span <= 0:
        return 1.0
    fade = min(max(0.0, float(transition_sec)), span)
    fade_start = t1 - fade
    if time <= fade_start:
        return 0.0
    return (time - fade_start) / fade if fade > 0 else 1.0


def _frame_at_time(
    sorted_kf: list[dict],
    time: float,
    *,
    interpolate: bool,
    transition_sec: float,
) -> dict:
    if not sorted_kf:
        return {"x": 0.0, "y": 0.0, "width": 2.0, "height": 2.0}
    if time <= float(sorted_kf[0]["time"]):
        return dict(sorted_kf[0]["frame"])
    if time >= float(sorted_kf[-1]["time"]):
        return dict(sorted_kf[-1]["frame"])
    for i in range(len(sorted_kf) - 1):
        a = sorted_kf[i]
        b = sorted_kf[i + 1]
        t0 = float(a["time"])
        t1 = float(b["time"])
        if t0 <= time <= t1:
            ratio = _keyframe_interp_ratio(
                time, t0, t1, transition_sec, interpolate=interpolate
            )
            fa, fb = a["frame"], b["frame"]
            return {
                "x": float(fa["x"]) + (float(fb["x"]) - float(fa["x"])) * ratio,
                "y": float(fa["y"]) + (float(fb["y"]) - float(fa["y"])) * ratio,
                "width": float(fa["width"])
                + (float(fb["width"]) - float(fa["width"])) * ratio,
                "height": float(fa["height"])
                + (float(fb["height"]) - float(fa["height"])) * ratio,
            }
    return dict(sorted_kf[-1]["frame"])


def _normalize_export_range(
    export_start: float,
    export_end: float | None,
    duration_sec: float,
) -> tuple[float, float, bool]:
    """Retourne (start, end, is_partial)."""
    duration = max(0.0, float(duration_sec))
    start = max(0.0, float(export_start or 0.0))
    end = duration if export_end is None else min(duration, float(export_end))
    end = max(start + 0.03, end)
    is_partial = start > 0.01 or end < duration - 0.05
    return start, end, is_partial


def _effective_export_keyframes(
    sorted_kf: list[dict],
    export_start: float,
    export_end: float,
    *,
    interpolate: bool,
    transition_sec: float,
) -> list[dict]:
    effective: list[dict] = []
    has_at_start = False
    for kf in sorted_kf:
        t = float(kf["time"])
        if t < export_start - 0.001:
            continue
        if t > export_end + 0.001:
            break
        if abs(t - export_start) < 0.02:
            has_at_start = True
        effective.append(kf)
    if not has_at_start:
        effective.insert(
            0,
            {
                "time": export_start,
                "frame": _frame_at_time(
                    sorted_kf,
                    export_start,
                    interpolate=interpolate,
                    transition_sec=transition_sec,
                ),
            },
        )
    if not effective:
        raise ValueError("Aucun cadrage dans la plage export.")
    return effective


def _clamp_segments_to_range(
    segments: list[tuple[float, float, dict]],
    export_start: float,
    export_end: float,
) -> list[tuple[float, float, dict]]:
    out: list[tuple[float, float, dict]] = []
    for t0, t1, frame in segments:
        ct0 = max(t0, export_start)
        ct1 = min(t1, export_end)
        if ct1 - ct0 >= 0.03:
            out.append((ct0, ct1, frame))
    return out


def _keyframe_interval_segments(
    sorted_kf: list[dict],
    duration: float,
    *,
    interpolate: bool,
    transition_sec: float = 1.0,
    fps: float = 30.0,
) -> list[tuple[float, float, dict]]:
    """
    Segments entre keyframes.
    ffmpeg n'anime que x/y par frame — w/h sont figés à l'init du crop.
    Le fondu est découpé en sous-segments à crop fixe (zoom + pan synchrones).
    """
    segments: list[tuple[float, float, dict]] = []
    fade_intervals = 0
    if interpolate:
        for i, kf in enumerate(sorted_kf):
            if i + 1 >= len(sorted_kf):
                break
            t0 = float(kf["time"])
            t1 = float(sorted_kf[i + 1]["time"])
            if t1 - t0 >= 0.03:
                fade_intervals += 1

    fade_cap = (
        max(6, (MAX_EXPORT_SEGMENTS - len(sorted_kf)) // max(1, fade_intervals))
        if fade_intervals
        else 30
    )

    for i, kf in enumerate(sorted_kf):
        t0 = float(kf["time"])
        t1 = float(sorted_kf[i + 1]["time"]) if i + 1 < len(sorted_kf) else duration
        span = t1 - t0
        if span < 0.03:
            continue
        f0 = kf["frame"]
        if i + 1 >= len(sorted_kf):
            segments.append((t0, t1, f0))
            continue
        f1 = sorted_kf[i + 1]["frame"]
        if not interpolate:
            segments.append((t0, t1, f0))
            continue

        fade = min(max(0.0, float(transition_sec)), span)
        if fade < 0.03:
            segments.append((t0, t1, f0))
            continue

        steps = _fade_substep_count(fade, fps, cap=fade_cap)

        if fade >= span - 1e-6:
            for s in range(steps):
                ft0 = t0 + span * s / steps
                ft1 = t0 + span * (s + 1) / steps
                if ft1 - ft0 < 0.001:
                    continue
                ratio = (s + 0.5) / steps
                segments.append((ft0, ft1, _interp_frame(f0, f1, ratio)))
            continue

        hold_end = t1 - fade
        if hold_end - t0 >= 0.03:
            segments.append((t0, hold_end, f0))
        for s in range(steps):
            ft0 = hold_end + fade * s / steps
            ft1 = hold_end + fade * (s + 1) / steps
            if ft1 - ft0 < 0.001:
                continue
            ratio = (s + 0.5) / steps
            segments.append((ft0, ft1, _interp_frame(f0, f1, ratio)))

    return segments


def _segment_reframe_chain(
    in_label: str,
    out_label: str,
    t0: float,
    t1: float,
    frame: dict,
    *,
    output_w: int,
    output_h: int,
    pad_left: int,
    pad_top: int,
    pad_right: int,
    pad_bottom: int,
    padded_w: int,
    padded_h: int,
    pad_color: str,
) -> str:
    out_w = _even(output_w)
    out_h = _even(output_h)

    chain = f"{in_label}trim=start={t0:.3f}:end={t1:.3f},setpts=PTS-STARTPTS"
    if pad_left or pad_top or pad_right or pad_bottom:
        chain += f",pad={padded_w}:{padded_h}:{pad_left}:{pad_top}:{pad_color}"

    fw = _even(max(2.0, float(frame["width"])))
    fh = _even(max(2.0, float(frame["height"])))
    cx = _even_pos(float(frame["x"]) + pad_left)
    cy = _even_pos(float(frame["y"]) + pad_top)
    chain += f",crop={fw}:{fh}:{cx}:{cy}"
    chain += f",scale={out_w}:{out_h}:force_original_aspect_ratio=decrease"
    chain += f",pad={out_w}:{out_h}:(ow-iw)/2:(oh-ih)/2:{pad_color},setsar=1,format=yuv420p"
    return chain + out_label


def build_reframe_filter_keyframes(
    source_w: int,
    source_h: int,
    output_w: int,
    output_h: int,
    keyframes: list[dict],
    pad_color: str = "black",
    *,
    duration_sec: float = 0.0,
    fps: float = 30.0,
    interpolate_keyframes: bool = True,
    transition_sec: float = 1.0,
    export_start: float = 0.0,
    export_end: float | None = None,
) -> dict[str, str]:
    """
    Filtre recadrage : palier + fondu transition_sec avant chaque keyframe suivant.
    export_start / export_end limitent la plage exportée (temps source).
    """
    if not keyframes:
        raise ValueError("Au moins un keyframe requis.")

    sorted_kf = sorted(keyframes, key=lambda k: float(k["time"]))
    duration = duration_sec or float(sorted_kf[-1]["time"]) + 1.0
    ex_start, ex_end, is_partial = _normalize_export_range(
        export_start, export_end, duration
    )

    if is_partial:
        work_kf = _effective_export_keyframes(
            sorted_kf,
            ex_start,
            ex_end,
            interpolate=interpolate_keyframes,
            transition_sec=transition_sec,
        )
        seg_duration = ex_end
    else:
        work_kf = sorted_kf
        seg_duration = duration

    if len(work_kf) == 1 and not is_partial:
        f = work_kf[0]["frame"]
        spec: dict[str, str] = {
            "vf": build_reframe_filter(
                source_w,
                source_h,
                output_w,
                output_h,
                float(f["x"]),
                float(f["y"]),
                float(f["width"]),
                float(f["height"]),
                normalize_pad_color(pad_color),
            )
        }
        return spec

    pad_color_norm = normalize_pad_color(pad_color)
    slice_len = ex_end - ex_start
    pad_left, pad_top, pad_right, pad_bottom = _compute_max_padding(
        source_w, source_h, work_kf if is_partial else sorted_kf
    )
    padded_w = _even(source_w + pad_left + pad_right)
    padded_h = _even(source_h + pad_top + pad_bottom)

    if len(work_kf) == 1:
        segments = [(0.0, slice_len, work_kf[0]["frame"])]
    else:
        segments = _keyframe_interval_segments(
            work_kf,
            seg_duration,
            interpolate=interpolate_keyframes,
            transition_sec=transition_sec,
            fps=fps,
        )
        if is_partial:
            segments = _clamp_segments_to_range(segments, ex_start, ex_end)
            segments = [
                (t0 - ex_start, t1 - ex_start, frame)
                for t0, t1, frame in segments
            ]

    if not segments:
        f = work_kf[0]["frame"]
        return {
            "vf": build_reframe_filter(
                source_w, source_h, output_w, output_h,
                float(f["x"]), float(f["y"]), float(f["width"]), float(f["height"]),
                pad_color_norm,
            )
        }

    n_seg = len(segments)
    split_outs = " ".join(f"[sk{i}]" for i in range(n_seg))
    parts = [f"[0:v]split={n_seg} {split_outs}"]
    vlabels: list[str] = []

    for i, (t0, t1, frame) in enumerate(segments):
        in_label = f"[sk{i}]"
        out_label = f"[v{i}]"
        parts.append(
            _segment_reframe_chain(
                in_label,
                out_label,
                t0,
                t1,
                frame,
                output_w=output_w,
                output_h=output_h,
                pad_left=pad_left,
                pad_top=pad_top,
                pad_right=pad_right,
                pad_bottom=pad_bottom,
                padded_w=padded_w,
                padded_h=padded_h,
                pad_color=pad_color_norm,
            )
        )
        vlabels.append(out_label)

    parts.append(f"{''.join(vlabels)}concat=n={n_seg}:v=1:a=0:unsafe=1[outv]")
    result: dict[str, str | int] = {
        "filter_complex": ";".join(parts),
        "segment_count": n_seg,
    }
    if is_partial:
        result["audio_filter"] = (
            f"atrim=start=0:end={slice_len:.3f},asetpts=PTS-STARTPTS"
        )
        result["input_seek"] = ex_start
    return result


def _compute_max_padding(
    source_w: int,
    source_h: int,
    keyframes: list[dict],
) -> tuple[int, int, int, int]:
    pad_left = pad_top = pad_right = pad_bottom = 0
    for kf in keyframes:
        f = kf["frame"]
        fx, fy = float(f["x"]), float(f["y"])
        fw = max(2.0, float(f["width"]))
        fh = max(2.0, float(f["height"]))
        pad_left = max(pad_left, int(math.ceil(-fx)))
        pad_top = max(pad_top, int(math.ceil(-fy)))
        pad_right = max(pad_right, int(math.ceil(fx + fw - source_w)))
        pad_bottom = max(pad_bottom, int(math.ceil(fy + fh - source_h)))
    return pad_left, pad_top, pad_right, pad_bottom


def _parse_time_seconds(text: str) -> float | None:
    match = _TIME_RE.search(text)
    if not match:
        return None
    hours, minutes, seconds = match.groups()
    return int(hours) * 3600 + int(minutes) * 60 + float(seconds)


def _parse_stats_line(line: str) -> dict[str, str | float | int]:
    """Extrait frame / fps / speed / time d'une ligne stats ffmpeg."""
    update: dict[str, str | float | int] = {"log": line}

    if "frame=" in line:
        parts = line.split()
        for part in parts:
            if part.startswith("frame="):
                try:
                    update["frame"] = int(part.split("=", 1)[1])
                except ValueError:
                    pass
            elif part.startswith("fps="):
                update["fps"] = part.split("=", 1)[1]
            elif part.startswith("speed="):
                update["speed"] = part.split("=", 1)[1]

    time_match = _TIME_RE.search(line)
    if time_match:
        update["out_time"] = time_match.group(0).split("=", 1)[1]

    return update


def _video_encoder_args(
    crf: int,
    preset: str,
    *,
    source_bitrate: int = 0,
) -> list[str]:
    """Encodeur vidéo : VideoToolbox sur macOS, libx264 ailleurs."""
    if sys.platform == "darwin":
        if source_bitrate > 0:
            target = max(200_000, int(source_bitrate * 1.05))
            maxrate = max(target, int(source_bitrate * 1.5))
            return [
                "-c:v",
                "h264_videotoolbox",
                "-b:v",
                str(target),
                "-maxrate",
                str(maxrate),
                "-bufsize",
                str(maxrate * 2),
                "-profile:v",
                "high",
                "-pix_fmt",
                "yuv420p",
                "-allow_sw",
                "1",
            ]
        # CRF bas = meilleure qualité → q:v plus élevé (échelle 1–100, modérée)
        q = max(40, min(75, 110 - crf * 2))
        return [
            "-c:v",
            "h264_videotoolbox",
            "-q:v",
            str(q),
            "-profile:v",
            "high",
            "-pix_fmt",
            "yuv420p",
            "-allow_sw",
            "1",
        ]

    args = [
        "-c:v",
        "libx264",
        "-preset",
        preset,
        "-crf",
        str(crf),
        "-pix_fmt",
        "yuv420p",
    ]
    if source_bitrate > 0:
        maxrate = max(300_000, int(source_bitrate * 1.5))
        args.extend(["-maxrate", str(maxrate), "-bufsize", str(maxrate * 2)])
    return args


def is_identity_export(meta: dict, payload: dict) -> bool:
    """Export sans recadrage ni changement de ratio → copie directe des flux."""
    if payload.get("resolution_mode") != "source":
        return False
    keyframes = payload.get("keyframes") or []
    if len(keyframes) > 1:
        return False
    sw, sh = meta["width"], meta["height"]
    aspect_src = sw / sh
    aspect_target = payload["aspect_w"] / payload["aspect_h"]
    if abs(aspect_src - aspect_target) > 0.02:
        return False
    if keyframes:
        frame = keyframes[0]["frame"]
    else:
        frame = payload.get("frame") or {}
    if abs(frame.get("x", 0)) > 2 or abs(frame.get("y", 0)) > 2:
        return False
    if abs(frame.get("width", 0) - sw) > 4 or abs(frame.get("height", 0) - sh) > 4:
        return False
    return True


def export_copy(
    input_path: Path,
    output_path: Path,
    *,
    export_start: float = 0.0,
    export_end: float | None = None,
    on_progress: Callable[[dict[str, str | float | int]], None] | None = None,
) -> None:
    """Recopie les flux sans ré-encodage (même taille / qualité)."""
    args = [
        "ffmpeg",
        "-y",
        "-hide_banner",
        "-loglevel",
        "info",
    ]
    if export_start > 0.01:
        args.extend(["-ss", f"{export_start:.3f}"])
    args.extend(["-ignore_editlist", "1", "-i", str(input_path)])
    if export_end is not None and export_end > export_start + 0.03:
        args.extend(["-to", f"{export_end:.3f}"])
    args.extend([
        "-c",
        "copy",
        "-movflags",
        "+faststart",
        str(output_path),
    ])
    if on_progress:
        on_progress({"log": f"$ {' '.join(args)}"})
        on_progress({"log": "Copie directe (sans ré-encodage)."})

    result = subprocess.run(args, capture_output=True, text=True, check=False)
    if result.returncode != 0:
        detail = _format_ffmpeg_error(
            (result.stderr or result.stdout or "").splitlines(),
            result.returncode,
        )
        raise RuntimeError(detail)


def export_video(
    input_path: Path,
    output_path: Path,
    video_filter: str = "",
    *,
    filter_complex: str = "",
    audio_filter: str = "",
    input_seek: float = 0.0,
    duration_sec: float = 0.0,
    crf: int = 23,
    preset: str = "medium",
    source_bitrate: int = 0,
    on_progress: Callable[[dict[str, str | float | int]], None] | None = None,
) -> None:
    """Exporte la vidéo recadrée en H.264, audio copié."""
    libx264_args = [
        "-c:v",
        "libx264",
        "-preset",
        preset,
        "-crf",
        str(crf),
        "-pix_fmt",
        "yuv420p",
    ]
    if source_bitrate > 0:
        maxrate = max(300_000, int(source_bitrate * 1.5))
        libx264_args.extend(["-maxrate", str(maxrate), "-bufsize", str(maxrate * 2)])

    encoders: list[list[str]] = []
    if sys.platform == "darwin":
        encoders.append(
            _video_encoder_args(crf, preset, source_bitrate=source_bitrate)
        )
    encoders.append(libx264_args)

    last_error = ""
    for index, encoder_args in enumerate(encoders):
        if index > 0 and on_progress:
            on_progress({"log": "Repli sur libx264…"})
        try:
            _run_ffmpeg_export(
                input_path,
                output_path,
                encoder_args,
                duration_sec,
                on_progress,
                video_filter=video_filter,
                filter_complex=filter_complex,
                audio_filter=audio_filter,
                input_seek=input_seek,
            )
            return
        except RuntimeError as exc:
            last_error = str(exc)
            output_path.unlink(missing_ok=True)

    raise RuntimeError(last_error or "Export ffmpeg échoué.")


def _run_ffmpeg_export(
    input_path: Path,
    output_path: Path,
    encoder_args: list[str],
    duration_sec: float,
    on_progress: Callable[[dict[str, str | float | int]], None] | None,
    *,
    video_filter: str = "",
    filter_complex: str = "",
    audio_filter: str = "",
    input_seek: float = 0.0,
) -> None:
    args = [
        "ffmpeg",
        "-y",
        "-hide_banner",
        "-loglevel",
        "info",
        "-stats_period",
        "1",
    ]
    if input_seek > 0.01:
        args.extend(["-ss", f"{input_seek:.3f}"])
    args.extend(["-ignore_editlist", "1", "-i", str(input_path)])
    fc = filter_complex
    if fc and audio_filter:
        fc = f"{fc};[0:a]{audio_filter}[aout]"
    if fc:
        args.extend(["-filter_complex", fc, "-map", "[outv]"])
        if audio_filter:
            args.extend(["-map", "[aout]"])
        else:
            args.extend(["-map", "0:a?"])
    elif video_filter:
        if audio_filter:
            fc = f"[0:a]{audio_filter}[aout]"
            args.extend(["-filter_complex", fc, "-vf", video_filter, "-map", "0:v", "-map", "[aout]"])
        else:
            args.extend(["-vf", video_filter, "-map", "0:v", "-map", "0:a?"])
    else:
        raise RuntimeError("Aucun filtre vidéo défini.")

    if audio_filter:
        audio_args = ["-c:a", "aac", "-b:a", "192k"]
    else:
        audio_args = ["-c:a", "copy"]

    args.extend([
        *encoder_args,
        *audio_args,
        "-movflags",
        "+faststart",
        str(output_path),
    ])

    if on_progress:
        on_progress({"log": f"$ {' '.join(args)}"})

    proc = subprocess.Popen(
        args,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
    )

    stderr_lines: list[str] = []

    def read_stderr() -> None:
        assert proc.stderr is not None
        for line in proc.stderr:
            text = line.rstrip()
            if not text:
                continue
            stderr_lines.append(text)
            if not on_progress:
                continue

            update = _parse_stats_line(text)
            if duration_sec > 0 and "out_time" in update:
                seconds = _parse_time_seconds(text)
                if seconds is not None:
                    update["progress_percent"] = min(
                        99.0, (seconds / duration_sec) * 100
                    )
            on_progress(update)

    stderr_thread = threading.Thread(target=read_stderr, daemon=True)
    stderr_thread.start()

    proc.wait()
    stderr_thread.join(timeout=2)

    if proc.returncode != 0:
        detail = _format_ffmpeg_error(stderr_lines, proc.returncode)
        raise RuntimeError(detail)


def _format_ffmpeg_error(lines: list[str], returncode: int) -> str:
    """Extrait les lignes utiles d'une sortie ffmpeg (sans le dump de métadonnées)."""
    keywords = (
        "error",
        "failed",
        "invalid",
        "cannot",
        "conversion failed",
        "nothing was written",
        "no such file",
    )
    picked = [
        line.strip()
        for line in lines
        if any(word in line.lower() for word in keywords)
    ]
    if picked:
        return "\n".join(picked[-8:])
    tail = [line.strip() for line in lines[-5:] if line.strip()]
    if tail:
        return "\n".join(tail)
    return f"ffmpeg a échoué (code {returncode})"
