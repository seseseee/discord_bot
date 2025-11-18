import type { PrismaClient } from "@prisma/client";
import { prisma as prismaSingleton } from "@/lib/prisma";
import type { Label } from "@/lib/rules";
import { LABELS } from "@/lib/rules";

export type RangePreset = "week" | "month" | "year";

export function resolveRange(range?: RangePreset, from?: string|Date, to?: string|Date) {
  const now = new Date();
  if (from && to) return { from: new Date(from), to: new Date(to) };

  if (range === "week") {
    const end = new Date(now); end.setHours(23,59,59,999);
    const start = new Date(now); start.setDate(start.getDate() - 6); start.setHours(0,0,0,0);
    return { from: start, to: end };
  }
  if (range === "month") {
    const end = new Date(now); end.setHours(23,59,59,999);
    const start = new Date(now); start.setMonth(start.getMonth()-1); start.setHours(0,0,0,0);
    return { from: start, to: end };
  }
  if (range === "year") {
    const end = new Date(now); end.setHours(23,59,59,999);
    const start = new Date(now); start.setFullYear(start.getFullYear()-1); start.setHours(0,0,0,0);
    return { from: start, to: end };
  }
  // default 7d
  const end = new Date(now); end.setHours(23,59,59,999);
  const start = new Date(now); start.setDate(start.getDate() - 6); start.setHours(0,0,0,0);
  return { from: start, to: end };
}

type Row = {
  authorId: string;
  labels: { label: Label }[];
};

async function fetchRows(prisma: PrismaClient, serverId: string, channelId: string|null, from: Date, to: Date) {
  const where: any = {
    serverId,
    createdAt: { gte: BigInt(from.getTime()), lte: BigInt(to.getTime()) },
  };
  if (channelId) where.channelId = channelId;

  const rows = await prisma.message.findMany({
    where,
    orderBy: { createdAt: "asc" },
    select: {
      authorId: true,
      labels: { orderBy: { createdAt: "desc" }, take: 1, select: { label: true } },
    },
  });
  return rows as Row[];
}

export async function getTopUsersByLabel(opts: {
  prisma?: PrismaClient;
  serverId: string;
  channelId?: string | null;
  range?: RangePreset;
  from?: string|Date;
  to?: string|Date;
  label: Label;
  limit?: number;
}) {
  const prisma = opts.prisma ?? prismaSingleton;
  const { from, to } = resolveRange(opts.range, opts.from, opts.to);
  const rows = await fetchRows(prisma, opts.serverId, opts.channelId ?? null, from, to);

  const totalMsgs = rows.length || 1;
  const counter = new Map<string, number>();
  for (const r of rows) {
    const lab = r.labels?.[0]?.label?.toUpperCase?.() as Label | undefined;
    if (lab === opts.label) {
      counter.set(r.authorId, (counter.get(r.authorId) ?? 0) + 1);
    }
  }
  const items = Array.from(counter.entries())
    .map(([userId, count]) => ({ userId, count, share: count / totalMsgs }))
    .sort((a,b)=> b.count - a.count)
    .slice(0, opts.limit ?? 15);

  return { from: from.toISOString(), to: to.toISOString(), totalMsgs, items };
}

// ★ 修正点：mapped type と通常プロパティを交差型で合成
type Agg = { total: number } & Partial<Record<Label, number>>;

export async function getUserLabelMatrix(opts: {
  prisma?: PrismaClient;
  serverId: string;
  channelId?: string | null;
  range?: RangePreset;
  from?: string|Date;
  to?: string|Date;
}) {
  const prisma = opts.prisma ?? prismaSingleton;
  const { from, to } = resolveRange(opts.range, opts.from, opts.to);
  const rows = await fetchRows(prisma, opts.serverId, opts.channelId ?? null, from, to);

  const totalMsgs = rows.length || 1;
  const byUser = new Map<string, Agg>();

  for (const r of rows) {
    const lab = (r.labels?.[0]?.label || "CH").toUpperCase() as Label;
    if (!(LABELS as readonly Label[]).includes(lab)) continue;
    const agg: Agg = byUser.get(r.authorId) ?? { total: 0 };
    agg.total = (agg.total ?? 0) + 1;
    agg[lab] = (agg[lab] ?? 0) + 1;
    byUser.set(r.authorId, agg);
  }

  const matrix = Array.from(byUser.entries()).map(([userId, agg]) => {
    const rec: any = { userId, total: agg.total, share: (agg.total) / totalMsgs };
    for (const L of LABELS as readonly Label[]) rec[L] = agg[L] ?? 0;
    return rec;
  }).sort((a,b)=> b.total - a.total);

  return { from: from.toISOString(), to: to.toISOString(), totalMsgs, users: matrix.length, matrix };
}
