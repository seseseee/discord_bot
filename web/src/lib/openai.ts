// src/lib/openai.ts
import OpenAI from "openai";

export const USE_OLLAMA = process.env.ANALYSIS_USE_OLLAMA === "true";
export const OLLAMA_BASE = process.env.OLLAMA_BASE || "http://127.0.0.1:11434";
export const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "qwen2.5:7b";

// OpenAIを使う場合だけ参照。キー未設定でも絶対 throw しない。
export const ANALYSIS_MODEL = process.env.ANALYSIS_MODEL || "gpt-4o-mini";
export let openai: OpenAI | null = null;
if (!USE_OLLAMA) {
  const key = process.env.OPENAI_API_KEY;
  if (key) {
    openai = new OpenAI({ apiKey: key });
  } // ← キー無ければ何もしない（エラーにしない）
}

// ---- Ollama ユーティリティ ----
export async function callOllamaGenerate(prompt: string, opts?: { temperature?: number }) {
  const res = await fetch(`${OLLAMA_BASE}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      prompt,
      stream: false,
      options: { temperature: opts?.temperature ?? 0.1 },
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Ollama error ${res.status}: ${t}`);
  }
  const json = (await res.json()) as { response: string };
  return json.response;
}

// ```json ... ``` を剥がしてJSON抽出
export function extractJson(text: string) {
  const m = text.match(/```json\s*([\s\S]*?)```/i) || text.match(/```([\s\S]*?)```/);
  const raw = m ? m[1] : text;
  return JSON.parse(raw);
}
