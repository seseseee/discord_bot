// src/lib/trigger.ts
import { prisma } from "@/lib/prisma";
import type { Label } from "@/lib/rules";

// 雑ノイズ除去
function norm(text: string) {
  return (text || "")
    .replace(/\s+/g, "")                // 空白除去
    .replace(/[。、，,.!！?？~〜…・]/g, "") // 句読点類
    .replace(/https?:\/\/\S+/g, "");    // URL
}

// 文字 n-gram を作る（日本語に寄せる）
function charNgrams(s: string, min = 4, max = 8): string[] {
  const out: string[] = [];
  for (let L = min; L <= max; L++) {
    for (let i = 0; i + L <= s.length; i++) {
      const t = s.slice(i, i + L);
      // 記号類だけ／数字だけは捨てる
      if (!/[一-龠ぁ-んァ-ヴーｦ-ﾟA-Za-z]/.test(t)) continue;
      if (/^\d+$/.test(t)) continue;
      out.push(t);
    }
  }
  return out;
}

// 和文の「は」までの短い前置き（例：今日のご飯は）
function shortPrefixUntilParticleHa(s: string): string | null {
  const idx = s.indexOf("は");
  if (idx >= 2 && idx <= 14) return s.slice(0, idx + 1);
  return null;
}

// メイン抽出器：前置き + n-gram を混ぜて上位だけ返す
export function extractKeyPhrases(text: string, topK = 5): string[] {
  const s = norm(text);
  const bag = new Set<string>();

  const prefix = shortPrefixUntilParticleHa(s);
  if (prefix) bag.add(prefix); // 例: "今日のご飯は"

  for (const g of charNgrams(s, 4, 8)) bag.add(g);

  // 優先度: 長い > 「は」を含む > ひらがな/カナ/漢字を多く含む
  const scored = Array.from(bag).map(p => {
    const hasHa = p.includes("は") ? 1 : 0;
    const jpChar = (p.match(/[一-龠ぁ-んァ-ヶ]/g) || []).length;
    return { p, score: p.length * 2 + hasHa * 3 + jpChar * 1.5 };
  });
  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, topK).map(x => x.p);
}

// Feedback を受けて Trigger を更新
export async function learnFromFeedback(options: {
  serverId: string;
  text: string;
  labels: Label[];
}) {
  const { serverId, text, labels } = options;
  const phrases = extractKeyPhrases(text);
  if (phrases.length === 0) return;

  // weight は最小 1。複数ラベル時は若干弱めに（例: 1 / labels.length）
  const baseWeight = Math.max(0.5, 1 / Math.max(1, labels.length));

  const ops: Promise<any>[] = [];
  for (const lab of labels) {
    for (const phrase of phrases) {
      ops.push(
        prisma.trigger.upsert({
          where: { serverId_phrase_label: { serverId, phrase, label: lab } },
          // ← Prisma の TriggerUpdateInput に存在するフィールド名を使う
          update: {
            hits: { increment: 1 },
            // 任意：学習強度を少しずつ近づける（無ければ消してOK）
            weight: { increment: 0.0 }, // ここで weight を変えたくないなら 0
          },
          create: {
            serverId,
            phrase,
            label: lab,
            hits: 1,
            weight: baseWeight,
            // pattern を自動生成する場合はここで指定してもよい（例: null）
            pattern: null,
          },
        })
      );
    }
  }
  await Promise.all(ops);
}
