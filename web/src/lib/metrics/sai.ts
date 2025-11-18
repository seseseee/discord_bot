// src/lib/metrics/sai.ts
import type { PrismaClient } from "@prisma/client";
import { prisma as prismaSingleton } from "@/lib/prisma";

export type SAIResult = {
  serverId: string;
  channelId?: string | null;
  windowMinutes: number;
  from: string; // ISO
  to: string;   // ISO
  counts: { messages: number; users: number };
  metrics: {
    msg_rate: number;        // 0..1
    user_diversity: number;  // 0..1
    turn_taking: number;     // 0..1
    burst_inverse: number;   // 0..1
    topical_variety: number; // 0..1
  };
  sai: number; // 0..100
};

export type SAISeriesPoint = {
  t: string; // ISO (bucket start)
  windowMinutes: number;
  counts: { messages: number; users: number };
  metrics: SAIResult["metrics"];
  sai: number;
};

// ★ 分析チャンネルID を .env から取得
const ANALYSIS_CH =
  process.env.ANALYSIS_CHANNEL_ID ||
  process.env.DISCORD_ANALYSIS_CHANNEL_ID ||
  "";

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

function entropyNorm(counts: Map<string, number>) {
  const total = Array.from(counts.values()).reduce((a, b) => a + b, 0);
  if (total <= 0) return 0;
  const probs = Array.from(counts.values()).map((c) => c / total);
  const H = -probs.reduce((s, p) => (p > 0 ? s + p * Math.log2(p) : s), 0);
  const maxH = Math.log2(Math.max(1, counts.size));
  return maxH > 0 ? clamp01(H / maxH) : 0;
}

/** 単発SAI（既存） */
export async function computeSAI(opts: {
  serverId: string;
  channelId?: string | null;
  windowMinutes?: number;
  prisma?: PrismaClient;
}): Promise<SAIResult> {
  const {
    serverId,
    channelId = null,
    prisma = prismaSingleton,
  } = opts;

  const windowMinutes = Number(
    opts.windowMinutes ?? process.env.SAI_WINDOW_MIN ?? 60
  );

  const now = new Date();
  const from = new Date(now.getTime() - windowMinutes * 60 * 1000);

  // 期間内メッセージ（古→新）
  const where: any = {
    serverId,
    createdAt: { gte: BigInt(from.getTime()), lte: BigInt(now.getTime()) },
  };

  // ★ 明示 channelId 指定があればそれを優先、なければ分析CHを除外
  if (channelId) {
    where.channelId = channelId;
  } else if (ANALYSIS_CH) {
    where.channelId = { not: ANALYSIS_CH };
  }

  const rows = await prisma.message.findMany({
    where,
    orderBy: { createdAt: "asc" },
    select: {
      authorId: true,
      createdAt: true,
      labels: {
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { label: true },
      },
    },
  });

  const N = rows.length;
  const uniqueUsers = new Set(rows.map((r) => r.authorId)).size;

  // 1) 分あたり密度（0〜2 msg/min → 0〜1）
  const msgPerMin = N / Math.max(1, windowMinutes);
  const msg_rate = clamp01(msgPerMin / 2.0);

  // 2) ユーザー分布のエントロピー正規化
  const userCount = new Map<string, number>();
  rows.forEach((r) => userCount.set(r.authorId, (userCount.get(r.authorId) ?? 0) + 1));
  const user_diversity = entropyNorm(userCount);

  // 3) 交替率
  let turn = 0;
  for (let i = 1; i < N; i++) {
    if (rows[i].authorId !== rows[i - 1].authorId) turn++;
  }
  const turn_taking = N > 1 ? clamp01(turn / (N - 1)) : 0;

  // 4) 間隔の安定性（median/mean）
  const gaps: number[] = [];
  for (let i = 1; i < N; i++) {
    const dt = Number(rows[i].createdAt - rows[i - 1].createdAt) / 1000; // sec
    gaps.push(Math.max(0, dt));
  }
  let burst_inverse = 0;
  if (gaps.length >= 2) {
    const sorted = [...gaps].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    burst_inverse = clamp01(mean > 0 ? median / mean : 0);
  }

  // 5) ラベル多様性（最新ラベルを使用）
  const labelCount = new Map<string, number>();
  for (const r of rows) {
    const lab = r.labels?.[0]?.label || "CH";
    labelCount.set(lab, (labelCount.get(lab) ?? 0) + 1);
  }
  const topical_variety = entropyNorm(labelCount);

  // 重み付け合成
  const w = { msg_rate: 0.28, user_diversity: 0.22, turn_taking: 0.18, burst_inverse: 0.16, topical_variety: 0.16 };
  const score01 =
    msg_rate * w.msg_rate +
    user_diversity * w.user_diversity +
    turn_taking * w.turn_taking +
    burst_inverse * w.burst_inverse +
    topical_variety * w.topical_variety;

  return {
    serverId,
    channelId,
    windowMinutes,
    from: from.toISOString(),
    to: now.toISOString(),
    counts: { messages: N, users: uniqueUsers },
    metrics: { msg_rate, user_diversity, turn_taking, burst_inverse, topical_variety },
    sai: Math.round(clamp01(score01) * 100),
  };
}

/** バケット開始に丸める */
function floorToBucket(d: Date, bucket: "hour"|"day"|"week"|"month") {
  const dt = new Date(d);
  if (bucket === "hour") { dt.setMinutes(0,0,0); return dt; }
  if (bucket === "day")  { dt.setHours(0,0,0,0); return dt; }
  if (bucket === "week") {
    const day = dt.getDay(); // 0:Sun
    const diff = (day + 6) % 7; // 月始まり（Mon=0）
    dt.setDate(dt.getDate() - diff);
    dt.setHours(0,0,0,0);
    return dt;
  }
  // month
  dt.setDate(1); dt.setHours(0,0,0,0); return dt;
}

/** 次のバケット開始 */
function addBucket(d: Date, bucket: "hour"|"day"|"week"|"month") {
  const dt = new Date(d);
  if (bucket === "hour") { dt.setHours(dt.getHours()+1); return dt; }
  if (bucket === "day")  { dt.setDate(dt.getDate()+1); return dt; }
  if (bucket === "week") { dt.setDate(dt.getDate()+7); return dt; }
  // month
  dt.setMonth(dt.getMonth()+1); return dt;
}

function bucketMinutes(bucket: "hour"|"day"|"week"|"month") {
  return bucket === "hour" ? 60 : bucket === "day" ? 1440 : bucket === "week" ? 10080 : 43200; // 30d=43200
}

/** SAIの時系列（バケット集計） */
export async function computeSAISeries(opts: {
  serverId: string;
  channelId?: string | null;
  from: string | Date;
  to: string | Date;
  bucket?: "hour" | "day" | "week" | "month";
  prisma?: PrismaClient;
}): Promise<SAISeriesPoint[]> {
  const {
    serverId,
    channelId = null,
    prisma = prismaSingleton,
  } = opts;

  const bucket = opts.bucket ?? "day";
  const to   = typeof opts.to   === "string" ? new Date(opts.to)   : new Date(opts.to);
  const from = typeof opts.from === "string" ? new Date(opts.from) : new Date(opts.from);

  const where: any = {
    serverId,
    createdAt: { gte: BigInt(from.getTime()), lte: BigInt(to.getTime()) },
  };

  // ★ 明示 channelId 指定があればそれを優先、なければ分析CHを除外
  if (channelId) {
    where.channelId = channelId;
  } else if (ANALYSIS_CH) {
    where.channelId = { not: ANALYSIS_CH };
  }

  const rows = await prisma.message.findMany({
    where,
    orderBy: { createdAt: "asc" },
    select: {
      authorId: true,
      createdAt: true,
      labels: { orderBy: { createdAt: "desc" }, take: 1, select: { label: true } },
    },
  });

  // バケットに振り分けて各メトリクスを計算
  const map = new Map<number, Array<typeof rows[0]>>();
  for (const r of rows) {
    const t = new Date(Number(r.createdAt));
    const key = floorToBucket(t, bucket).getTime();
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(r);
  }

  // 欠損バケットも0で埋める
  const start = floorToBucket(from, bucket);
  const end   = floorToBucket(to, bucket);
  const points: SAISeriesPoint[] = [];
  for (let cursor = new Date(start); cursor <= end; cursor = addBucket(cursor, bucket)) {
    const key = cursor.getTime();
    const items = map.get(key) ?? [];
    const N = items.length;
    const uniqueUsers = new Set(items.map((r) => r.authorId)).size;

    const minutes = bucketMinutes(bucket);
    const msgPerMin = N / Math.max(1, minutes);
    const msg_rate = clamp01(msgPerMin / 2.0);

    const userCount = new Map<string, number>();
    items.forEach((r) => userCount.set(r.authorId, (userCount.get(r.authorId) ?? 0) + 1));
    const user_diversity = entropyNorm(userCount);

    let turn = 0;
    for (let i = 1; i < items.length; i++) {
      if (items[i].authorId !== items[i - 1].authorId) turn++;
    }
    const turn_taking = items.length > 1 ? clamp01(turn / (items.length - 1)) : 0;

    const gaps: number[] = [];
    for (let i = 1; i < items.length; i++) {
      const dt = Number(items[i].createdAt - items[i - 1].createdAt) / 1000;
      gaps.push(Math.max(0, dt));
    }
    let burst_inverse = 0;
    if (gaps.length >= 2) {
      const sorted = [...gaps].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
      burst_inverse = clamp01(mean > 0 ? median / mean : 0);
    }

    const labelCount = new Map<string, number>();
    for (const r of items) {
      const lab = r.labels?.[0]?.label || "CH";
      labelCount.set(lab, (labelCount.get(lab) ?? 0) + 1);
    }
    const topical_variety = entropyNorm(labelCount);

    const w = { msg_rate: 0.28, user_diversity: 0.22, turn_taking: 0.18, burst_inverse: 0.16, topical_variety: 0.16 };
    const score01 =
      msg_rate * w.msg_rate +
      user_diversity * w.user_diversity +
      turn_taking * w.turn_taking +
      burst_inverse * w.burst_inverse +
      topical_variety * w.topical_variety;

    points.push({
      t: new Date(key).toISOString(),
      windowMinutes: minutes,
      counts: { messages: N, users: uniqueUsers },
      metrics: { msg_rate, user_diversity, turn_taking, burst_inverse, topical_variety },
      sai: Math.round(clamp01(score01) * 100),
    });
  }

  return points;
}
