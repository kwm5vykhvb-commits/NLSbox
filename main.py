import os
import re
from fastapi import FastAPI, HTTPException, Request, Query
from fastapi.responses import StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from pyrogram import Client

app = FastAPI(title="NLSbox Anime Streaming API (User Session)")

# Autoriser les requêtes (Mobile, Web, Local)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Configuration depuis les variables d'environnement de Render
API_ID = int(os.getenv("API_ID", "0"))
API_HASH = os.getenv("API_HASH", "")
SESSION_STRING = os.getenv("SESSION_STRING", "")

# Initialisation du client Utilisateur Telegram avec Session String
user_bot = Client(
    "nlsbox_user",
    api_id=API_ID,
    api_hash=API_HASH,
    session_string=SESSION_STRING,
    in_memory=True
)

@app.on_event("startup")
async def startup_event():
    if not user_bot.is_connected:
        await user_bot.start()
        me = await user_bot.get_me()
        print(f" Connecté avec succès au compte Telegram : {me.first_name} (@{me.username or me.id})")

@app.get("/")
def root():
    return {
        "status": "En ligne",
        "mode": "User Session String",
        "message": "API de recherche et streaming Telegram opérationnelle !"
    }

@app.get("/catalog/{channel_id}")
@app.get("/search/{channel_id}")
async def search_channel(
    channel_id: str,
    q: str = Query(default="", description="Mot-clé de recherche"),
    limit: int = Query(default=100, description="Nombre max d'épisodes à scanner")
):
    """
    RECHERCHE PAR MOT-CLÉ :
    Tapez un nom d'animé (ex: Jujutsu, One Piece, 01) et récupérez tous les fichiers vidéos correspondants.
    """
    clean = channel_id.strip().lstrip("@")
    # Gère les ID numériques de canaux privés (-100xxxxxxx) ou les usernames publics
    target = int(clean) if (clean.startswith("-100") or clean.isdigit() or clean.startswith("-")) else clean

    episodes = []
    try:
        # Parcours l'historique du canal Telegram avec votre compte utilisateur
        async for msg in user_bot.get_chat_history(target, limit=limit):
            if msg.video or (msg.document and msg.document.mime_type and msg.document.mime_type.startswith("video")):
                media = msg.video or msg.document
                file_name = getattr(media, "file_name", "") or f"video_{msg.id}.mp4"
                caption = msg.caption or ""
                
                search_haystack = f"{file_name} {caption}".lower()
                
                # Filtrage selon le mot-clé tapé par l'utilisateur
                if not q or q.strip().lower() in search_haystack:
                    size_mb = round((media.file_size or 0) / (1024 * 1024), 2)
                    
                    # Titre propre tiré de la légende ou du nom de fichier
                    title = caption.split("\n")[0] if caption else file_name.rsplit(".", 1)[0].replace("_", " ")
                    
                    # Détection de la qualité
                    quality = "1080p" if "1080" in search_haystack else ("720p" if "720" in search_haystack else "HD")
                    
                    episodes.append({
                        "message_id": msg.id,
                        "title": title,
                        "file_name": file_name,
                        "size_mb": size_mb,
                        "download_url": f"/download/{clean}/{msg.id}",
                        "quality": quality,
                        "date_added": msg.date.strftime("%d/%m/%Y") if msg.date else "Récent"
                    })
                    
        return {
            "channel": clean,
            "query": q,
            "total_found": len(episodes),
            "episodes": episodes
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur Telegram ({type(e).__name__}): {str(e)}")

@app.get("/download/{channel_id}/{message_id}")
async def stream_media(channel_id: str, message_id: int, request: Request):
    """
    STREAMING VIDÉO FLUIDE :
    Diffuse directement la vidéo depuis Telegram vers le lecteur vidéo sans attendre.
    """
    clean = channel_id.strip().lstrip("@")
    target = int(clean) if (clean.startswith("-100") or clean.isdigit() or clean.startswith("-")) else clean

    try:
        msg = await user_bot.get_messages(target, message_id)
        if not msg or not (msg.video or msg.document):
            raise HTTPException(status_code=404, detail="Aucun fichier vidéo trouvé dans ce message")

        media = msg.video or msg.document
        file_size = media.file_size or 0
        file_name = getattr(media, "file_name", f"anime_{message_id}.mp4")

        # Streaming par morceaux (chunks) avec Pyrogram
        async def video_streamer():
            async for chunk in user_bot.stream_media(msg):
                yield chunk

        headers = {
            "Content-Disposition": f'inline; filename="{file_name}"',
            "Accept-Ranges": "bytes",
            "Content-Length": str(file_size),
            "Content-Type": "video/mp4",
        }

        return StreamingResponse(
            video_streamer(),
            headers=headers,
            media_type="video/mp4"
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur de streaming: {str(e)}")
