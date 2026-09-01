import os
from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from telethon import TelegramClient
from telethon.sessions import StringSession
from telethon.tl.types import MessageMediaDocument

# Récupération sécurisée depuis Render
API_ID = int(os.environ.get("API_ID"))
API_HASH = os.environ.get("API_HASH")
SESSION_STRING = os.environ.get("SESSION_STRING")

app = FastAPI(title="Telegram Anime Streamer API")

client = TelegramClient(StringSession(SESSION_STRING), API_ID, API_HASH)

@app.on_event("startup")
async def startup():
    await client.start()
    print("✅ Connecté avec succès à Telegram !")

@app.on_event("shutdown")
async def shutdown():
    await client.disconnect()

async def iter_file_chunks(message):
    async for chunk in client.iter_download(message.media, chunk_size=1024 * 512):
        yield chunk

@app.get("/")
def home():
    return {"status": "En ligne", "message": "API de streaming Telegram fonctionnelle !"}

@app.get("/download/{channel_id}/{message_id}")
async def download_file(channel_id: str, message_id: int):
    try:
        # Gère les canaux publics (ex: anime_channel) et privés (ex: -10012345678)
        target = int(channel_id) if channel_id.startswith("-") or channel_id.isdigit() else channel_id
        message = await client.get_messages(target, ids=message_id)
        
        if not message or not message.media:
            raise HTTPException(status_code=404, detail="Fichier introuvable sur Telegram.")

        file_name = "anime_video.mp4"
        file_size = 0
        mime_type = "application/octet-stream"

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
