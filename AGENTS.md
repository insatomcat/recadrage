# AGENTS.md — Recadrage

**Source unique de contexte pour agents IA** (Cursor, Claude, etc.). Complété par `ARCHITECTURE.md` pour le détail technique.

## TL;DR

App web **locale** (FastAPI + JS vanilla + ffmpeg) pour recadrer/reframer des vidéos MP4/MOV.

```bash
cd recadrage && source .venv/bin/activate
python run.py                    # http://127.0.0.1:8765
kill $(lsof -ti :8765)           # si port occupé
# Cmd+Shift+R navigateur après modif frontend
# api_version attendue : 5 (frontend refuse < 5)
```

Prérequis : Python 3.11+, `ffmpeg`/`ffprobe` dans le PATH.

**Stack** : FastAPI, uvicorn, ffmpeg en subprocess. Frontend monolithique `frontend/app.js` (~1350 lignes), pas de build step.

**Langue** : répondre en **français** à l'utilisateur. UI en français.

---

## Lire en priorité

| Besoin | Fichier |
|--------|---------|
| Schémas, API, pipeline ffmpeg | `ARCHITECTURE.md` |
| Endpoints, upload, preview | `backend/main.py` |
| Filtres, encodage, preview MOV | `backend/ffmpeg_utils.py` |
| Export async, logs | `backend/export_jobs.py` |
| UI, timeline, keyframes | `frontend/app.js` |
| Utilisateur final | `README.md` |

---

## Où modifier quoi

| Tâche | Fichier(s) |
|-------|------------|
| Nouvel endpoint API | `backend/main.py` |
| Filtre ffmpeg / encodage | `backend/ffmpeg_utils.py` |
| Progress export / logs | `backend/export_jobs.py` |
| UI, timeline, keyframes | `frontend/app.js` |
| Layout / styles | `frontend/styles.css`, `frontend/index.html` |
| Cache bust navigateur | `index.html` (`app.js?v=`, `styles.css?v=`) |

---

## État actuel (v5)

### Fonctionnalités

- Import MP4/MOV, aperçu avec overlay crop draggable
- **Cadrages multiples** (keyframes) + interpolation linéaire preview/export
- Timeline CSS custom (pas `<input type="range">`)
- Export async H.264 (VideoToolbox macOS → fallback libx264), copie directe si export identique
- Sauvegarde/chargement projet `.recadrage.json`
- Couleur des bandes configurable
- **Preview MOV** : MP4 dérivé pour le lecteur HTML5 ; original pour l'export

### Modèle mental frontend

```javascript
state = {
  video,           // métadonnées serveur ; video.url = /preview ou /file
  frame,           // crop courant (affichage)
  keyframes[],     // { id, time, frame }
  playheadRatio,   // 0–1, source de vérité timeline en pause
  scrubbing,       // drag curseur en cours
}
```

- **Pause** : position = `playheadRatio × duration`
- **Lecture** : `video.currentTime` ; sync via `tickPlayback` (rAF)
- **Scrub drag** : visuel seulement (`applyScrubRatio`, pas de seek)
- **Scrub relâchement** : overlay à jour + `seekVideoTo` si vidéo en pause
- **Play** : `resetScrubState()` → seek si besoin **en pause** → `video.play()`

### Modèle mental backend

- `{id}.mov` (ou `.mp4`) — **source export**
- `{id}.preview.mp4` — **lecteur HTML5** (MOV/M4V/HEVC)
- Export : toujours `_source_video_path()` (exclut `.preview.mp4`)
- 1 keyframe → `-vf` ; N keyframes → `filter_complex` (segments ~0,15 s)

### Pièges connus (ne pas réintroduire)

1. **MOV + Firefox** : seek KO sur MOV natif → preview MP4 (`build_browser_preview`).
2. **`<input type="range">`** : events `input` + `timeupdate` = boucle de seek → timeline CSS + listeners `document`.
3. **Seek pendant `play()`** : image figée Firefox → seek **en pause**, puis `play()`.
4. **`await waitForSeek()`** sur clic play : bloque si `seeked` ne fire pas → interdit.
5. **Glob `{video_id}.*`** : exclure `.preview.mp4` pour l'export.
6. **Serveurs multiples** (8765/9876/9877) : ancienne API, badge « Serveur obsolète ».
7. **Cache** : bump `?v=` dans `index.html` ; `/app.js` en `no-cache`.

### Bug scrub résolu (contexte)

Symptôme : scrub bloque lecture, play inopérant, image figée, compteur bouge.

Diagnostic : **MP4 OK, MOV KO** (Firefox). Compteur bougeait car `paused === false` sans décodage frame (seek during play).

Fix : preview MP4 serveur + seek-before-play en pause côté client. Si bug réapparaît → tester **MP4 vs MOV** et **navigateur** avant de toucher au scrubber.

---

## Structure repo

```
recadrage/
├── run.py                 # uvicorn, vérif ports
├── backend/
│   ├── main.py            # API REST + static
│   ├── ffmpeg_utils.py    # ffprobe, filtres, export, preview
│   └── export_jobs.py     # export thread + logs
├── frontend/
│   ├── index.html
│   ├── app.js
│   └── styles.css
└── data/
    ├── uploads/           # {id}.mov + {id}.preview.mp4
    ├── exports/
    └── logs/
```

---

## Conventions

- **Minimal diff** — pas de refactor hors scope
- **Vanilla JS** — pas de framework, pas de npm
- **Crop** — coordonnées source (pixels vidéo post-rotation), pas canvas
- **API** — incrémenter `api_version` + seuil `checkServer()` si breaking change
- **Commits** — uniquement si demandé explicitement

---

## Workflow debug

1. `curl http://127.0.0.1:8765/api/health` → `api_version: 5`
2. Hard refresh, vérifier `app.js?v=…` dans le source
3. Un seul serveur : `lsof -ti :8765`
4. MOV : `{id}.preview.mp4` existe, `url` → `/preview`
5. Lecture : `togglePlayback`, `onScrubberPointerDown`, `onDocumentScrubEnd`, `getPlayheadTime`
6. Export : poll `/api/export/jobs/{id}` + `/log.txt`

---

## Checklist fin de tâche

- [ ] `api_version` cohérente si API change
- [ ] Bump `?v=` si JS/CSS modifié
- [ ] MOV : preview OK, export utilise source
- [ ] Pas de commit sauf demande explicite

---

## Tests manuels

1. MP4 : play → scrub → play
2. MOV (Firefox) : idem après réimport
3. 2+ keyframes : interpolation + export
4. Export identique → copie sans ré-encodage

---

## Historique

| Version | Changements |
|---------|-------------|
| v1 | MVP crop, export sync |
| v2–v3 | Export async, logs, layout 2 col., fix ratio/débit |
| v4 | Keyframes, interpolation, projets JSON, couleur bandes |
| v5 | Preview MOV→MP4, fix timeline Firefox |

## Pistes futures

- Preview rendu final temps réel
- Traitement par lot
