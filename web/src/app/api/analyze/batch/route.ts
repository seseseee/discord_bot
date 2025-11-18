// src/app/api/analyze/batch/route.ts
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { classifyMessage, normalizeLabel, type Label, LABELS } from "@/lib/rules";

/* ─────────────────────────────────────────────────────────────
 * Next.js 実行環境（Prisma 使用のため Edge を回避）
 * ───────────────────────────────────────────────────────────── */
export const runtime = "nodejs";

/* ─────────────────────────────────────────────────────────────
 * Settings (env)
 * ───────────────────────────────────────────────────────────── */
const USE_OLLAMA       = (process.env.ANALYSIS_USE_OLLAMA || "0") === "1";
const USE_LLAMA        = (process.env.ANALYSIS_USE_LLAMA_CPP || "0") === "1";
const OLLAMA_BASE      = (process.env.OLLAMA_BASE || "http://127.0.0.1:11434").replace(/\/+$/, "");
const OLLAMA_MODEL     = process.env.OLLAMA_MODEL || "qwen2.5:7b";
const LLAMA_BASE       = (process.env.LLAMA_BASE || "http://127.0.0.1:8080").replace(/\/+$/, "");
const LLAMA_MODEL      = process.env.LLAMA_MODEL || "llama";
const ANALYZE_API_KEY  = process.env.ANALYZE_API_KEY || ""; // 任意: 認証
const LLM_THRESHOLD    = Number(process.env.ANALYSIS_LLM_THRESHOLD ?? "0.75"); // これ以上なら LLM 呼出しをスキップ
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS ?? "15000");
const MAX_LIMIT        = 100; // API 安全上限
const MAX_LLM_CONC     = Math.max(1, Number(process.env.ANALYSIS_CONCURRENCY ?? "2")); // LLM同時実行

/* ─────────────────────────────────────────────────────────────
 * 小ユーティリティ
 * ───────────────────────────────────────────────────────────── */
const asBool = (v: string | null, def = false) =>
  v ? ["1", "true", "yes"].includes(v.toLowerCase()) : def;

function timeoutFetch(input: RequestInfo | URL, init: RequestInit = {}, ms = FETCH_TIMEOUT_MS) {
  const ac = new AbortController();
  const id = setTimeout(() => ac.abort(), ms);
  return fetch(input, { ...init, signal: ac.signal }).finally(() => clearTimeout(id));
}

function extractJsonObject(s: string): any | undefined {
  if (!s) return;
  const src = String(s).slice(0, 256 * 1024);
  // 末尾近傍の { ... } を優先
  const m = src.match(/\{[\s\S]*\}\s*$/);
  if (m) {
    try { return JSON.parse(m[0]); } catch {}
  }
  // 行ごとに最初に parse できたもの
  const lines = src.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const tail = lines.slice(i).join("\n");
    const mm = tail.match(/\{[\s\S]*\}/);
    if (mm) {
      try { return JSON.parse(mm[0]); } catch {}
    }
  }
  return;
}

type Comp = { label: Label; pct: number };
const uniq = <T,>(arr: T[]) => Array.from(new Set(arr));
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
function padComposition(comp?: Comp[]): Comp[] {
  const map = new Map<Label, number>();
  (comp || []).forEach(c => map.set(c.label, c.pct));
  return LABELS.map(l => ({ label: l, pct: map.get(l) ?? 0 }));
}
function evenComp(labels: Label[]): Comp[] {
  const set = Array.from(new Set(labels));
  if (set.length === 0) return LABELS.map(l => ({ label: l, pct: 0 }));
  const per = Math.round((100 / set.length) * 100) / 100;
  const m = new Map<Label, number>();
  set.forEach(l => m.set(l, per));
  return LABELS.map(l => ({ label: l, pct: m.get(l) ?? 0 }));
}
function singleComp(label: Label): Comp[] {
  const m = new Map<Label, number>(); m.set(label, 100);
  return LABELS.map(l => ({ label: l, pct: m.get(l) ?? 0 }));
}
function chooseFirstValidLabel(candidates: string[]): Label | null {
  for (const c of candidates) {
    const up = (c || "").toUpperCase().trim() as Label;
    if ((LABELS as readonly Label[]).includes(up)) return up;
  }
  return null;
}
function normalizeForMatch(s: string) {
  return (s || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/* ─────────────────────────────────────────────────────────────
 * Trigger 学習の適用
 * ───────────────────────────────────────────────────────────── */
type TriggerRow = {
  phrase: string;
  pattern?: string | null;
  label: string;
  hits?: number | null;
  weight?: number | null;
};
function applyTriggersToText(
  textRaw: string,
  triggers: TriggerRow[]
): { best?: Label; labs: Label[]; why: string[]; score: number; exact: boolean } {
  const text = (textRaw || "").trim();
  if (!text || !triggers?.length) return { labs: [], why: [], score: 0, exact: false };

  const score = new Map<Label, number>();
  const why: string[] = [];
  let exact = false;
  const normText = normalizeForMatch(text);

  for (const t of triggers) {
    const lab = chooseFirstValidLabel([t.label]);
    if (!lab) continue;

    const phrase = t.phrase || "";
    const normPhrase = normalizeForMatch(phrase);
    const hasExact = normText === normPhrase && normPhrase.length > 0;

    let matched = false;
    if (t.pattern && !matched) {
      try {
        const re = new RegExp(t.pattern, "i");
        if (re.test(text)) matched = true;
      } catch {}
    }
    if (!matched && normPhrase) {
      if (normText.includes(normPhrase)) matched = true;
    }
    if (!matched && hasExact) matched = true;

    if (!matched) continue;

    const freq = (t.hits ?? 0) + 1;
    const base = 1 + Math.log1p(Math.max(0, freq));
    const w = (t.weight ?? 1) * (hasExact ? 2.5 : 1.2) * base;

    score.set(lab, (score.get(lab) ?? 0) + w);
    const tag = hasExact ? `"${phrase}"(=exact)` : (t.pattern ? `/${t.pattern}/` : `"${phrase}"`);
    why.push(`${lab}:${tag}×${t.hits ?? 0}`);
    if (hasExact) exact = true;
  }

  let best: Label | undefined;
  let bestVal = 0;
  for (const [lb, sc] of score.entries()) {
    if (sc > bestVal) { bestVal = sc; best = lb; }
  }
  const labs = Array.from(score.keys());
  return { best, labs, why, score: bestVal, exact };
}

/* ─────────────────────────────────────────────────────────────
 * LLM 呼び出し（Ollama / llama.cpp 両対応）
 * ───────────────────────────────────────────────────────────── */
async function callOllama(text: string): Promise<{ label?: string; confidence?: number; rationale?: string }> {
  const prompt = [
    "あなたは短文チャットのラベラーです。以下の発言に 1つ以上のラベルを付与します。",
    "labels = [AG, TP, EM, S, Q, CH, NG]",
    "TP: 新しい話題の持ち込み / Q: 質問 / S: 情報共有 / EM: 感情 / AG: 同意 / NG: 反対 / CH: その他",
    '出力は JSON のみ。{"label":"AG|TP など | 区切り可","confidence":0.0～1.0,"rationale":"日本語で理由"}',
    `発言: """${text}"""`,
  ].join("\n");

  // 1) OpenAI互換API
  try {
    const r = await timeoutFetch(`${OLLAMA_BASE}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        messages: [
          { role: "system", content: "JSON only. Reply in Japanese." },
          { role: "user", content: prompt }
        ],
        temperature: 0.1,
        max_tokens: 256,
      }),
    });
    if (r.ok) {
      const j: any = await r.json().catch(() => ({}));
      const out: string =
        j?.choices?.[0]?.message?.content ??
        j?.choices?.[0]?.text ?? "";
      const parsed = extractJsonObject(out);
      if (parsed) return parsed;
    }
  } catch {}

  // 2) 旧 /api/generate
  const res = await timeoutFetch(`${OLLAMA_BASE}/api/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      prompt,
      stream: false,
      options: { temperature: 0.1, num_predict: 256 },
    }),
  });
  if (!res.ok) throw new Error(`ollama ${res.status} ${res.statusText}`);
  const json: any = await res.json().catch(() => ({}));
  const out = typeof json?.response === "string" ? json.response : "";
  return extractJsonObject(out) ?? {};
}

let llamaCompatAvailable: boolean | null = null;

async function llamaOpenAICompat(text: string) {
  const url = `${LLAMA_BASE}/v1/chat/completions`;
  const messages = [
    { role: "system", content: "You are a precise JSON-only classifier. Reply in Japanese. Output JSON only." },
    { role: "user", content: [
      "labels=[AG,TP,EM,S,Q,CH,NG]。出力はJSONのみ。",
      '形式: {"label":"AG|TP など | 区切り可","confidence":0.0-1.0,"rationale":"理由(日本語)"}',
      `発言: """${text}"""`,
    ].join("\n") }
  ];
  const res = await timeoutFetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: LLAMA_MODEL, messages, temperature: 0.1, max_tokens: 256, stream: false }),
  });
  if (!res.ok) throw new Error(`llama OpenAI-compat ${res.status} ${res.statusText}`);
  const data: any = await res.json();
  const out: string =
    data?.choices?.[0]?.message?.content ??
    data?.choices?.[0]?.text ?? "";
  return extractJsonObject(out) ?? {};
}

async function llamaNativeCompletion(text: string) {
  const url = `${LLAMA_BASE}/completion`;
  const prompt = [
    "### System:",
    "You are a precise JSON-only classifier. Reply in Japanese.",
    "",
    "### User:",
    `labels=[AG,TP,EM,S,Q,CH,NG]。{"label":"...","confidence":0.0-1.0,"rationale":"..."} のJSONのみで返答。`,
    `発言: """${text}"""`,
    "",
    "### Assistant:\n",
  ].join("\n");
  const res = await timeoutFetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt, temperature: 0.1, n_predict: 256, cache_prompt: true, stream: false, model: LLAMA_MODEL }),
  });
  if (!res.ok) throw new Error(`llama /completion ${res.status} ${res.statusText}`);
  const data: any = await res.json().catch(() => ({}));
  const out: string =
    data?.content ??
    data?.response ??
    data?.choices?.[0]?.text ??
    data?.choices?.[0]?.message?.content ?? "";
  return extractJsonObject(out) ?? {};
}

async function callLlama(text: string): Promise<{ label?: string; confidence?: number; rationale?: string }> {
  if (llamaCompatAvailable === null) {
    try {
      const ping = await timeoutFetch(`${LLAMA_BASE}/v1/models`, { method: "GET" }, 5000);
      llamaCompatAvailable = ping.ok;
    } catch { llamaCompatAvailable = false; }
  }
  return llamaCompatAvailable ? llamaOpenAICompat(text) : llamaNativeCompletion(text);
}

async function callLLM(text: string): Promise<{ label?: string; confidence?: number; rationale?: string }> {
  if (USE_OLLAMA) {
    try { return await callOllama(text); }
    catch {
      if (USE_LLAMA) { try { return await callLlama(text); } catch {} }
      return {};
    }
  }
  if (USE_LLAMA) {
    try { return await callLlama(text); }
    catch {
      if (USE_OLLAMA) { try { return await callOllama(text); } catch {} }
      return {};
    }
  }
  return {};
}

/* ─────────────────────────────────────────────────────────────
 * 簡易 limiter（外部依存を入れずに LLM 同時実行を制限）
 * ───────────────────────────────────────────────────────────── */
function createLimiter(limit = 2) {
  let active = 0;
  const q: Array<() => void> = [];
  const next = () => {
    active--;
    const fn = q.shift();
    if (fn) fn();
  };
  return async function <T>(task: () => Promise<T>): Promise<T> {
    if (active >= limit) await new Promise<void>(res => q.push(res));
    active++;
    try { return await task(); } finally { next(); }
  };
}
const withLLM = createLimiter(MAX_LLM_CONC);

/* ─────────────────────────────────────────────────────────────
 * Route
 * ───────────────────────────────────────────────────────────── */
export async function POST(req: NextRequest) {
  const t0 = performance.now();
  try {
    // 認可（任意）
    const auth = req.headers.get("authorization") || "";
    if (ANALYZE_API_KEY && auth !== `Bearer ${ANALYZE_API_KEY}`) {
      return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
    }

    // クエリ
    const { searchParams } = new URL(req.url);
    const serverId = searchParams.get("serverId") ?? "";
    const force    = asBool(searchParams.get("force"), false);
    const limitArg = Math.min(Number(searchParams.get("limit") ?? "50"), MAX_LIMIT);
    const idsParam = (searchParams.get("ids") ?? "").trim();
    const ids      = idsParam ? idsParam.split(",").map(s => s.trim()).filter(Boolean) : [];

    if (!serverId) {
      return NextResponse.json({ ok: false, error: "missing serverId" }, { status: 400 });
    }

    // 取得条件
    const whereBase: any = { serverId };
    if (ids.length) whereBase.id = { in: ids };
    const where = force ? whereBase : { ...whereBase, labels: { none: {} } };

    // 取得（ids 指定時は limit を超えないように）
    const take = ids.length ? Math.min(ids.length, limitArg) : limitArg;

    const [msgs, triggers] = await Promise.all([
      prisma.message.findMany({
        where,
        orderBy: { createdAt: "asc" },
        take,
        include: {
          labels:    { orderBy: { createdAt: "desc" }, take: 1, select: { label: true } },
          feedbacks: { orderBy: { createdAt: "desc" }, take: 16 }, // 票は多めに見る
        },
      }),
      prisma.trigger.findMany({
        where: { serverId },
        select: { phrase: true, pattern: true, label: true, hits: true, weight: true },
      }),
    ]);

    if (!msgs.length) {
      const remaining = await prisma.message.count({ where: { serverId, labels: { none: {} } } });
      const took_ms = Math.round(performance.now() - t0);
      return NextResponse.json({ ok: true, analyzed: 0, remaining, took_ms, results: {} });
    }

    type AnalyzeOut = {
      messageId: string;
      label: Label;
      labels: Label[];
      confidence: number;
      rationale: string;
      composition: Comp[];
      prev: Label | null;
      sources: string[];
    };

    const results: Record<string, AnalyzeOut> = {};
    const writes: ReturnType<typeof prisma.label.create>[] = [];

    // 並列（ただし LLM は limiter 経由）
    await Promise.all(
      msgs.map(async (m) => {
        const text = String(m.contentText ?? "");
        const sources: string[] = [];

        // 0) Trigger
        let picked: Label | null = null;
        let pickedLabels: Label[] = [];
        let composition: Comp[] = [];
        let confidence = 0.8;
        let rationale = "";

        let tRes:
          | { best?: Label; labs: Label[]; why: string[]; score: number; exact: boolean }
          | undefined;

        if (triggers.length) {
          tRes = applyTriggersToText(text, triggers);
          if (tRes.best) {
            picked = tRes.best;
            pickedLabels = uniq<Label>([tRes.best, ...tRes.labs]);
            composition = pickedLabels.length > 1 ? evenComp(pickedLabels) : singleComp(tRes.best);
            confidence = tRes.exact ? 0.98 : Math.max(confidence, clamp01(0.75 + tRes.score * 0.08));
            rationale  = `source:trigger ${tRes.exact ? "(exact)" : ""} → ${tRes.why.join(",")}`;
            sources.push("trigger");
          }
        }

        // 1) Rule
        if (!picked) {
          const base = classifyMessage(text);
          const baseLabel = (base.label ?? "CH") as Label;
          picked = baseLabel;
          pickedLabels = Array.isArray(base.labels) ? (base.labels as Label[]) : [baseLabel];
          // ルールが composition を返す場合は埋める。なければ主ラベル100%
          composition = (base as any)?.composition ? padComposition((base as any).composition) : singleComp(baseLabel);
          confidence = typeof base.confidence === "number" ? base.confidence : confidence;
          rationale  = `source:rule → ${base.rationale ?? ""}`;
          sources.push("rule");
        }

        // 2) LLM（確信度不足 & trigger 完全一致でない）
        const needLLM =
          (USE_OLLAMA || USE_LLAMA) &&
          !(tRes?.exact) &&
          (confidence < LLM_THRESHOLD);

        if (needLLM) {
          try {
            const o = await withLLM(() => callLLM(text));
            const norm = normalizeLabel(String(o?.label ?? ""), text);
            if (norm && (LABELS as readonly Label[]).includes(norm)) {
              picked = norm;
              const llmConf = typeof o?.confidence === "number" ? clamp01(o.confidence) : confidence;
              confidence = Math.max(confidence, llmConf);
              rationale  = `${rationale} / source:llm → ${String(o?.rationale ?? "")}`.trim();
              pickedLabels = uniq<Label>([picked, ...pickedLabels]);
              composition = pickedLabels.length > 1 ? evenComp(pickedLabels) : singleComp(picked);
              sources.push("llm");
            }
          } catch {
            // LLM失敗は無視（rule/trigger結果を維持）
          }
        }

        // 3) Feedback 最優先（複数票 → 均等配分）
        const fbs = (m as any).feedbacks as Array<{ label: Label; userId?: string | null }> | undefined;
        if (Array.isArray(fbs) && fbs.length) {
          const fbLabels = uniq<Label>(
            fbs.map(f => f.label).filter((l): l is Label => (LABELS as readonly Label[]).includes(l))
          );
          if (fbLabels.length) {
            picked = fbLabels[0];
            pickedLabels = fbLabels;
            composition = evenComp(fbLabels);
            confidence = Math.max(confidence, 0.95);
            const who = fbs[0]?.userId ? ` by ${fbs[0].userId}` : "";
            rationale = `${rationale ? rationale + " / " : ""}source:feedback(${m.id}) → ${fbLabels.join("|")}${who}`;
            sources.push("feedback");
          }
        }

        // セーフティ：最終的に必ず何かのラベル
        if (!picked) picked = "CH";

        // 書き込みをバッチ化（履歴として label を積む）
        writes.push(
          prisma.label.create({
            data: {
              messageId: m.id,
              label: picked,
              confidence: clamp01(confidence),
              rationale,
              infoMentions: null,
              createdAt: new Date(),
            },
          })
        );

        const prev = (m.labels?.[0]?.label ?? null) as Label | null;
        results[m.id] = {
          messageId: m.id,
          label: picked,
          labels: uniq<Label>([picked, ...pickedLabels]),
          confidence: clamp01(confidence),
          rationale,
          composition,
          prev,
          sources,
        };
      })
    );

    // 一括コミット（高速・整合）
    if (writes.length) await prisma.$transaction(writes);

    const remaining = await prisma.message.count({
      where: { serverId, labels: { none: {} } },
    });
    const took_ms = Math.round(performance.now() - t0);

    return NextResponse.json({
      ok: true,
      analyzed: Object.keys(results).length,
      remaining,
      took_ms,
      results,
    });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: String(err?.message ?? err) }, { status: 500 });
  }
}
