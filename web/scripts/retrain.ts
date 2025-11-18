#!/usr/bin/env ts-node
/* scripts/retrain.ts
 * 直近N日分の Feedback を走査し、本文から候補語を抽出。
 * ラベルごとの出現数と偏りでフィルタし、data/lexicon.json を更新。
 *
 * 実行例:
 *   npm run retrain
 * または:
 *   tsx -r dotenv/config scripts/retrain.ts
 */

import "dotenv/config";
import fs from "fs";
import path from "path";
import { prisma } from "../src/lib/prisma";
import type { Label } from "../src/lib/rules";
import { LABELS } from "../src/lib/rules";

// ---- 設定（.env 連携） ----
const DAYS = Number(process.env.RETRAIN_DAYS || "14");               // 直近何日を学習対象
const MIN_COUNT = Number(process.env.RETRAIN_MIN_COUNT || "3");      // 採用最低出現数
const MIN_RATIO = Number(process.env.RETRAIN_MIN_RATIO || "0.7");    // 偏り比率しきい値
const MAX_PER_LABEL = Number(process.env.RETRAIN_MAX_PER_LABEL || "200"); // ラベルごとの上限語彙数
const SERVER_ID = (process.env.RETRAIN_SERVER_ID || "").trim();      // 指定時、そのサーバのみ

// 日本語の候補抽出（最小実装）: 2+の和文連続 or 3+の英字
const CAND_RE = /[ぁ-んァ-ヴー一-龥]{2,}|[A-Za-z]{3,}/g;

// よくある汎用語を除外（必要に応じて調整）
const STOP = new Set<string>([
  "これ","それ","あれ","ここ","そこ","あそこ",
  "です","ます","する","いる","なる","ある","ない",
  "ほんと","まじ","ちょっと","やばい","わろた","笑",
  "http","https","www","com"
]);

// NFKC 正規化 + URL/メンション/チャンネル/ロール/コードブロック除去 + 半角化一部
function normBase(s: string) {
  return (s || "")
    .normalize("NFKC")
    .replace(/https?:\/\/\S+/gi, " ")       // URL
    .replace(/<#[0-9]+>/g, " ")             // #channel
    .replace(/<@&?[0-9]+>/g, " ")           // @mention / @role
    .replace(/`{1,3}[\s\S]*?`{1,3}/g, " ")  // `code` / ```code```
    .replace(/[！-～]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0)) // 全角→半角
    .replace(/[ｰ－—―ー]+/g, "ー")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();                          // 英字は小文字統一
}

// 候補語抽出
function extract(text: string): string[] {
  const t = normBase(text);
  const m = t.match(CAND_RE) || [];
  const uniq = Array.from(
    new Set(
      m.map(x => x.trim())
       .filter(x => x.length >= 2 && !STOP.has(x))
    )
  );
  return uniq.slice(0, 20); // 暴走防止
}

// 既存 lexicon の読み書き
function readLexicon(): Record<Label, string[]> & { _meta?: any } {
  const p = path.resolve(process.cwd(), "data/lexicon.json");
  if (!fs.existsSync(p)) {
    return { AG: [], TP: [], EM: [], S: [], Q: [], CH: [], NG: [], _meta: {} };
  }
  const j = JSON.parse(fs.readFileSync(p, "utf8"));
  for (const k of LABELS) if (!Array.isArray(j[k])) j[k] = [];
  return j;
}

function ensureDataDir() {
  const dir = path.resolve(process.cwd(), "data");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function writeLexicon(j: any) {
  ensureDataDir();
  const p = path.resolve(process.cwd(), "data/lexicon.json");
  j._meta = j._meta || {};
  j._meta.updatedAt = new Date().toISOString();
  fs.writeFileSync(p, JSON.stringify(j, null, 2), "utf8");
}

async function main() {
  const since = new Date(Date.now() - DAYS * 24 * 60 * 60 * 1000);

  // Feedback と Message の join（直近DAYS日、必要なら serverId で絞り込み）
  const fb = await prisma.feedback.findMany({
    where: {
      createdAt: { gte: since },
      ...(SERVER_ID ? { serverId: SERVER_ID } : {}),
    },
    select: {
      label: true,
      message: { select: { contentText: true } },
    },
  });

  // 集計: term -> label -> count
  const counts = new Map<string, Map<Label, number>>();
  // ベスト頻度を保持して新規語の並びを安定化
  const bestScoreByTerm = new Map<string, number>();

  for (const f of fb) {
    const lab = (f.label || "") as Label;
    if (!LABELS.includes(lab)) continue;
    const text = f.message?.contentText || "";
    const terms = extract(text);
    for (const term of terms) {
      if (!counts.has(term)) counts.set(term, new Map<Label, number>());
      const m = counts.get(term)!;
      m.set(lab, (m.get(lab) || 0) + 1);
    }
  }

  // スコアリング & 選別
  const addByLabel: Record<Label, string[]> = {
    AG: [], TP: [], EM: [], S: [], Q: [], CH: [], NG: [],
  };

  for (const [term, map] of counts) {
    let total = 0;
    let bestLab: Label | null = null;
    let bestCount = 0;

    for (const lab of LABELS) {
      const c = map.get(lab) || 0;
      total += c;
      if (c > bestCount) { bestCount = c; bestLab = lab; }
    }

    if (!bestLab || total < MIN_COUNT) continue;
    const ratio = bestCount / total;
    if (ratio < MIN_RATIO) continue;

    // 1文字/英数字のみの短語は除外
    if (term.length < 2) continue;
    if (/^[a-z0-9]+$/.test(term) && term.length < 3) continue;

    addByLabel[bestLab].push(term);
    bestScoreByTerm.set(term, bestCount);
  }

  // 既存 lexicon とマージ（重複除去＆上限、かつ新規は頻度降順で）
  const lex = readLexicon();

  for (const lab of LABELS) {
    const existing: string[] = Array.isArray(lex[lab]) ? lex[lab] : [];

    // 新規候補（既存に無いもの）を頻度降順で整列
    const incoming = (addByLabel[lab] || [])
      .filter(w => !existing.includes(w))
      .sort((a, b) => (bestScoreByTerm.get(b)! - bestScoreByTerm.get(a)! || a.localeCompare(b)));

    const merged = existing.concat(incoming);
    lex[lab] = merged.slice(0, MAX_PER_LABEL);
  }

  writeLexicon(lex);

  console.log(
    `[retrain] days=${DAYS} minCount=${MIN_COUNT} minRatio=${MIN_RATIO} server=${SERVER_ID || "*"}`
  );
  console.log(
    "[retrain] added",
    (LABELS as Label[]).map(l => `${l}+${(addByLabel[l] || []).length}`).join(" "),
    "→ data/lexicon.json updated"
  );
}

main()
  .catch((e) => {
    console.error("[retrain] failed:", e?.message || e);
    process.exit(1);
  })
  .finally(async () => {
    try { await prisma.$disconnect(); } catch { /* noop */ }
  });
