// src/lib/nli.ts
export type Cat = 'AG'|'TP'|'EM'|'S'|'Q'|'CH'|'BOT';

const LABELS: Record<Cat,string> = {
  AG:'賛成/同意/了解などの肯定的反応',
  TP:'提案・告知・募集・開催/締切の案内',
  EM:'感情・相槌・笑い・驚きなど',
  S :'情報共有/資料・URL・日時・場所の提示',
  Q :'質問（なぜ/どう/どこ/いつ/誰/何 等）',
  CH:'雑談・軽い反応（情報性が低い）',
  BOT:'システム/自動メッセージ・投票告知/結果',
};

let pipe: any = null;

export async function classifyNLI(text: string, context?: string) {
  // ← ここで初回だけ動的 import（ビルド時に読み込まない）
  if (!pipe) {
    const { pipeline } = await import('@xenova/transformers');
    pipe = await pipeline(
      'zero-shot-classification',
      'MoritzLaurer/mDeBERTa-v3-base-xnli-multilingual-nli-2mil7'
    );
  }

  const candidates = (Object.entries(LABELS) as [Cat,string][])
    .map(([k,v]) => `${k}: ${v}`);

  const sequence = context ? `発言: ${text}\nコンテキスト: ${context}` : text;

  const out = await pipe(sequence, candidates, {
    multi_label: false,
    hypothesis_template: 'この文は {candidate_label} に該当する。'
  });

  const top = String(out.labels[0]);        // 例: "S: 情報共有/..."
  const label = top.split(':')[0] as Cat;   // 例: "S"
  const confidence = Number(out.scores[0]); // 0〜1
  return { label, confidence, rationale: 'nli' };
}
