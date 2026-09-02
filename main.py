import os
import re
import httpx
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import StreamingResponse
from telethon import TelegramClient
from telethon.sessions import StringSession
from telethon.tl.types import MessageMediaDocument

# Identifiants Render
API_ID = int(os.environ.get("API_ID"))
API_HASH = os.environ.get("API_HASH")
SESSION_STRING = os.environ.get("SESSION_STRING")

app = FastAPI(title="NLSbox Pro Engine")

client = TelegramClient(StringSession(SESSION_STRING), API_ID, API_HASH)

@app.on_event("startup")
async def startup():
    await client.start()
    print(" Connecté à Telegram !")

@app.on_event("shutdown")
async def shutdown():
    await client.disconnect()

# --- FONCTION POUR RÉCUPÉRER L'AFFICHE ET LES INFOS OFFICIELLES ---
async def fetch_anime_metadata(query: str):
    """Récupère les infos officielles (affiche HD, résumé, note) depuis AniList"""
    graphql_query = """
    query ($search: String) {
        Media (search: $search, type: ANIME) {
            title {
                romaji
                english
            }
            coverImage {
                extraLarge
                large
            }
            bannerImage
            description(asHtml: false)
            averageScore
            genres
            episodes
            status
            seasonYear
        }
    }
    """
    try:
        async with httpx.AsyncClient(timeout=4.0) as http_client:
            response = await http_client.post(
                "https://graphql.anilist.co",
                json={"query": graphql_query, "variables": {"search": query}}
            )
            if response.status_code == 200:
                data = response.json().get("data", {}).get("Media", {})
                if data:
                    return {
                        "title": data.get("title", {}).get("english") or data.get("title", {}).get("romaji") or query,
                        "cover": data.get("coverImage", {}).get("extraLarge") or data.get("coverImage", {}).get("large"),
                        "banner": data.get("bannerImage"),
                        "synopsis": data.get("description", "Aucun résumé disponible."),
                        "score": f"{data.get('averageScore', 'N/A')}%",
                        "genres": data.get("genres", []),
                        "total_episodes_official": data.get("episodes"),
                        "year": data.get("seasonYear")
                    }
    except Exception:
        pass
    
    # Valeurs de secours si AniList ne répond pas
    return {
        "title": query.capitalize(),
        "cover": "https://via.placeholder.com/300x450.png?text=Anime",
        "banner": None,
        "synopsis": "Informations indisponibles.",
        "score": "N/A",
        "genres": [],
        "total_episodes_official": None,
        "year": None
    }

# --- STREAMING RAPIDE TELEGRAM ---
async def iter_file_chunks(message):
    async for chunk in client.iter_download(message.media, chunk_size=1024 * 512):
        yield chunk

@app.get("/")
def home():
    return {"status": "En ligne", "app": "NLSbox Backend Pro"}

# --- ROUTE DE RECHERCHE INSTANTANÉE ---
@app.get("/search")
async def search_anime(
    q: str = Query(..., description="Nom de l'anime recherché (ex: Solo Leveling, Naruto)"),
    channel: str = Query(..., description="ID ou @username du canal Telegram")
):
    try:
        target = int(channel) if channel.startswith("-") or channel.isdigit() else channel
        
        # 1. Récupération des infos officielles (affiche, résumé)
        metadata = await fetch_anime_metadata(q)
        
        # 2. Recherche instantanée des épisodes dans Telegram (côté serveur)
        episodes = []
        async for msg in client.iter_messages(target, search=q, limit=100):
            if msg.media and isinstance(msg.media, MessageMediaDocument):
                file_name = "Episode.mp4"
                doc = msg.media.document
                
                for attr in doc.attributes:
                    if hasattr(attr, 'file_name') and attr.file_name:
                        file_name = attr.file_name
                
                # Tente d'extraire le numéro d'épisode avec une Regex (ex: Ep 01, Episode 12, E05)
                ep_match = re.search(r'(?:ep|episode|e)[\s._-]*(\d+)', file_name, re.IGNORECASE)
                ep_number = int(ep_match.group(1)) if ep_match else None

                episodes.append({
                    "message_id": msg.id,
                    "episode_number": ep_number,
                    "title": msg.text if msg.text else file_name,
                    "file_name": file_name,
                    "size_mb": round(doc.size / (1024 * 1024), 2),
                    "stream_url": f"/download/{channel}/{msg.id}"
                })
        
        # Trie les épisodes par numéro d'épisode dans l'ordre croissant
        episodes.sort(key=lambda x: x["episode_number"] if x["episode_number"] is not None else 9999)

        return {
            "query": q,
            "anime_info": metadata,
            "episodes_found": len(episodes),
            "episodes": episodes
        }

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# --- ROUTE DE TÉLÉCHARGEMENT & STREAMING ---
@app.get("/download/{channel_id}/{message_id}")
async def download_file(channel_id: str, message_id: int):
    try:
        target = int(channel_id) if channel_id.startswith("-") or channel_id.isdigit() else channel_id
        message = await client.get_messages(target, ids=message_id)
        
        if not message or not message.media:
            raise HTTPException(status_code=404, detail="Fichier introuvable.")

        file_name = "anime.mp4"
        file_size = 0
        mime_type = "video/mp4"

        if isinstance(message.media, MessageMediaDocument):
            doc = message.media.document
            file_size = doc.size
            mime_type = doc.mime_type
            for attr in doc.attributes:
                if hasattr(attr, 'file_name') and attr.file_name:
                    file_name = attr.file_name

        headers = {
            "Content-Disposition": f'attachment; filename="{file_name}"',
            "Content-Length": str(file_size),
            "Content-Type": mime_type,
            "Accept-Ranges": "bytes"
        }

        return StreamingResponse(
            iter_file_chunks(message),
            headers=headers,
            media_type=mime_type
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
