# bot.py
import os, io, sqlite3, math, datetime as dt
from contextlib import closing
import discord
from discord import app_commands
from discord.ext import commands
import matplotlib
matplotlib.use("Agg")  # 非GUI環境
import matplotlib.pyplot as plt

# ====== 設定 ======
TOKEN = os.environ.get("DISCORD_BOT_TOKEN")
GUILD_ID = os.environ.get("GUILD_ID")  # 任意（高速sync用）
DB_PATH = "scores.db"

AXES = ["topic", "question", "reply", "emotion", "constructive"]
EMOJI_MAP = {  # 反応→軸
    "👍": "topic",
    "❓": "question",
    "💬": "reply",
    "💗": "emotion",
    "🛠️": "constructive",
}
THRESHOLDS = [10, 20, 40, 80, 160]  # しきい値（満点が広がる）

# ====== DB ======
def init_db():
    with closing(sqlite3.connect(DB_PATH)) as con, con:
        con.execute("""
        CREATE TABLE IF NOT EXISTS scores(
            user_id INTEGER PRIMARY KEY,
            topic INTEGER DEFAULT 0,
            question INTEGER DEFAULT 0,
            reply INTEGER DEFAULT 0,
            emotion INTEGER DEFAULT 0,
            constructive INTEGER DEFAULT 0,
            updated_at TEXT
        )
        """)

def get_scores(uid: int):
    with closing(sqlite3.connect(DB_PATH)) as con:
        cur = con.execute("SELECT " + ",".join(AXES) + " FROM scores WHERE user_id=?", (uid,))
        row = cur.fetchone()
        if not row:
            return {k: 0 for k in AXES}
        return dict(zip(AXES, row))

def add_scores(uid: int, delta: dict):
    now = dt.datetime.utcnow().isoformat()
    cur_vals = get_scores(uid)
    new_vals = {k: max(0, cur_vals.get(k, 0) + int(delta.get(k, 0))) for k in AXES}
    with closing(sqlite3.connect(DB_PATH)) as con, con:
        fields = ",".join([f"{k}=?" for k in AXES])
        params = [new_vals[k] for k in AXES] + [now, uid]
        con.execute(f"""
            INSERT INTO scores(user_id, {",".join(AXES)}, updated_at)
            VALUES(?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(user_id) DO UPDATE SET {fields}, updated_at=?
        """, (uid, *[new_vals[k] for k in AXES], now, *[new_vals[k] for k in AXES], now,))

    return new_vals

# 現在の表示レンジ（外周）を決める
def current_scale_max(max_value: int):
    # 例：最大値が12なら 20、40で満点を取ったら次は80…という階段的レンジ
    for th in THRESHOLDS:
        if max_value <= th:
            return th
    return THRESHOLDS[-1]

# ====== チャート ======
def make_radar(scores: dict, user_display: str, window_desc: str = "") -> io.BytesIO:
    values = [scores[k] for k in AXES]
    max_v = max(values) if any(values) else 1
    scale = current_scale_max(max_v)

    # レーダー座標
    labels = ["話題提示", "質問", "応答", "感情", "建設性"]
    N = len(labels)
    angles = [n / float(N) * 2 * math.pi for n in range(N)]
    values_norm = [v / scale for v in values]
    values_norm += values_norm[:1]
    angles += angles[:1]

    fig = plt.figure(figsize=(5,5))
    ax = plt.subplot(111, polar=True)
    ax.set_theta_offset(math.pi / 2)
    ax.set_theta_direction(-1)
    ax.set_thetagrids([a * 180 / math.pi for a in angles[:-1]], labels, fontsize=10)

    # 同心円は閾値ベースで表示（例：0, 10, 20, 40…）
    grid_levels = [t/scale for t in THRESHOLDS if t <= scale]
    ax.set_rgrids([g*scale for g in grid_levels], labels=[str(int(g*scale)) for g in grid_levels], angle=90)
    ax.set_ylim(0, 1)

    ax.plot(angles, values_norm, linewidth=2)
    ax.fill(angles, values_norm, alpha=0.25)
    ax.set_title(f"{user_display} の貢献度レーダー（外周={scale}）{(' ' + window_desc) if window_desc else ''}", fontsize=11)
    buf = io.BytesIO()
    plt.tight_layout()
    plt.savefig(buf, format="png", dpi=160)
    plt.close(fig)
    buf.seek(0)
    return buf

# ====== Bot ======
intents = discord.Intents.default()
intents.message_content = True
intents.members = True
bot = commands.Bot(command_prefix="!", intents=intents)
tree = bot.tree

@bot.event
async def on_ready():
    init_db()
    # スラッシュコマンド同期
    try:
        if GUILD_ID:
            guild = bot.get_guild(int(GUILD_ID))
            await tree.sync(guild=guild)
        else:
            await tree.sync()
    except Exception as e:
        print("sync error:", e)
    print(f"Bot起動: {bot.user}")

# 反応で自動加点（静かに動く）
@bot.event
async def on_reaction_add(reaction: discord.Reaction, user: discord.User|discord.Member):
    if user.bot:
        return
    axis = EMOJI_MAP.get(str(reaction.emoji))
    if not axis:
        return
    target_author = reaction.message.author
    if target_author.bot:
        return
    delta = {k: 0 for k in AXES}
    delta[axis] = 1
    add_scores(target_author.id, delta)

# /eval @user topic:1 question:0 ... のように明示加点
@tree.command(name="eval", description="ユーザーに評価を加算（1～5など）")
@app_commands.describe(
    user="評価対象",
    topic="話題提示", question="質問", reply="応答",
    emotion="感情", constructive="建設性"
)
async def eval_cmd(
    interaction: discord.Interaction,
    user: discord.Member,
    topic: int = 0, question: int = 0, reply: int = 0, emotion: int = 0, constructive: int = 0
):
    delta = {"topic": topic, "question": question, "reply": reply, "emotion": emotion, "constructive": constructive}
    new_scores = add_scores(user.id, delta)
    await interaction.response.send_message(
        f"✅ {user.display_name} に加点しました：{delta}\n現在値：{new_scores}", ephemeral=True
    )

# /radar でレーダーチャート
@tree.command(name="radar", description="ユーザーのレーダーチャートを表示")
@app_commands.describe(user="対象（未指定なら自分）")
async def radar_cmd(interaction: discord.Interaction, user: discord.Member | None = None):
    target = user or interaction.user
    scores = get_scores(target.id)
    img = make_radar(scores, target.display_name)
    await interaction.response.send_message(file=discord.File(fp=img, filename="radar.png"))

# 便利：現在値を確認
@tree.command(name="score", description="ユーザーの現在スコアを表示")
@app_commands.describe(user="対象（未指定なら自分）")
async def score_cmd(interaction: discord.Interaction, user: discord.Member | None = None):
    target = user or interaction.user
    scores = get_scores(target.id)
    scale = current_scale_max(max(scores.values()) if any(scores.values()) else 0)
    await interaction.response.send_message(f"📊 {target.display_name} のスコア：{scores}（現在の外周={scale}）")

# （任意）profile_manager 拡張があればロード
async def setup_hook():
    try:
        await bot.load_extension("profile_manager")
        print("profile_manager loaded")
    except Exception as e:
        print("profile_manager not loaded:", e)
bot.setup_hook = setup_hook

# ====== 起動 ======
if __name__ == "__main__":
    if not TOKEN:
        print("環境変数 DISCORD_BOT_TOKEN が未設定です。")
    else:
        bot.run(TOKEN)
