// web/scripts/roll_median_job.ts
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { prisma } from "../src/lib/prisma";

const DAYS = Number(process.env.SAI_BASELINE_DAYS ?? "14");

function ensureDir(p: string) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function median(arr: number[]) {
  if (!arr.length) return 0;
  const a = [...arr].sort((x, y) => x - y);
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

async function main() {
  const serverId = process.env.SERVER_ID || process.env.NEXT_PUBLIC_SERVER_ID || "";
  if (!serverId) throw new Error("SERVER_ID が未設定です");

  const now = new Date();
  const since = new Date(now.getTime() - DAYS * 24 * 60 * 60 * 1000);
  const hour = now.getHours();

  // 過去N日、同じ hour の範囲を抽出（雑に：その時間±30分）
  const startHour = new Date(now);
  startHour.setHours(hour, 0, 0, 0);

  const lower = new Date(startHour.getTime() - 30 * 60 * 1000);
  const upper = new Date(startHour.getTime() + 30 * 60 * 1000);

  // 各日ブロックごとの件数→1分当たりに正規化
  const windowMin = 60;
  const perMinute: number[] = [];

  const dayMs = 24 * 60 * 60 * 1000;
  for (let t = lower.getTime(); t >= since.getTime(); t -= dayMs) {
    const lo = t;
    const hi = t + (upper.getTime() - lower.getTime());

    const msgs = await prisma.message.count({
      where: {
        serverId,
        createdAt: { gte: BigInt(lo), lt: BigInt(hi) },
      },
    });
    perMinute.push(msgs / windowMin);
  }

  const med = median(perMinute.filter((x) => Number.isFinite(x)));
  const out = { serverId, hour, days: DAYS, medianPerMinute: med, updatedAt: new Date().toISOString() };

  const baseDir = path.resolve(process.cwd(), "data", "metrics", "baseline");
  ensureDir(baseDir);
  const file = path.join(baseDir, `baseline_${serverId}_h${hour}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2), "utf8");

  console.log("[baseline] saved:", file, out);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
