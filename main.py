import os
import json
import logging
import asyncio
import re
from typing import Optional, List, Dict

import aiohttp
import discord
from discord.ext import commands, tasks
from discord import app_commands
from dotenv import load_dotenv

load_dotenv()

DISCORD_BOT_TOKEN = os.getenv("DISCORD_BOT_TOKEN")
INGEST_URL = os.getenv("INGEST_URL")  # e.g. http://localhost:3000/api/ingest/discord
SURVEY_URL = os.getenv("SURVEY_URL")  # e.g. http://localhost:3000/api/survey
GUILD_ID = os.getenv("GUILD_ID")

if not DISCORD_BOT_TOKEN:
    raise RuntimeError("環境変数 DISCORD_BOT_TOKEN が未設定です")
if not INGEST_URL:
    raise RuntimeError("環境変数 INGEST_URL が未設定です")

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("collector")

intents = discord.Intents.default()
intents.members = True
intents.message_content = True

bot = commands.Bot(command_prefix="!", intents=intents)

# ---- ユーティリティ ----
url_re = re.compile(r'https?://\S+')
number_re = re.compile(r'[-+]?\d+[.,]?\d*')

def extract_entities(text: str) -> Dict[str, List[str]]:
    urls = url_re.findall(text or '')
    nums = number_re.findall(text or '')
    return {"urls": urls, "numbers": nums}

def naive_label(text: str) -> str:
    t = text or ""
    if url_re.search(t) or number_re.search(t):
        return "S"   # 情報共有
    if any(q in t for q in ["？","?"]) or t.strip().endswith("か"):
        return "Q"   # 質問
    if any(w in t for w in ["賛成","同意","了解","たしかに","わかる","いいね"]):
        return "AG"  # 応答・同意
    if any(w in t for w in ["嬉しい","悲しい","怒","楽しい","最高","最悪","草","笑"]):
        return "EM"  # 感情
    if len(t) > 0 and len(t) < 20:
        return "CH"  # 雑談・短文
    return "TP"      # 話題提示の仮置き

async def post_json(url: str, payload: dict):
    try:
        timeout = aiohttp.ClientTimeout(total=15)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.post(url, json=payload) as resp:
                if resp.status >= 300:
                    text = await resp.text()
                    log.warning(f"POST NG {resp.status}: {text}")
                else:
                    log.debug("POST OK")
    except Exception as e:
        log.exception(f"POST error: {e}")

# ---- Slash: 公平性アンケート ----
class Survey(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot

    @app_commands.command(name="fairness", description="討議の公平性を1〜5で評価する")
    @app_commands.describe(score="1〜5の整数", note="任意メモ")
    async def fairness(self, interaction: discord.Interaction, score: int, note: Optional[str] = None):
        if score < 1 or score > 5:
            await interaction.response.send_message("1〜5の整数を指定してください", ephemeral=True)
            return
        payload = {
            "serverId": str(interaction.guild_id) if interaction.guild_id else None,
            "channelId": str(interaction.channel_id),
            "raterId": str(interaction.user.id),
            "score": score,
            "note": note or "",
            "createdAt": int(discord.utils.utcnow().timestamp() * 1000),
        }
        if not SURVEY_URL:
            await interaction.response.send_message("SURVEY_URLが未設定のため保存できません", ephemeral=True)
            return
        await post_json(SURVEY_URL, payload)
        await interaction.response.send_message("評価を受け付けました ありがとうございました", ephemeral=True)

async def setup_cogs():
    await bot.add_cog(Survey(bot))

@bot.event
async def setup_hook():
    await setup_cogs()
    try:
        if GUILD_ID:
            guild = discord.Object(id=int(GUILD_ID))
            await bot.tree.sync(guild=guild)
            log.info(f"Slash synced to guild {GUILD_ID}")
        else:
            await bot.tree.sync()
            log.info("Slash commands synced globally")
    except Exception as e:
        log.exception(f"Slash sync failed: {e}")

@bot.event
async def on_ready():
    log.info(f"✅ Bot起動: {bot.user} | guilds={len(bot.guilds)}")

@bot.event
async def on_message(message: discord.Message):
    if message.author.bot:
        return

    entities = extract_entities(message.content or "")
    payload = {
        "serverId": str(message.guild.id) if message.guild else None,
        "channelId": str(message.channel.id),
        "threadId": str(message.channel.id) if isinstance(message.channel, discord.Thread) else None,
        "messageId": str(message.id),
        "authorId": str(message.author.id),
        "authorIsBot": bool(message.author.bot),
        "createdAt": int(message.created_at.timestamp() * 1000),
        "contentText": message.content or "",
        "replyToId": str(message.reference.message_id) if message.reference and message.reference.message_id else None,
        "mentions": [str(u.id) for u in message.mentions] if message.mentions else [],
        "urls": entities["urls"],
        "numbers": entities["numbers"],
        "label": naive_label(message.content or ""),
    }
    await post_json(INGEST_URL, payload)
    await bot.process_commands(message)

if __name__ == "__main__":
    bot.run(DISCORD_BOT_TOKEN)