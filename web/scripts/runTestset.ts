#!/usr/bin/env ts-node
// C:\Users\icgks\Desktop\bot-main\web\scripts\runTestset.ts
import "dotenv/config";
import fs from "fs";
import path from "path";
import { PrismaClient } from "@prisma/client";
import type { Label as BaseLabel } from "../src/lib/rules";
import { LABELS as BASE_LABELS } from "../src/lib/rules";

const prisma = new PrismaClient();

/** 評価で使う拡張ラベル（未判定とBOTを含む） */
type TestLabel = BaseLabel | "BOT" | "(none)";



type Item = { id: string; text: string; expected: TestLabel };

const SERVER_ID = process.env.TEST_SERVER_ID || "testserver";
const CHANNEL_ID = "testset";
const BASE = process.env.TEST_BASE_URL || "http://localhost:3000";
/** 既定: BOT は採点対象から除外（含めたい場合は TEST_INCLUDE_BOT=true） */
const INCLUDE_BOT = (process.env.TEST_INCLUDE_BOT || "false").toLowerCase() === "true";

/** JSON を投げる小ヘルパー */
async function httpJson(url: string, method = "GET", body?: any) {
  const r = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`${method} ${url} -> ${r.status}`);
  return r.json().catch(() => ({}));
}

async function main() {
  // ===== テストセット読込 =====
  const p = path.join(process.cwd(), "test", "testset.json");
  const items: Item[] = JSON.parse(fs.readFileSync(p, "utf-8"));

  // 採点に含めるアイテム（既定は BOT 期待行を除外）
  const evalItems: Item[] = INCLUDE_BOT ? items : items.filter(i => i.expected !== "BOT");

  // ===== 既存データ掃除 =====
  const ids = items.map(i => i.id);

  await prisma.label.deleteMany({ where: { messageId: { in: ids } } });
  // Entity モデルが無い環境のために try/catch（ある場合のみ掃除）
  try {
    await (prisma as any).entity?.deleteMany?.({ where: { messageId: { in: ids } } });
  } catch { /* noop */ }
  await prisma.message.deleteMany({ where: { id: { in: ids } } });

  // ===== インジェスト =====
  const now = Date.now();
  for (let k = 0; k < items.length; k++) {
    const it = items[k];
    await httpJson(`${BASE}/api/ingest/discord`, "POST", {
      serverId: SERVER_ID,
      channelId: CHANNEL_ID,
      messageId: it.id,
      authorId: "u_test",
      authorIsBot: it.expected === "BOT",
      // Message.createdAt は BigInt の想定 → ミリ秒数を渡す
      createdAt: now + k,
      contentText: it.text,
      mentions: [],
    });
  }

  // ===== 解析（force=true で既存ラベル有無を問わず解析）=====
  const res = await httpJson(
    `${BASE}/api/analyze/batch?serverId=${SERVER_ID}&limit=${items.length + 5}&force=true`,
    "POST"
  );
  console.log("analyze:", { ok: res?.ok, analyzed: res?.analyzed });

  if (evalItems.length === 0) {
    console.log("No items to evaluate (BOTs were excluded). Set TEST_INCLUDE_BOT=true to include BOT rows.");
    return;
  }

  // ===== 最新ラベルを取得（createdAt 降順の先頭1件を採用）=====
  const latest = await prisma.label.findMany({
    where: { messageId: { in: evalItems.map(i => i.id) } },
    orderBy: { createdAt: "desc" },
    select: { messageId: true, label: true, createdAt: true },
  });
  const gotById = new Map<string, BaseLabel>();
  for (const row of latest) {
    // 同一 messageId については最初（最新）だけ採用
    if (!gotById.has(row.messageId)) {
      gotById.set(row.messageId, row.label as BaseLabel);
    }
  }

  // ===== 混同行列の器 =====
 const classes = [
  ...BASE_LABELS,
  "(none)" as const,
  ...(INCLUDE_BOT ? (["BOT"] as const) : ([] as const))
] as TestLabel[];

  const cm: Record<TestLabel, Record<TestLabel, number>> = {} as any;
  for (const e of classes) {
    cm[e] = {} as any;
    for (const g of classes) cm[e][g] = 0;
  }

  // ===== 採点 =====
  let ok = 0;
  const miss: Array<{ id: string; expected: TestLabel; got: TestLabel; text: string }> = [];
  for (const it of evalItems) {
    const gotBase = gotById.get(it.id);
    const got: TestLabel = gotBase ?? "(none)";
    if (got === it.expected) {
      ok++;
    } else {
      miss.push({ id: it.id, expected: it.expected, got, text: it.text });
    }
    cm[it.expected][got] = (cm[it.expected][got] || 0) + 1;
  }

  const acc = (ok / Math.max(1, evalItems.length) * 100).toFixed(1);

  // ===== 結果表示 =====
  console.log(`\n=== RESULT ===`);
  console.log(
    `Accuracy: ${ok}/${evalItems.length} = ${acc}%` +
      (INCLUDE_BOT ? "" : "  (BOT rows excluded; set TEST_INCLUDE_BOT=true to include)")
  );

  if (miss.length) {
    console.log(`\nMismatches (${miss.length}):`);
    for (const m of miss) {
      console.log(`- ${m.id} exp=${m.expected} got=${m.got}  text="${m.text}"`);
    }
  }

  console.log(`\nConfusion Matrix (rows=Expected, cols=Got):`);
  console.log(["    "].concat(classes as any).join("\t"));
  for (const e of classes) {
    const row = [e];
    for (const g of classes) row.push(String(cm[e][g] || 0));
    console.log(row.join("\t"));
  }
}

main()
  .catch(e => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    try {
      await prisma.$disconnect();
    } catch { /* noop */ }
  });
