import os
import subprocess
import sys

# Compatibilité Render : Si le Web Service Render a été créé avec l'environnement Python
# et tente d'exécuter "python main.py", ce script démarre immédiatement le backend Node.js.
def start_node_backend():
    print("[NLSbox] Démarrage du backend Node.js depuis main.py...")
    # Vérifie si node_modules existe
    if not os.path.exists("node_modules"):
        print("[NLSbox] Installation des dépendances npm...")
        subprocess.run(["npm", "install"], check=False)

    # Vérifie si le fichier compilé dist/server.cjs existe
    if not os.path.exists("dist/server.cjs"):
        print("[NLSbox] Compilation de server.ts...")
        subprocess.run(["npm", "run", "build"], check=False)

    # Remplace le processus Python par le serveur Node.js compilé
    os.execvp("node", ["node", "dist/server.cjs"])

if __name__ == "__main__":
    start_node_backend()
