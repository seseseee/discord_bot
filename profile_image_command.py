# profile_image_command.py
import os
import re
import json
from io import BytesIO
import discord
from discord import app_commands
from discord.ext import commands

from profile_image_utils import select_odd_even_odd, generate_profile_image

PROFILE_FILE = os.getenv("PROFILE_FILE", "profiles.json")  # profile_manager と合わせる

def _load_profiles() -> dict:
    try:
        with open(PROFILE_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return {}
    except Exception:
        return {}

def _extract_numbers_from_taikei(taikei_text: str) -> list[int]:
    """
    taikei 文字列から数字だけを抽出（例: '1種/複合2-5' → [1,2,5]）
    """
    nums = re.findall(r"\d+", taikei_text or "")
    return [int(n) for n in nums]

class ProfileImageCog(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot

    @app_commands.command(
        name="profile_image",
        description="profile_managerで登録済みの体癖を読み取り、数字入りプロフィール画像を生成して送信します"
    )
    @app_commands.describe(
        user="対象ユーザー（未指定なら自分）"
    )
    async def profile_image(self, interaction: discord.Interaction, user: discord.Member | None = None):
        target = user or interaction.user
        profiles = _load_profiles()
        rec = profiles.get(str(target.id))

        if not rec:
            await interaction.response.send_message(
                "⚠️ プロフィール未登録です。先に /profile から登録してください。",
                ephemeral=True
            )
            return

        taikei_text = rec.get("taikei", "")
        numbers_raw = _extract_numbers_from_taikei(taikei_text)
        if not numbers_raw:
            await interaction.response.send_message(
                f"⚠️ 登録済みプロフィールに数字が見つかりませんでした（体癖: “{taikei_text}”）。\n例: 1,2,5 のように数字を含めて登録してください。",
                ephemeral=True
            )
            return

        picked_nums = select_odd_even_odd(numbers_raw)

        # Discordアバター
        avatar_io: BytesIO | None = None
        try:
            avatar_bytes = await target.display_avatar.read()
            avatar_io = BytesIO(avatar_bytes)
        except Exception:
            avatar_io = None

        # 画像生成
        img_bytes = generate_profile_image(
            display_name=rec.get("display_name", target.display_name),
            taikei=taikei_text,
            numbers=picked_nums,
            bio=rec.get("bio", ""),
            interests=rec.get("interests", ""),
            avatar_bytes=avatar_io,
            base_image_path=None,         # 任意で背景画像を使うならパスを指定
            font_path=os.getenv("FONT_PATH", "arial.ttf"),
        )

        # 送信（自己紹介チャンネルがあれば優先）
        intro_channel_name = os.getenv("INTRO_CHANNEL_NAME", "自己紹介")
        intro_ch = discord.utils.get(interaction.guild.text_channels, name=intro_channel_name)
        dst = intro_ch or interaction.guild.system_channel or interaction.channel

        await dst.send(
            f"{target.mention} さんのプロフィール画像（体癖: {taikei_text} | 数字: {picked_nums}）",
            file=discord.File(img_bytes, filename="profile.png"),
            allowed_mentions=discord.AllowedMentions(users=True, roles=False, everyone=False)
        )

        await interaction.response.send_message("✅ プロフィール画像を投稿しました。", ephemeral=True)

async def setup(bot: commands.Bot):
    await bot.add_cog(ProfileImageCog(bot))
