# Recadrage

Application web locale pour recadrer ou reframer une vidéo (crop + bandes noires) avec aperçu graphique et export ffmpeg.

## Prérequis

- Python 3.11+
- [ffmpeg](https://ffmpeg.org/) installé et disponible dans le `PATH`

## Installation

```bash
cd recadrage
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## Lancement

```bash
python run.py
```

Ouvrez [http://127.0.0.1:8765](http://127.0.0.1:8765).

Si le port est déjà pris :

```bash
for p in 8765 9876 9877; do kill $(lsof -ti :$p) 2>/dev/null; done
python run.py
```

## Utilisation

1. **Ouvrir une vidéo** (MP4 ou MOV)
2. Choisir un **aspect ratio** (ratio initial, presets, ou personnalisé)
3. Ajuster le cadre en déplaçant les **coins** (crop ou bandes noires) ou le **centre**
4. **Ajouter des cadrages** (`+ Ici`) à différents moments — interpolation automatique entre eux
5. Naviguer dans la timeline, **Exporter**
6. **Sauver / Charger** un projet `.recadrage.json` (la vidéo doit rester sur le serveur)

## Options

| Option | Description |
|--------|-------------|
| Ratio initial | Conserve le ratio de la vidéo source |
| Canvas source | Sortie à la résolution source, bandes noires si besoin |
| Adapter au ratio | Sortie dimensionnée au ratio choisi |
| Bandes | Couleur des bandes (défaut : noir) |
| CRF | Qualité vidéo (23 par défaut ; plus bas = meilleure qualité) |

## Architecture

- **Backend** : FastAPI v5 + ffprobe/ffmpeg (subprocess, export async)
- **Frontend** : HTML/CSS/JS vanilla, layout plein écran deux colonnes
- **Docs techniques** : [AGENTS.md](AGENTS.md) (contexte agent) · [ARCHITECTURE.md](ARCHITECTURE.md)

## Fonctionnalités v2

- **Cadrages multiples** avec interpolation linéaire entre keyframes
- **Sauvegarde / chargement** de projet JSON
- **Couleur des bandes** configurable
- Export sans ré-encodage si aucun changement (copie directe)
- Encodage calé sur le débit source (VideoToolbox sur macOS)
- **Aperçu MOV** : conversion automatique en MP4 navigateur (l'original sert à l'export)

## Pistes futures

- Preview rendu final en direct dans le lecteur
