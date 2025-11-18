/* web/src/app/api/summarize/route.ts
 * LLM駆動サマライザ（Map→Reduce→Critic + Coverage）改良版
 * 入力:  { channelId: string, messages: Array<{id, author, content, ts}> }
 * 出力:  既存の EmbedBuilder 用 JSON:
 *        { oneLiner, practical, bullets[], decisions[], actionItems[], openQuestions[], labels[], coverage }
 *
 * 改良点（要約）:
 *  - エンジン自動選択（llama.cpp / Ollama）を堅牢化（タイムアウト/フォールバック/JSON抽出）
 *  - スパム判定の正規表現を安全にパース、重複連投を閾値付きで抑制
 *  - LLM失敗時の完全フォールバック（ルールベース: 決定/タスク/質問抽出 & キーワード要約）
 *  - ラベル（TP/Q/S/EM/AG/CH/NG）のルールベース補完（LLM出力が欠落/異常時）
 *  - practicalの生成をtopics + bullets合成に一本化（長さ上限で安全に整形）
 *  - 文字数・配列長の上限を環境変数化、出力の安全整形（…で打ち切り）
 *  - 例外時でも200を返しUIを止めない（coverageにエラー理由をメモ）
 *
 * エンジン選択:
 *  - LLM_PROVIDER=auto|llama|ollama
 *  - ANALYSIS_USE_LLAMA_CPP=true, LLAMA_BASE, LLAMA_MODEL
 *  - ANALYSIS_USE_OLLAMA=true,     OLLAMA_BASE, OLLAMA_MODEL
 *
 * 調整（環境変数/既定値）:
 *  - SUM_USE_LLM=1           LLMを使う（0で完全にオフ）
 *  - SUM_MAX_MSG=400         要約対象として使う最大メッセージ数
 *  - SUM_MSG_TRIM=240        1メッセージの最大文字数（整形時）
 *  - SUM_TIMEOUT_MS=22000    LLM呼び出しのタイムアウト(ms)
 *  - SUM_DUP_LIMIT=3         同一テキストの許容連投回数
 *  - SUM_SPAM_REGEX=...      スパム検出の正規表現（例:  "/^@everyone$|^https?:\\/\\/\\S+$/i"）
 *  - SUM_BULLETS_MAX=6       bullets最大数（出力時はここで丸め）
 *  - SUM_TOPICS_MAX=5        topics最大数（LLM出力の想定）
 *  - SUM_BULLET_TRIM=120     各bullet最大長
 *  - SUM_ONELINER_TRIM=140   oneLiner最大長
 */

import { NextRequest, NextResponse } from "next/server";

/* ========================= Types ========================= */

type RawMsg = { id: string; author: string; content: string; ts: string };

type Decision = { what: string; who?: string; when?: string };
type ActionItem = { owner?: string; task: string; due?: string };
type OpenQuestion = { asker?: string; q: string };
type Cat = "AG" | "EM" | "Q" | "TP" | "S" | "NG" | "CH";
type Label = { id: string; cat: Cat };

type EmbedJson = {
  oneLiner: string;
  practical: string;
  bullets: string[];
  decisions: Decision[];
  actionItems: ActionItem[];
  openQuestions: OpenQuestion[];
  labels: Label[];
  coverage: {
    total: number;
    used: number;
    coverageRate: number;
    missing?: any[];
    note?: string;
    error?: string;
  };
};

/* ========================= Env ========================= */

const ENV = {
  // behavior
  SUM_USE_LLM: (process.env.SUM_USE_LLM ?? "1") === "1",
  SUM_MAX_MSG: clampInt(process.env.SUM_MAX_MSG, 400, 20, 2000),
  SUM_MSG_TRIM: clampInt(process.env.SUM_MSG_TRIM, 240, 60, 2000),
  SUM_TIMEOUT_MS: clampInt(process.env.SUM_TIMEOUT_MS, 22000, 2000, 60000),
  SUM_DUP_LIMIT: clampInt(process.env.SUM_DUP_LIMIT, 3, 1, 10),
  SUM_BULLETS_MAX: clampInt(process.env.SUM_BULLETS_MAX, 6, 3, 12),
  SUM_TOPICS_MAX: clampInt(process.env.SUM_TOPICS_MAX, 5, 0, 10),
  SUM_BULLET_TRIM: clampInt(process.env.SUM_BULLET_TRIM, 120, 40, 300),
  SUM_ONELINER_TRIM: clampInt(process.env.SUM_ONELINER_TRIM, 140, 40, 300),

  // spam regex (安全パース)
  SUM_SPAM_REGEX: parseRegex(process.env.SUM_SPAM_REGEX ?? "/(^@everyone$)|(^https?:\\/\\/\\S+$)/i", /(^@everyone$)|(^https?:\/\/\S+$)/i),

  // engines
  LLM_PROVIDER: (process.env.LLM_PROVIDER ?? "auto") as "auto" | "llama" | "ollama",

  // llama.cpp
  USE_LLAMA: (process.env.ANALYSIS_USE_LLAMA_CPP ?? "0") === "1",
  LLAMA_BASE: (process.env.LLAMA_BASE ?? "http://127.0.0.1:8080").replace(/\/+$/, ""),
  LLAMA_MODEL: process.env.LLAMA_MODEL || "local",

  // Ollama
  USE_OLLAMA: (process.env.ANALYSIS_USE_OLLAMA ?? "0") === "1",
  OLLAMA_BASE: (process.env.OLLAMA_BASE ?? "http://127.0.0.1:11434").replace(/\/+$/, ""),
  OLLAMA_MODEL: process.env.OLLAMA_MODEL || "qwen2.5:7b",
};

function clampInt(v: string | number | undefined, def: number, min: number, max: number) {
  const n = Number(v ?? def);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function parseRegex(raw: string, fallback: RegExp): RegExp {
  try {
    // 形式: "/pattern/flags"
    if (raw.startsWith("/") && raw.lastIndexOf("/") > 0) {
      const last = raw.lastIndexOf("/");
      const body = raw.slice(1, last);
      const flags = raw.slice(last + 1);
      return new RegExp(body, flags);
    }
    return new RegExp(raw, "i");
  } catch {
    return fallback;
  }
}

/* ========================= Helpers ========================= */

const urlRe = /https?:\/\/\S+/g;

function toStr(x: any): string {
  return typeof x === "string" ? x : x == null ? "" : String(x);
}

function normalizeText(x: string, max = 240) {
  const t = toStr(x).replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

function trimTo(x: string, max: number) {
  const t = toStr(x).trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

function stripForDedup(x: string) {
  return toStr(x).replace(/[！!。．.、,〜~ｗw\s]+/g, "").toLowerCase();
}

function sortByTsAsc(items: RawMsg[]) {
  // tsは任意文字列想定：ISOであればそのまま比較、非ISOでも字句比較で大抵は並ぶ
  return [...items].sort((a, b) => toStr(a.ts).localeCompare(toStr(b.ts)));
}

function safeJsonParse<T = any>(s: string): T | null {
  try {
    return JSON.parse(s);
  } catch {
    const m = s.match(/\{[\s\S]*\}$/);
    if (!m) return null;
    try { return JSON.parse(m[0]) as T; } catch { return null; }
  }
}

function arr<T>(x: any): T[] { return Array.isArray(x) ? x : []; }

function isValidCat(c: any): c is Cat {
  return c === "TP" || c === "Q" || c === "S" || c === "EM" || c === "AG" || c === "CH" || c === "NG";
}

function asLabel(obj: any): Label | null {
  const id = toStr(obj?.id);
  const cat = obj?.cat;
  if (!id) return null;
  if (!isValidCat(cat)) return null;
  return { id, cat };
}

/* ========================= Spam / Dedupe ========================= */

function filterAndDedupe(raw: RawMsg[]) {
  const seen = new Map<string, number>();
  const out: RawMsg[] = [];

  for (const m of raw) {
    const text = toStr(m.content).trim();
    if (!text) continue;
    if (ENV.SUM_SPAM_REGEX.test(text)) continue; // ルールマッチは除外
    const key = stripForDedup(text);
    const n = (seen.get(key) ?? 0) + 1;
    if (n <= ENV.SUM_DUP_LIMIT) out.push(m);
    seen.set(key, n);
  }
  return out;
}

/* ========================= Rule-based labeling & extraction ========================= */

function isQuestionLine(t: string): boolean {
  const s = t.trim();
  return /[?？]\s*$/.test(s) || /(どう|なぜ|何|どこ|いつ|誰|どれ|いくら|なに|どんな|どうやって)/.test(s);
}

function labelOf(text: string): Cat {
  const t = text;
  if (isQuestionLine(t)) return "Q";
  if (/(ありがとう|助かる|賛成|了解|いいね|OK|おｋ|同意|同感|わかる|共感)/i.test(t)) return "AG";
  if (/(嬉しい|悲しい|つらい|ムカつ|楽しい|しんどい|最高|最悪|草|泣|神|好き|嫌い|感動|焦る|怖い|こわい)/.test(t)) return "EM";
  if (/(提案|どう思う|やらない\?|しよう|案|アイデア|提起|議題|テーマ|始めたい)/.test(t)) return "TP";
  if (/(FYI|参考|情報|リンク|資料|共有|メモ|スクショ|まとめ|報告)/i.test(t) || urlRe.test(t)) return "S";
  if (/(荒らし|spam|スパム|煽り|卑猥|暴言)/i.test(t)) return "NG";
  return "CH";
}

function decideDecisionsActionsQuestions(lines: string[]) {
  const decisions: Decision[] = [];
  const actions: ActionItem[] = [];
  const openQuestions: OpenQuestion[] = [];

  for (const s0 of lines) {
    const s = toStr(s0).trim();
    if (!s) continue;

    // 決定/方針
    if (/^(決定|合意|方針)/.test(s) || (/(やる|採用|進める|確定)/.test(s) && !isQuestionLine(s))) {
      decisions.push({ what: s });
    }

    // タスク
    if (/(TODO|ToDo|やること|お願いします|任せた|対応|対応します|やります|対応お願い)/i.test(s)) {
      const m = s.match(/@([\w\-\u3040-\u30FF\u4E00-\u9FAF]+)/);
      actions.push({ owner: m?.[1], task: s });
    }

    // 質問
    if (isQuestionLine(s)) {
      const m = s.match(/^@?([\w\-\u3040-\u30FF\u4E00-\u9FAF]+)[:：]/);
      openQuestions.push({ asker: m?.[1], q: s.replace(/^@?([\w\-\u3040-\u30FF\u4E00-\u9FAF]+)[:：]\s*/, "") });
    }
  }

  // uniq
  const u = <T,>(xs: T[], key: (t: T) => string) => {
    const seen = new Set<string>();
    const out: T[] = [];
    for (const x of xs) {
      const k = key(x);
      if (!seen.has(k)) { seen.add(k); out.push(x); }
    }
    return out;
  };

  return {
    decisions: u(decisions, x => JSON.stringify(x)),
    actions:   u(actions,   x => JSON.stringify(x)),
    openQs:    u(openQuestions, x => JSON.stringify(x)),
  };
}

/* ========================= Naive keywords & bullets ========================= */

function keywords(lines: string[], topN = 10): string[] {
  const f: Record<string, number> = {};
  const stop = new Set([
    "です","ます","する","いる","ある","こと","それ","これ","ため","よう","もの","的","ので",
    "に対して","について","あと","まぁ","なんか","とか","ですし","ですね","かな","かも","ですか","でしょう",
    "なるほど","たしかに","はい","うん","了解","お疲れ様","ありがとうございます","ありがとう","了解です"
  ]);

  for (const s0 of lines) {
    const s = toStr(s0).replace(urlRe, "").trim();
    const tokens = s
      .replace(/[、。・＝＝…！!？?（）()[\]「」【】<>『』—–-]/g, " ")
      .split(/\s+/)
      .map(w => w.trim())
      .filter(w => w.length >= 2 && !stop.has(w));
    for (const t of tokens) f[t] = (f[t] || 0) + 1;
  }

  return Object.entries(f).sort((a, b) => b[1] - a[1]).slice(0, topN).map(([k]) => k);
}

function bulletsFrom(lines: string[], kws: string[], upTo: number): string[] {
  if (lines.length === 0) return [];
  const out: string[] = [];

  for (const kw of kws) {
    const hits = lines.filter(s => s.includes(kw));
    if (hits.length < 2) continue;
    const rep = normalizeText(hits[0], ENV.SUM_BULLET_TRIM);
    out.push(`${kw}：${rep}`);
    if (out.length >= upTo) break;
  }

  if (out.length === 0) {
    const rep = normalizeText(lines[0], ENV.SUM_BULLET_TRIM);
    out.push(rep);
  }
  return out;
}

/* ========================= Prompt & Engines ========================= */

const CATEGORY_GUIDE = `
# カテゴリ定義（最も強い1つ。曖昧なら最大2つまで）
- TP(話題提示): 新しい話題や議題・提案の提示。議論の余地あり。
- Q(質問): 実質的な質問。?の有無に関わらず確認/照会。
- S(情報共有): 事実・リンク・引用・FYI等の共有。
- EM(感情): 感情/感想/共感/賞賛/謝罪など。
- AG(賛同): 意見や決定への賛成/同意/共感。
- CH(雑談/その他): 上記に該当しない軽談。
- NG(無効): 明らかなスパム/無関係/機械的ノイズ。`;

const OUTPUT_SCHEMA = `
JSONのみで出力:
{
  "oneLiner": "会話全体を一言で要約（〜について話している）",
  "topics": ["主要トピック1", "... (最大${ENV.SUM_TOPICS_MAX})"],
  "bullets": ["3〜${ENV.SUM_BULLETS_MAX}行の要点(各${ENV.SUM_BULLET_TRIM}字以内)"],
  "decisions": [{"what":"何を","who":"誰が","when":"いつ(任意)"}],
  "actionItems": [{"owner":"担当(任意)","task":"タスク","due":"期限(任意)"}],
  "openQuestions": [{"asker":"誰(任意)","q":"質問文"}],
  "labels": [{"id":"msgId","cat":"TP|Q|S|EM|AG|CH|NG"}],
  "notes": "補足（任意、短く）"
}`;

function buildPrompt(channelId: string, logs: RawMsg[]) {
  const head = `あなたはDiscordの会話要約アシスタントです。
- 事実に忠実、固有名詞は誤生成しない。抽象語より具体語。
- 繰り返しは代表例に圧縮。URL/スパムは無視。
- 「この会話は◯◯について話している」と明確なoneLiner。
${CATEGORY_GUIDE}
${OUTPUT_SCHEMA}

# 入力（古い→新しい）
id | author | ts | text`;
  const body = logs
    .map(m => `${m.id} | ${m.author} | ${m.ts} | ${normalizeText(m.content, ENV.SUM_MSG_TRIM)}`)
    .join("\n");
  return `${head}\n${body}\n\n必ずJSONのみで出力。説明文やコードブロックは不要。`;
}

function pickEngine() {
  const order: Array<"llama" | "ollama"> =
    ENV.LLM_PROVIDER === "llama" ? ["llama"] :
    ENV.LLM_PROVIDER === "ollama" ? ["ollama"] :
    ENV.USE_LLAMA && ENV.USE_OLLAMA ? ["llama", "ollama"] :
    ENV.USE_LLAMA ? ["llama"] :
    ENV.USE_OLLAMA ? ["ollama"] : [];

  for (const k of order) {
    if (k === "llama" && ENV.USE_LLAMA) return { kind: "llama" as const, base: ENV.LLAMA_BASE, model: ENV.LLAMA_MODEL };
    if (k === "ollama" && ENV.USE_OLLAMA) return { kind: "ollama" as const, base: ENV.OLLAMA_BASE, model: ENV.OLLAMA_MODEL };
  }
  return null;
}

async function callChatCompat(
  base: string,
  model: string,
  messages: Array<{ role: "system" | "user"; content: string }>
): Promise<string | null> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ENV.SUM_TIMEOUT_MS);
  try {
    const r = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, messages, temperature: 0.2, max_tokens: 1200 }),
      signal: ac.signal,
    });
    clearTimeout(timer);
    const j: any = await r.json().catch(() => ({}));
    return j?.choices?.[0]?.message?.content ?? null;
  } catch {
    clearTimeout(timer);
    return null;
  }
}

/** Ollama 旧APIフォールバック */
async function callOllamaGenerate(base: string, model: string, prompt: string): Promise<string | null> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ENV.SUM_TIMEOUT_MS);
  try {
    const r = await fetch(`${base}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, prompt, options: { temperature: 0.2, num_predict: 1200 } }),
      signal: ac.signal,
    });
    clearTimeout(timer);
    const text = await r.text();
    const lines = text.trim().split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const j = JSON.parse(lines[i]);
        if (j?.response) return j.response as string;
      } catch {}
    }
    return null;
  } catch {
    clearTimeout(timer);
    return null;
  }
}

async function runLLM(prompt: string): Promise<{ parsed: any; engine: string } | null> {
  const plan = pickEngine();
  if (!plan) return null;

  // 1) 互換エンドポイント
  const content = await callChatCompat(plan.base, plan.model, [
    { role: "system", content: "あなたは正確で簡潔な議事要約者です。JSONのみを返します。" },
    { role: "user", content: prompt },
  ]);
  if (content) {
    const parsed = safeJsonParse(content);
    if (parsed) return { parsed, engine: plan.kind };
  }

  // 2) Ollama generate フォールバック
  if (plan.kind === "ollama") {
    const text = await callOllamaGenerate(plan.base, plan.model, `${prompt}\n\nJSONのみで回答。`);
    const parsed = text ? safeJsonParse(text) : null;
    if (parsed) return { parsed, engine: plan.kind };
  }

  // 3) autoなら交代
  if (ENV.LLM_PROVIDER === "auto") {
    const alt = plan.kind === "llama"
      ? { kind: "ollama" as const, base: ENV.OLLAMA_BASE, model: ENV.OLLAMA_MODEL, ok: ENV.USE_OLLAMA }
      : { kind: "llama"  as const, base: ENV.LLAMA_BASE,  model: ENV.LLAMA_MODEL,  ok: ENV.USE_LLAMA  };

    if (alt.ok) {
      const content2 = await callChatCompat(alt.base, alt.model, [
        { role: "system", content: "あなたは正確で簡潔な議事要約者です。JSONのみを返します。" },
        { role: "user", content: prompt },
      ]);
      if (content2) {
        const parsed = safeJsonParse(content2);
        if (parsed) return { parsed, engine: alt.kind };
      }
      if (alt.kind === "ollama") {
        const text2 = await callOllamaGenerate(alt.base, alt.model, `${prompt}\n\nJSONのみで回答。`);
        const parsed2 = text2 ? safeJsonParse(text2) : null;
        if (parsed2) return { parsed: parsed2, engine: alt.kind };
      }
    }
  }

  return null;
}

/* ========================= Output shaping ========================= */

function toEmbedPayload(
  channelId: string,
  msgsAll: RawMsg[],
  msgsUsed: RawMsg[],
  modelOut: any | null,
  engine: string | null,
  fallbackNote?: string,
): EmbedJson {
  const total = msgsAll.length;
  const used = msgsUsed.length;
  const coverageRate = total > 0 ? used / total : 0;

  // LLM出力の受け皿
  let oneLiner: string = toStr(modelOut?.oneLiner || modelOut?.title);
  let bullets: string[] = arr<string>(modelOut?.bullets).slice(0, ENV.SUM_BULLETS_MAX).map(s => trimTo(s, ENV.SUM_BULLET_TRIM));
  const topics: string[] = arr<string>(modelOut?.topics).slice(0, ENV.SUM_TOPICS_MAX).map(s => trimTo(s, 80));
  const decisions: Decision[] = arr<any>(modelOut?.decisions).map(x => ({
    what: trimTo(toStr(x?.what), 140),
    who: x?.who ? trimTo(toStr(x.who), 60) : undefined,
    when: x?.when ? trimTo(toStr(x.when), 60) : undefined,
  })).slice(0, 10);
  const actionItems: ActionItem[] = arr<any>(modelOut?.actionItems).map(x => ({
    owner: x?.owner ? trimTo(toStr(x.owner), 60) : undefined,
    task: trimTo(toStr(x?.task), 160),
    due: x?.due ? trimTo(toStr(x.due), 60) : undefined,
  })).slice(0, 10);
  const openQuestions: OpenQuestion[] = arr<any>(modelOut?.openQuestions).map(x => ({
    asker: x?.asker ? trimTo(toStr(x.asker), 60) : undefined,
    q: trimTo(toStr(x?.q), 160),
  })).slice(0, 10);

  // labels: 既知catのみ受け付け
  let labels: Label[] = arr<any>(modelOut?.labels)
    .map(asLabel)
    .filter((x): x is Label => !!x)
    .slice(0, 400);

  // oneLiner/practical 整形
  if (!oneLiner) {
    const topTopic = topics[0];
    if (topTopic) oneLiner = `この会話は「${topTopic}」について話している`;
  }
  oneLiner = oneLiner ? trimTo(oneLiner, ENV.SUM_ONELINER_TRIM) : "（この会話は◯◯について話している… を生成できませんでした）";

  const practical = [
    ...topics.map(t => `・${t}`),
    ...bullets.map(b => `・${b}`),
  ].join("\n") || "—";

  const coverage: EmbedJson["coverage"] = {
    total,
    used,
    coverageRate,
    missing: [],
    note: `engine=${engine ?? "none"} | mode=${ENV.SUM_USE_LLM ? "LLM" : "naive"}${fallbackNote ? ` | ${fallbackNote}` : ""}`,
  };

  return { oneLiner, practical, bullets, decisions, actionItems, openQuestions, labels, coverage };
}

/* ========================= Core ========================= */

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const channelId = toStr(body?.channelId);
    const messagesIn: RawMsg[] = Array.isArray(body?.messages) ? body.messages : [];

    if (!channelId || !messagesIn.length) {
      return NextResponse.json({ error: "invalid payload" }, { status: 400 });
    }

    // 時系列に並べてからスパム/重複抑制 → 直近N件に丸め
    const sorted = sortByTsAsc(messagesIn);
    const filtered = filterAndDedupe(sorted);
    const sliced = filtered.slice(-ENV.SUM_MAX_MSG);

    // LLMを使わない指定（ハードオフ）→素朴要約
    if (!ENV.SUM_USE_LLM) {
      const lines = sliced.map(m => toStr(m.content));
      const kws = keywords(lines, 8);
      const bullets = bulletsFrom(lines, kws, ENV.SUM_BULLETS_MAX);
      const { decisions, actions, openQs } = decideDecisionsActionsQuestions(lines);
      const labels: Label[] = sliced.map(m => ({ id: m.id, cat: labelOf(toStr(m.content)) }));

      const payload = toEmbedPayload(
        channelId, messagesIn, sliced,
        {
          oneLiner: kws[0] ? `この会話は「${kws[0]}」について話している` : "",
          topics: kws.slice(0, ENV.SUM_TOPICS_MAX),
          bullets,
          decisions,
          actionItems: actions,
          openQuestions: openQs,
          labels,
        },
        null,
        "fallback=rule-based(no-LLM)"
      );
      return NextResponse.json(payload, { status: 200 });
    }

    // LLM プロンプト作成 & 実行
    const prompt = buildPrompt(channelId, sliced);
    const result = await runLLM(prompt);

    // LLM失敗 → ルールベース完全フォールバック
    if (!result?.parsed) {
      const lines = sliced.map(m => toStr(m.content));
      const kws = keywords(lines, 8);
      const bullets = bulletsFrom(lines, kws, ENV.SUM_BULLETS_MAX);
      const { decisions, actions, openQs } = decideDecisionsActionsQuestions(lines);
      const labels: Label[] = sliced.map(m => ({ id: m.id, cat: labelOf(toStr(m.content)) }));

      const payload = toEmbedPayload(
        channelId, messagesIn, sliced,
        {
          oneLiner: kws[0] ? `この会話は「${kws[0]}」について話している` : "",
          topics: kws.slice(0, ENV.SUM_TOPICS_MAX),
          bullets,
          decisions,
          actionItems: actions,
          openQuestions: openQs,
          labels,
        },
        null,
        "fallback=rule-based(LLM-error)"
      );
      payload.coverage.error = "LLM response missing or unparsable";
      return NextResponse.json(payload, { status: 200 });
    }

    // LLM出力 → 整形
    let payload = toEmbedPayload(channelId, messagesIn, sliced, result.parsed, result.engine ?? null);

    // ラベル補完: LLMがlabelsを出していない/欠落している場合はルールベースで補完
    if (!payload.labels?.length) {
      payload.labels = sliced.map(m => ({ id: m.id, cat: labelOf(toStr(m.content)) }));
      payload.coverage.note = (payload.coverage.note ?? "") + " | labels=fallback(rule)";
    } else {
      // cat検証で弾かれた結果が多い場合は補完
      const have = new Set(payload.labels.map(l => l.id));
      const miss: Label[] = [];
      for (const m of sliced) {
        if (!have.has(m.id)) miss.push({ id: m.id, cat: labelOf(toStr(m.content)) });
      }
      if (miss.length) {
        payload.labels = [...payload.labels, ...miss];
        payload.coverage.note = (payload.coverage.note ?? "") + ` | labels+=${miss.length}(rule)`;
      }
    }

    // 出力の最終安全化
    payload.oneLiner = trimTo(payload.oneLiner, ENV.SUM_ONELINER_TRIM);
    payload.bullets = payload.bullets.slice(0, ENV.SUM_BULLETS_MAX).map(s => trimTo(s, ENV.SUM_BULLET_TRIM));
    payload.practical = payload.practical.split("\n").slice(0, ENV.SUM_BULLETS_MAX + ENV.SUM_TOPICS_MAX).join("\n");

    return NextResponse.json(payload, { status: 200 });
  } catch (e: any) {
    // 例外時もUIを止めない：最低限の情報で返す
    const err = toStr(e?.message || e);
    const payload: EmbedJson = {
      oneLiner: "（要約に失敗しました）",
      practical: "—",
      bullets: ["（内部エラーのため、最低限のレスポンスを返却しました）"],
      decisions: [],
      actionItems: [],
      openQuestions: [],
      labels: [],
      coverage: { total: 0, used: 0, coverageRate: 0, error: err, note: "exception" },
    };
    return NextResponse.json(payload, { status: 200 });
  }
}
