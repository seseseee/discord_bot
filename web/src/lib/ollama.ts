// src/lib/ollama.ts
const OLLAMA_BASE = process.env.OLLAMA_BASE || "http://127.0.0.1:11434";
const OLLAMA_MODEL = process.env.OLLLAMA_MODEL || process.env.OLLAMA_MODEL || "qwen2.5:7b";

// 分類ラベルの型（rules.ts と揃える）
export type Label = "AG" | "TP" | "EM" | "S" | "Q" | "CH" | "BOT";

// Ollama /api/generate を叩く薄いラッパ
export async function ollamaGenerate(prompt: string, options?: Record<string, any>): Promise<string> {
  const res = await fetch(`${OLLAMA_BASE}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      prompt,
      stream: false,
      options: { temperature: 0, ...options },
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Ollama generate failed: ${res.status} ${text}`);
  }
  const data: any = await res.json();
  // /api/generate のレスポンスは { response: string, ... }
  return String(data.response ?? "");
}

// JSON を頑張って抜く（```json ... ``` でもOK、最初の {} を取る）
function extractJson(s: string): any | null {
  // 1) コードフェンス除去
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fence ? fence[1] : s;
  // 2) 最初の { ～ 対応する } をナイーブに探す
  const start = raw.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        const chunk = raw.slice(start, i + 1);
        try { return JSON.parse(chunk); } catch { /* fallthrough */ }
      }
    }
  }
  // 3) ダメなら生パース
  try { return JSON.parse(raw.trim()); } catch { return null; }
}

// 型・値のバリデーション
function coerceLabel(x: any): Label | null {
  const ok: Label[] = ["AG", "TP", "EM", "S", "Q", "CH", "BOT"];
  return ok.includes(x) ? (x as Label) : null;
}

// 1発言を Ollama で解析
export async function analyzeWithOllama(text: string): Promise<{ label: Label, confidence: number, rationale: string }> {
  const prompt = `
あなたはメッセージを次のカテゴリに厳密に1つ割り当てます:
- "AG": 賛成・同意・承認（例: 賛成、わかる、それな、OK 等）
- "TP": 提案・トピック出し・告知・募集・日程/場所など運営連絡
- "EM": 感情（嬉しい/悲しい/草/！連打/絵文字多用 など情動表現）
- "S" : 情報共有（URL, 資料, 日付や時刻など具体情報の共有）
- "Q" : 質問（？終わり、なぜ/どうやって/どこ/いつ/誰 等の疑問）
- "CH": 雑談・相槌・軽いコメント（上記のどれにも当てはまらない）
- "BOT": システム/投票結果/自動メッセージ

出力は **最小限の1行JSON** のみ。例:
{"label":"S","confidence":0.92,"rationale":"URLと日付を含む情報共有"}

必ず keys は "label","confidence","rationale" の3つ。label は上のいずれか。
confidence は 0～1。本文:
---
${text}
---
`.trim();

  const out = await ollamaGenerate(prompt);
  const parsed = extractJson(out);
  const fallback = { label: "CH" as Label, confidence: 0.6, rationale: "fallback" };

  if (!parsed || typeof parsed !== "object") return fallback;

  const label = coerceLabel(parsed.label);
  const conf = typeof parsed.confidence === "number" ? Math.max(0, Math.min(1, parsed.confidence)) : 0.6;
  const rationale = typeof parsed.rationale === "string" ? parsed.rationale : "";

  return label ? { label, confidence: conf, rationale } : fallback;
}
