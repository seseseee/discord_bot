// src/lib/metrics/sai.ts
import type { PrismaClient } from "@prisma/client";
import { prisma as prismaSingleton } from "@/lib/prisma";

/**
 * SAI (Server Activation Index) の最終出力
 */
export type SAIResult = {
  serverId: string;
  channelId?: string | null;
  windowMinutes: number;
  from: string; // ISO
  to: string;   // ISO
  counts: { messages: number; users: number };
  metrics: {
    msg_rate: number;        // 0..1 (分あたり密度を緩く正規化)
    user_diversity: number;  // 0..1 (ユーザー分布エントロピー)
    turn_taking: number;     // 0..1 (交替率)
    burst_inverse: number;   // 0..1 (間隔の安定: median/mean)
    topical_variety: number; // 0..1 (ラベル多様性)
  };
  sai: number; // 0..100
};

function clamp01(x: number) {
  return Math.max(0, Math.min(1, x));
}

function entropyNorm(counts: Map<string, number>) {
  const total = Array.from(counts.values()).reduce((a, b) => a + b, 0);
  if (total <= 0) return 0;
  const probs = Array.from(counts.values()).map((c) => c / total);
  const H = -probs.reduce((s, p) => (p > 0 ? s + p * Math.log2(p) : s), 0);
  const maxH = Math.log2(Math.max(1, counts.size));
  return maxH > 0 ? clamp01(H / maxH) : 0;
}

/**
 * computeSAI
 * - prisma を渡さなければ既定の singleton を使用
 * - channelId は省略可能（サーバ全体集計）
 * - windowMinutes の既定は env SAI_WINDOW_MIN(なければ60)
 */
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

  // 期間内メッセージのみ取得（古→新）
  const where: any = {
    serverId,
    createdAt: { gte: BigInt(from.getTime()), lte: BigInt(now.getTime()) },
  };
  if (channelId) where.channelId = channelId;

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

  // 1) msg_rate: 分あたり密度を 0..1 にスケール（経験則で 0〜2 msg/min を 0〜1）
  const msgPerMin = N / Math.max(1, windowMinutes);
  const msg_rate = clamp01(msgPerMin / 2.0);

  // 2) user_diversity: ユーザー分布のエントロピー正規化
  const userCount = new Map<string, number>();
  rows.forEach((r) => userCount.set(r.authorId, (userCount.get(r.authorId) ?? 0) + 1));
  const user_diversity = entropyNorm(userCount);

  // 3) turn_taking: 直前と別ユーザーの割合（交替率）
  let turn = 0;
  for (let i = 1; i < N; i++) {
    if (rows[i].authorId !== rows[i - 1].authorId) turn++;
  }
  const turn_taking = N > 1 ? clamp01(turn / (N - 1)) : 0;

  // 4) burst_inverse: メッセージ間隔の安定性（median/mean）
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

  // 5) topical_variety: ラベル多様性（最新ラベル1件を使用）
  const labelCount = new Map<string, number>();
  for (const r of rows) {
    const lab = r.labels?.[0]?.label || "CH";
    labelCount.set(lab, (labelCount.get(lab) ?? 0) + 1);
  }
  const topical_variety = entropyNorm(labelCount);

  // 総合（重みは任意に調整可）
  const w = {
    msg_rate: 0.28,
    user_diversity: 0.22,
    turn_taking: 0.18,
    burst_inverse: 0.16,
    topical_variety: 0.16,
  };
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
