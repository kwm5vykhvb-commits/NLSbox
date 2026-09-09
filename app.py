import os
import subprocess
import sys

def start_node_backend():
    print("[NLSbox] Démarrage du backend Node.js depuis app.py...")
    if not os.path.exists("node_modules"):
        print("[NLSbox] Installation des dépendances npm...")
        subprocess.run(["npm", "install"], check=False)

    if not os.path.exists("dist/server.cjs"):
        print("[NLSbox] Compilation de server.ts...")
        subprocess.run(["npm", "run", "build"], check=False)

    os.execvp("node", ["node", "dist/server.cjs"])

if __name__ == "__main__":
    start_node_backend()
