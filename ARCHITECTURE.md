# ARCHITECTURE.md — Recadrage

## Vue d’ensemble

```
┌─────────────────────────────────────────────────────────────┐
│  Navigateur (Firefox / Safari / Chrome)                       │
│  ┌──────────────┐    fetch REST     ┌─────────────────────┐ │
│  │ frontend/    │ ◄──────────────► │ backend/main.py      │ │
│  │ app.js       │                   │ FastAPI + StaticFiles│ │
│  │ canvas overlay│                  └──────────┬──────────┘ │
│  │ <video>      │                              │            │
│  └──────────────┘                              │ subprocess │
└────────────────────────────────────────────────│────────────┘
                                                 ▼
                                    ffprobe / ffmpeg (local)
```

Application **100 % locale** : pas d’auth, pas de cloud. Les vidéos restent dans `data/uploads/`.

---

## Backend

### `backend/main.py`

Point d’entrée FastAPI. Monte le frontend en statique sur `/`.

| Route | Rôle |
|-------|------|
| `GET /api/health` | `{ status, api_version: 5, logs_dir }` |
| `POST /api/upload` | Enregistre `{uuid}.{ext}`, probe, preview MOV si besoin |
| `GET /api/videos/{id}` | Métadonnées + `url` playback (+ génère preview lazy) |
| `GET /api/videos/{id}/file` | Fichier source original |
| `GET /api/videos/{id}/preview` | MP4 navigateur (`{id}.preview.mp4`) |
| `POST /api/export` | Lance job async → `{ job_id }` |
| `GET /api/export/jobs/{id}` | Statut + log inline |
| `GET /api/export/jobs/{id}/log.txt` | Log brut (préféré par le frontend) |
| `GET /api/exports/{id}/file` | Téléchargement export |

Helpers internes :
- `_source_video_path(id)` — glob `{id}.*` **sans** `.preview.mp4`
- `_preview_path(id)` — `{id}.preview.mp4`
- `_playback_url(id)` — preview si existe, sinon file

### `backend/ffmpeg_utils.py`

| Fonction | Rôle |
|----------|------|
| `probe_video` | Dimensions **affichées** (rotation iPhone), durée, codec, bitrate |
| `needs_browser_preview` | True si `.mov`/`.m4v` ou codec ≠ H.264 |
| `build_browser_preview` | Remux H.264 → MP4 faststart, ou transcode libx264 |
| `build_reframe_filter` | Filtre `-vf` crop + scale + pad (1 keyframe) |
| `build_reframe_filter_keyframes` | 1 kf → `-vf` ; N kf → `filter_complex` |
| `is_identity_export` | Détecte export sans changement → copie |
| `export_copy` | `-c copy -movflags +faststart` |
| `export_video` | VideoToolbox (macOS) puis fallback libx264 ; bitrate calé source |

**Pipeline crop export** (single frame) :
```
crop → scale (force_original_aspect_ratio=decrease) → pad (bandes) → yuv420p
```

**Multi-keyframes** : découpage temporal ~0,15 s, crop statique ou interpolé par segment, `concat=unsafe=1`.

Dimensions paires obligatoires (`_even`, `_even_pos`).

### `backend/export_jobs.py`

- Thread daemon par export
- État en mémoire `_jobs` + log append-only `data/logs/{job_id}.log`
- Progress via parsing stderr ffmpeg (`time=`, `frame=`, etc.)
- Réponse status inclut `log[]` ; frontend poll + fetch `log.txt`

---

## Stockage fichiers

```
data/uploads/
  abc123.mov              # original (export)
  abc123.preview.mp4      # lecteur HTML5 (MOV/M4V/HEVC)

data/exports/
  def456.mp4              # export final

data/logs/
  job789.log              # stdout/stderr ffmpeg
```

---

## Frontend

### Fichiers

- `index.html` — layout 2 colonnes : stage vidéo + sidebar contrôles/logs
- `styles.css` — variables CSS, stage plein écran, timeline
- `app.js` — monolithe : état, API, overlay canvas, keyframes, export poll

### Layout UI

```
┌────────────────────────────┬──────────────────┐
│  stage (video + canvas)    │  aspect ratio    │
│                            │  keyframes list  │
│                            │  export + logs   │
├────────────────────────────┤                  │
│  ▶  00:00 ═══●────  03:42  │                  │
└────────────────────────────┴──────────────────┘
```

### Coordonnées

- **Source** : pixels vidéo (espace ffprobe post-rotation)
- **Display** : mapping letterbox via `getDisplayRect()` + `sourceToDisplay` / `displayToSource`
- Overlay canvas : zone semi-transparente + trou (evenodd) sur le crop

### Keyframes

```javascript
{ id: string, time: number, frame: { x, y, width, height } }
```

- `getFrameAtTime(t)` — interpolation linéaire entre keyframes triés
- `+ Ici` — ajoute keyframe à `getPlayheadTime()`
- Drag overlay — crée/édite keyframe actif au time courant
- Minimum 1 keyframe

### Timeline / lecture (design actuel v25+)

Composants :
- `#scrubber-wrap` — zone cliquable (role=slider)
- `#scrubber-fill` / `#scrubber-thumb` — indicateur visuel CSS
- **Pas** de `<input type="range">` (historique de bugs Safari/Firefox)

Flux scrub :
```
pointerdown (wrap)
  → scrubbing=true, pause si lecture
  → bind document pointermove/up
  → applyScrubRatio (visuel, updateOverlay:false)

pointermove
  → scheduleScrubPreview (rAF, visuel only)

pointerup (document)
  → scrubbing=false, unbind
  → applyScrubRatio (updateOverlay:true)
  → seekVideoTo si paused
```

Flux play (`togglePlayback`) :
```
resetScrubState()
si paused:
  target = playheadRatio × duration
  si |currentTime - target| > ε → video.currentTime = target  (en pause)
  video.play()
```

Boucle lecture : `tickPlayback` via rAF sur event `playing` ; sync `playheadRatio` depuis `currentTime`.

### Projet JSON (`.recadrage.json`)

Contient `video_id`, keyframes, aspect, etc. **Pas** le fichier vidéo.

Chargement : `GET /api/videos/{video_id}` pour résoudre `url` (preview vs file).

---

## Preview MOV — pourquoi

| Problème | Cause |
|----------|--------|
| Scrub/play cassé sur MOV | Firefox gère mal seek QuickTime (edit lists, HEVC, moov) |
| MP4 OK | Conteneur + faststart compatibles |

Solution :
1. Upload MOV → `build_browser_preview` → `{id}.preview.mp4`
2. Frontend `video.src = url` (preview)
3. Export lit `{id}.mov` via `_source_video_path`

Preview H.264 in MOV : `-c copy -movflags +faststart`.  
Preview HEVC/ProRes : transcode `libx264 veryfast crf 23`.

---

## Encodage export

Priorité macOS :
1. **VideoToolbox** (`h264_videotoolbox`) avec `-q:v` / bitrate source
2. Fallback **libx264** CRF + maxrate ~1,5× source

Export identique (plein cadre, ratio source, 1 keyframe) → **stream copy** sans ré-encodage.

Audio : `-c:a copy` (ou AAC si transcode preview seulement).

---

## Versionning & cache

| Signal | Valeur actuelle |
|--------|-----------------|
| `api_version` | 5 |
| Frontend check | `version >= 5` dans `checkServer()` |
| Cache bust | `app.js?v=26`, `styles.css?v=5` |
| `run.py` banner | affiche encore « v4 » (cosmétique) |

Après modif JS/CSS : **incrémenter `?v=`** et dire à l’utilisateur Cmd+Shift+R.

---

## Diagramme export

```
POST /api/export { video_id, keyframes, aspect_w/h, ... }
        │
        ▼
start_export (thread)
        │
        ├─ is_identity_export? ──yes──► export_copy
        │
        └─ no ──► build_reframe_filter_keyframes
                    │
                    ▼
              export_video (ffmpeg)
                    │
                    ▼
              data/exports/{id}.mp4
                    │
        GET /api/export/jobs/{job_id}  (poll)
        GET /api/export/jobs/{job_id}/log.txt
```

---

## Dépendances

```
requirements.txt  → fastapi, uvicorn, python-multipart
Système           → ffmpeg, ffprobe
```

Pas de Node/npm pour le frontend.

---

## Évolutions prévues (README)

- Preview rendu final live (non trivial : nécessiterait wasm-canvas ou stream transcodé)
- Batch processing
