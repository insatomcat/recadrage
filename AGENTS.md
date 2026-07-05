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

**Stack** : FastAPI, uvicorn, ffmpeg en subprocess. Frontend monolithique `frontend/app.js` (~1700 lignes), pas de build step.

**Langue** : répondre en **français** à l'utilisateur. UI en français.

---

## Lire en priorité

| Besoin | Fichier |
|--------|---------|
| Schémas, API, pipeline ffmpeg | `ARCHITECTURE.md` |
| Endpoints, upload, preview, nettoyage | `backend/main.py` |
| Filtres, encodage, preview MOV, slice export | `backend/ffmpeg_utils.py` |
| Export async, logs | `backend/export_jobs.py` |
| UI, timeline, keyframes, slice | `frontend/app.js` |
| Utilisateur final | `README.md` |

---

## Où modifier quoi

| Tâche | Fichier(s) |
|-------|------------|
| Nouvel endpoint API | `backend/main.py` |
| Filtre ffmpeg / encodage / plage export | `backend/ffmpeg_utils.py` |
| Progress export / logs | `backend/export_jobs.py` |
| UI, timeline, keyframes, slice | `frontend/app.js` |
| Layout / styles | `frontend/styles.css`, `frontend/index.html` |
| Cache bust navigateur | `index.html` (`app.js?v=`, `styles.css?v=`) |

---

## État actuel (v5)

### Fonctionnalités

- Import MP4/MOV, aperçu avec overlay crop draggable
- **Cadrages multiples** (keyframes) + interpolation preview/export (palier + fondu configurable)
- **Plage export** (slice) : poignées début/fin sur la timeline → `export_start` / `export_end`
- Timeline CSS custom (pas `<input type="range">`)
- Export async H.264 (VideoToolbox macOS → fallback libx264), copie directe si export identique
- Sauvegarde/chargement projet `.recadrage.json` (avec ou sans vidéo sur le serveur)
- Couleur des bandes configurable
- **Preview MOV** : MP4 dérivé pour le lecteur HTML5 ; original pour l'export
- **Nettoyer** : bouton toolbar → vide `uploads/`, `exports/`, `logs/`, `tmp/`

### Modèle mental frontend

```javascript
state = {
  video,           // métadonnées serveur ; video.url = /preview ou /file
  frame,           // crop courant (affichage)
  keyframes[],     // { id, time, frame }
  playheadRatio,   // 0–1, source de vérité timeline en pause
  scrubbing,       // drag curseur en cours
  sliceIn,         // début plage export (s, temps source)
  sliceOut,        // fin plage export (s) ; 0 ou > duration → fin vidéo
  sliceDragging,   // 'in' | 'out' | null
  pendingProject,  // JSON chargé sans vidéo correspondante
}
```

- **Pause** : position = `playheadRatio × duration`
- **Lecture** : `video.currentTime` ; sync via `tickPlayback` (rAF)
- **Scrub drag** : visuel seulement (`applyScrubRatio`, pas de seek)
- **Scrub relâchement** : overlay à jour + `seekVideoTo` si vidéo en pause
- **Play** : `resetScrubState()` → seek si besoin **en pause** → `video.play()`
- **Slice** : drag poignées vert/rouge ; label « Export : … » ; min 0,5 s ; ignoré au clic scrub si `.slice-handle`
- **Projet sans vidéo** : `pendingProject` + message d’accueil ; match par `source_filename` à l’upload

### Modèle mental backend

- `{id}.mov` (ou `.mp4`) — **source export**
- `{id}.preview.mp4` — **lecteur HTML5** (MOV/M4V/HEVC)
- Export : toujours `_source_video_path()` (exclut `.preview.mp4`)
- 1 keyframe, plage complète → `-vf` ; sinon → `filter_complex` (segments, plafond `MAX_EXPORT_SEGMENTS = 200`)
- **Interpolation export** : palier stable puis fondu sur `transition_sec` avant chaque keyframe suivant ; fondu découpé en sous-segments (~25/s) car ffmpeg n’anime que **x/y** du crop (w/h figés par segment)
- **Plage partielle** : `-ss export_start` avant `-i` ; `trim`/`atrim` **relatifs** (0 → durée slice) ; audio filtré → **AAC** (pas `-c:a copy`) ; `-ignore_editlist 1` sur entrée MOV

### Pièges connus (ne pas réintroduire)

1. **MOV + Firefox** : seek KO sur MOV natif → preview MP4 (`build_browser_preview`).
2. **`<input type="range">`** : events `input` + `timeupdate` = boucle de seek → timeline CSS + listeners `document`.
3. **Seek pendant `play()`** : image figée Firefox → seek **en pause**, puis `play()`.
4. **`await waitForSeek()`** sur clic play : bloque si `seeked` ne fire pas → interdit.
5. **Glob `{video_id}.*`** : exclure `.preview.mp4` pour l'export.
6. **Serveurs multiples** (8765/9876/9877) : ancienne API, badge « Serveur obsolète ».
7. **Cache** : bump `?v=` dans `index.html` ; `/app.js` en `no-cache`.
8. **Crop dynamique `t` / expressions `n` sur w/h** : export H.264 incohérent ou zoom d’un coup → segments à crop fixe.
9. **Slice + timestamps absolus dans filter** sans `-ss` : erreurs MOV edit list ; **audio `atrim` + `-c:a copy`** : ffmpeg refuse (filtergraph).
10. **Champs export** : passer `interpolate_keyframes`, `transition_sec`, `export_start`, `export_end` de `main.py` → `start_export` (sinon fondus/plage ignorés).

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
    ├── logs/
    └── tmp/               # réservé ; vidé par « Nettoyer »
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
6. Export : poll `/api/export/jobs/{id}` + `/log.txt` ; log « Plage export : … » si slice
7. Nettoyage : `GET /api/data/stats` puis `POST /api/data/cleanup` (409 si export en cours)

---

## Checklist fin de tâche

- [ ] `api_version` cohérente si API change
- [ ] Bump `?v=` si JS/CSS modifié
- [ ] MOV : preview OK, export utilise source
- [ ] Slice : offsets relatifs + `input_seek` si plage partielle
- [ ] Pas de commit sauf demande explicite

---

## Tests manuels

1. MP4 : play → scrub → play
2. MOV (Firefox) : idem après réimport
3. 2+ keyframes : interpolation on/off + export
4. Export identique → copie sans ré-encodage
5. Slice partiel (début ≠ 0) : export OK, durée et audio sync
6. Projet JSON sans vidéo → upload fichier correspondant → cadrages restaurés
7. Nettoyer : confirmation, UI reset, réimport possible

---

## Historique

| Version | Changements |
|---------|-------------|
| v1 | MVP crop, export sync |
| v2–v3 | Export async, logs, layout 2 col., fix ratio/débit |
| v4 | Keyframes, interpolation, projets JSON, couleur bandes |
| v5 | Preview MOV→MP4, fix timeline Firefox |
| v5+ | Palier+fondu export, slice timeline, projets pending, nettoyage disque, fix offsets slice |

## Pistes futures

- Preview rendu final temps réel
- Traitement par lot
- Raccourcis I/O ou « Début/Fin = playhead » pour le slice
