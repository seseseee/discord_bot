// scripts/compute_sai.ts
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { prisma } from "../src/lib/prisma";
import { computeSAI } from "../src/app/api/metrics/sai";

function ensureDir(p: string) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

/**
 * 使い方:
 *   npm run metrics:sai:once -- --window 60
 *   npm run metrics:sai:once -- --channel 123456789012345678 --window 15
 *
 * .env:
 *   SERVER_ID or NEXT_PUBLIC_SERVER_ID を設定
 */
async function main() {
  const args = process.argv.slice(2);

  // 引数: [channel?] [window?] に対応もするが、基本はフラグを推奨
  let channelId: string | undefined;
  let windowMinutes: number | undefined;
  let noSave = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--channel" && args[i + 1]) {
      channelId = args[++i];
    } else if (a === "--window" && args[i + 1]) {
      windowMinutes = Number(args[++i]);
    } else if (a === "--no-save") {
      noSave = true;
    } else if (/^\d{5,}$/.test(a) && !channelId) {
      // 位置引数で channelId を渡された場合の互換
      channelId = a;
    } else if (!Number.isNaN(Number(a)) && !windowMinutes) {
      windowMinutes = Number(a);
    }
  }

  const serverId =
    process.env.SERVER_ID || process.env.NEXT_PUBLIC_SERVER_ID || "";
  if (!serverId) {
    throw new Error(
      "SERVER_ID が未設定です (.env の SERVER_ID または NEXT_PUBLIC_SERVER_ID を設定)"
    );
  }

  const result = await computeSAI({
    prisma,
    serverId,
    channelId,
    windowMinutes,
  });

  console.log("[SAI]", JSON.stringify(result, null, 2));

  if (noSave) return;

  // 出力: data/metrics/
  const base = path.resolve(process.cwd(), "data", "metrics");
  ensureDir(base);

  const latestFile = path.join(
    base,
    `sai_latest${channelId ? `_${channelId}` : ""}_${serverId}.json`
  );
  fs.writeFileSync(latestFile, JSON.stringify(result, null, 2), "utf8");

  const histDir = path.join(base, "history");
  ensureDir(histDir);
  const histFile = path.join(
    histDir,
    `${serverId}${channelId ? `_${channelId}` : ""}.ndjson`
  );
  fs.appendFileSync(histFile, JSON.stringify(result) + "\n", "utf8");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
