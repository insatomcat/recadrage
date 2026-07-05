/** @typedef {{ id: string, width: number, height: number, duration: number, fps: number, url: string, filename: string }} VideoMeta */

/** @typedef {{ x: number, y: number, width: number, height: number }} Frame */

/** @typedef {{ id: string, time: number, frame: Frame }} Keyframe */

const state = {
  /** @type {VideoMeta | null} */
  video: null,
  aspectW: 16,
  aspectH: 9,
  aspectLocked: false,
  /** @type {Frame} */
  frame: { x: 0, y: 0, width: 0, height: 0 },
  /** @type {Keyframe[]} */
  keyframes: [],
  /** @type {string | null} */
  activeKeyframeId: null,
  dragging: null,
  dragStart: null,
  scrubbing: false,
  /** @type {number | null} */
  scrubRaf: null,
  /** @type {number | null} */
  pendingScrubRatio: null,
  /** @type {number} */
  playheadRatio: 0,
  /** @type {number | null} */
  playbackRaf: null,
  /** @type {{ w: number, h: number }} */
  overlaySize: { w: 0, h: 0 },
  /** @type {object | null} Projet JSON en attente d'une vidéo correspondante */
  pendingProject: null,
  /** @type {number} Temps source (s) — début de la plage export */
  sliceIn: 0,
  /** @type {number} Temps source (s) — fin de la plage export */
  sliceOut: 0,
  /** @type {'in' | 'out' | null} */
  sliceDragging: null,
};

const MIN_SLICE_SEC = 0.5;

const els = {
  fileInput: document.getElementById("file-input"),
  fileName: document.getElementById("file-name"),
  saveProjectBtn: document.getElementById("save-project"),
  loadProjectInput: /** @type {HTMLInputElement} */ (document.getElementById("load-project")),
  loadProjectLabel: document.getElementById("load-project-label"),
  cleanupDataBtn: document.getElementById("cleanup-data"),
  serverStatus: document.getElementById("server-status"),
  welcome: document.getElementById("welcome"),
  pendingProjectMsg: document.getElementById("pending-project-msg"),
  editor: document.getElementById("editor"),
  stage: document.getElementById("stage"),
  video: /** @type {HTMLVideoElement} */ (document.getElementById("video")),
  overlay: /** @type {HTMLCanvasElement} */ (document.getElementById("overlay")),
  aspectPreset: /** @type {HTMLSelectElement} */ (document.getElementById("aspect-preset")),
  customAspect: document.getElementById("custom-aspect"),
  aspectW: /** @type {HTMLInputElement} */ (document.getElementById("aspect-w")),
  aspectH: /** @type {HTMLInputElement} */ (document.getElementById("aspect-h")),
  resolutionMode: /** @type {HTMLSelectElement} */ (document.getElementById("resolution-mode")),
  crf: /** @type {HTMLInputElement} */ (document.getElementById("crf")),
  padColor: /** @type {HTMLInputElement} */ (document.getElementById("pad-color")),
  interpolateKeyframes: /** @type {HTMLInputElement} */ (
    document.getElementById("interpolate-keyframes")
  ),
  transitionSec: /** @type {HTMLInputElement} */ (document.getElementById("transition-sec")),
  resetFrame: document.getElementById("reset-frame"),
  addKeyframe: document.getElementById("add-keyframe"),
  keyframeList: document.getElementById("keyframe-list"),
  keyframeMarkers: document.getElementById("keyframe-markers"),
  exportBtn: document.getElementById("export-btn"),
  playBtn: document.getElementById("play-btn"),
  scrubberWrap: document.getElementById("scrubber-wrap"),
  scrubberFill: document.getElementById("scrubber-fill"),
  scrubberThumb: document.getElementById("scrubber-thumb"),
  sliceMaskLeft: document.getElementById("slice-mask-left"),
  sliceMaskRight: document.getElementById("slice-mask-right"),
  sliceRange: document.getElementById("slice-range"),
  sliceInHandle: document.getElementById("slice-in-handle"),
  sliceOutHandle: document.getElementById("slice-out-handle"),
  sliceRangeLabel: document.getElementById("slice-range-label"),
  timeCurrent: document.getElementById("time-current"),
  timeDuration: document.getElementById("time-duration"),
  status: document.getElementById("status"),
  exportResult: document.getElementById("export-result"),
  downloadLink: /** @type {HTMLAnchorElement} */ (document.getElementById("download-link")),
  exportBanner: document.getElementById("export-banner"),
  exportBannerTitle: document.getElementById("export-banner-title"),
  exportBannerText: document.getElementById("export-banner-text"),
  exportProgress: /** @type {HTMLProgressElement} */ (document.getElementById("export-progress")),
  exportLogWrap: document.getElementById("export-log-wrap"),
  exportLog: document.getElementById("export-log"),
};

const ctx = els.overlay?.getContext("2d");

function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return "00:00";
  const total = Math.max(0, seconds);
  const whole = Math.floor(total);
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** Temps affiché pour un cadrage (dixièmes si < 1 min). */
function formatKeyframeTime(seconds) {
  if (!Number.isFinite(seconds)) return "00:00";
  if (seconds < 60) {
    const s = Math.max(0, seconds);
    const whole = Math.floor(s);
    const tenths = Math.round((s - whole) * 10) % 10;
    return `00:${String(whole).padStart(2, "0")}.${tenths}`;
  }
  return formatTime(seconds);
}

function getVideoDuration() {
  const fromVideo = els.video?.duration;
  if (Number.isFinite(fromVideo) && fromVideo > 0) return fromVideo;
  const fromMeta = state.video?.duration;
  if (Number.isFinite(fromMeta) && fromMeta > 0) return fromMeta;
  return 0;
}

function getSliceOut() {
  const duration = getVideoDuration();
  if (duration <= 0) return 0;
  if (state.sliceOut > 0 && state.sliceOut <= duration) return state.sliceOut;
  return duration;
}

function resetSliceRange() {
  const duration = getVideoDuration();
  state.sliceIn = 0;
  state.sliceOut = duration > 0 ? duration : 0;
  renderSliceUI();
}

function renderSliceUI() {
  const duration = getVideoDuration();
  if (duration <= 0 || !els.sliceInHandle || !els.sliceOutHandle) return;

  const sliceOut = getSliceOut();
  const inPct = (state.sliceIn / duration) * 100;
  const outPct = (sliceOut / duration) * 100;

  els.sliceInHandle.style.left = `${inPct}%`;
  els.sliceOutHandle.style.left = `${outPct}%`;
  if (els.sliceMaskLeft) els.sliceMaskLeft.style.width = `${inPct}%`;
  if (els.sliceMaskRight) els.sliceMaskRight.style.width = `${100 - outPct}%`;
  if (els.sliceRange) {
    els.sliceRange.style.left = `${inPct}%`;
    els.sliceRange.style.width = `${Math.max(0, outPct - inPct)}%`;
  }

  const partial = state.sliceIn > 0.05 || sliceOut < duration - 0.05;
  if (els.sliceRangeLabel) {
    if (partial) {
      els.sliceRangeLabel.textContent = `Export : ${formatTime(state.sliceIn)} → ${formatTime(sliceOut)} (${formatTime(sliceOut - state.sliceIn)})`;
      els.sliceRangeLabel.classList.remove("hidden");
    } else {
      els.sliceRangeLabel.classList.add("hidden");
    }
  }
}

function bindSliceListeners() {
  document.addEventListener("pointermove", onSlicePointerMove);
  document.addEventListener("pointerup", onSlicePointerEnd);
  document.addEventListener("pointercancel", onSlicePointerEnd);
}

function unbindSliceListeners() {
  document.removeEventListener("pointermove", onSlicePointerMove);
  document.removeEventListener("pointerup", onSlicePointerEnd);
  document.removeEventListener("pointercancel", onSlicePointerEnd);
}

function onSliceHandlePointerDown(event, which) {
  if (!state.video || event.button !== 0) return;
  event.preventDefault();
  event.stopPropagation();
  state.sliceDragging = which;
  if (!els.video.paused) els.video.pause();
  bindSliceListeners();
}

function onSlicePointerMove(event) {
  if (!state.sliceDragging) return;
  const duration = getVideoDuration();
  if (duration <= 0) return;
  const t = ratioFromPointer(event) * duration;
  if (state.sliceDragging === "in") {
    state.sliceIn = Math.max(0, Math.min(t, getSliceOut() - MIN_SLICE_SEC));
  } else {
    state.sliceOut = Math.min(duration, Math.max(t, state.sliceIn + MIN_SLICE_SEC));
  }
  renderSliceUI();
}

function onSlicePointerEnd() {
  if (!state.sliceDragging) return;
  unbindSliceListeners();
  state.sliceDragging = null;
}

/** Position de lecture : ratio timeline en pause, currentTime en lecture. */
function getPlayheadTime() {
  const duration = getVideoDuration();
  if (duration <= 0) return 0;
  if (els.video && !els.video.paused && !els.video.ended) {
    return els.video.currentTime;
  }
  return Math.min(duration, Math.max(0, state.playheadRatio * duration));
}

function setScrubberVisual(ratio) {
  const clamped = Math.min(1, Math.max(0, ratio));
  state.playheadRatio = clamped;
  const pct = `${clamped * 100}%`;
  if (els.scrubberFill) els.scrubberFill.style.width = pct;
  if (els.scrubberThumb) els.scrubberThumb.style.left = pct;
  els.scrubberWrap?.setAttribute("aria-valuenow", String(Math.round(clamped * 1000)));
}

function syncScrubberFromVideo() {
  const duration = getVideoDuration();
  const current = els.video?.currentTime ?? 0;
  if (duration <= 0) return;
  setScrubberVisual(current / duration);
}

function ratioFromPointer(event) {
  const wrap = els.scrubberWrap;
  if (!wrap) return 0;
  const rect = wrap.getBoundingClientRect();
  if (rect.width <= 0) return 0;
  return Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
}

function seekVideoTo(time) {
  if (!els.video) return;
  const duration = getVideoDuration();
  const t = duration > 0 ? Math.min(duration, Math.max(0, time)) : Math.max(0, time);
  if (Math.abs(els.video.currentTime - t) <= 0.001) return;
  els.video.currentTime = t;
}

function applyScrubRatio(ratio, { updateOverlay = true } = {}) {
  const duration = getVideoDuration();
  if (duration <= 0) return 0;
  const clamped = Math.min(1, Math.max(0, ratio));
  const t = clamped * duration;
  setScrubberVisual(clamped);
  if (els.timeCurrent) els.timeCurrent.textContent = formatTime(t);
  if (updateOverlay) updatePreviewAtTime(t);
  return t;
}

function scheduleScrubPreview(ratio) {
  state.pendingScrubRatio = ratio;
  if (state.scrubRaf != null) return;
  state.scrubRaf = requestAnimationFrame(() => {
    state.scrubRaf = null;
    if (state.pendingScrubRatio == null || !state.scrubbing) return;
    applyScrubRatio(state.pendingScrubRatio, { updateOverlay: false });
    state.pendingScrubRatio = null;
  });
}

function tickPlayback() {
  state.playbackRaf = null;
  if (!els.video || els.video.paused || els.video.ended) return;

  const duration = getVideoDuration();
  const current = els.video.currentTime;
  if (duration > 0) {
    setScrubberVisual(current / duration);
  }
  if (els.timeCurrent) els.timeCurrent.textContent = formatTime(current);
  if (!state.dragging && !state.scrubbing) {
    updatePreviewAtTime(current);
  }

  state.playbackRaf = requestAnimationFrame(tickPlayback);
}

function startPlaybackLoop() {
  if (state.playbackRaf != null) return;
  state.playbackRaf = requestAnimationFrame(tickPlayback);
}

function stopPlaybackLoop() {
  if (state.playbackRaf != null) {
    cancelAnimationFrame(state.playbackRaf);
    state.playbackRaf = null;
  }
}

function updatePreviewAtTime(time) {
  state.frame = getFrameAtTime(time);
  drawOverlay();
}

function syncInterpControls() {
  const on = els.interpolateKeyframes?.checked !== false;
  if (els.transitionSec) els.transitionSec.disabled = !on;
}

function refreshDisplayFrame() {
  const t = getPlayheadTime();
  updatePreviewAtTime(t);
  renderKeyframeUI();
}

function setPlayheadTime(time) {
  const duration = getVideoDuration();
  const clamped = duration > 0 ? Math.min(duration, Math.max(0, time)) : Math.max(0, time);
  if (duration > 0) {
    applyScrubRatio(clamped / duration, { updateOverlay: true });
  } else if (els.timeCurrent) {
    els.timeCurrent.textContent = formatTime(clamped);
  }
  seekVideoTo(clamped);
  return clamped;
}

function resetScrubState() {
  state.scrubbing = false;
  state.pendingScrubRatio = null;
  if (state.scrubRaf != null) {
    cancelAnimationFrame(state.scrubRaf);
    state.scrubRaf = null;
  }
  unbindScrubListeners();
}

function bindScrubListeners() {
  document.addEventListener("pointermove", onDocumentScrubMove);
  document.addEventListener("pointerup", onDocumentScrubEnd);
  document.addEventListener("pointercancel", onDocumentScrubEnd);
}

function unbindScrubListeners() {
  document.removeEventListener("pointermove", onDocumentScrubMove);
  document.removeEventListener("pointerup", onDocumentScrubEnd);
  document.removeEventListener("pointercancel", onDocumentScrubEnd);
}

function togglePlayback() {
  const video = els.video;
  if (!video || !state.video) return;

  resetScrubState();

  if (!video.paused && !video.ended) {
    video.pause();
    return;
  }

  const duration = getVideoDuration();
  const target = getPlayheadTime();
  const clamped = duration > 0 ? Math.min(Math.max(0, target), duration - 0.001) : Math.max(0, target);

  // Seek en pause : Firefox fige l'image si on seek pendant la lecture
  if (Math.abs(video.currentTime - clamped) > 0.001) {
    video.currentTime = clamped;
  }
  void video.play();
}

function setStatus(message, isError = false) {
  if (!els.status) return;
  els.status.textContent = message;
  els.status.classList.remove("hidden", "error");
  if (isError) els.status.classList.add("error");
}

function clearStatus() {
  els.status?.classList.add("hidden");
  els.status?.classList.remove("error");
}

function parseApiError(data) {
  const detail = data?.detail;
  if (!detail) return "Erreur inconnue.";
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    return detail.map((item) => item.msg || JSON.stringify(item)).join(" · ");
  }
  return String(detail);
}

async function readJsonResponse(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Réponse serveur invalide.");
  }
}

function showExportBanner(title, text, mode = "running") {
  els.exportBanner?.classList.remove("hidden", "success", "error");
  if (mode === "success") els.exportBanner?.classList.add("success");
  if (mode === "error") els.exportBanner?.classList.add("error");
  if (els.exportBannerTitle) els.exportBannerTitle.textContent = title;
  if (els.exportBannerText) els.exportBannerText.textContent = text;
}

function hideExportBanner() {
  els.exportBanner?.classList.add("hidden");
  els.exportBanner?.classList.remove("success", "error");
  if (els.exportProgress) {
    els.exportProgress.hidden = true;
    els.exportProgress.value = 0;
  }
}

function resetExportUi() {
  hideExportBanner();
  els.exportLogWrap?.classList.add("hidden");
  els.exportResult?.classList.add("hidden");
}

function showExportLog(lines, { done = false } = {}) {
  if (!els.exportLog) return;
  els.exportLogWrap?.classList.remove("hidden");
  if (lines?.length) {
    els.exportLog.textContent = lines.join("\n");
  } else if (done) {
    els.exportLog.textContent =
      "Aucun log ffmpeg reçu. Relancez le serveur (kill $(lsof -ti :8765) && python run.py) puis réexportez.";
  } else {
    els.exportLog.textContent = "En attente de la sortie ffmpeg…";
  }
  els.exportLog.scrollTop = els.exportLog.scrollHeight;
}

async function fetchJobLogs(jobId) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const ts = Date.now();
    const endpoints = [
      { url: `/api/export/jobs/${jobId}/log.txt?t=${ts}`, kind: "txt" },
      { url: `/api/export/jobs/${jobId}/log?t=${ts}`, kind: "json" },
    ];
    for (const { url, kind } of endpoints) {
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) continue;
      const text = await response.text();
      if (kind === "json") {
        try {
          const data = JSON.parse(text);
          if (Array.isArray(data.log) && data.log.length) return data.log;
        } catch {
          /* ignore */
        }
      } else if (text.trim()) {
        return text.split("\n");
      }
    }
    await sleep(250);
  }
  return [];
}

async function fetchJobStatus(jobId) {
  const response = await fetch(`/api/export/jobs/${jobId}?t=${Date.now()}`, {
    cache: "no-store",
  });
  const raw = await response.text();
  let job = {};
  try {
    job = raw ? JSON.parse(raw) : {};
  } catch {
    throw new Error(`Statut export non-JSON : ${raw.slice(0, 120)}`);
  }
  if (!response.ok) {
    throw new Error(parseApiError(job) || "Suivi d'export impossible.");
  }
  const logs = await fetchJobLogs(jobId);
  if (logs.length) {
    job.log = logs;
  } else if (!Array.isArray(job.log)) {
    job.log = [];
  }
  return job;
}

async function finishExportSuccess(job, jobId) {
  const logLines = jobId ? await fetchJobLogs(jobId) : (job.log || []);
  const lines = logLines.length ? logLines : (Array.isArray(job.log) ? job.log : []);
  if (els.downloadLink) {
    els.downloadLink.href = job.url;
    els.downloadLink.download = `recadrage-${state.video.filename}`;
  }
  els.exportResult?.classList.remove("hidden");
  if (els.exportProgress) {
    els.exportProgress.hidden = false;
    els.exportProgress.value = 100;
  }
  showExportLog(lines, { done: true });
  showExportBanner(
    "Export terminé",
    `${job.output_width}×${job.output_height} — cliquez sur Télécharger ci-dessous.`,
    "success",
  );
  setStatus(`Export prêt (${job.output_width}×${job.output_height}).`);
}

function updateExportProgress(job) {
  const logLines = Array.isArray(job.log) ? job.log : [];
  const elapsed = formatElapsed(job.elapsed_seconds || 0);
  const parts = [`Encodage ffmpeg… ${elapsed} écoulées.`];

  if (job.out_time) parts.push(`Temps encodé : ${job.out_time}`);
  if (job.speed) parts.push(`Vitesse : ${job.speed}`);
  if (job.fps) parts.push(`${job.fps} fps`);
  if (job.frame) parts.push(`frame ${job.frame}`);
  if (job.progress_percent > 0) {
    parts.push(`${Math.round(job.progress_percent)} %`);
  }

  showExportBanner("Export en cours", parts.join(" · "));
  setStatus(parts.join(" · "));

  if (els.exportProgress && job.progress_percent > 0) {
    els.exportProgress.hidden = false;
    els.exportProgress.value = job.progress_percent;
  }

  showExportLog(logLines);
}

async function pollExportJob(jobId) {
  while (true) {
    const job = await fetchJobStatus(jobId);

    if (job.status === "pending" || job.status === "running") {
      updateExportProgress(job);
      await sleep(500);
      continue;
    }

    if (job.status === "done") {
      await finishExportSuccess(job, jobId);
      return;
    }

    showExportLog(job.log || [], { done: true });
    throw new Error(job.detail || "Export échoué.");
  }
}

function formatElapsed(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} o`;
  const units = ["Ko", "Mo", "Go"];
  let value = n;
  let unitIndex = -1;
  do {
    value /= 1024;
    unitIndex += 1;
  } while (value >= 1024 && unitIndex < units.length - 1);
  const digits = value >= 10 || unitIndex === 0 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unitIndex]}`;
}

function resetAppAfterCleanup() {
  if (!els.video.paused) els.video.pause();
  state.video = null;
  state.keyframes = [];
  state.activeKeyframeId = null;
  state.playheadRatio = 0;
  state.sliceIn = 0;
  state.sliceOut = 0;
  state.frame = { x: 0, y: 0, width: 0, height: 0 };
  clearPendingProjectUi();
  resetExportUi();
  clearStatus();
  els.video.removeAttribute("src");
  els.video.load();
  els.fileName.textContent = "Aucun fichier";
  setScrubberVisual(0);
  els.timeCurrent.textContent = "00:00";
  els.timeDuration.textContent = "00:00";
  els.editor.classList.add("hidden");
  els.welcome?.classList.remove("hidden");
  if (els.saveProjectBtn) {
    els.saveProjectBtn.classList.add("hidden");
    els.saveProjectBtn.disabled = true;
  }
  renderKeyframeUI();
  renderSliceUI();
}

async function cleanupData() {
  if (window.location.protocol === "file:") {
    setStatus("Ouvrez http://127.0.0.1:8765 pour utiliser cette fonction.", true);
    return;
  }

  els.cleanupDataBtn.disabled = true;
  try {
    const statsResponse = await fetch(`/api/data/stats?t=${Date.now()}`, { cache: "no-store" });
    const stats = await readJsonResponse(statsResponse);
    if (!statsResponse.ok) {
      throw new Error(parseApiError(stats) || "Impossible de lire l'espace disque.");
    }

    const labels = {
      uploads: "Imports",
      exports: "Exports",
      logs: "Logs ffmpeg",
      tmp: "Temporaire",
    };
    const lines = Object.entries(labels).map(([key, label]) => {
      const entry = stats[key] || { files: 0, bytes: 0 };
      return `• ${label} : ${entry.files} fichier(s), ${formatBytes(entry.bytes)}`;
    });
    const totalFiles = Object.values(stats).reduce((sum, entry) => sum + (entry?.files || 0), 0);
    const totalBytes = Object.values(stats).reduce((sum, entry) => sum + (entry?.bytes || 0), 0);

    if (totalFiles === 0) {
      setStatus("Rien à nettoyer — dossiers data/ déjà vides.", false);
      return;
    }

    const message =
      `Supprimer ${totalFiles} fichier(s) (${formatBytes(totalBytes)}) ?\n\n` +
      `${lines.join("\n")}\n\n` +
      "La vidéo ouverte et les exports ne seront plus disponibles sur ce serveur.";
    if (!window.confirm(message)) return;

    const response = await fetch("/api/data/cleanup", { method: "POST" });
    const data = await readJsonResponse(response);
    if (!response.ok) {
      throw new Error(parseApiError(data) || "Nettoyage impossible.");
    }

    resetAppAfterCleanup();
    setStatus(
      `Nettoyage terminé : ${data.total_files} fichier(s), ${formatBytes(data.total_bytes)} libérés.`,
      false,
    );
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Nettoyage échoué.", true);
  } finally {
    els.cleanupDataBtn.disabled = false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function checkServer() {
  if (window.location.protocol === "file:") {
    if (els.serverStatus) {
      els.serverStatus.textContent =
        "Ouvrez http://127.0.0.1:8765 (pas le fichier HTML directement)";
      els.serverStatus.classList.remove("hidden");
      els.serverStatus.classList.add("error");
    }
    return false;
  }

  try {
    const response = await fetch(`/api/health?t=${Date.now()}`, {
      cache: "no-store",
    });
    const raw = await response.text();
    let data = {};
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch {
      throw new Error(`Health non-JSON : ${raw.slice(0, 120)}`);
    }

    if (!response.ok || data.status !== "ok") {
      throw new Error(`Health invalide (${response.status}) : ${raw.slice(0, 120)}`);
    }

    const version = Number(data.api_version);
    const port = window.location.port || "8765";
    if (!Number.isFinite(version) || version < 5) {
      throw new Error(
        `Serveur obsolète sur le port ${port} (api v${Number.isFinite(version) ? version : "?"}). ` +
          "Relancez python run.py (v5) et ouvrez http://127.0.0.1:8765",
      );
    }

    if (els.serverStatus) {
      els.serverStatus.textContent = `Serveur v${version} · port ${port}`;
      els.serverStatus.classList.remove("hidden", "error");
    }
    return true;
  } catch (error) {
    if (els.serverStatus) {
      const detail = error instanceof Error ? error.message : "Erreur réseau";
      els.serverStatus.textContent = `Serveur inaccessible : ${detail}`;
      els.serverStatus.classList.remove("hidden");
      els.serverStatus.classList.add("error");
    }
    return false;
  }
}

function newId() {
  return crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function sortKeyframes() {
  state.keyframes.sort((a, b) => a.time - b.time);
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function cloneFrame(frame) {
  return { x: frame.x, y: frame.y, width: frame.width, height: frame.height };
}

function getTransitionSec() {
  const v = Number(els.transitionSec?.value);
  return Number.isFinite(v) && v >= 0 ? v : 1;
}

/** Ratio 0–1 entre deux keyframes : palier puis fondu sur transitionSec avant t1. */
function keyframeInterpRatio(time, t0, t1, transitionSec) {
  const span = t1 - t0;
  if (span <= 0) return 1;
  const fade = Math.min(Math.max(0, transitionSec), span);
  const fadeStart = t1 - fade;
  if (time <= fadeStart) return 0;
  return (time - fadeStart) / fade;
}

function getFrameAtTime(time) {
  const kfs = state.keyframes;
  if (!kfs.length) return cloneFrame(state.frame);
  if (time <= kfs[0].time) return cloneFrame(kfs[0].frame);
  if (time >= kfs[kfs.length - 1].time) return cloneFrame(kfs[kfs.length - 1].frame);

  const interpolate = els.interpolateKeyframes?.checked !== false;
  const transitionSec = getTransitionSec();
  for (let i = 0; i < kfs.length - 1; i += 1) {
    const a = kfs[i];
    const b = kfs[i + 1];
    if (time >= a.time && time <= b.time) {
      const ratio = interpolate
        ? keyframeInterpRatio(time, a.time, b.time, transitionSec)
        : 0;
      return {
        x: lerp(a.frame.x, b.frame.x, ratio),
        y: lerp(a.frame.y, b.frame.y, ratio),
        width: lerp(a.frame.width, b.frame.width, ratio),
        height: lerp(a.frame.height, b.frame.height, ratio),
      };
    }
  }
  return cloneFrame(kfs[kfs.length - 1].frame);
}

function getActiveKeyframe() {
  return state.keyframes.find((kf) => kf.id === state.activeKeyframeId) ?? null;
}

function initKeyframes(frame) {
  const kf = { id: newId(), time: 0, frame: cloneFrame(frame) };
  state.keyframes = [kf];
  state.activeKeyframeId = kf.id;
  renderKeyframeUI();
}

function addKeyframeAt(time, frame = null) {
  const t = Number.isFinite(time) ? Math.max(0, time) : getPlayheadTime();
  const existing = state.keyframes.find((kf) => Math.abs(kf.time - t) < 0.05);
  if (existing) {
    state.activeKeyframeId = existing.id;
    refreshDisplayFrame();
    return existing;
  }
  const kf = {
    id: newId(),
    time: t,
    frame: cloneFrame(frame ?? getFrameAtTime(t)),
  };
  state.keyframes.push(kf);
  sortKeyframes();
  state.activeKeyframeId = kf.id;
  refreshDisplayFrame();
  return kf;
}

function deleteKeyframe(id) {
  if (state.keyframes.length <= 1) return;
  state.keyframes = state.keyframes.filter((kf) => kf.id !== id);
  if (state.activeKeyframeId === id) {
    state.activeKeyframeId = state.keyframes[0]?.id ?? null;
  }
  refreshDisplayFrame();
}

function selectKeyframe(id) {
  const kf = state.keyframes.find((item) => item.id === id);
  if (!kf || !state.video) return;
  state.activeKeyframeId = id;
  setPlayheadTime(kf.time);
  refreshDisplayFrame();
}

function renderKeyframeUI() {
  if (!els.keyframeList) return;

  els.keyframeList.innerHTML = "";
  for (const kf of state.keyframes) {
    const li = document.createElement("li");
    li.className = `keyframe-item${kf.id === state.activeKeyframeId ? " active" : ""}`;
    li.dataset.id = kf.id;

    const label = document.createElement("span");
    label.className = "keyframe-item-time";
    label.textContent = formatKeyframeTime(kf.time);

    const del = document.createElement("button");
    del.type = "button";
    del.className = "keyframe-item-del secondary";
    del.textContent = "×";
    del.title = "Supprimer ce cadrage";
    del.addEventListener("click", (event) => {
      event.stopPropagation();
      deleteKeyframe(kf.id);
    });

    li.appendChild(label);
    if (state.keyframes.length > 1) li.appendChild(del);
    li.addEventListener("click", () => selectKeyframe(kf.id));
    els.keyframeList.appendChild(li);
  }

  if (!els.keyframeMarkers || !state.video) return;
  els.keyframeMarkers.innerHTML = "";
  const duration = getVideoDuration();
  if (duration <= 0) return;

  for (const kf of state.keyframes) {
    const dot = document.createElement("span");
    dot.className = `keyframe-marker${kf.id === state.activeKeyframeId ? " active" : ""}`;
    dot.style.left = `${(kf.time / duration) * 100}%`;
    els.keyframeMarkers.appendChild(dot);
  }
  renderSliceUI();
}

function buildExportPayload() {
  if (!state.video?.id) {
    throw new Error("Vidéo non chargée. Cliquez sur « Ouvrir une vidéo ».");
  }
  if (!state.keyframes.length) {
    throw new Error("Aucun cadrage défini.");
  }
  return {
    video_id: state.video.id,
    aspect_w: state.aspectW,
    aspect_h: state.aspectH,
    keyframes: state.keyframes.map((kf) => ({
      time: Number(kf.time),
      frame: {
        x: Number(kf.frame.x),
        y: Number(kf.frame.y),
        width: Number(kf.frame.width),
        height: Number(kf.frame.height),
      },
    })),
    resolution_mode: els.resolutionMode.value,
    pad_color: els.padColor?.value || "#000000",
    crf: Number(els.crf.value) || 23,
    interpolate_keyframes: els.interpolateKeyframes?.checked !== false,
    transition_sec: getTransitionSec(),
    export_start: state.sliceIn,
    export_end: getSliceOut(),
  };
}

function buildProject() {
  if (!state.video) throw new Error("Aucune vidéo chargée.");
  return {
    version: 2,
    video_id: state.video.id,
    filename: state.video.filename,
    source_filename: state.video.filename,
    aspect_w: state.aspectW,
    aspect_h: state.aspectH,
    aspect_preset: els.aspectPreset.value,
    resolution_mode: els.resolutionMode.value,
    crf: Number(els.crf.value) || 23,
    pad_color: els.padColor?.value || "#000000",
    interpolate_keyframes: els.interpolateKeyframes?.checked !== false,
    transition_sec: getTransitionSec(),
    export_start: state.sliceIn,
    export_end: getSliceOut(),
    keyframes: state.keyframes.map((kf) => ({
      time: kf.time,
      frame: cloneFrame(kf.frame),
    })),
  };
}

async function fetchVideoMeta(videoId) {
  const response = await fetch(`/api/videos/${videoId}`);
  if (!response.ok) {
    throw new Error("Vidéo absente du serveur — réimportez le fichier original.");
  }
  return readJsonResponse(response);
}

function showEditor() {
  els.welcome?.classList.add("hidden");
  els.editor.classList.remove("hidden");
  els.saveProjectBtn?.classList.remove("hidden");
  if (els.saveProjectBtn) els.saveProjectBtn.disabled = !state.video;
}

function projectSourceName(data) {
  return (data.source_filename || data.filename || "").trim();
}

function filenamesMatch(a, b) {
  if (!a || !b) return false;
  const base = (name) => name.split(/[/\\]/).pop().toLowerCase();
  return base(a) === base(b);
}

function updatePendingProjectUi() {
  const pending = state.pendingProject;
  if (!pending) {
    els.pendingProjectMsg?.classList.add("hidden");
    return;
  }
  const name = projectSourceName(pending) || "le fichier vidéo indiqué dans le projet";
  if (els.pendingProjectMsg) {
    els.pendingProjectMsg.textContent = `Projet chargé — ouvrez « ${name} » pour restaurer les cadrages.`;
    els.pendingProjectMsg.classList.remove("hidden");
  }
  if (!state.video) {
    els.welcome?.classList.remove("hidden");
  }
}

function clearPendingProjectUi() {
  state.pendingProject = null;
  els.pendingProjectMsg?.classList.add("hidden");
}

async function applyProjectSettings(data, videoRecord) {
  state.video = {
    id: videoRecord.id,
    filename: data.filename || videoRecord.filename || "vidéo",
    url: videoRecord.url,
    width: videoRecord.width ?? 0,
    height: videoRecord.height ?? 0,
    duration: videoRecord.duration ?? 0,
    fps: videoRecord.fps ?? 0,
    preview: Boolean(videoRecord.preview),
  };

  els.fileName.textContent = state.video.filename;
  showEditor();
  if (els.saveProjectBtn) els.saveProjectBtn.disabled = false;

  els.aspectPreset.value = data.aspect_preset || "source";
  if (data.aspect_preset === "custom") {
    state.aspectW = data.aspect_w;
    state.aspectH = data.aspect_h;
    els.aspectW.value = String(data.aspect_w);
    els.aspectH.value = String(data.aspect_h);
  }
  els.resolutionMode.value = data.resolution_mode || "source";
  els.crf.value = String(data.crf ?? 23);
  if (els.padColor) els.padColor.value = data.pad_color || "#000000";
  if (els.interpolateKeyframes) {
    els.interpolateKeyframes.checked = data.interpolate_keyframes !== false;
  }
  if (els.transitionSec) {
    els.transitionSec.value = String(data.transition_sec ?? 1);
  }
  if (data.export_start != null && Number.isFinite(Number(data.export_start))) {
    state.sliceIn = Math.max(0, Number(data.export_start));
  }
  if (data.export_end != null && Number.isFinite(Number(data.export_end))) {
    state.sliceOut = Math.max(0, Number(data.export_end));
  }

  state.keyframes = (data.keyframes || []).map((kf) => ({
    id: newId(),
    time: Number(kf.time),
    frame: cloneFrame(kf.frame),
  }));
  sortKeyframes();
  state.activeKeyframeId = state.keyframes[0]?.id ?? null;

  els.video.src = state.video.url;
  resetExportUi();

  await new Promise((resolve) => {
    if (els.video.readyState >= 1) resolve(undefined);
    else els.video.addEventListener("loadedmetadata", () => resolve(undefined), { once: true });
  });

  if (els.video.videoWidth && els.video.videoHeight) {
    state.video.width = els.video.videoWidth;
    state.video.height = els.video.videoHeight;
    state.video.duration = els.video.duration || state.video.duration;
    els.timeDuration.textContent = formatTime(state.video.duration);
  }

  clampSliceAfterLoad();
  applyAspectFromPreset(false);
  syncInterpControls();
  refreshDisplayFrame();
}

function clampSliceAfterLoad() {
  const duration = getVideoDuration();
  if (duration <= 0) return;
  if (state.sliceOut <= 0 || state.sliceOut > duration) {
    state.sliceOut = duration;
  }
  state.sliceIn = Math.min(Math.max(0, state.sliceIn), Math.max(0, state.sliceOut - MIN_SLICE_SEC));
  if (state.sliceOut - state.sliceIn < MIN_SLICE_SEC) {
    resetSliceRange();
  } else {
    renderSliceUI();
  }
}

async function applyProject(data) {
  if (!data?.video_id && !data?.keyframes?.length) {
    throw new Error("Projet invalide.");
  }

  const sourceName = projectSourceName(data);

  if (data.video_id) {
    try {
      const meta = await fetchVideoMeta(data.video_id);
      await applyProjectSettings(data, {
        id: data.video_id,
        filename: meta.filename,
        url: meta.url,
        width: 0,
        height: 0,
        duration: meta.duration ?? 0,
        fps: meta.fps ?? 0,
        preview: Boolean(meta.preview),
      });
      clearPendingProjectUi();
      return;
    } catch {
      /* vidéo absente du serveur — essai par nom de fichier */
    }
  }

  if (state.video && sourceName && filenamesMatch(state.video.filename, sourceName)) {
    await applyProjectSettings(data, state.video);
    clearPendingProjectUi();
    setStatus(`Projet appliqué à « ${state.video.filename} ».`, false);
    return;
  }

  state.pendingProject = data;
  updatePendingProjectUi();

  if (state.video) {
    setStatus(
      sourceName
        ? `Projet pour « ${sourceName} » en attente — ouvrez ce fichier pour appliquer les cadrages.`
        : "Projet en attente — ouvrez la vidéo correspondante.",
      false,
    );
  } else {
    setStatus(
      sourceName
        ? `Projet chargé — ouvrez « ${sourceName} » pour restaurer les cadrages.`
        : "Projet chargé — ouvrez la vidéo correspondante.",
      false,
    );
  }
}

function saveProject() {
  const blob = new Blob([JSON.stringify(buildProject(), null, 2)], {
    type: "application/json",
  });
  const name = (state.video?.filename || "projet").replace(/\.[^.]+$/, "");
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `${name}.recadrage.json`;
  link.click();
  URL.revokeObjectURL(link.href);
}

function aspectRatio() {
  return state.aspectW / state.aspectH;
}

function getDisplayRect() {
  const canvas = els.overlay;
  const vw = state.video?.width ?? 16;
  const vh = state.video?.height ?? 9;
  const cw = canvas.clientWidth;
  const ch = canvas.clientHeight;
  const videoAspect = vw / vh;
  const canvasAspect = cw / ch;

  let dw;
  let dh;
  if (videoAspect > canvasAspect) {
    dw = cw;
    dh = cw / videoAspect;
  } else {
    dh = ch;
    dw = ch * videoAspect;
  }
  return {
    x: (cw - dw) / 2,
    y: (ch - dh) / 2,
    w: dw,
    h: dh,
    scale: dw / vw,
  };
}

function sourceToDisplay(frame) {
  const d = getDisplayRect();
  return {
    x: d.x + frame.x * d.scale,
    y: d.y + frame.y * d.scale,
    width: frame.width * d.scale,
    height: frame.height * d.scale,
  };
}

function displayToSource(dx, dy) {
  const d = getDisplayRect();
  return {
    x: (dx - d.x) / d.scale,
    y: (dy - d.y) / d.scale,
  };
}

function defaultCenteredFrame() {
  if (!state.video) return;
  const { width: W, height: H } = state.video;
  const r = aspectRatio();

  let fw;
  let fh;
  if (W / H >= r) {
    fh = H;
    fw = H * r;
  } else {
    fw = W;
    fh = W / r;
  }

  state.frame = {
    x: (W - fw) / 2,
    y: (H - fh) / 2,
    width: fw,
    height: fh,
  };
}

function applyAspectFromPreset(updateKeyframeFrames = true) {
  if (!state.video) return;

  const preset = els.aspectPreset.value;
  if (preset === "source") {
    state.aspectW = state.video.width;
    state.aspectH = state.video.height;
    els.customAspect.classList.add("hidden");
  } else if (preset === "custom") {
    state.aspectW = Math.max(1, Number(els.aspectW.value) || 16);
    state.aspectH = Math.max(1, Number(els.aspectH.value) || 9);
    els.customAspect.classList.remove("hidden");
  } else {
    const [w, h] = preset.split(":").map(Number);
    state.aspectW = w;
    state.aspectH = h;
    els.customAspect.classList.add("hidden");
  }

  state.aspectLocked = true;
  if (preset === "source") {
    els.resolutionMode.value = "source";
  } else {
    els.resolutionMode.value = "fit_aspect";
  }
  defaultCenteredFrame();
  if (updateKeyframeFrames && state.keyframes.length) {
    const f = cloneFrame(state.frame);
    for (const kf of state.keyframes) {
      kf.frame = cloneFrame(f);
    }
  }
  refreshDisplayFrame();
}

function drawOverlay() {
  if (!ctx || !state.video) return;
  const canvas = els.overlay;
  const cw = canvas.clientWidth;
  const ch = canvas.clientHeight;
  if (cw <= 0 || ch <= 0) return;
  if (state.overlaySize.w !== cw || state.overlaySize.h !== ch) {
    canvas.width = cw;
    canvas.height = ch;
    state.overlaySize = { w: cw, h: ch };
  }

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const disp = sourceToDisplay(state.frame);
  const videoRect = getDisplayRect();

  ctx.fillStyle = "rgba(0,0,0,0.55)";
  ctx.beginPath();
  ctx.rect(0, 0, canvas.width, canvas.height);
  ctx.rect(disp.x, disp.y, disp.width, disp.height);
  ctx.fill("evenodd");

  ctx.strokeStyle = "#4f8cff";
  ctx.lineWidth = 2;
  ctx.strokeRect(disp.x, disp.y, disp.width, disp.height);

  const corners = [
    [disp.x, disp.y],
    [disp.x + disp.width, disp.y],
    [disp.x, disp.y + disp.height],
    [disp.x + disp.width, disp.y + disp.height],
  ];

  for (const [cx, cy] of corners) {
    ctx.beginPath();
    ctx.fillStyle = "#ffffff";
    ctx.strokeStyle = "#4f8cff";
    ctx.lineWidth = 2;
    ctx.arc(cx, cy, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  ctx.strokeStyle = "rgba(255,255,255,0.15)";
  ctx.strokeRect(videoRect.x, videoRect.y, videoRect.w, videoRect.h);
}

function hitTest(x, y) {
  const disp = sourceToDisplay(state.frame);
  const handleRadius = 12;
  const corners = [
    { id: "tl", x: disp.x, y: disp.y },
    { id: "tr", x: disp.x + disp.width, y: disp.y },
    { id: "bl", x: disp.x, y: disp.y + disp.height },
    { id: "br", x: disp.x + disp.width, y: disp.y + disp.height },
  ];

  for (const corner of corners) {
    const dx = x - corner.x;
    const dy = y - corner.y;
    if (Math.hypot(dx, dy) <= handleRadius) {
      return { type: "corner", corner: corner.id };
    }
  }

  if (
    x >= disp.x &&
    x <= disp.x + disp.width &&
    y >= disp.y &&
    y <= disp.y + disp.height
  ) {
    return { type: "move" };
  }

  return null;
}

function resizeFromCorner(corner, pointerSourceX, pointerSourceY) {
  const frame = state.frame;
  const r = aspectRatio();
  const anchor = getAnchor(corner, frame);

  let rawW;
  let rawH;
  if (corner === "br") {
    rawW = pointerSourceX - anchor.x;
    rawH = pointerSourceY - anchor.y;
  } else if (corner === "bl") {
    rawW = anchor.x - pointerSourceX;
    rawH = pointerSourceY - anchor.y;
  } else if (corner === "tr") {
    rawW = pointerSourceX - anchor.x;
    rawH = anchor.y - pointerSourceY;
  } else {
    rawW = anchor.x - pointerSourceX;
    rawH = anchor.y - pointerSourceY;
  }

  let fw;
  let fh;
  if (rawW / Math.max(rawH, 0.0001) >= r) {
    fw = rawW;
    fh = fw / r;
  } else {
    fh = rawH;
    fw = fh * r;
  }

  if (Math.abs(fw) < 20 || Math.abs(fh) < 20) return;

  applySizedFrame(corner, anchor, fw, fh);
}

function getAnchor(corner, frame) {
  switch (corner) {
    case "tl":
      return { x: frame.x + frame.width, y: frame.y + frame.height };
    case "tr":
      return { x: frame.x, y: frame.y + frame.height };
    case "bl":
      return { x: frame.x + frame.width, y: frame.y };
    default:
      return { x: frame.x, y: frame.y };
  }
}

function applySizedFrame(corner, anchor, fw, fh) {
  let x;
  let y;
  switch (corner) {
    case "br":
      x = anchor.x;
      y = anchor.y;
      break;
    case "bl":
      x = anchor.x - fw;
      y = anchor.y;
      break;
    case "tr":
      x = anchor.x;
      y = anchor.y - fh;
      break;
    default:
      x = anchor.x - fw;
      y = anchor.y - fh;
      break;
  }

  state.frame = { x, y, width: fw, height: fh };
  const active = getActiveKeyframe();
  if (active) active.frame = cloneFrame(state.frame);
}

function onPointerDown(event) {
  if (!state.video) return;
  const rect = els.overlay.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  const hit = hitTest(x, y);
  if (!hit) return;

  addKeyframeAt(getPlayheadTime());
  const active = getActiveKeyframe();
  if (!active) return;

  state.dragging = hit;
  state.dragStart = {
    pointer: displayToSource(x, y),
    frame: cloneFrame(active.frame),
  };
  state.frame = cloneFrame(active.frame);
  els.overlay.setPointerCapture(event.pointerId);
}

function onPointerMove(event) {
  if (!state.dragging || !state.dragStart) return;
  const rect = els.overlay.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  const pointer = displayToSource(x, y);

  if (state.dragging.type === "move") {
    const dx = pointer.x - state.dragStart.pointer.x;
    const dy = pointer.y - state.dragStart.pointer.y;
    state.frame = {
      ...state.dragStart.frame,
      x: state.dragStart.frame.x + dx,
      y: state.dragStart.frame.y + dy,
    };
  } else if (state.dragging.type === "corner") {
    resizeFromCorner(state.dragging.corner, pointer.x, pointer.y);
  }

  const active = getActiveKeyframe();
  if (active) active.frame = cloneFrame(state.frame);
  drawOverlay();
}

function onPointerUp(event) {
  if (state.dragging) {
    state.dragging = null;
    state.dragStart = null;
    try {
      els.overlay.releasePointerCapture(event.pointerId);
    } catch {
      /* capture déjà relâchée */
    }
  }
}

async function uploadFile(file) {
  clearStatus();
  els.exportResult.classList.add("hidden");
  const isMov = /\.(mov|m4v)$/i.test(file.name || "");
  setStatus(isMov ? "Import et préparation aperçu (MOV)…" : "Import en cours…");

  const form = new FormData();
  form.append("file", file);

  const response = await fetch("/api/upload", { method: "POST", body: form });
  const data = await readJsonResponse(response);
  if (!response.ok) {
    throw new Error(parseApiError(data) || "Import impossible.");
  }

  state.video = data;
  state.aspectLocked = false;
  els.fileName.textContent = data.filename;
  resetExportUi();
  els.video.src = data.url;
  setScrubberVisual(0);
  els.timeDuration.textContent = formatTime(data.duration);
  els.timeCurrent.textContent = "00:00";

  resetSliceRange();

  if (state.pendingProject) {
    const expected = projectSourceName(state.pendingProject);
    if (!expected || filenamesMatch(data.filename, expected)) {
      await applyProjectSettings(state.pendingProject, data);
      clearPendingProjectUi();
      setStatus(
        expected
          ? `Projet appliqué à « ${data.filename} ».`
          : `Projet appliqué à la vidéo ouverte.`,
        false,
      );
      clearStatus();
      return;
    }
    state.keyframes = [];
    els.aspectPreset.value = "source";
    applyAspectFromPreset();
    initKeyframes(state.frame);
    setStatus(
      `Vidéo importée. Projet en attente pour « ${expected} » — ouvrez ce fichier pour appliquer les cadrages.`,
      false,
    );
    showEditor();
    clearStatus();
    return;
  }

  state.keyframes = [];
  els.aspectPreset.value = "source";
  applyAspectFromPreset();
  initKeyframes(state.frame);
  showEditor();
  clearStatus();
}

async function exportVideo() {
  if (!state.video) return;

  els.exportBtn.disabled = true;
  els.exportResult?.classList.add("hidden");
  hideExportBanner();

  try {
    const serverOk = await checkServer();
    if (!serverOk) {
      throw new Error(
        "Impossible de joindre le serveur. Ouvrez http://127.0.0.1:8765 puis rechargez.",
      );
    }

    const payload = buildExportPayload();
    showExportBanner(
      "Export en cours",
      "Lancement de ffmpeg… l'encodage peut prendre plusieurs minutes.",
    );
    setStatus("Export en cours…");
    els.exportLogWrap?.classList.remove("hidden");
    showExportLog(["Export démarré…"]);

    const response = await fetch("/api/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const raw = await response.text();
    let data = {};
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch {
      throw new Error(`Réponse non-JSON (${response.status}) : ${raw.slice(0, 200)}`);
    }

    if (!response.ok) {
      throw new Error(parseApiError(data) || `Export échoué (${response.status}).`);
    }

    const jobId = data.job_id;
    if (jobId) {
      await pollExportJob(jobId);
      return;
    }

    const port = window.location.port || "8765";
    if (data.url && data.output_width) {
      throw new Error(
        `Export synchrone (ancien serveur sur le port ${port}). ` +
          "Fermez tous les serveurs : for p in 8765 9876 9877; do kill $(lsof -ti :$p) 2>/dev/null; done " +
          "puis python run.py et ouvrez http://127.0.0.1:8765 (Cmd+Shift+R).",
      );
    }

    throw new Error(
      `Réponse export inattendue (${response.status}) : ${raw.slice(0, 300)}`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Export échoué.";
    showExportBanner("Export échoué", message, "error");
    setStatus(message, true);
  } finally {
    els.exportBtn.disabled = false;
  }
}

els.fileInput.addEventListener("change", async (event) => {
  const input = /** @type {HTMLInputElement} */ (event.target);
  const file = input.files?.[0];
  if (!file) return;
  try {
    await uploadFile(file);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Import échoué.", true);
  }
});

els.aspectPreset.addEventListener("change", applyAspectFromPreset);
els.aspectW.addEventListener("change", applyAspectFromPreset);
els.aspectH.addEventListener("change", applyAspectFromPreset);
els.interpolateKeyframes?.addEventListener("change", () => {
  syncInterpControls();
  refreshDisplayFrame();
});
els.transitionSec?.addEventListener("input", refreshDisplayFrame);
els.transitionSec?.addEventListener("change", refreshDisplayFrame);
els.resetFrame.addEventListener("click", () => {
  defaultCenteredFrame();
  const active = getActiveKeyframe();
  if (active) active.frame = cloneFrame(state.frame);
  refreshDisplayFrame();
});

els.addKeyframe?.addEventListener("click", () => {
  if (!state.video) return;
  addKeyframeAt(getPlayheadTime());
});

els.saveProjectBtn?.addEventListener("click", () => {
  try {
    saveProject();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Sauvegarde impossible.", true);
  }
});

els.loadProjectInput?.addEventListener("change", async (event) => {
  const input = /** @type {HTMLInputElement} */ (event.target);
  const file = input.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    await applyProject(JSON.parse(text));
    if (!state.pendingProject) clearStatus();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Chargement impossible.", true);
  } finally {
    input.value = "";
  }
});

els.cleanupDataBtn?.addEventListener("click", () => {
  cleanupData();
});

els.exportBtn.addEventListener("click", exportVideo);

els.playBtn.addEventListener("click", togglePlayback);

els.video.addEventListener("play", () => {
  els.playBtn.textContent = "⏸";
});
els.video.addEventListener("playing", () => {
  els.playBtn.textContent = "⏸";
  startPlaybackLoop();
});
els.video.addEventListener("pause", () => {
  els.playBtn.textContent = "▶";
  stopPlaybackLoop();
  if (!state.scrubbing) {
    syncScrubberFromVideo();
  }
});
els.video.addEventListener("ended", () => {
  els.playBtn.textContent = "▶";
  stopPlaybackLoop();
  syncScrubberFromVideo();
});

els.video.addEventListener("loadedmetadata", () => {
  if (!state.video || !els.video.videoWidth || !els.video.videoHeight) return;

  const vw = els.video.videoWidth;
  const vh = els.video.videoHeight;
  const dimsChanged = state.video.width !== vw || state.video.height !== vh;

  if (dimsChanged) {
    state.video.width = vw;
    state.video.height = vh;
    state.video.duration = els.video.duration || state.video.duration;
    if (els.aspectPreset.value === "source") {
      state.aspectW = vw;
      state.aspectH = vh;
    }
    defaultCenteredFrame();
    if (!state.keyframes.length) {
      initKeyframes(state.frame);
    } else if (state.keyframes.length === 1 && state.keyframes[0].time === 0) {
      state.keyframes[0].frame = cloneFrame(state.frame);
    }
    els.timeDuration.textContent = formatTime(getVideoDuration());
    clampSliceAfterLoad();
  }

  refreshDisplayFrame();
});

function onScrubberPointerDown(event) {
  if (!state.video || event.button !== 0) return;
  if (event.target instanceof Element && event.target.closest(".slice-handle")) return;
  state.scrubbing = true;
  state.pendingScrubRatio = null;
  if (!els.video.paused) els.video.pause();
  applyScrubRatio(ratioFromPointer(event), { updateOverlay: false });
  bindScrubListeners();
}

function onDocumentScrubMove(event) {
  if (!state.scrubbing) return;
  scheduleScrubPreview(ratioFromPointer(event));
}

function onDocumentScrubEnd(event) {
  if (!state.scrubbing) return;
  unbindScrubListeners();
  state.scrubbing = false;
  if (state.scrubRaf != null) {
    cancelAnimationFrame(state.scrubRaf);
    state.scrubRaf = null;
  }
  const t = applyScrubRatio(ratioFromPointer(event), { updateOverlay: true });
  if (els.video?.paused) seekVideoTo(t);
}

if (els.scrubberWrap) {
  els.scrubberWrap.addEventListener("pointerdown", onScrubberPointerDown);
}

els.sliceInHandle?.addEventListener("pointerdown", (e) => onSliceHandlePointerDown(e, "in"));
els.sliceOutHandle?.addEventListener("pointerdown", (e) => onSliceHandlePointerDown(e, "out"));

window.addEventListener("blur", () => {
  if (state.sliceDragging) {
    unbindSliceListeners();
    state.sliceDragging = null;
  }
  if (state.scrubbing) {
    unbindScrubListeners();
    state.scrubbing = false;
    if (state.scrubRaf != null) {
      cancelAnimationFrame(state.scrubRaf);
      state.scrubRaf = null;
    }
    const t = applyScrubRatio(state.playheadRatio, { updateOverlay: true });
    if (els.video?.paused) seekVideoTo(t);
  }
  state.dragging = null;
  state.dragStart = null;
});

els.overlay.addEventListener("pointerdown", onPointerDown);
els.overlay.addEventListener("pointermove", onPointerMove);
els.overlay.addEventListener("pointerup", onPointerUp);
els.overlay.addEventListener("pointercancel", onPointerUp);

window.addEventListener("resize", drawOverlay);
if (els.stage && typeof ResizeObserver !== "undefined") {
  new ResizeObserver(drawOverlay).observe(els.stage);
}
checkServer();
setInterval(checkServer, 5000);
syncInterpControls();
