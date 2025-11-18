# profile_image_utils.py
from io import BytesIO
from typing import Iterable, List, Optional
from PIL import Image, ImageDraw, ImageFont


# -------------------------------
# 数字の選抜：奇数-偶数-奇数（最大3つ）
# -------------------------------
def select_odd_even_odd(nums: Iterable[int]) -> List[int]:
    """
    入力の数字列から奇数-偶数-奇数(O-E-O)の順になるよう最大3つを返す。
    ・奇数が2つ、偶数が1つある場合： [odd1, even1, odd2]
    ・奇数が1つ＆偶数が1つ： [odd1, even1]（2つ）
    ・奇数が2つのみ： [odd1, odd2]（O-O）※偶数が無ければやむを得ず
    ・それ以外：先頭から最大3つを返す（フォールバック）
    """
    nums = [int(n) for n in nums]
    odds  = [n for n in nums if n % 2 == 1]
    evens = [n for n in nums if n % 2 == 0]

    if len(odds) >= 2 and len(evens) >= 1:
        return [odds[0], evens[0], odds[1]]
    if len(odds) >= 1 and len(evens) >= 1:
        return [odds[0], evens[0]]
    if len(odds) >= 2:
        return odds[:2]
    # ここまで来たら条件を満たせないので、そのまま最大3つ
    return nums[:3]


# -------------------------------
# プロフィール画像生成
# -------------------------------
def generate_profile_image(
    display_name: str,
    taikei: str,
    numbers: Iterable[int],
    bio: str = "",
    interests: str = "",
    avatar_bytes: Optional[BytesIO] = None,
    base_image_path: Optional[str] = None,
    font_path: str = "arial.ttf",
) -> BytesIO:
    """
    プロフィールカード画像を生成して BytesIO を返す。
    埋め込む数字は select_odd_even_odd() で整形した最大3つ。
    """
    # 背景
    if base_image_path:
        image = Image.open(base_image_path).convert("RGB")
    else:
        image = Image.new("RGB", (760, 360), (250, 250, 255))

    draw = ImageDraw.Draw(image)

    # フォント
    try:
        font_title = ImageFont.truetype(font_path, 34)
        font_body  = ImageFont.truetype(font_path, 22)
        font_nums  = ImageFont.truetype(font_path, 80)
        font_badge = ImageFont.truetype(font_path, 16)
    except Exception:
        font_title = font_body = font_nums = font_badge = ImageFont.load_default()

    # 左：アバター
    if avatar_bytes:
        try:
            avatar = Image.open(avatar_bytes).convert("RGB").resize((140, 140))
            image.paste(avatar, (24, 24))
        except Exception:
            pass

    # 右：テキスト
    x = 190
    y = 28
    draw.text((x, y), display_name, fill=(20, 20, 20), font=font_title); y += 46
    draw.text((x, y), f"体癖: {taikei}", fill=(30, 30, 30), font=font_body); y += 34
    if bio:
        draw.text((x, y), f"ひとこと: {bio}", fill=(30, 30, 30), font=font_body); y += 34
    if interests:
        draw.text((x, y), f"興味: {interests}", fill=(30, 30, 30), font=font_body)

    # 下部：数字バッジ + 大きな表示
    picked = select_odd_even_odd(numbers)
    # バッジ行
    badge_y = 190
    draw.text((24, badge_y), "数字（O-E-O 準拠）", fill=(80, 80, 120), font=font_badge)
    bx = 24
    for n in picked:
        w, h = draw.textbbox((0, 0), str(n), font=font_badge)[2:]
        pad = 12
        draw.rounded_rectangle([bx, badge_y+20, bx+w+pad*2, badge_y+20+h+pad], 8, fill=(230, 235, 255), outline=(120,130,180))
        draw.text((bx+pad, badge_y+20+pad//2), str(n), fill=(40,40,80), font=font_badge)
        bx += w + pad*2 + 10

    # 大きな中央表示（視覚的に分かりやすく）
    nums_text = "  ".join(str(n) for n in picked)
    tw, th = draw.textbbox((0, 0), nums_text, font=font_nums)[2:]
    cx = (image.width - tw) // 2
    cy = image.height - th - 28
    draw.text((cx, cy), nums_text, fill=(10, 10, 30), font=font_nums)

    # 出力
    out = BytesIO()
    image.save(out, format="PNG")
    out.seek(0)
    return out
