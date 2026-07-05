# Recadrage

Application web locale pour recadrer ou reframer une vidéo (crop + bandes) avec aperçu graphique et export ffmpeg.

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

1. **Ouvrir une vidéo** (MP4 ou MOV) — ou **Charger** un projet JSON puis ouvrir la vidéo correspondante
2. Choisir un **aspect ratio** (ratio initial, presets, ou personnalisé)
3. Ajuster le cadre en déplaçant les **coins** (crop ou bandes) ou le **centre**
4. **Ajouter des cadrages** (`+ Ici`) à différents moments
5. Optionnel : **Interpolation** et durée **Fondu** (transition vers le cadrage suivant)
6. Optionnel : resserrer la **plage export** avec les poignées vert (début) et rouge (fin) sur la timeline
7. Naviguer dans la timeline, **Exporter**
8. **Sauver** le projet `.recadrage.json` (cadrages + réglages ; la vidéo reste sur le serveur)

### Barre d’outils

| Action | Description |
|--------|-------------|
| Ouvrir | Importer MP4 / MOV |
| Sauver | Télécharger le projet JSON (vidéo chargée requise) |
| Charger | Restaurer un projet ; fonctionne même si la vidéo n’est pas encore sur le serveur |
| Nettoyer | Supprimer tous les fichiers locaux (imports, exports, logs) après confirmation |

## Options

| Option | Description |
|--------|-------------|
| Ratio initial | Conserve le ratio de la vidéo source |
| Canvas source | Sortie à la résolution source, bandes si besoin |
| Adapter au ratio | Sortie dimensionnée au ratio choisi |
| Bandes | Couleur des bandes (défaut : noir) |
| CRF | Qualité vidéo (23 par défaut ; plus bas = meilleure qualité) |
| Interpolation | Cadrage stable puis fondu vers le keyframe suivant (preview + export) |
| Fondu | Durée du fondu en secondes (grisé si interpolation désactivée) |
| Plage export | Poignées sur la timeline ; label « Export : début → fin » si plage réduite |

## Projets JSON

Le fichier `.recadrage.json` contient les cadrages, le ratio, la plage export, etc. Il référence la vidéo par `video_id` et `source_filename`.

- Si la vidéo est encore sur le serveur (même session), le projet se charge directement.
- Sinon, chargez le JSON puis ouvrez le fichier vidéo original : l’app reconnaît le nom et applique les cadrages.

## Fichiers locaux

Tout est stocké dans `data/` :

- `uploads/` — vidéos importées et previews navigateur
- `exports/` — fichiers exportés
- `logs/` — journaux ffmpeg

Le bouton **Nettoyer** vide ces dossiers (impossible pendant un export en cours).

## Architecture

- **Backend** : FastAPI v5 + ffprobe/ffmpeg (subprocess, export async)
- **Frontend** : HTML/CSS/JS vanilla, layout plein écran deux colonnes
- **Docs techniques** : [AGENTS.md](AGENTS.md) (contexte agent) · [ARCHITECTURE.md](ARCHITECTURE.md)

## Fonctionnalités principales

- **Cadrages multiples** avec interpolation (palier + fondu configurable)
- **Plage export** limitée par des ancres début/fin sur la timeline
- **Sauvegarde / chargement** de projet JSON (avec reprise par nom de fichier)
- **Couleur des bandes** configurable
- Export sans ré-encodage si aucun changement (copie directe)
- Encodage calé sur le débit source (VideoToolbox sur macOS)
- **Aperçu MOV** : conversion automatique en MP4 navigateur (l’original sert à l’export)
- **Nettoyage disque** en un clic

## Pistes futures

- Preview rendu final en direct dans le lecteur
- Traitement par lot
- Raccourcis clavier pour les ancres export (I/O)
