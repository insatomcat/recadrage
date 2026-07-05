"""Point d'entrée pour lancer le serveur Recadrage."""

import os
import socket
import sys

import uvicorn


def _port_in_use(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        return sock.connect_ex(("127.0.0.1", port)) == 0


def _other_recadrage_ports(exclude: int) -> list[int]:
    import subprocess

    busy: list[int] = []
    for candidate in (8765, 9876, 9877, 9878):
        if candidate == exclude:
            continue
        if _port_in_use(candidate):
            busy.append(candidate)
    if not busy:
        return busy

    for candidate in busy:
        try:
            result = subprocess.run(
                ["lsof", "-ti", f":{candidate}"],
                capture_output=True,
                text=True,
                check=False,
            )
            pids = [p.strip() for p in result.stdout.splitlines() if p.strip()]
            if pids:
                print(f"  port {candidate} → PID {', '.join(pids)}")
        except OSError:
            print(f"  port {candidate} occupé")
    return busy


def main() -> None:
    port = int(os.environ.get("PORT", "8765"))

    if _port_in_use(port):
        print(f"ERREUR : le port {port} est déjà utilisé par un autre processus.")
        print(f"  for p in 8765 9876 9877; do kill $(lsof -ti :$p) 2>/dev/null; done")
        print(f"  puis relancez : python run.py")
        print(f"  (ou : PORT={port + 1} python run.py)")
        sys.exit(1)

    others = _other_recadrage_ports(port)
    if others:
        print("ATTENTION : d'autres serveurs Recadrage tournent encore :")
        print(f"  for p in {' '.join(str(p) for p in others)}; do kill $(lsof -ti :$p) 2>/dev/null; done")
        print(f"  Ouvrez bien http://127.0.0.1:{port} (pas un autre port).")

    print(f"Recadrage v5 — http://127.0.0.1:{port}")
    print("Hard refresh navigateur : Cmd+Shift+R")
    uvicorn.run(
        "backend.main:app",
        host="127.0.0.1",
        port=port,
        reload=False,
    )


if __name__ == "__main__":
    main()
