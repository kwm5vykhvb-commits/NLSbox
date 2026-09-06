import os
import re
import httpx
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from telethon import TelegramClient
from telethon.sessions import StringSession
from telethon.tl.types import MessageMediaDocument

API_ID = int(os.environ.get("API_ID"))
API_HASH = os.environ.get("API_HASH")
SESSION_STRING = os.environ.get("SESSION_STRING")

app = FastAPI(title="NLSbox Pro Engine - FIXED")

client = TelegramClient(StringSession(SESSION_STRING), API_ID, API_HASH)

@app.on_event("startup")
async def startup():
    await client.start()
    print(" Connecté à Telegram !")

@app.on_event("shutdown")
async def shutdown():
    await client.disconnect()

# --- METADATA AniList (ton code gardé) ---
async def fetch_anime_metadata(query: str):
    graphql_query = """
    query ($search: String) {
        Media (search: $search, type: ANIME) {
            title { romaji english }
            coverImage { extraLarge large }
            bannerImage
            description(asHtml: false)
            averageScore genres episodes status seasonYear
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
    return {
        "title": query.capitalize(),
        "cover": "https://via.placeholder.com/300x450.png?text=Anime",
        "banner": None, "synopsis": "Informations indisponibles.",
        "score": "N/A", "genres": [], "total_episodes_official": None, "year": None
    }

@app.get("/")
def home():
    return {"status": "En ligne FIXED - Range OK", "app": "NLSbox Backend Pro"}

@app.get("/search")
async def search_anime(q: str = Query(...), channel: str = Query(...)):
    try:
        target = int(channel) if channel.startswith("-") or channel.isdigit() else channel
        metadata = await fetch_anime_metadata(q)
        episodes = []
        async for msg in client.iter_messages(target, search=q, limit=100):
            if msg.media and isinstance(msg.media, MessageMediaDocument):
                file_name = "Episode.mp4"
                doc = msg.media.document
                for attr in doc.attributes:
                    if hasattr(attr, 'file_name') and attr.file_name:
                        file_name = attr.file_name
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
        episodes.sort(key=lambda x: x["episode_number"] if x["episode_number"] is not None else 9999)
        return {"query": q, "anime_info": metadata, "episodes_found": len(episodes), "episodes": episodes}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# --- FIX CRITIQUE DU TELECHARGEMENT 0kb ---
@app.get("/download/{channel_id}/{message_id}")
async def download_file(channel_id: str, message_id: int, request: Request):
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
            mime_type = doc.mime_type or "video/mp4"
            for attr in doc.attributes:
                if hasattr(attr, 'file_name') and attr.file_name:
                    file_name = attr.file_name

        # Nettoyage nom fichier pour éviter crash headers
        safe_name = re.sub(r'[^\x20-\x7E]', '_', file_name).replace('"', '_')[:100]

        # --- GESTION DU RANGE HEADER (C'est ça qui fix le 0kb et le seek) ---
        range_header = request.headers.get("range")
        start = 0
        end = file_size - 1
        status_code = 200

        if range_header:
            # Ex: bytes=0-1048575 ou bytes=1048576-
            match = re.match(r"bytes=(\d*)-(\d*)", range_header)
            if match:
                s, e = match.groups()
                if s:
                    start = int(s)
                if e:
                    end = int(e)
                else:
                    end = file_size - 1
                if start >= file_size:
                    raise HTTPException(status_code=416, detail="Range Not Satisfiable")
                status_code = 206

        content_length = end - start + 1

        # Le générateur qui ne charge JAMAIS tout en RAM
        async def file_iterator():
            offset = start
            # On télécharge par chunk de 512KB en partant de offset
            async for chunk in client.iter_download(message.media, offset=offset, chunk_size=1024*512, request_size=1024*512):
                # Si on dépasse la fin demandée, on coupe
                if offset + len(chunk) > end + 1:
                    yield chunk[: end + 1 - offset]
                    break
                yield chunk
                offset += len(chunk)
                if offset > end:
                    break

        headers = {
            "Content-Disposition": f'inline; filename="{safe_name}"',
            "Content-Length": str(content_length),
            "Content-Type": mime_type,
            "Accept-Ranges": "bytes",
            "Cache-Control": "no-cache",
        }
        if status_code == 206:
            headers["Content-Range"] = f"bytes {start}-{end}/{file_size}"

        return StreamingResponse(
            file_iterator(),
            status_code=status_code,
            headers=headers,
            media_type=mime_type
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
