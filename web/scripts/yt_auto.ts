// scripts/yt_auto.ts
//
// YouTube のコメントを取得 → LLMで tp/q/s/em/ag/ng に自動分類
// しきい値未満は needs_review.json に分離し、再学習用の JSON も同時出力。
// - 出力先: data/yt/<videoId>.*.json
//
// 使い方（PowerShell例）:
//   # llama.cpp を使う例
//   $env:LLM_PROVIDER="llama"
//   $env:LLM_BASE="http://127.0.0.1:8080"
//   $env:LLM_MODEL="local"   # llama-server 側の -m でロード済みなら何でもOK
//   # オプション（安定重視）
//   $env:YT_BATCH_SIZE="1"
//   $env:LLM_CONCURRENCY="1"
//
//   # YouTube Data API v3（コメント取得用）
//   $env:YT_API_KEY="AIza..."   # 必須（未設定の場合はエラー）
//
//   # 実行
//   npx tsx -r dotenv/config .\scripts\yt_auto.ts --url "https://www.youtube.com/watch?v=XXXXXXXXXXX" --threshold 0.75
//
//   または
//   npx tsx -r dotenv/config .\scripts\yt_auto.ts --video XXXXXXXXXXX --threshold 0.75
//
// 依存: zod（package.json に含まれている想定）

import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";

/* ========================= 基本型・定数 ========================= */

const LABEL_TUPLE = ["tp", "q", "s", "em", "ag", "ng"] as const;
type Label = typeof LABEL_TUPLE[number];

const LABELS: Label[] = [...LABEL_TUPLE];

type ModelOut = {
  index?: number;
  label?: Label;
  confidence?: number;
  secondary?: Label | null;
  reason?: string;
};

type LabeledRow = {
  index: number;
  text: string;
  label: Label;
  confidence: number;
  secondary: Label | null;
  reason: string;
};

type ForRetrainRow = {
  id: string;             // "<videoId>:<index>"
  videoId: string;
  index: number;
  text: string;
  label: Label;
  confidence: number;
  relabel: Label | null;  // 人手で修正した最終ラベルを入れる
  relabel_reason: string; // 修正理由（任意）
};

const OutSchema = z.array(z.object({
  index: z.number(),
  label: z.enum(LABEL_TUPLE),
  confidence: z.number().min(0).max(1),
  secondary: z.enum(LABEL_TUPLE).nullable().optional(),
  reason: z.string().optional(),
}));

/* ========================= ユーティリティ ========================= */

function clamp01(x: number) { return Math.max(0, Math.min(1, x)); }

function ensureDir(p: string) {
  const dir = dirname(p);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function getArg(name: string): string | undefined {
  // --name value または --name=value の両対応
  const i = process.argv.findIndex(a => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i === -1) return undefined;
  const a = process.argv[i];
  if (a.includes("=")) return a.split("=")[1];
  return process.argv[i + 1];
}

function parseThreshold(): number {
  const raw = getArg("threshold");
  if (!raw) return 0.72;
  const n = Number(raw);
  return Number.isFinite(n) ? clamp01(n) : 0.72;
}

function parseBatchSize(): number {
  const env = process.env.YT_BATCH_SIZE;
  const raw = getArg("batch");
  const base = Number(raw ?? env ?? "1");
  return Math.max(1, Math.min(8, Number.isFinite(base) ? base : 1));
}

function parseConcurrency(): number {
  const env = process.env.LLM_CONCURRENCY;
  const raw = getArg("concurrency");
  const n = Number(raw ?? env ?? "1");
  return Math.max(1, Math.min(2, Number.isFinite(n) ? n : 1));
}

function getVideoIdFromInput(): string | null {
  const url = getArg("url");
  const vid = getArg("video");
  if (vid) return vid.trim();
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.hostname.includes("youtube.com")) {
      const v = u.searchParams.get("v");
      if (v) return v;
      // shorts / embed 等のパターンにも簡易対応
      const parts = u.pathname.split("/").filter(Boolean);
      if (parts[0] === "shorts" && parts[1]) return parts[1];
      if (parts[0] === "embed" && parts[1]) return parts[1];
    }
    if (u.hostname === "youtu.be") {
      const id = u.pathname.replace("/", "");
      if (id) return id;
    }
  } catch {
    // not a URL, ignore
  }
  return null;
}

function stripHtml(s: string): string {
  return (s || "").replace(/<[^>]+>/g, "");
}

/* ========================= YouTube コメント取得 ========================= */

type YTComment = { index: number; text: string };

async function fetchAllCommentsByAPI(videoId: string, maxComments?: number): Promise<YTComment[]> {
  const key = process.env.YT_API_KEY || "";
  if (!key) throw new Error("YT_API_KEY が未設定です（YouTube Data API v3 必須）");

  const items: YTComment[] = [];
  let pageToken: string | undefined;
  let idx = 0;
  let threads = 0;

  // Top-level threads
  while (true) {
    const url = new URL("https://www.googleapis.com/youtube/v3/commentThreads");
    url.searchParams.set("part", "snippet,replies");
    url.searchParams.set("videoId", videoId);
    url.searchParams.set("maxResults", "100");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    url.searchParams.set("key", key);

    const r = await fetch(url, { method: "GET" });
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      throw new Error(`commentThreads ${r.status}: ${t}`);
    }
    const j: any = await r.json();
    const arr = Array.isArray(j.items) ? j.items : [];
    threads += arr.length;

    for (const it of arr) {
      const top = it?.snippet?.topLevelComment?.snippet?.textDisplay as string | undefined;
      if (top) {
        items.push({ index: idx++, text: stripHtml(top).trim() });
      }
      // replies
      const reps = it?.replies?.comments || [];
      for (const rep of reps) {
        const t = rep?.snippet?.textDisplay as string | undefined;
        if (t) items.push({ index: idx++, text: stripHtml(t).trim() });
      }
      if (maxComments && items.length >= maxComments) break;
    }
    if (maxComments && items.length >= maxComments) break;

    pageToken = j?.nextPageToken;
    if (!pageToken) break;
  }

  console.log(`[yt_auto] threads=${threads}`);
  return items;
}

/* ========================= LLM 呼び出し ========================= */

const PROVIDER = process.env.LLM_PROVIDER ?? "llama"; // "ollama" | "llama" | "openai"
const LLM_BASE = process.env.LLM_BASE ?? (PROVIDER === "ollama" ? "http://127.0.0.1:11434" : "http://127.0.0.1:8080");
const LLM_MODEL = process.env.LLM_MODEL ?? (PROVIDER === "ollama" ? "qwen2.5:7b" : "local");

async function callLLM(messages: { role: "system" | "user"; content: string }[]): Promise<string> {
  if (PROVIDER === "ollama") {
    const res = await fetch(`${LLM_BASE}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: LLM_MODEL,
        messages,
        stream: false,
        options: {
          temperature: 0.2,
          num_predict: 280, // だらだら出さない
        },
      }),
    });
    const j: any = await res.json();
    return j?.message?.content ?? "";
  } else if (PROVIDER === "llama") {
    const res = await fetch(`${LLM_BASE}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: LLM_MODEL,
        messages,
        temperature: 0.2,
        stream: false,
        max_tokens: 280, // 無制限にならないよう必ず指定
      }),
    });
    const j: any = await res.json();
    return j?.choices?.[0]?.message?.content ?? "";
  } else {
    const res = await fetch(`https://api.openai.com/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY ?? ""}`,
      },
      body: JSON.stringify({
        model: LLM_MODEL,
        messages,
        temperature: 0.2,
        stream: false,
        max_tokens: 280,
      }),
    });
    const j: any = await res.json();
    return j?.choices?.[0]?.message?.content ?? "";
  }
}

/* ========================= プロンプト ========================= */

const SYSTEM_PROMPT = `あなたは短文コメントの分類器です。入力サンプル配列を6クラスから分類し、**JSON配列のみ**を厳密に返します。説明文・コードブロック・余計な文字は禁止。

【クラス】
- tp: 話題提示（新テーマ提案・議論の呼びかけ）
- q : 質問（不明点の確認・実質的な問い。「？」だけは除外）
- s : 情報共有（URL/参考/日時/資料。反応不要でも成立）
- em: 感情（喜怒哀楽・驚き・感想・絵文字・スラング）
- ag: 賛同（同意・称賛・共感）
- ng: 否定（反対・却下・不要・批判・否定語）

【優先順位（同点時のタイブレーク）】
q > ng > tp > ag > em > s

【簡易ヒント】
- URL/日時/資料語 → s
- 疑問文/「教えて/なぜ/どう」や末尾「?/?」(単独記号は除外) → q
- 「だめ/不要/反対/違う/無理/却下/論外/ボツ」等 → ng
- 「賛成/同意/それな/いいね/称賛/ナイス/GJ/さすが/最高/神」等 → ag
- 「草/笑/ｗ/やばい/嬉しい/悲しい/面白い/大好き」等 → em
- 提案/募集/告知/議題化（〜しよう/どう思う/やりませんか/募集/お知らせ）→ tp
- 記号のみ・タイムスタンプのみは em（低自信）

【出力仕様（**配列のみ**）】
- 入力と同じ順序・同じ長さの配列
- 各要素: {"index": <number>, "label": "tp|q|s|em|ag|ng", "confidence": 0.00}
- confidence は 0〜1、2桁程度でよい
- 追加キー禁止（secondary/reason等は出さない）
- JSON以外の文字・改行装飾・前後文言は一切出力しない

`;

function userPrompt(samples: { index: number; text: string }[]) {
  const trimmed = samples.map((s) => ({ index: s.index, text: s.text.slice(0, 800) }));
  return `以下のサンプルを6クラスから分類して、JSON配列だけ返してください。\n${JSON.stringify(trimmed, null, 2)}`;
}

// 単発（壊れにくい 1オブジェクト版）
const SINGLE_SYSTEM_PROMPT = `あなたは短文コメントの分類器です。
次の6クラスから最も当てはまる1つを選び、JSONオブジェクト【だけ】を返してください:
- tp / q / s / em / ag / ng

出力は厳密に1オブジェクト:
{"index": 0, "label": "tp|q|s|em|ag|ng", "confidence": 0.00}
`;

function singleUserPrompt(sample: { index: number; text: string }) {
  const t = sample.text.slice(0, 800);
  return `分類対象:\n{"index": ${sample.index}, "text": ${JSON.stringify(t)}}\nJSONオブジェクトだけ返してください。`;
}

/* ========================= JSON 救助パーサ & フォールバック ========================= */

function tryParseJsonArray(text: string): unknown[] | null {
  if (!text) return null;
  try {
    const j = JSON.parse(text);
    return Array.isArray(j) ? j : null;
  } catch {
    // 先頭の '[' から末尾の ']' を抜く救助
    const s = text.indexOf("[");
    const e = text.lastIndexOf("]");
    if (s >= 0 && e > s) {
      try {
        const j2 = JSON.parse(text.slice(s, e + 1));
        return Array.isArray(j2) ? j2 : null;
      } catch { /* noop */ }
    }
  }
  return null;
}

function salvageSingleObject(text: string): { index?: number; label?: Label; confidence?: number } | null {
  const s = text.indexOf("{");
  const e = text.lastIndexOf("}");
  if (s >= 0 && e > s) {
    try {
      const j = JSON.parse(text.slice(s, e + 1));
      const idx = Number(j?.index);
      const lab = String(j?.label ?? "").toLowerCase();
      const conf = Number(j?.confidence);
      if (Number.isFinite(idx) && LABELS.includes(lab as Label) && Number.isFinite(conf)) {
        return { index: idx, label: lab as Label, confidence: clamp01(conf) };
      }
    } catch { /* noop */ }
  }
  // ラベルだけでも拾う
  const mIdx = text.match(/"index"\s*:\s*(\d+)/);
  const mLab = text.match(/"label"\s*:\s*"(tp|q|s|em|ag|ng)"/i);
  const mConf = text.match(/"confidence"\s*:\s*([0-1](?:\.\d+)?)/);
  if (mIdx && mLab) {
    return {
      index: Number(mIdx[1]),
      label: mLab[1].toLowerCase() as Label,
      confidence: mConf ? clamp01(Number(mConf[1])) : 0.66,
    };
  }
  return null;
}

function heuristicLabel(text: string): { label: Label; confidence: number } {
  const t = (text || "").toLowerCase().trim();
  if (/https?:\/\/\S+/.test(t)) return { label: "s", confidence: 0.72 };
  if (/[?？]\s*$/.test(t) || /(なぜ|なんで|どう|教えて|わからん|分からん)/.test(t)) return { label: "q", confidence: 0.7 };
  if (/(だめ|ダメ|駄目|不要|却下|反対|論外|無理|ng|ボツ|没|違う|ちゃう)/i.test(text)) return { label: "ng", confidence: 0.7 };
  if (/(賛成|同意|同感|それな|いいね|gj|グッジョブ|やるじゃん|さすが|最高|神)/i.test(text)) return { label: "ag", confidence: 0.68 };
  if (/(草|笑|ｗ|やば|嬉しい|楽しい|悲しい|泣|面白|おもろ|大好き|最高|えぐ|すご|好き)/i.test(text)) return { label: "em", confidence: 0.65 };
  return { label: "em", confidence: 0.55 };
}

/* ========================= 分類（堅牢版） ========================= */

async function classifyBatch(batch: { index: number; text: string }[]): Promise<ModelOut[]> {
  if (!batch.length) return [];

  // まず配列JSONで試す
  try {
    const content = await callLLM([
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt(batch) },
    ]);
    const arrUnknown = tryParseJsonArray(content);
    const parsed = arrUnknown && OutSchema.safeParse(arrUnknown);
    if (parsed && parsed.success) {
      return parsed.data.map(it => ({
        index: it.index,
        label: it.label,
        confidence: clamp01(it.confidence),
        secondary: (it.secondary as Label | null) ?? null,
        reason: "batch",
      }));
    }
  } catch {
    // 続行（下で単発に落とす）
  }

  // 単発オブジェクトで再試行（最も堅牢）
  const each: ModelOut[] = [];
  for (const one of batch) {
    try {
      const content = await callLLM([
        { role: "system", content: SINGLE_SYSTEM_PROMPT },
        { role: "user", content: singleUserPrompt(one) },
      ]);
      // ① JSONとして読む
      try {
        const j = JSON.parse(content);
        const idx = Number(j?.index);
        const lab = String(j?.label ?? "").toLowerCase();
        const conf = Number(j?.confidence);
        if (Number.isFinite(idx) && LABELS.includes(lab as Label) && Number.isFinite(conf)) {
          each.push({
            index: idx,
            label: lab as Label,
            confidence: clamp01(conf),
            secondary: null,
            reason: "single",
          });
          await sleep(60);
          continue;
        }
      } catch {
        // ② 救助パーサ
        const salv = salvageSingleObject(content);
        if (salv && salv.index === one.index && salv.label) {
          each.push({
            index: one.index,
            label: salv.label,
            confidence: clamp01(salv.confidence ?? 0.66),
            secondary: null,
            reason: "single-salvage",
          });
          await sleep(60);
          continue;
        }
      }
      // ③ ヒューリスティック
      const h = heuristicLabel(one.text);
      each.push({
        index: one.index,
        label: h.label,
        confidence: clamp01(h.confidence),
        secondary: null,
        reason: "heuristic",
      });
    } catch {
      const h = heuristicLabel(one.text);
      each.push({
        index: one.index,
        label: h.label,
        confidence: clamp01(h.confidence),
        secondary: null,
        reason: "heuristic-error",
      });
    }
    await sleep(60);
  }
  return each;
}

/* ========================= メイン ========================= */

async function main() {
  const videoId = getVideoIdFromInput();
  if (!videoId) throw new Error("--url もしくは --video が必要です");

  const threshold = parseThreshold();
  const BATCH_SIZE = parseBatchSize();
  const CONC = parseConcurrency();

  console.log(`[yt_auto] videoId=${videoId}`);
  console.log(`[yt_auto] batch=${BATCH_SIZE} concurrency=${CONC} threshold=${threshold}`);

  // コメント取得
  const MAX = process.env.YT_MAX_COMMENTS ? Number(process.env.YT_MAX_COMMENTS) : undefined;
  const comments = await fetchAllCommentsByAPI(videoId, Number.isFinite(MAX) ? MAX : undefined);
  console.log(`[yt_auto] comments=${comments.length}`);

  if (!comments.length) throw new Error("コメントが空です");

  // LLM で分類
  const labeled: LabeledRow[] = [];
  for (let i = 0; i < comments.length; i += BATCH_SIZE) {
    const chunk = comments.slice(i, i + BATCH_SIZE);
    const out = await classifyBatch(chunk);

    // out を index で合流
    const got = new Map<number, ModelOut>();
    for (const o of out) {
      if (typeof o.index === "number") got.set(o.index, o);
    }

    for (const s of chunk) {
      const o = got.get(s.index);
      if (o && o.label && typeof o.confidence === "number") {
        labeled.push({
          index: s.index,
          text: s.text,
          label: o.label,
          confidence: clamp01(o.confidence),
          secondary: o.secondary ?? null,
          reason: o.reason ?? "ok",
        });
      } else {
        // ここまで来るのは稀：最終フォールバック
        const h = heuristicLabel(s.text);
        labeled.push({
          index: s.index,
          text: s.text,
          label: h.label,
          confidence: clamp01(h.confidence),
          secondary: null,
          reason: "final-heuristic",
        });
      }
    }
  }

  // 低スコア抽出
  const needs = labeled.filter(x => (x.confidence ?? 0) < threshold);

  // 再学習パック
  const toRetrainAll: ForRetrainRow[] = labeled.map((x) => ({
    id: `${videoId}:${x.index}`,
    videoId,
    index: x.index,
    text: x.text,
    label: x.label,
    confidence: x.confidence,
    relabel: null,
    relabel_reason: "",
  }));
  const toRetrainNeeds: ForRetrainRow[] = needs.map((x) => ({
    id: `${videoId}:${x.index}`,
    videoId,
    index: x.index,
    text: x.text,
    label: x.label,
    confidence: x.confidence,
    relabel: null,
    relabel_reason: "",
  }));

  // 保存
  const base = resolve(process.cwd(), "data", "yt");
  const f1 = join(base, `${videoId}.labeled_all.json`);
  const f2 = join(base, `${videoId}.needs_review.json`);
  const f3 = join(base, `${videoId}.for_retrain.all.json`);
  const f4 = join(base, `${videoId}.for_retrain.needs_review.json`);

  ensureDir(f1);
  writeFileSync(f1, JSON.stringify(labeled, null, 2), "utf-8");
  writeFileSync(f2, JSON.stringify(needs, null, 2), "utf-8");
  writeFileSync(f3, JSON.stringify(toRetrainAll, null, 2), "utf-8");
  writeFileSync(f4, JSON.stringify(toRetrainNeeds, null, 2), "utf-8");

  console.log(`[yt_auto] ✅ saved:
  - ${f1}
  - ${f2}
  - ${f3}
  - ${f4}`);

  // ざっくり分布も表示
  const dist = new Map<Label, number>();
  for (const lab of LABELS) dist.set(lab, 0);
  for (const r of labeled) dist.set(r.label, (dist.get(r.label) ?? 0) + 1);
  const distStr = LABELS.map(l => `${l}:${dist.get(l)}`).join(" ");
  console.log(`[yt_auto] distribution: ${distStr}`);
}

// 実行
main().catch((e) => {
  console.error(`[yt_auto] ❌ Error:`, e);
  process.exit(1);
});
