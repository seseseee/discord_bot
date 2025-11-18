# profile_manager.py
import os
import json
import io
import re
import datetime as dt
import discord
from discord.ext import commands
from discord.ui import View, Button, Modal, TextInput

from profile_image_utils import generate_profile_image, select_odd_even_odd

# ===== 設定 =====
INTRO_CHANNEL_NAME = os.getenv("INTRO_CHANNEL_NAME", "体癖紹介")
PROFILE_FILE = os.getenv("PROFILE_FILE", "profiles.json")
BASE_IMAGE_PATH = os.getenv("BASE_IMAGE_PATH", None)
FONT_PATH = os.getenv("FONT_PATH", "arial.ttf")


# ---------- 永続化 ----------
def load_profiles() -> dict:
    if os.path.exists(PROFILE_FILE):
        with open(PROFILE_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    return {}


def save_profiles(data: dict) -> None:
    with open(PROFILE_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


# ---------- モーダル ----------
class ProfileModal(Modal, title="プロフィール登録"):
    taikei: TextInput = TextInput(
        label="体癖（例：1種/複合など。数字を含めてください）",
        max_length=64,
        required=True,
        placeholder="例）1種/複合 2-5"
    )
    bio: TextInput = TextInput(
        label="ひとこと",
        style=discord.TextStyle.short,
        max_length=80,
        required=False,
        placeholder="よろしくお願いします！"
    )
    interests: TextInput = TextInput(
        label="興味・関心（カンマ区切り）",
        required=False,
        max_length=120,
        placeholder="例）デザイン, 読書, 散歩"
    )

    def __init__(self, cog: "ProfileManager"):
        super().__init__(timeout=None)
        self.cog = cog

    async def on_submit(self, interaction: discord.Interaction):
        user = interaction.user

        # 保存
        profiles = load_profiles()
        profiles[str(user.id)] = {
            "display_name": user.display_name,
            "taikei": str(self.taikei).strip(),
            "bio": str(self.bio).strip(),
            "interests": str(self.interests).strip(),
            "updated_at": dt.datetime.utcnow().isoformat()
        }
        save_profiles(profiles)

        # 体癖 → 数字抽出 → 奇数-偶数-奇数（最大3つ）に整形
        taikei_text = profiles[str(user.id)]["taikei"]
        nums_raw = [int(n) for n in re.findall(r"\d+", taikei_text)]
        picked_nums = select_odd_even_odd(nums_raw) if nums_raw else []

        # アバター取得（await は async 内で）
        avatar_io = None
        try:
            avatar_bytes = await user.display_avatar.read()
            avatar_io = io.BytesIO(avatar_bytes)
        except Exception:
            avatar_io = None

        # プロフィール画像生成（numbers を必ず渡す）
        img = generate_profile_image(
            display_name=user.display_name,
            taikei=taikei_text,
            numbers=picked_nums,  # ★必須
            bio=profiles[str(user.id)].get("bio", ""),
            interests=profiles[str(user.id)].get("interests", ""),
            avatar_bytes=avatar_io,
            base_image_path=BASE_IMAGE_PATH,
            font_path=FONT_PATH,
        )

        # 自己紹介チャンネルへ投稿
        intro_ch = discord.utils.get(interaction.guild.text_channels, name=self.cog.intro_channel_name)
        if intro_ch is None:
            intro_ch = await interaction.guild.create_text_channel(self.cog.intro_channel_name)

        await intro_ch.send(
            content=f"{user.mention} さんがプロフィールを登録しました！",
            file=discord.File(fp=img, filename="profile.png"),
            allowed_mentions=discord.AllowedMentions(users=True, roles=False, everyone=False)
        )

        # ユーザーへ完了通知（ephemeral）
        await interaction.response.send_message(
            "✅ 登録が完了しました。自己紹介チャンネルにカードを投稿しました！",
            ephemeral=True
        )


# ---------- 常設ボタン（未登録者のみモーダル表示） ----------
class RegisterView(View):
    def __init__(self, cog: "ProfileManager"):
        super().__init__(timeout=None)  # 永続
        self.cog = cog

    @discord.ui.button(
        label="プロフィール登録 / 更新",
        style=discord.ButtonStyle.success,
        custom_id="taikei_register_button"
    )
    async def register(self, interaction: discord.Interaction, button: Button):
        profiles = load_profiles()
        uid = str(interaction.user.id)

        # 既登録 → モーダルは出さず案内のみ
        if uid in profiles:
            await interaction.response.send_message(
                "すでに登録済みです。更新したい場合はボタンから再登録できます。",
                ephemeral=True
            )
            return

        # 未登録者のみモーダル表示
        await interaction.response.send_modal(ProfileModal(self.cog))


# ---------- Cog ----------
class ProfileManager(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot
        self.intro_channel_name = INTRO_CHANNEL_NAME

    @commands.Cog.listener()
    async def on_ready(self):
        # 再起動時もボタンを生かすため、案内メッセージを確保して View を再アタッチ
        for guild in self.bot.guilds:
            try:
                await self.ensure_intro_message(guild)
            except Exception as e:
                print(f"[intro ensure error] {guild.name}: {e}")

    async def ensure_intro_message(self, guild: discord.Guild):
        intro_ch = discord.utils.get(guild.text_channels, name=self.intro_channel_name)
        if intro_ch is None:
            intro_ch = await guild.create_text_channel(self.intro_channel_name)

        marker = "📇 プロフィール登録はこちら（未登録者のみモーダル表示）"

        # 直近の Bot メッセージに再び View を付け直す
        async for m in intro_ch.history(limit=50):
            if m.author == self.bot.user and m.content.startswith(marker):
                try:
                    await m.edit(view=RegisterView(self))
                except Exception:
                    pass
                return

        # なければ新規投稿 + ピン留め
        msg = await intro_ch.send(marker, view=RegisterView(self))
        try:
            await msg.pin()
        except discord.Forbidden:
            # 権限が無ければスルー
            pass


async def setup(bot: commands.Bot):
    await bot.add_cog(ProfileManager(bot))
