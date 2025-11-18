// src/lib/normalizeLabel.ts
import type { Label } from "@/lib/rules";
import { LABELS } from "@/lib/rules";

/** 入力をUnicode正規化(NFKC)＋trim */
function normNFKC(s: string | unknown): string {
  return String(s ?? "").normalize("NFKC").trim();
}

// 絵文字 → ラベル
export const EMOJI_TO_LABEL: Record<string, Label> = {
  "👍": "AG", "🆗": "AG", "✅": "AG",
  "🗓️": "TP", "📅": "TP",
  "😊": "EM", "😆": "EM", "😂": "EM", "🤣": "EM", "😢": "EM", "😡": "EM",
  "ℹ️": "S", "📎": "S", "🔗": "S",
  "❓": "Q", "❔": "Q", "？": "Q", "?": "Q",
  "💬": "CH", "🗨️": "CH",
  "⛔": "NG", "❌": "NG", "🚫": "NG", "✖": "NG", "✕": "NG",
} as const;

// 単語/同義語 → ラベル（NFKC後のトークンに対して判定）
const WORD_TO_LABEL: Array<[RegExp, Label]> = [
  // AG: 同意/賛成/了解系
  [/^(ag|agree|agreement|ok|okay|了解(?:です|しました)?|賛成|同意|同感|それな|いいね|gj|グッジョブ|称賛)$/i, "AG"],
  // TP: 話題提示/予定/告知
  [/^(tp|topic|トピック|提案|告知|アナウンス|募集|予定|スケジュール)$/i, "TP"],
  // EM: 感情表出（w/草/笑 の連続も許容）
  [/^(em|emotion|感情|嬉しい|楽しい|悲しい|やばい|草+|笑+|(?:ｗ+|w+))$/i, "EM"],
  // S: 情報共有
  [/^(s|share|shareinfo|情報|リンク|url|日時|データ|資料|画像|動画)$/i, "S"],
  // Q: 質問
  [/^(q|question|質問|なぜ|なんで|教えて|[?？])$/i, "Q"],
  // CH: 雑談/相槌
  [/^(ch|chat|雑談|挨拶|なるほど|へぇ|ふむ)$/i, "CH"],
  // NG: 否定/反対
  [/^(ng|否定|だめ|ダメ|駄目|不要|却下|反対|無し|なし|論外)$/i, "NG"],
];

/** 1つの入力（文字列/絵文字/カスタム絵文字表記）を単一ラベルへ正規化 */
export function normalizeFeedbackLabel(input: string): Label | null {
  const raw = normNFKC(input);
  if (!raw) return null;

  // 完全一致の絵文字
  if (EMOJI_TO_LABEL[raw]) return EMOJI_TO_LABEL[raw];

  // 複合指定を許容（"AG|TP" や "AG,TP" など）→ 単一返却なので最初の妥当値を返す
  // 区切り: | / 、 / , / ／ / / / 空白 すべてOK
  const parts = raw
    .replace(/[、,／/｜|]+/g, "|")
    .split(/\s*\|\s*|\s+/)
    .filter(Boolean);

  for (const p0 of parts) {
    // カスタム絵文字 <a:name:id> / :name: を剥がす→NFKC
    const name = normNFKC(
      p0.replace(/^<a?:([^:>]+):\d+>$/, "$1").replace(/^:([^:]+):$/, "$1")
    );

    // 公式略号（AG/TP/EM/S/Q/CH/NG）
    if ((LABELS as readonly string[]).includes(name.toUpperCase())) {
      return name.toUpperCase() as Label;
    }

    // 語彙マッチ
    for (const [re, lab] of WORD_TO_LABEL) {
      if (re.test(name)) return lab;
    }
  }
  return null;
}

/** 文字列から複数ラベルを抽出（分析・一括適用用。重複除去） */
export function normalizeFeedbackLabelMany(input: string): Label[] {
  const s = normNFKC(input);
  if (!s) return [];
  const got = new Set<Label>();

  // 1) 絵文字を広い目に拾う（含まれていれば採用）
  for (const [emo, lab] of Object.entries(EMOJI_TO_LABEL)) {
    if (s.includes(emo)) got.add(lab);
  }

  // 2) 区切り正規化 → 分割（| / 、 / , / ／ / / / 空白）
  const parts = s
    .replace(/[、,／/｜|]+/g, "|")
    .split(/\s*\|\s*|\s+/)
    .filter(Boolean);

  for (const p of parts) {
    const one = normalizeFeedbackLabel(p);
    if (one) got.add(one);
  }
  return Array.from(got);
}
