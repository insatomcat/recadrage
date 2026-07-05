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
| `GET /api/data/stats` | Fichiers et octets par dossier (`uploads`, `exports`, `logs`, `tmp`) |
| `POST /api/data/cleanup` | Vide les dossiers data ; 409 si export en cours |
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
- `_dir_stats` / `_clear_directory` — nettoyage disque

### `POST /api/export` — payload

| Champ | Défaut | Rôle |
|-------|--------|------|
| `video_id` | — | ID upload |
| `aspect_w`, `aspect_h` | — | Ratio cible |
| `keyframes[]` | — | `{ time, frame: { x, y, width, height } }` |
| `resolution_mode` | `source` | `source` \| `fit_aspect` |
| `pad_color` | `black` | Couleur bandes |
| `crf` | 23 | Qualité libx264 |
| `interpolate_keyframes` | `true` | Palier + fondu vs palier seul |
| `transition_sec` | 1.0 | Durée du fondu avant keyframe suivant |
| `export_start` | 0 | Début plage export (s, temps source) |
| `export_end` | `null` | Fin plage ; `null` ou fin vidéo = export complet |

### `backend/ffmpeg_utils.py`

| Fonction | Rôle |
|----------|------|
| `probe_video` | Dimensions **affichées** (rotation iPhone), durée, codec, bitrate |
| `needs_browser_preview` | True si `.mov`/`.m4v` ou codec ≠ H.264 |
| `build_browser_preview` | Remux H.264 → MP4 faststart, ou transcode libx264 |
| `build_reframe_filter` | Filtre `-vf` crop + scale + pad (1 keyframe, plage complète) |
| `build_reframe_filter_keyframes` | Segments `filter_complex` ; gère slice et interpolation |
| `_normalize_export_range` | Valide `export_start` / `export_end` |
| `_effective_export_keyframes` | Keyframes dans la plage + frame synthétique au début slice |
| `_clamp_segments_to_range` | Recadre les segments temporels |
| `_keyframe_interval_segments` | Palier + fondu découpé en sous-segments |
| `is_identity_export` | Détecte export sans changement → copie |
| `export_copy` | `-c copy` avec `-ss`/`-to` si slice |
| `export_video` | VideoToolbox puis libx264 ; `input_seek` si slice |

**Pipeline crop export** (single frame) :
```
crop → scale (force_original_aspect_ratio=decrease) → pad (bandes) → yuv420p
```

**Multi-keyframes / slice** :
```
split → [par segment] trim → setpts → [pad source] → crop → scale → pad → concat
```

- **Interpolation** : cadrage stable jusqu’à `transition_sec` avant le keyframe suivant, puis fondu découpé (~25 sous-segments/s, plafond global `MAX_EXPORT_SEGMENTS = 200`) — nécessaire car ffmpeg n’interpole **x/y** que par frame et fige **w/h** à l’init du crop.
- **Plage partielle** : retourne `input_seek = export_start` ; segments et `atrim` en temps **relatifs** `[0, export_end − export_start]` ; `export_video` ajoute `-ss` avant `-i` et `-ignore_editlist 1`.

Dimensions paires obligatoires (`_even`, `_even_pos`).

### `backend/export_jobs.py`

- Thread daemon par export
- État en mémoire `_jobs` + log append-only `data/logs/{job_id}.log`
- Progress via parsing stderr ffmpeg (`time=`, `frame=`, etc.)
- Réponse status inclut `log[]` ; frontend poll + fetch `log.txt`
- `has_active_exports()` — bloque cleanup si `pending`/`running`
- `clear_jobs_registry()` — après cleanup disque

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

data/tmp/                 # réservé (vidé par cleanup)
```

---

## Frontend

### Fichiers

- `index.html` — layout 2 colonnes : stage vidéo + sidebar contrôles/logs
- `styles.css` — variables CSS, stage plein écran, timeline, slice handles
- `app.js` — monolithe : état, API, overlay canvas, keyframes, slice, export poll, cleanup

### Layout UI

```
┌────────────────────────────┬──────────────────┐
│  stage (video + canvas)    │  aspect ratio    │
│                            │  interpolation   │
│                            │  keyframes list  │
│                            │  export + logs   │
├────────────────────────────┤                  │
│  ▶  00:00 ║slice║══●──  │                  │
│  Export : 1:00 → 8:00    │                  │
└────────────────────────────┴──────────────────┘

Toolbar : Ouvrir | Sauver | Charger | Nettoyer | nom fichier
```

### Coordonnées

- **Source** : pixels vidéo (espace ffprobe post-rotation)
- **Display** : mapping letterbox via `getDisplayRect()` + `sourceToDisplay` / `displayToSource`
- Overlay canvas : zone semi-transparente + trou (evenodd) sur le crop

### Keyframes

```javascript
{ id: string, time: number, frame: { x, y, width, height } }
```

- `getFrameAtTime(t)` — palier + fondu (`keyframeInterpRatio`) si interpolation cochée
- `+ Ici` — ajoute keyframe à `getPlayheadTime()`
- Drag overlay — crée/édite keyframe actif au time courant
- Minimum 1 keyframe

### Plage export (slice)

- Poignées `#slice-in-handle` / `#slice-out-handle` sur `#scrubber-wrap`
- Masques grisés hors plage ; bande `#slice-range` sur la zone exportée
- `MIN_SLICE_SEC = 0.5`
- `buildExportPayload()` / `buildProject()` envoient `export_start`, `export_end`
- Drag slice : listeners `document` (comme scrub) ; `stopPropagation` sur handles

### Timeline / lecture

Composants :
- `#scrubber-wrap` — zone cliquable (role=slider)
- `#scrubber-fill` / `#scrubber-thumb` — indicateur visuel CSS
- **Pas** de `<input type="range">` (historique de bugs Safari/Firefox)

Flux scrub :
```
pointerdown (wrap, pas .slice-handle)
  → scrubbing=true, pause si lecture
  → bind document pointermove/up
  → applyScrubRatio (visuel, updateOverlay:false)

pointerup (document)
  → seekVideoTo si paused
```

Flux play (`togglePlayback`) :
```
resetScrubState()
si paused → video.currentTime = playheadRatio × duration
video.play()
```

### Projet JSON (`.recadrage.json`, version 2)

Contient métadonnées et cadrages — **pas** le fichier vidéo.

| Champ | Rôle |
|-------|------|
| `video_id` | ID serveur (optionnel si vidéo absente) |
| `source_filename` | Nom fichier pour match à l’upload |
| `keyframes[]` | Cadrages |
| `aspect_*`, `resolution_mode`, `crf`, `pad_color` | Paramètres export |
| `interpolate_keyframes`, `transition_sec` | Interpolation |
| `export_start`, `export_end` | Plage slice |

**Chargement** :
- Vidéo présente → `GET /api/videos/{video_id}` puis `applyProjectSettings`
- Vidéo absente → `pendingProject` + message d’accueil ; à l’upload, match `filenamesMatch(source_filename, fichier)`

### Nettoyage disque

- Bouton **Nettoyer** → `GET /api/data/stats` → confirm → `POST /api/data/cleanup`
- `resetAppAfterCleanup()` : UI accueil, état vidéo/keyframes/slice effacé

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

Export identique (plein cadre, ratio source, 1 keyframe, plage complète) → **stream copy** (`export_copy`).

Audio :
- Plage complète, pas de filtre audio → `-c:a copy`
- Plage partielle (`atrim` dans filtergraph) → **`-c:a aac -b:a 192k`** (streamcopy interdit après filtre)

Entrée MOV slice : `-ignore_editlist 1` + `-ss export_start` avant `-i`.

---

## Versionning & cache

| Signal | Valeur actuelle |
|--------|-----------------|
| `api_version` | 5 |
| Frontend check | `version >= 5` dans `checkServer()` |
| Cache bust | `app.js?v=35`, `styles.css?v=10` |
| Projet JSON | `version: 2` |

Après modif JS/CSS : **incrémenter `?v=`** et dire à l’utilisateur Cmd+Shift+R.

---

## Diagramme export

```
POST /api/export { video_id, keyframes, export_start, export_end, ... }
        │
        ▼
start_export (thread)
        │
        ├─ is_identity_export? ──yes──► export_copy (-ss/-to si slice)
        │
        └─ no ──► build_reframe_filter_keyframes
                    │  (keyframes effectifs, segments relatifs si slice)
                    │  → input_seek, audio_filter, filter_complex
                    ▼
              export_video (ffmpeg -ss … -i … -filter_complex …)
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

## Évolutions prévues

- Preview rendu final live (non trivial : wasm-canvas ou stream transcodé)
- Batch processing
- Raccourcis I/O pour les poignées slice
