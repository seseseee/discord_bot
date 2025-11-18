// web/src/app/api/summarize/route.ts
// LLM必須・堅牢版（常にローカル LLM で要約。失敗=502）
// - llama.cpp / Ollama の OpenAI 互換エンドポイント優先 + Ollama /api/generate フォールバック
// - タイムアウト/アボート正しく実装、ENV 正規表現の安全パース、JSON 抽出の堅牢化
// - oneLiner が URL/メンション/絵文字だけになるアーティファクトを自動補正
// - Next.js App Router 用に runtime/dynamic を指定（ローカル HTTP 可）

import { NextRequest, NextResponse } from "next/server";

// ---- Next.js 実行環境指定 ----
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ---- Types ----
export type RawMsg = { id: string; author: string; content: string; ts: string };

type Decision     = { what: string; who?: string; when?: string };
type ActionItem   = { owner?: string; task: string; due?: string };
type OpenQuestion = { asker?: string; q: string };
type Label        = { id: string; cat: "AG" | "EM" | "Q" | "TP" | "S" | "NG" | "CH" };

type PipelineOut = {
  oneLiner: string;
  practical: string;
  bullets: string[];
  decisions: Decision[];
  actionItems: ActionItem[];
  openQuestions: OpenQuestion[];
  labels: Label[];
  coverage: { coverageRate: number; total: number; used: number; missing?: any };
  meta?: { usedLlm: boolean; engine: string | null };
};

// ---- ENV ----
const ENV = {
  LLM_PROVIDER: (process.env.LLM_PROVIDER ?? "auto") as "auto" | "llama" | "ollama",

  // llama.cpp
  USE_LLAMA: (process.env.ANALYSIS_USE_LLAMA_CPP ?? "0") === "1",
  LLAMA_BASE: (process.env.LLAMA_BASE ?? "http://127.0.0.1:8080").replace(/\/+$/, ""),
  LLAMA_MODEL: process.env.LLAMA_MODEL || "local",

  // Ollama
  USE_OLLAMA: (process.env.ANALYSIS_USE_OLLAMA ?? "0") === "1",
  OLLAMA_BASE: (process.env.OLLAMA_BASE ?? "http://127.0.0.1:11434").replace(/\/+$/, ""),
  OLLAMA_MODEL: process.env.OLLAMA_MODEL || "qwen2.5:7b",

  // 前処理
  SUM_MAX_MSG: Number(process.env.SUM_MAX_MSG ?? "500"),
  SUM_MSG_TRIM: Number(process.env.SUM_MSG_TRIM ?? "240"),
  SUM_SPAM_REGEX: process.env.SUM_SPAM_REGEX ?? "/(^@everyone\\b)|(^https?:\\/\\/\\S+$)/i",

  // LLM
  TEMP: Number(process.env.SUM_TEMPERATURE ?? "0.2"),
  MAX_TOKENS: Number(process.env.SUM_MAX_TOKENS ?? "1200"),

  // タイムアウト
  REQ_TIMEOUT_MS: Number(process.env.SUM_TIMEOUT_MS ?? "25000"),
};

// ---- Utils ----
function pickEngine() {
  const order: Array<"llama" | "ollama"> =
    ENV.LLM_PROVIDER === "llama"  ? ["llama"] :
    ENV.LLM_PROVIDER === "ollama" ? ["ollama"] :
    ENV.USE_LLAMA && ENV.USE_OLLAMA ? ["llama", "ollama"] :
    ENV.USE_LLAMA ? ["llama"] :
    ENV.USE_OLLAMA ? ["ollama"] : [];

  for (const k of order) {
    if (k === "llama"  && ENV.USE_LLAMA)  return { kind: "llama"  as const, base: ENV.LLAMA_BASE,  model: ENV.LLAMA_MODEL };
    if (k === "ollama" && ENV.USE_OLLAMA) return { kind: "ollama" as const, base: ENV.OLLAMA_BASE, model: ENV.OLLAMA_MODEL };
  }
  return null;
}

function fetchWithTimeout(input: string, init: RequestInit = {}, ms = ENV.REQ_TIMEOUT_MS) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  const merged: RequestInit = { ...init, signal: ac.signal };
  return fetch(input, merged).finally(() => clearTimeout(t));
}

function safeJsonParse<T = any>(s: string): T | null {
  try { return JSON.parse(s); }
  catch {
    const m = s.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try { return JSON.parse(m[0]); } catch { return null; }
  }
}

function normalizeText(x: string, max = ENV.SUM_MSG_TRIM) {
  const t = (x || "")
    .replace(/\r|\t/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

function cleanArtifacts(s: string) {
  return (s || "")
    .replace(/<\|[^>]*\|>/g, "")             // <|eot_id|> 等
    .replace(/^\s*(assistant|system)\s*:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isCrudTokenOnly(s: string) {
  // URL、メンション、添付、絵文字等しか含まないなら true
  const t = (s || "").trim();
  if (!t) return true;
  const noText = t
    .replace(/https?:\/\/\S+/g, "")
    .replace(/<@[!&]?\d+>/g, "")
    .replace(/@[a-zA-Z0-9_\-]+/g, "")
    .replace(/[:*#\u{1F300}-\u{1FAFF}]/gu, "")
    .replace(/[📎🔗]/g, "")
    .replace(/[・\s]/g, "");
  return noText.length === 0;
}

function toRegex(input: string): RegExp {
  // "/pattern/flags" または "pattern" の両方を許容
  const m = input.match(/^\/(.+)\/([gimsuy]*)$/);
  if (m) {
    try { return new RegExp(m[1], m[2] as any); } catch { /* fallthrough */ }
  }
  try { return new RegExp(input, "i"); } catch { return /$a/; } // 不一致ダミー
}

function filterAndDedupe(raw: RawMsg[]) {
  const re = toRegex(ENV.SUM_SPAM_REGEX);
  const seen = new Map<string, number>();
  const out: RawMsg[] = [];

  for (const m of raw) {
    const text = (m.content || "").trim();
    if (!text) continue;
    if (re.test(text)) continue;

    const key = text
      .toLowerCase()
      .replace(/[！!。．.、,〜~ｗw\s]+/g, "")
      .replace(/https?:\/\/\S+/g, "");

    const n = (seen.get(key) ?? 0) + 1;
    if (n <= 3) out.push(m);     // 同一文3回まで許容
    seen.set(key, n);
  }
  return out;
}

// ---- Prompt ----
const CATEGORY_GUIDE = `
# カテゴリ定義（最も強い1つ、同率なら2つまで）
- TP(話題提示): 新しい話題の持ち込み。議論の余地がある。
- Q(質問): 実質的な質問（?の有無は不問）。
- S(情報共有): 事実・リンク・引用の共有（反応がなくてもよい）。
- EM(感情): 感情・感想・共感・驚き・賞賛・謝罪など。
- AG(賛同): 決定や意見への賛成/同意/共感。
- CH(雑談/その他): 上記以外の軽談。
- NG(無効): 明確なスパム/無関係/機械ノイズ。
1メッセージにつき原則1（同率で最大2）まで。簡潔に。`;

const OUTPUT_SCHEMA = `
JSONのみで出力:
{
  "oneLiner": "『この会話は◯◯について話している』の形式（句点なし・全角60字以内）",
  "topics": ["主要トピック(最大5)"],
  "bullets": ["3〜6行の要点（各 全角100字以内）"],
  "decisions": [{"what":"何を","who":"誰が","when":"いつ"}],
  "actionItems": [{"owner":"担当","task":"タスク","due":"期限(空可)"}],
  "openQuestions": [{"asker":"誰","q":"質問文"}],
  "labels": [{"id":"msgId","cat":"TP|Q|S|EM|AG|CH|NG"}],
  "notes": "補足（任意、短く）"
}`;

function buildPrompt(channelId: string, logs: RawMsg[]) {
  const head = `あなたはDiscordの会話要約アシスタントです。
- 事実に忠実に、具体語で簡潔に。
- URL/@everyone/絵文字だけの発言は無視。
- 重複は代表例のみ。
- ${CATEGORY_GUIDE}

${OUTPUT_SCHEMA}

# 入力（古い→新しい）
id | author | ts | text`;

  const body = logs
    .map(m => `${m.id} | ${m.author} | ${m.ts} | ${normalizeText(m.content)}`)
    .join("\n");

  return `${head}\n${body}`;
}

// ---- LLM calls ----
async function callChatCompat(base: string, model: string, messages: Array<{role:"system"|"user";content:string}>) {
  try {
    const r = await fetchWithTimeout(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, messages, temperature: ENV.TEMP, max_tokens: ENV.MAX_TOKENS }),
    });
    if (!r.ok) return null;
    const j: any = await r.json().catch(() => ({}));
    return (j?.choices?.[0]?.message?.content ?? null) as string | null;
  } catch { return null; }
}

async function callOllamaGenerate(base: string, model: string, prompt: string) {
  try {
    const r = await fetchWithTimeout(`${base}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, prompt, options: { temperature: ENV.TEMP, num_predict: ENV.MAX_TOKENS } }),
    });
    if (!r.ok) return null;
    const text = await r.text();
    const lines = text.trim().split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const j = JSON.parse(lines[i]);
        if (j?.response) return j.response as string;
      } catch {}
    }
    return null;
  } catch { return null; }
}

async function runLLM(prompt: string): Promise<{ parsed: any; engine: string } | null> {
  const plan = pickEngine();
  if (!plan) return null;

  // 1) chat/completions
  const content = await callChatCompat(plan.base, plan.model, [
    { role: "system", content: "あなたは正確で簡潔な議事要約者です。必ずJSONのみを返します。" },
    { role: "user", content: prompt },
  ]);
  if (content) {
    const parsed = safeJsonParse(content);
    if (parsed) return { parsed, engine: plan.kind };
  }

  // 2) ollama generate fallback
  if (plan.kind === "ollama") {
    const text = await callOllamaGenerate(plan.base, plan.model, `${prompt}\n\nJSONのみで回答。`);
    const parsed = text ? safeJsonParse(text) : null;
    if (parsed) return { parsed, engine: plan.kind };
  }

  // 3) alternate engine (auto)
  if (ENV.LLM_PROVIDER === "auto") {
    const alt = plan.kind === "llama"
      ? { kind: "ollama" as const, base: ENV.OLLAMA_BASE, model: ENV.OLLAMA_MODEL, ok: ENV.USE_OLLAMA }
      : { kind: "llama"  as const, base: ENV.LLAMA_BASE,  model: ENV.LLAMA_MODEL,  ok: ENV.USE_LLAMA  };

    if (alt.ok) {
      const c2 = await callChatCompat(alt.base, alt.model, [
        { role: "system", content: "あなたは正確で簡潔な議事要約者です。必ずJSONのみを返します。" },
        { role: "user", content: prompt },
      ]);
      if (c2) {
        const parsed = safeJsonParse(c2);
        if (parsed) return { parsed, engine: alt.kind };
      }
      if (alt.kind === "ollama") {
        const t2 = await callOllamaGenerate(alt.base, alt.model, `${prompt}\n\nJSONのみで回答。`);
        const p2 = t2 ? safeJsonParse(t2) : null;
        if (p2) return { parsed: p2, engine: alt.kind };
      }
    }
  }

  return null;
}

// ---- Embed payload ----
function toEmbedPayload(channelId: string, msgsAll: RawMsg[], msgsUsed: RawMsg[], modelOut: any, engine: string | null): PipelineOut {
  const total = msgsAll.length;
  const used  = msgsUsed.length;
  const coverageRate = total > 0 ? used / total : 0;

  let one = cleanArtifacts(modelOut?.oneLiner || modelOut?.title || "");
  if (!one || isCrudTokenOnly(one)) {
    const topics: string[] = Array.isArray(modelOut?.topics) ? modelOut.topics : [];
    const t = topics?.[0]?.trim();
    one = t && !isCrudTokenOnly(t) ? `この会話は${t}について話している` : "この会話は雑談について話している";
  }
  one = one.replace(/。+$/,"").slice(0, 60);

  const bullets: string[]      = Array.isArray(modelOut?.bullets) ? modelOut.bullets : [];
  const topics:  string[]      = Array.isArray(modelOut?.topics)  ? modelOut.topics  : [];
  const decisions: any[]       = Array.isArray(modelOut?.decisions) ? modelOut.decisions : [];
  const actionItems: any[]     = Array.isArray(modelOut?.actionItems) ? modelOut.actionItems : [];
  const openQuestions: any[]   = Array.isArray(modelOut?.openQuestions) ? modelOut.openQuestions : [];
  const labels: any[]          = Array.isArray(modelOut?.labels) ? modelOut.labels : [];

  const practical =
    [
      ...topics.slice(0, 3).map(t => `・${normalizeText(t, 80)}`),
      ...bullets.slice(0, 6).map(b => `・${normalizeText(b, 100)}`),
    ].join("\n") || "—";

  return {
    oneLiner: one || "（主題を生成できませんでした）",
    practical,
    bullets: bullets.slice(0, 10),
    decisions: decisions.slice(0, 10),
    actionItems: actionItems.slice(0, 10),
    openQuestions: openQuestions.slice(0, 10),
    labels: labels.slice(0, 200),
    coverage: { total, used, coverageRate },
    meta: { usedLlm: true, engine },
  };
}

// ---- Handler ----
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const channelId = String(body?.channelId ?? "");
    const messages: RawMsg[] = Array.isArray(body?.messages) ? body.messages : [];

    if (!channelId || !messages.length) {
      return NextResponse.json({ error: "invalid payload: channelId and messages are required" }, { status: 400 });
    }

    const plan = pickEngine();
    if (!plan) {
      return NextResponse.json({
        error: "No local LLM engine configured.",
        hint: {
          set: {
            llama:  { ANALYSIS_USE_LLAMA_CPP: "1", LLAMA_BASE: ENV.LLAMA_BASE, LLAMA_MODEL: ENV.LLAMA_MODEL },
            ollama: { ANALYSIS_USE_OLLAMA: "1", OLLAMA_BASE: ENV.OLLAMA_BASE, OLLAMA_MODEL: ENV.OLLAMA_MODEL },
            LLM_PROVIDER: "auto|llama|ollama"
          }
        }
      }, { status: 503 });
    }

    // 前処理：ノイズ抑制 + 直近 N 件（古→新）
    const filtered = filterAndDedupe(messages);
    const sliced   = filtered.slice(-ENV.SUM_MAX_MSG);
    if (sliced.length === 0) {
      return NextResponse.json({
        error: "no usable messages after filtering",
        coverage: { total: messages.length, used: 0, coverageRate: 0, missing: { reason: "filtered_out" } }
      }, { status: 422 });
    }

    // プロンプト → LLM
    const prompt = buildPrompt(channelId, sliced);
    const result = await runLLM(prompt);
    if (!result?.parsed) {
      return NextResponse.json({
        error: "LLM summarize failed (timeout or invalid response).",
        hint: {
          engineOrder: ENV.LLM_PROVIDER,
          llama:  ENV.USE_LLAMA  ? `${ENV.LLAMA_BASE}/v1/chat/completions` : "disabled",
          ollama: ENV.USE_OLLAMA ? `${ENV.OLLAMA_BASE}/v1/chat/completions|/api/generate` : "disabled",
          timeoutMs: ENV.REQ_TIMEOUT_MS
        }
      }, { status: 502 });
    }

    const payload = toEmbedPayload(channelId, messages, sliced, result.parsed, result.engine);
    return NextResponse.json(payload, { status: 200 });

  } catch (e: any) {
    console.error("[/api/summarize] fatal:", e?.stack || e);
    return NextResponse.json({ error: String(e?.message || e) }, { status: 500 });
  }
}
