// web/src/lib/metrics/save.ts
import fs from "node:fs";
import path from "node:path";
import type { SAIResult } from "./sai";
import { publishSAI } from "src/lib/sse/sai";

function ensureDir(p: string) { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); }

export function saveSAIToFiles(r: SAIResult) {
  const base = path.resolve(process.cwd(), "data", "metrics");
  ensureDir(base);

  const latestFile = path.join(
    base,
    `sai_latest${r.channelId ? `_${r.channelId}` : ""}_${r.serverId}.json`
  );
  fs.writeFileSync(latestFile, JSON.stringify(r, null, 2), "utf8");

  const histDir = path.join(base, "history");
  ensureDir(histDir);
  const histFile = path.join(histDir, `${r.serverId}${r.channelId ? `_${r.channelId}` : ""}.ndjson`);
  fs.appendFileSync(histFile, JSON.stringify(r) + "\n", "utf8");

  // フロントへSSE配信（任意）
  publishSAI(r);
}
