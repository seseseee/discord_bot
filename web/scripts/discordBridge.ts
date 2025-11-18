/* scripts/discordBridge.ts
 * /summary と /backfill の安定版（LLM一文リファイン対応）
 * + 追加:
 *   - ✅ ラベル修正の復元（TRUST_USER_IDS 限定）
 *       - 絵文字リアクション → ラベル付与/削除（/api/feedback）
 *       - /label message_id label notes
 *   - ✅ 未回答Qの掘り起こし（/resurface エフェメラル一覧）
 *
 * 絵文字 ↔ ラベル:
 *   AG（同意）: 👍
 *   TP（話題）: 🗓️
 *   EM（感情）: 😊
 *   S（共有）  : ℹ️
 *   Q（質問）  : ❓
 *   CH（雑談） : 💬
 *   NG（反対） : ⛔
 */

import {
  Client, GatewayIntentBits, Partials, Events,
  TextChannel, Message, ChannelType, Collection, Snowflake,
  REST, Routes, SlashCommandBuilder, EmbedBuilder,
  type MessageReaction, type PartialMessage
} from "discord.js";
// 既存 import に追加
import {
  // ...
  type PartialMessageReaction,
  type PartialUser,
  type MessageReactionEventDetails,
  type User,
} from "discord.js";


/* ========= 環境変数 ========= */
const TOKEN      = process.env.DISCORD_TOKEN || "";
const APP_ID     = process.env.DISCORD_APP_ID || process.env.DISCORD_CLIENT_ID || "";
const GUILD_ID   = process.env.SERVER_ID || process.env.NEXT_PUBLIC_SERVER_ID || "";
const BASE       = (process.env.ANALYZER_BASE || process.env.BASE_URL || "http://localhost:3001").replace(/\/+$/, "");

const REGISTER_SLASH = (process.env.REGISTER_SLASH || "true") === "true";
const ANALYSIS_CHANNEL_ID = process.env.ANALYSIS_CHANNEL_ID || process.env.DISCORD_ANALYSIS_CHANNEL_ID || "";

/* --- 信頼ユーザー（カテゴリ修正権限） --- */
const TRUST_USER_IDS = (process.env.TRUST_USER_IDS || "675572098885746689")
  .split(",").map(s=>s.trim()).filter(Boolean);
const TRUST_SET = new Set(TRUST_USER_IDS);

/* --- 取得対象CHフィルタ --- */
const RAW_FILTER = (process.env.DISCORD_CHANNEL_IDS || "").split(",").map(s=>s.trim()).filter(Boolean);
const INCLUDE = RAW_FILTER.filter(id => !id.startsWith("!") && id !== "");
const EXCLUDE = RAW_FILTER.filter(id => id.startsWith("!")).map(id => id.slice(1));

/* --- サマリ設定 --- */
const SUMMARY_ALL_HISTORY = (process.env.SUMMARY_ALL_HISTORY || "0") === "1";
const SUMMARY_HARD_CAP    = numEnv(process.env.SUMMARY_HARD_CAP, 5000, 100, 20000);
const SNAP_LOOKBACK_DAYS  = numEnv(process.env.SUMMARY_LOOKBACK_DAYS, 3, 1, 30);
const SNAP_FETCH_LIMIT    = numEnv(process.env.SUMMARY_FETCH_LIMIT, 120, 20, 500);

/* --- LLM設定 --- */
const USE_LLAMA_CPP = (process.env.ANALYSIS_USE_LLAMA_CPP || "0") === "1";
const LLAMA_BASE    = (process.env.LLAMA_BASE  || "http://127.0.0.1:8080").replace(/\/+$/, "");
const LLAMA_MODEL   = process.env.LLAMA_MODEL || "";
const USE_OLLAMA    = (process.env.ANALYSIS_USE_OLLAMA || "0") === "1";
const OLLAMA_BASE   = (process.env.OLLAMA_BASE  || "http://127.0.0.1:11434").replace(/\/+$/, "");
const OLLAMA_MODEL  = process.env.OLLAMA_MODEL || "qwen2.5:7b";

const LLM_PROVIDER  = (process.env.LLM_PROVIDER || "auto").toLowerCase(); // "auto" | "llama" | "ollama"
const FORCE_LLM_REFINE = (process.env.FORCE_LLM_REFINE || "0") === "1";

/* --- 定数/タイムアウト推定 --- */
const FETCH_CHUNK_SIZE = 100; // Discord API の上限
const MAX_TEXT = 4000;
const FLAGS_EPHEMERAL = 64; // MessageFlags.Ephemeral

//  要約APIの動的タイムアウト
const API_TIMEOUT_BASE_MS = numEnv(process.env.API_TIMEOUT_BASE_MS, 25_000, 10_000, 300_000);
const API_TIMEOUT_PER_CHUNK_MS = numEnv(process.env.API_TIMEOUT_PER_CHUNK_MS, 7_000, 1_000, 60_000);
const MAP_MAX_MSGS_PER_CHUNK_HINT = numEnv(process.env.MAP_MAX_MSGS_PER_CHUNK_HINT, 120, 40, 300);

function estimateSummarizeTimeout(msgCount: number): number {
  const chunks = Math.max(1, Math.ceil(msgCount / MAP_MAX_MSGS_PER_CHUNK_HINT));
  const est = API_TIMEOUT_BASE_MS + API_TIMEOUT_PER_CHUNK_MS * chunks;
  return Math.min(est, numEnv(process.env.API_TIMEOUT_MAX_MS, 240_000, 60_000, 600_000));
}

/* ========= 前提チェック ========= */
if (!TOKEN)    { console.error("[bridge] ERR: DISCORD_TOKEN 未設定"); process.exit(1); }
if (!GUILD_ID) { console.error("[bridge] ERR: SERVER_ID/NEXT_PUBLIC_SERVER_ID 未設定"); process.exit(1); }
if (!/^https?:\/\//i.test(BASE)) { console.warn(`[bridge] WARN: BASE_URL/ANALYZER_BASE がHTTPではなさそう: ${BASE}`); }

/* ========= Discord client ========= */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions, // ★ リアクションでラベル修正
  ],
  partials: [Partials.Channel, Partials.Message, Partials.Reaction, Partials.User], // ★ リアクション
});

/* ========= 競合防止（チャンネル単位ロック） ========= */
const inFlightSummary = new Set<string>();

/* ========= ユーティリティ ========= */
const sleep = (ms:number)=> new Promise(r=>setTimeout(r, ms));
const fromDays  = (d:number)=> d*24*60*60*1000;
const fromHours = (h:number)=> h*60*60*1000;

function numEnv(v: any, def: number, min: number, max: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function isGuildText(ch: any): ch is TextChannel {
  return !!ch && ch.type === ChannelType.GuildText && typeof (ch as TextChannel).isTextBased === "function";
}
function isAnalysisChannelId(channelId: string) {
  return Boolean(ANALYSIS_CHANNEL_ID) && channelId === ANALYSIS_CHANNEL_ID;
}
function inFilter(channelId: string) {
  if (isAnalysisChannelId(channelId)) return false;
  if (EXCLUDE.includes(channelId)) return false;
  if (INCLUDE.length === 0) return true;
  return INCLUDE.includes(channelId);
}
function stripCtl(s: string) {
  return (s || "").replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "");
}
function excerpt(s: string, n: number) {
  const t = stripCtl((s || "").replace(/\s+/g, " ").trim());
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}
function embedText(s: string | undefined, max=1024){ return excerpt(s || "—", max); }

function materializeContent(msg: Message): string {
  const parts: string[] = [];
  const base = (msg.content || "").trim();
  if (base) parts.push(base);

  // @ts-ignore
  const ref = (msg as any).referencedMessage as Message | undefined;
  if (ref) {
    const refText = (ref.content || (ref.embeds?.[0]?.title || "") + " " + (ref.embeds?.[0]?.description || "") || "").trim();
    if (refText) parts.push(`↩️ ${excerpt(refText, 240)}`);
  }
  if (msg.embeds && msg.embeds.length) {
    msg.embeds.forEach(e => {
      const t = [(e.title || ""), (e.description || "")].filter(Boolean).join(" — ");
      if (t) parts.push(`🔗 ${excerpt(t, 300)}`);
    });
  }
  const atts = [...(msg.attachments?.values?.() || [])];
  if (atts.length) parts.push(...atts.map(a => `📎${a.name || "file"} ${a.url}`));

  return parts.join("\n").slice(0, MAX_TEXT);
}

async function ensureApiReady(): Promise<void> {
  const url = `${BASE}/api/ping`;
  for (let i = 1; i <= 20; i++) {
    try {
      const r = await fetch(url, { method: "GET" });
      if (r.ok) { console.log(`[bridge] API ready: ${url} tries=${i}`); return; }
      console.warn(`[bridge] API not ready (${r.status})`);
    } catch {}
    await sleep(800);
  }
  console.warn(`[bridge] WARN: API not reachable: ${url}（/api/summarize はフォールバックの可能性）`);
}

/* ========= Snowflake/time ========= */
const DISCORD_EPOCH = 1420070400000;
function toSnowflakeFromMs(ms:number): string {
  const v = BigInt(ms - DISCORD_EPOCH) << 22n;
  return v.toString();
}

/* ========= メッセージ取得 ========= */
async function fetchChannelMessagesSince(
  ch: TextChannel,
  sinceMs: number,
  maxCount = SNAP_FETCH_LIMIT
): Promise<Message[]> {
  const after = toSnowflakeFromMs(sinceMs);
  let out: Message[] = [];
  let lastId: string | undefined = after;

  while (out.length < maxCount) {
    const n = Math.min(FETCH_CHUNK_SIZE, maxCount - out.length);
    const batch: Collection<Snowflake, Message> | null =
      (await ch.messages.fetch({ limit: n, after: lastId }).catch(()=> null)) as Collection<Snowflake, Message> | null;
    if (!batch || batch.size === 0) break;

    const sorted: Message[] = [...batch.values()].sort((a: Message, b: Message) =>
      BigInt(a.id) < BigInt(b.id) ? -1 : 1
    );
    out = out.concat(sorted.filter((m: Message) => !m.author?.bot));
    lastId = sorted[sorted.length - 1]?.id;
    await sleep(250);
  }
  out.sort((a: Message, b: Message)=> ((a as any).createdTimestamp||0)-((b as any).createdTimestamp||0));
  return out;
}

async function fetchChannelMessagesAll(ch: TextChannel, hardCap = SUMMARY_HARD_CAP): Promise<Message[]> {
  let out: Message[] = [];
  let before: string | undefined = undefined;

  while (out.length < hardCap) {
    const n = Math.min(FETCH_CHUNK_SIZE, hardCap - out.length);
    const batch: Collection<Snowflake, Message> | null =
      (await ch.messages.fetch({ limit: n, before }).catch(()=> null)) as Collection<Snowflake, Message> | null;
    if (!batch || batch.size === 0) break;

    const sorted: Message[] = [...batch.values()].sort((a: Message, b: Message) =>
      BigInt(a.id) < BigInt(b.id) ? 1 : -1 // 新→古
    );
    sorted.forEach((m: Message) => { if (!m.author?.bot) out.push(m); });
    before = sorted[sorted.length - 1]?.id;
    await sleep(300);
  }
  out.sort((a: Message, b: Message)=> ((a as any).createdTimestamp||0)-((b as any).createdTimestamp||0));
  return out;
}

/* ========= /api/summarize 呼び出し ========= */
export type RawMsg = { id: string; author: string; content: string; ts: string };

async function fetchJsonWithTimeout(url: string, init: RequestInit = {}, timeoutMs = 60_000, retry = 2): Promise<any> {
  for (let attempt = 0; attempt <= retry; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const r = await fetch(url, { ...init, signal: ac.signal });
      clearTimeout(timer);
      if (!r.ok) throw new Error(`${url} ${r.status}`);
      return await r.json();
    } catch (err) {
      clearTimeout(timer);
      if (attempt < retry) {
        const backoff = Math.min(1500 * Math.pow(2, attempt), 6000);
        await sleep(backoff);
        continue;
      }
      throw err;
    }
  }
  throw new Error("unreachable");
}

async function callSummarizeApi(channelId: string, messages: RawMsg[]): Promise<any> {
  const url = `${BASE}/api/summarize`;
  const timeout = estimateSummarizeTimeout(messages.length);
  return await fetchJsonWithTimeout(url, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ channelId, messages }),
  }, timeout, 2);
}

/* ========= Embed構築 ========= */
function buildSummaryEmbedFromPipeline(guildId: string, ch: TextChannel, sr: any): EmbedBuilder {
  const eb = new EmbedBuilder()
    .setTitle("要約カード（Map→Reduce→Critic＋Coverage）")
    .setDescription(embedText(`Channel: <#${ch.id}>  | Coverage: ${(((sr.coverage?.coverageRate)||0)*100).toFixed(1)}%`, 2048))
    .addFields(
      { name: "一文サマリ", value: embedText(sr.oneLiner) },
      { name: "実務サマリ(抜粋)", value: embedText(sr.practical) },
      { name: "箇条書き", value: embedText((sr.bullets||[]).slice(0,10).map((b:string)=>`• ${b}`).join("\n")) },
      { name: "決定", value: embedText((sr.decisions||[]).slice(0,7).map((d:any)=>`• ${d.what}${d.who?`（${d.who}`:""}${d.when?` / ${d.when}`:""}${d.who?`）`:""}`).join("\n")) },
      { name: "アクション", value: embedText((sr.actionItems||[]).slice(0,7).map((a:any)=>`• ${a.owner?`${a.owner}: `:""}${a.task}${a.due?` / ${a.due}`:""}`).join("\n")) },
      { name: "未解決Q", value: embedText((sr.openQuestions||[]).slice(0,7).map((q:any)=>`• ${q.asker?`${q.asker}: `:""}${q.q}`).join("\n")) },
      { name: "カテゴリ分布", value: embedText((() => {
          const agg: Record<string, number> = {};
          (sr.labels||[]).forEach((l:any)=> agg[l.cat]=(agg[l.cat]||0)+1);
          const line = Object.entries(agg).map(([k,v])=>`${k}:${v}`).join(" / ");
          return line || "—";
        })()) }
    )
    .setTimestamp(new Date());

  if (sr.coverage?.missing && Array.isArray(sr.coverage.missing) && sr.coverage.missing.length > 0) {
    const body = JSON.stringify(sr.coverage.missing.slice(0, 3), null, 2);
    eb.addFields({ name: "不足一覧（例）", value: embedText("```json\n" + body + "\n```", 1024) });
  }

  if (sr.meta?.usedLlm) {
    eb.setFooter({ text: `LLM refine: ON (${sr.meta.engine || "?"})` });
  } else {
    eb.setFooter({ text: `LLM refine: OFF` });
  }
  return eb;
}

/* ========= LLM フォールバック（簡易要約） ========= */
export type LlmSummaryOut = { bullets: string[]; next: string };
function truncate(s: string, max = 200) { return excerpt(s, max); }
function buildSummaryPrompt(logs: {author:string; text:string}[]){
  const header =
`あなたはDiscordの会話ファシリボットです。
以下は直近の発言ログ（新しい順, 一部抜粋）です。
1) 要約を短い箇条書き 2〜3 行（各 全角100字以内）、
2) 「次の一手」を 1 行（全角120字以内）で、
JSONのみを返してください: {"bullets":["…","…"],"next":"…"}
禁止: 捏造・過度な断定・固有名の新規作成`;
  const body = logs.map(l => `- @${l.author}: ${l.text}`).join("\n");
  return `${header}\n# Logs (newest first)\n${body}`;
}
function extractJsonObject(text: string): any | null {
  try { return JSON.parse(text); }
  catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try { return JSON.parse(m[0]); } catch { return null; }
  }
}
async function callLlamaCppChat(prompt: string, maxTokens=320): Promise<LlmSummaryOut | null> {
  try {
    const url = `${LLAMA_BASE}/v1/chat/completions`;
    const body: any = { model: LLAMA_MODEL || "llama", messages: [{ role: "user", content: prompt }], temperature: 0.3, max_tokens: maxTokens };
    const r = await fetch(url, { method: "POST", headers: { "content-type":"application/json; charset=utf-8" }, body: JSON.stringify(body) });
    const j: any = await r.json().catch(()=> ({}));
    const content: string | undefined = j?.choices?.[0]?.message?.content || j?.content || j?.text;
    if (!content) return null;
    const parsed = extractJsonObject(content);
    if (parsed?.bullets?.length && typeof parsed?.next === "string") return { bullets: parsed.bullets as string[], next: parsed.next as string };
  } catch {}
  return null;
}
async function callOllama(prompt: string, maxTokens=320): Promise<LlmSummaryOut | null> {
  try {
    const url = `${OLLAMA_BASE}/v1/chat/completions`;
    const body: any = { model: OLLAMA_MODEL, messages: [{ role: "user", content: prompt }], temperature: 0.3, max_tokens: maxTokens };
    let content: string | null = null;
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type":"application/json" }, body: JSON.stringify(body) });
      const j: any = await r.json().catch(()=> ({}));
      content = j?.choices?.[0]?.message?.content || null;
    } catch {}
    if (!content) {
      const urlGen = `${OLLAMA_BASE}/api/generate`;
      const r2 = await fetch(urlGen, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: OLLAMA_MODEL, prompt, options: { temperature: 0.3, num_predict: 320 } }) });
      const text = await r2.text();
      const lines = text.trim().split(/\r?\n/);
      for (let i = lines.length - 1; i >= 0; i--) {
        try { const j = JSON.parse(lines[i]); if (j?.response) { content = j.response; break; } } catch {}
      }
    }
    if (!content) return null;
    const parsed = extractJsonObject(content);
    if (parsed?.bullets?.length && typeof parsed?.next === "string") return { bullets: parsed.bullets as string[], next: parsed.next as string };
  } catch {}
  return null;
}

/* ========= 主題一文リファイン ========= */
async function callChatLLMForOneLine(prompt: string, maxTokens=80): Promise<{text:string|null, engine:string|null}> {
  const tryLlama  = USE_LLAMA_CPP && (LLM_PROVIDER === "llama" || LLM_PROVIDER === "auto");
  const tryOllama = USE_OLLAMA    && (LLM_PROVIDER === "ollama" || LLM_PROVIDER === "auto");
  if (tryLlama) {
    try {
      const url = `${LLAMA_BASE}/v1/chat/completions`;
      const body: any = { model: LLAMA_MODEL || "llama", messages: [{ role: "user", content: prompt }], temperature: 0.2, max_tokens: maxTokens };
      const r = await fetch(url, { method: "POST", headers: { "content-type":"application/json" }, body: JSON.stringify(body) });
      const j: any = await r.json().catch(()=> ({}));
      const content: string | undefined = j?.choices?.[0]?.message?.content;
      if (content && typeof content === "string") return { text: content.trim(), engine: "llama.cpp" };
    } catch {}
  }
  if (tryOllama) {
    try {
      const url = `${OLLAMA_BASE}/v1/chat/completions`;
      const body: any = { model: OLLAMA_MODEL, messages: [{ role: "user", content: prompt }], temperature: 0.2, max_tokens: maxTokens };
      const r = await fetch(url, { method: "POST", headers: { "content-type":"application/json" }, body: JSON.stringify(body) });
      const j: any = await r.json().catch(()=> ({}));
      const content: string | undefined = j?.choices?.[0]?.message?.content;
      if (content && typeof content === "string") return { text: content.trim(), engine: "ollama" };
    } catch {}
  }
  return { text: null, engine: null };
}

function buildTopicPrompt(messages: RawMsg[], limit=120) {
  const newestFirst = [...messages].sort((a,b)=> (new Date(b.ts).getTime()) - (new Date(a.ts).getTime()));
  const logs = newestFirst.slice(0, limit).map(m => `- ${m.author}: ${m.content.replace(/\s+/g, " ").slice(0, 240)}`).join("\n");
  return `あなたは会話の主題を短く要約する専門家です。
以下のDiscord会話抜粋（新しい順・最大${limit}件）を読み、
『この会話は◯◯について話している』という形の一文（全角60字以内、日本語、句点なし）を1つだけ出力してください。
優先: 具体的な固有トピック > メタ語は避ける。禁止: 捏造/誹謗中傷/推測/絵文字多用。
出力はプレーンテキスト1行のみ。
# 会話ログ
${logs}`;
}

async function refineTopicOneLinerIfNeeded(sr:any, msgs: RawMsg[], force:boolean): Promise<{oneLine:string, meta:{usedLlm:boolean; engine:string|null}}> {
  const noisy = (s:string)=> /^(主題は|なるほど|確かに|あー|あ〜|笑|w|ふむ|了解|ok|thanks|ありがとう)/i.test((s||"").trim());
  const shouldRefine = force || noisy(sr?.oneLiner || "");
  if (!shouldRefine) return { oneLine: sr?.oneLiner || "—", meta:{ usedLlm:false, engine:null } };

  const prompt = buildTopicPrompt(msgs);
  const { text, engine } = await callChatLLMForOneLine(prompt, 80);
  if (text && text.length > 0) {
    const cleaned = text.replace(/[\r\n]+/g, " ").replace(/^["'「『\s]+|["'」『』\s]+$/g, "").replace(/。+$/g, "").slice(0, 60);
    return { oneLine: cleaned, meta:{ usedLlm:true, engine } };
  }
  return { oneLine: sr?.oneLiner || "—", meta:{ usedLlm:false, engine:null } };
}

/* ========= 解析CH取得 ========= */
async function getAnalysisChannel(): Promise<TextChannel | null> {
  if (!ANALYSIS_CHANNEL_ID) return null;
  try {
    const ch = await client.channels.fetch(ANALYSIS_CHANNEL_ID).catch(()=> null);
    if (ch && isGuildText(ch)) return ch;
  } catch {}
  return null;
}

/* ========= ラベル正規化 & 反映API ========= */
function normalizeFeedbackLabel(raw: string): string | null {
  const s = (raw || "").trim();
  const m = s.toUpperCase();
  // 直接ラベル
  if (["AG","TP","EM","S","Q","CH","NG"].includes(m)) return m;
  // 絵文字対応
  if (/👍/.test(s)) return "AG";
  if (/🗓️|📅/.test(s)) return "TP";
  if (/😊|🙂|😄|❤️/.test(s)) return "EM";
  if (/ℹ️|📎|🔗|🧠/.test(s)) return "S";
  if (/❓|❔|\?/.test(s)) return "Q";
  if (/💬/.test(s)) return "CH";
  if (/⛔|🚫/.test(s)) return "NG";
  return null;
}
const FEEDBACK_API = `${BASE}/api/feedback`;
async function apiFeedbackCreate(payload: {
  messageId: string; serverId: string; channelId: string; userId: string;
  label: string; notes?: string; confidence?: number;
}) {
  const r = await fetch(FEEDBACK_API, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(payload)
  });
  if (!r.ok) throw new Error(`feedback create ${r.status}`);
}
async function apiFeedbackDelete(payload: {
  messageId: string; serverId: string; channelId: string; userId: string; label?: string;
}) {
  // DELETE with query（対応していない場合は POST op=delete を試す）
  try {
    const q = new URLSearchParams(payload as any);
    const r = await fetch(`${FEEDBACK_API}?${q.toString()}`, { method: "DELETE" });
    if (r.ok) return;
  } catch {}
  const r2 = await fetch(FEEDBACK_API, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ op: "delete", ...payload })
  });
  if (!r2.ok) throw new Error(`feedback delete ${r2.status}`);
}

/* ========= Slash Commands ========= */
async function registerSlash(): Promise<void> {
  if (!REGISTER_SLASH) return;
  if (!APP_ID) {
    console.warn("[bridge] WARN: REGISTER_SLASH=true ですが DISCORD_APP_ID/CLIENT_ID 未設定。登録スキップ");
    return;
  }
  const commands = [
    new SlashCommandBuilder()
      .setName("summary")
      .setDescription("直近ログ or 全履歴を完璧要約（Map→Reduce→Critic＋Coverage）でカード化")
      .addChannelOption(opt => opt.setName("channel").setDescription("対象チャンネル（未指定=現在）"))
      .addBooleanOption(opt => opt.setName("all_history").setDescription("全履歴から作成（上限: SUMMARY_HARD_CAP）"))
      .addIntegerOption(opt => opt.setName("days").setDescription("直近◯日だけで要約").setMinValue(1).setMaxValue(30))
      .addBooleanOption(opt => opt.setName("refine").setDescription("LLMで主題一文を必ずリファイン"))
      .toJSON(),
    new SlashCommandBuilder()
      .setName("backfill")
      .setDescription("ダウン中のメッセージを取り込み（分析CHは除外）")
      .addStringOption(opt => opt.setName("since").setDescription("開始（例: 24h, 7d, 90m, 2025-10-01T00:00:00Z）"))
      .addIntegerOption(opt => opt.setName("limit").setDescription("各CHの最大件数（既定: 500）").setMinValue(1).setMaxValue(5000))
      .addChannelOption(opt => opt.setName("channel").setDescription("対象チャンネル（未指定なら全対象）"))
      .addBooleanOption(opt => opt.setName("dry_run").setDescription("取り込みせず件数だけ確認"))
      .toJSON(),
    // ★ カテゴリ修正（TRUST限定）
    new SlashCommandBuilder()
      .setName("label")
      .setDescription("指定メッセージにラベルを付ける（AG/TP/EM/S/Q/CH/NG または絵文字）")
      .addStringOption(opt => opt.setName("message_id").setDescription("対象のメッセージID").setRequired(true))
      .addStringOption(opt => opt.setName("label").setDescription("AG/TP/EM/S/Q/CH/NG または絵文字").setRequired(true))
      .addStringOption(opt => opt.setName("notes").setDescription("備考").setRequired(false))
      .toJSON(),
    // ★ 未回答Qの掘り起こし（エフェメラル表示）
    new SlashCommandBuilder()
      .setName("resurface")
      .setDescription("直近14日から48h未返信の質問(Q)を一覧（エフェメラル）")
      .addChannelOption(opt => opt.setName("channel").setDescription("対象チャンネル（未指定=現在）"))
      .toJSON(),
  ];
  try {
    const rest = new REST({ version: "10" }).setToken(TOKEN);
    await rest.put(Routes.applicationGuildCommands(APP_ID, GUILD_ID), { body: commands });
    console.log("[bridge] /summary /backfill /label /resurface を登録");
  } catch (e:any) {
    console.warn("[bridge] WARN: Slash登録に失敗:", e?.message || e);
  }
}

/* ========= /summary & /backfill & /label & /resurface ========= */
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (!interaction.isChatInputCommand()) return;

    // ===== /label（TRUST限定） =====
    if (interaction.commandName === "label") {
      if (!TRUST_SET.has(interaction.user.id)) {
        await interaction.reply({ content: "この操作は信頼ユーザーだけが実行できます。", flags: FLAGS_EPHEMERAL });
        return;
      }
      const mid = interaction.options.getString("message_id", true);
      const raw = interaction.options.getString("label", true);
      const notes = interaction.options.getString("notes") || undefined;

      const lab = normalizeFeedbackLabel(raw);
      if (!lab) { await interaction.reply({ content:`ラベルが不正です: ${raw}`, flags: FLAGS_EPHEMERAL }); return; }

      const serverId = interaction.guildId || GUILD_ID;
      const channelId = interaction.channelId;
      await apiFeedbackCreate({
        messageId: mid, serverId, channelId,
        userId: interaction.user.id, label: lab, notes: notes || `via /label ${raw}`, confidence: 1
      });

      // 最新解析を促す（存在すれば）
      try {
        const anUrl = `${BASE}/api/analyze/batch?serverId=${serverId}&ids=${mid}&force=true`;
        await fetch(anUrl, { method: "POST" }).catch(()=>{});
      } catch {}
      await interaction.reply({ content: `反映しました（${lab}）`, flags: FLAGS_EPHEMERAL });
      return;
    }

    // ===== /resurface（未回答Qの一覧・エフェメラル） =====
    if (interaction.commandName === "resurface") {
      const chOpt = interaction.options.getChannel("channel");
      const chId = chOpt?.id ?? interaction.channelId;
      const ch = await client.channels.fetch(chId).catch(() => null);
      if (!ch || !isGuildText(ch)) {
        await interaction.reply({ content: "対象がテキストCHではありません。", flags: FLAGS_EPHEMERAL });
        return;
      }
      const chText = ch as TextChannel;
      const since = Date.now() - fromDays(14);
      const msgs14 = await fetchChannelMessagesSince(chText, since, 500);

      // 解析APIでラベル取得（まとめて）
      const ids = msgs14.map(m=> m.id).join(",");
      const anUrl = `${BASE}/api/analyze/batch?serverId=${interaction.guildId || GUILD_ID}&ids=${ids}&force=false`;
      const aj: any = await fetch(anUrl, { method: "POST" }).then(r=>r.json()).catch(()=> ({}));
      const resMap: Record<string, any> = aj?.results || {};

      const unanswered = msgs14.filter(m => {
        const lab = resMap[m.id]?.label || resMap[m.id]?.labels?.[0];
        if (lab !== "Q") return false;
        const deadline = (m.createdTimestamp || 0) + fromHours(48);
        return !msgs14.some(mm =>
          mm.author.id !== m.author.id &&
          (mm.createdTimestamp || 0) > (m.createdTimestamp || 0) &&
          (mm.createdTimestamp || 0) <= deadline
        );
      });

      const lines = unanswered.slice(0, 10).map(m => {
        const jump = `https://discord.com/channels/${interaction.guildId}/${chText.id}/${m.id}`;
        return `• <@${m.author.id}>: ${excerpt(materializeContent(m), 100)} — [Jump](${jump})`;
      }).join("\n") || "—";

      const eb = new EmbedBuilder()
        .setTitle("未回答Qリスト（48h未返信 / 直近14日）")
        .setDescription(`Channel: <#${chText.id}>`)
        .addFields({ name: "対象", value: lines })
        .setTimestamp(new Date());

      await interaction.reply({ embeds:[eb], flags: FLAGS_EPHEMERAL });
      return;
    }

    // ===== /summary =====
    if (interaction.commandName === "summary") {
      const chOpt = interaction.options.getChannel("channel");
      const chId = chOpt?.id ?? interaction.channelId;

      if (inFlightSummary.has(chId)) {
        await interaction.reply({ content: "このチャンネルの要約は既に実行中です。少し待ってから再実行してください。", flags: FLAGS_EPHEMERAL });
        return;
      }
      inFlightSummary.add(chId);

      const ch = await client.channels.fetch(chId).catch(() => null);
      if (!ch || !isGuildText(ch)) {
        inFlightSummary.delete(chId);
        await interaction.reply({ content: "対象がテキストCHではありません。", flags: FLAGS_EPHEMERAL });
        return;
      }
      if (!inFilter(ch.id)) {
        inFlightSummary.delete(chId);
        await interaction.reply({ content: "このチャンネルは対象外です（INCLUDE/EXCLUDE設定）。", flags: FLAGS_EPHEMERAL });
        return;
      }

      const chText = ch as TextChannel;
      const wantAll = interaction.options.getBoolean("all_history") === true || SUMMARY_ALL_HISTORY;
      const daysOpt = interaction.options.getInteger("days");
      const lookbackDays = daysOpt && daysOpt > 0 ? daysOpt : SNAP_LOOKBACK_DAYS;
      const forceRefineOption = interaction.options.getBoolean("refine") === true;

      await interaction.reply({
        content: wantAll
          ? "📝 **チャンネル全履歴**から要約カードを作成中…（100件ずつページング）"
          : `📝 直近ログから要約カードを作成中…（${lookbackDays}日）`,
        flags: FLAGS_EPHEMERAL
      });

      try {
        const rawMsgs: Message[] = wantAll
          ? await fetchChannelMessagesAll(chText, SUMMARY_HARD_CAP)
          : await fetchChannelMessagesSince(chText, Date.now() - fromDays(lookbackDays), SNAP_FETCH_LIMIT);

        const msgs: RawMsg[] = rawMsgs
          .map((m: Message) => ({
            id: m.id,
            author: `@${m.member?.nickname || m.author?.username || "user"}`,
            content: materializeContent(m).replace(/\s+/g, " ").slice(0, 2000),
            ts: new Date((m as any).createdTimestamp || Date.now()).toISOString(),
          }))
          .filter(m => m.content && m.content.trim());

        if (!msgs.length) {
          const eb = new EmbedBuilder()
            .setTitle("要約カード")
            .setDescription(`Channel: <#${chText.id}>`)
            .addFields({ name: "情報", value: "対象期間内に要約可能なメッセージがありませんでした。" })
            .setTimestamp(new Date());
          const analysisCh = await getAnalysisChannel();
          if (analysisCh) await analysisCh.send({ embeds:[eb] }); else await chText.send({ embeds:[eb] });
          await interaction.followUp({ content: "ℹ️ データなし: 要約カード（空）を掲示しました。", flags: FLAGS_EPHEMERAL });
          inFlightSummary.delete(chId);
          return;
        }

        const sr: any = await callSummarizeApi(chText.id, msgs);
        const { oneLine, meta } = await refineTopicOneLinerIfNeeded(sr, msgs, FORCE_LLM_REFINE || forceRefineOption);
        sr.oneLiner = oneLine;
        sr.meta = meta;

        const eb: EmbedBuilder = buildSummaryEmbedFromPipeline(interaction.guildId!, chText, sr);
        const analysisCh = await getAnalysisChannel();
        if (analysisCh) await analysisCh.send({ embeds:[eb] }); else await chText.send({ embeds:[eb] });

        await interaction.followUp({ content: "✅ 要約カードを掲示しました。", flags: FLAGS_EPHEMERAL });
        inFlightSummary.delete(chId);
        return;
      } catch (e:any) {
        try {
          const msgsSnap: {author:string; text:string}[] = (await fetchChannelMessagesSince(chText, Date.now() - fromDays(lookbackDays), SNAP_FETCH_LIMIT))
            .map(m=> ({ author: m.member?.nickname || m.author?.username || "user", text: excerpt(materializeContent(m), 240) }))
            .filter(v=> v.text);

          const prompt = buildSummaryPrompt([...msgsSnap].reverse());
          let out: LlmSummaryOut | null = null;
          if (USE_LLAMA_CPP && (LLM_PROVIDER === "llama" || LLM_PROVIDER === "auto")) out = await callLlamaCppChat(prompt);
          if (!out && USE_OLLAMA && (LLM_PROVIDER === "ollama" || LLM_PROVIDER === "auto")) out = await callOllama(prompt);

          const eb = new EmbedBuilder()
            .setTitle(wantAll ? "要約カード（全履歴スナップ・フォールバック）" : "要約カード（スナップ・フォールバック）")
            .setDescription(`Channel: <#${chText.id}>`)
            .addFields(
              { name:"箇条書き", value: (out?.bullets||[]).map(b=>`• ${truncate(b,100)}`).slice(0,3).join("\n") || "—" },
              { name:"次の一手", value: truncate(out?.next || "—", 120) }
            )
            .setFooter({ text: "LLM refine: OFF (pipeline失敗時の簡易要約)" })
            .setTimestamp(new Date());

          const analysisCh = await getAnalysisChannel();
          if (analysisCh) await analysisCh.send({ embeds:[eb] }); else await chText.send({ embeds:[eb] });

          await interaction.followUp({ content: `⚠️ /api/summarize に失敗: ${String(e?.message || e)}`, flags: FLAGS_EPHEMERAL });
        } catch (e2:any) {
          await interaction.followUp({ content: `❌ フォールバックも失敗: ${String(e2?.message || e2)}`, flags: FLAGS_EPHEMERAL });
        } finally {
          inFlightSummary.delete(chId);
        }
        return;
      }
    }

    // ===== /backfill =====
    if (interaction.commandName === "backfill") {
      const sinceRaw = interaction.options.getString("since");
      const limitOpt = interaction.options.getInteger("limit") ?? 500;
      const dryRun   = interaction.options.getBoolean("dry_run") ?? false;
      const chOpt    = interaction.options.getChannel("channel");

      const parseSince = (input?: string | null): number | null => {
        if (!input) return null;
        const s = input.trim();
        const m = s.match(/^(\d+)\s*(d|day|days|h|hour|hours|m|min|mins|minute|minutes)$/i);
        if (m) {
          const n = Number(m[1]);
          const unit = m[2].toLowerCase();
          const now = Date.now();
          if (["d","day","days"].includes(unit)) return now - n*24*60*60*1000;
          if (["h","hour","hours"].includes(unit)) return now - n*60*60*1000;
          if (["m","min","mins","minute","minutes"].includes(unit)) return now - n*60*1000;
        }
        const t = Date.parse(s);
        if (!Number.isNaN(t)) return t;
        return null;
      };
      const now = Date.now();
      const fromMs = parseSince(sinceRaw) ?? (now - fromDays(1));
      const perChannelLimit = Math.max(1, Math.min(5000, limitOpt));

      await interaction.reply({
        content:`⏳ バックフィル開始: since=${new Date(fromMs).toISOString()} limit/ch=${perChannelLimit} dry_run=${dryRun}`,
        flags: FLAGS_EPHEMERAL
      });

      const ingestOne = async (m: Message): Promise<boolean> => {
        const text = materializeContent(m);
        if (!text) return false;
        const body = {
          serverId: m.guildId || GUILD_ID,
          channelId: m.channelId,
          messageId: m.id,
          authorId: m.author?.id ?? "u?",
          authorIsBot: Boolean(m.author?.bot),
          createdAt: (m as any).createdTimestamp || Date.now(),
          createdAtIso: new Date((m as any).createdTimestamp || Date.now()).toISOString(),
          contentText: stripCtl(text),
        };
        if (dryRun) return true;
        const r = await fetch(`${BASE}/api/ingest/discord`, {
          method: "POST", headers: { "content-type":"application/json; charset=utf-8" }, body: JSON.stringify(body)
        }).catch(()=> null as any);
        return Boolean(r?.ok);
      };

      const target: TextChannel[] = [];
      const isText = (c: any): c is TextChannel => c && c.type === ChannelType.GuildText;
      if (chOpt && isText(chOpt)) {
        if (!isAnalysisChannelId(chOpt.id) && inFilter(chOpt.id)) target.push(chOpt);
      } else {
        const guild = await client.guilds.fetch(interaction.guildId!);
        const all = await guild.channels.fetch();
        all.forEach((c) => {
          if (!isText(c)) return;
          if (isAnalysisChannelId(c.id)) return;
          if (!inFilter(c.id)) return;
          target.push(c);
        });
      }

      let total = 0;
      for (const ch of target) {
        let fetched = 0;
        const after = toSnowflakeFromMs(fromMs);
        let lastId: string | undefined = after;

        while (fetched < perChannelLimit) {
          const n = Math.min(FETCH_CHUNK_SIZE, perChannelLimit - fetched);
          const batch: Collection<Snowflake, Message> | null =
            (await ch.messages.fetch({ limit: n, after: lastId }).catch(()=> null)) as Collection<Snowflake, Message> | null;
          if (!batch || batch.size === 0) break;

          const sorted: Message[] = [...batch.values()].sort((a: Message, b: Message) =>
            BigInt(a.id) < BigInt(b.id) ? -1 : 1
          );
          for (const m of sorted) {
            if (m.author?.bot) continue;
            const ok = await ingestOne(m);
            if (ok) { fetched++; total++; }
            if (fetched >= perChannelLimit) break;
          }
          lastId = sorted[sorted.length - 1]?.id;
          if (fetched >= perChannelLimit) break;
          await sleep(260);
        }

        await interaction.followUp({ content:`📥 <#${ch.id}>: +${fetched} msgs`, flags: FLAGS_EPHEMERAL });
      }

      await interaction.followUp({ content:`✅ バックフィル完了: 合計 ${total} 件`, flags: FLAGS_EPHEMERAL });
      return;
    }
  } catch (e:any) {
    console.error("[bridge] slash error:", e?.message || e);
  }
});

// ===== リアクション → ラベル修正（TRUST限定） =====
client.on(
  Events.MessageReactionAdd,
  async (
    reaction: MessageReaction | PartialMessageReaction,
    user: User | PartialUser,
    _details: MessageReactionEventDetails
  ) => {
    try {
      if (user?.bot) return;
      if (!TRUST_SET.has(user.id)) return; // 権限ガード

      // Partial 対応
      if (user.partial) {
        try { await user.fetch(); } catch {}
      }
      if (reaction.partial) {
        try { await reaction.fetch(); } catch {}
      }
      const msg = reaction.message;
      if (!msg) return;
      if ((msg as any).partial) {
        try { await (msg as any).fetch(); } catch {}
      }
      if (!msg.guild) return;

      const ch: any = msg.channel;
      if (!isGuildText(ch)) return;
      if (!inFilter(ch.id)) return;

      const raw =
        reaction.emoji?.toString?.() ||
        (reaction as any).emoji?.name ||
        "";
      const lab = normalizeFeedbackLabel(raw);
      if (!lab) return;

      await apiFeedbackCreate({
        messageId: msg.id,
        serverId: msg.guildId!,
        channelId: msg.channelId,
        userId: user.id,
        label: lab,
        notes: `via reaction ${raw}`,
        confidence: 1,
      });

      // 再解析（あれば）
      try {
        const anUrl = `${BASE}/api/analyze/batch?serverId=${msg.guildId!}&ids=${msg.id}&force=true`;
        await fetch(anUrl, { method: "POST" }).catch(() => {});
      } catch {}
    } catch (e: any) {
      console.warn("[bridge] reaction add error:", e?.message || e);
    }
  }
);

client.on(
  Events.MessageReactionRemove,
  async (
    reaction: MessageReaction | PartialMessageReaction,
    user: User | PartialUser,
    _details: MessageReactionEventDetails
  ) => {
    try {
      if (user?.bot) return;
      if (!TRUST_SET.has(user.id)) return; // 権限ガード

      // Partial 対応
      if (user.partial) {
        try { await user.fetch(); } catch {}
      }
      if (reaction.partial) {
        try { await reaction.fetch(); } catch {}
      }
      const msg = reaction.message;
      if (!msg) return;
      if ((msg as any).partial) {
        try { await (msg as any).fetch(); } catch {}
      }
      if (!msg.guild) return;

      const ch: any = msg.channel;
      if (!isGuildText(ch)) return;
      if (!inFilter(ch.id)) return;

      const raw =
        reaction.emoji?.toString?.() ||
        (reaction as any).emoji?.name ||
        "";
      const lab = normalizeFeedbackLabel(raw);

      await apiFeedbackDelete({
        messageId: msg.id,
        serverId: msg.guildId!,
        channelId: msg.channelId,
        userId: user.id,
        label: lab || undefined,
      });

      try {
        const anUrl = `${BASE}/api/analyze/batch?serverId=${msg.guildId!}&ids=${msg.id}&force=true`;
        await fetch(anUrl, { method: "POST" }).catch(() => {});
      } catch {}
    } catch (e: any) {
      console.warn("[bridge] reaction remove error:", e?.message || e);
    }
  }
);

/* ========= 安全終了 ========= */
function gracefulExit(code = 0) {
  console.log("[bridge] shutting down…");
  try { client.destroy(); } catch {}
  setTimeout(()=> process.exit(code), 300);
}
process.on("SIGINT",  () => gracefulExit(0));
process.on("SIGTERM", () => gracefulExit(0));
process.on("unhandledRejection", (e:any)=> console.warn("[bridge] unhandledRejection:", e?.message || e));
process.on("uncaughtException",  (e:any)=> console.warn("[bridge] uncaughtException:",  e?.message || e));

// ====== 前提チェック ======
if (!TOKEN)    { console.error("[bridge] ERR: DISCORD_TOKEN 未設定"); process.exit(1); }
if (!GUILD_ID) { console.error("[bridge] ERR: SERVER_ID/NEXT_PUBLIC_SERVER_ID 未設定"); process.exit(1); }

// 追加: 起動時に主要ENVをログ
console.log("[bridge] env snapshot", {
  APP_ID,
  GUILD_ID,
  BASE,
  REGISTER_SLASH,
  ANALYSIS_CHANNEL_ID,
});

// 追加: 早期終了の理由を捕まえる
process.on("beforeExit", (code) => {
  console.warn("[bridge] beforeExit", code);
});
process.on("exit", (code) => {
  console.warn("[bridge] exit", code);
});
process.on("unhandledRejection", (e:any) => {
  console.error("[bridge] unhandledRejection:", e?.message || e);
});
process.on("uncaughtException", (e:any) => {
  console.error("[bridge] uncaughtException:", e?.message || e);
});

// --- 起動直後の健全性ダンプ（デバッグ用） ---
console.log("[bridge] env snapshot", {
  APP_ID: process.env.DISCORD_APP_ID || process.env.DISCORD_CLIENT_ID,
  GUILD_ID: process.env.SERVER_ID || process.env.NEXT_PUBLIC_SERVER_ID,
  BASE: (process.env.ANALYZER_BASE || process.env.BASE_URL),
  REGISTER_SLASH: (process.env.REGISTER_SLASH||"true")==="true",
  ANALYSIS_CHANNEL_ID: process.env.ANALYSIS_CHANNEL_ID || process.env.DISCORD_ANALYSIS_CHANNEL_ID,
  TOKEN_PRESENT: !!(process.env.DISCORD_TOKEN && process.env.DISCORD_TOKEN.length > 20)
});
process.on("beforeExit", (code)=> console.log("[bridge] beforeExit", code));
process.on("exit",      (code)=> console.log("[bridge] exit", code));

client.login(TOKEN)
  .then(()=> console.log("[bridge] login() resolved"))
  .catch(err => {
    console.error("[bridge] login failed:", err?.message || err);
    process.exit(1);
  });


// 追加：ゲートウェイ診断ログ
client.on('debug', (m) => console.log('[bridge][debug]', m));
client.on('warn',  (m) => console.warn('[bridge][warn]', m));
client.on('error', (e) => console.error('[bridge][error]', e));

client.on(Events.ShardReady, (id, unavailable) => {
  console.log(`[bridge] ShardReady id=${id} unavailable=${Boolean(unavailable)}`);
});
client.on(Events.ShardDisconnect, (event, id) => {
  console.warn(`[bridge] ShardDisconnect id=${id} code=${event.code} reason=${event.reason}`);
});
client.on(Events.ShardError, (err, id) => {
  console.error(`[bridge] ShardError id=${id} err=${err?.message||err}`);
});

console.log("[bridge] registering READY handler");
client.once(Events.ClientReady, async () => {
  console.log(`[bridge] READY as ${client.user?.tag}`);
  await ensureApiReady();
  await registerSlash();
  console.log("[bridge] post-ready done");
});

console.log("[bridge] calling login()");
client.login(TOKEN)
  .then(()=> console.log("[bridge] login() resolved"))
  .catch(err => {
    console.error("[bridge] login failed:", err?.message || err);
    process.exit(1);
  });

// 念のため：READY待ちウォッチャ
setInterval(() => {
  const s = (client.ws as any)?.status ?? 'unknown';
  console.log(`[bridge] ws status=${s} at ${new Date().toISOString()}`);
}, 15000);
