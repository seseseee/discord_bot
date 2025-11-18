import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ANALYSIS_CH = process.env.ANALYSIS_CHANNEL_ID || process.env.DISCORD_ANALYSIS_CHANNEL_ID || "";

function json(data: any, status = 200) {
  return new NextResponse(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

function rangeToFromTo(range: string | null) {
  const now = new Date();
  const to = now;
  const from = new Date(now);
  switch ((range || "month").toLowerCase()) {
    case "day":  from.setUTCDate(from.getUTCDate() - 1); break;
    case "week": from.setUTCDate(from.getUTCDate() - 7); break;
    case "year": from.setUTCFullYear(from.getUTCFullYear() - 1); break;
    default:     from.setUTCMonth(from.getUTCMonth() - 1); break;
  }
  return { from, to };
}

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const serverId = (url.searchParams.get("serverId") ||
      process.env.SERVER_ID ||
      process.env.NEXT_PUBLIC_SERVER_ID ||
      "").trim();
    if (!serverId) return json({ ok: false, error: "missing serverId" }, 400);

    const range = url.searchParams.get("range");
    const { from, to } = rangeToFromTo(range);

    const whereBase: any = {
      serverId,
      createdAt: { gte: BigInt(from.getTime()), lte: BigInt(to.getTime()) },
      ...(ANALYSIS_CH ? { channelId: { not: ANALYSIS_CH } } : {}),
    };

    const rows = await prisma.message.findMany({
      where: whereBase,
      orderBy: { createdAt: "asc" },
      select: {
        id: true, authorId: true, channelId: true, createdAt: true,
        labels: { orderBy: { createdAt: "desc" }, take: 1, select: { label: true } },
      },
    });

    const byUserTotal = new Map<string, number>();
    const byUserTP = new Map<string, number>();
    const byUserQ  = new Map<string, number>();
    const byUserAG = new Map<string, number>();

    for (const r of rows) {
      const u = r.authorId;
      byUserTotal.set(u, (byUserTotal.get(u) ?? 0) + 1);

      const lab = (r.labels?.[0]?.label || "").toUpperCase();
      if (lab === "TP") byUserTP.set(u, (byUserTP.get(u) ?? 0) + 1);
      if (lab === "Q")  byUserQ.set(u,  (byUserQ.get(u)  ?? 0) + 1);
      if (lab === "AG") byUserAG.set(u, (byUserAG.get(u) ?? 0) + 1);
    }

    function topN(map: Map<string, number>, n = 20) {
      const total = Array.from(map.values()).reduce((a, b) => a + b, 0) || 1;
      return Array.from(map.entries())
        .sort((a, b) => (b[1] - a[1]))
        .slice(0, n)
        .map(([userId, count]) => ({ userId, count, share: count / total }));
    }

    const result = {
      from: from.toISOString(),
      to: to.toISOString(),
      serverId,
      excludedChannels: ANALYSIS_CH ? [ANALYSIS_CH] : [],
      rankings: {
        active:   topN(byUserTotal, 20), // 発言数
        topic:    topN(byUserTP, 20),    // 話題提示
        question: topN(byUserQ, 20),     // 質問王
        agree:    topN(byUserAG, 20),    // AG王
      }
    };

    return json({ ok: true, ...result });
  } catch (err: any) {
    return json({ ok: false, error: String(err?.message ?? err) }, 500);
  }
}

export function POST(req: NextRequest) { return GET(req); }
