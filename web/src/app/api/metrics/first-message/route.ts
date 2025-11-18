// web/src/app/api/metrics/first-message/route.ts
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ANALYSIS_CH =
  process.env.ANALYSIS_CHANNEL_ID ||
  process.env.DISCORD_ANALYSIS_CHANNEL_ID ||
  "";

function json(body: any, status = 200) {
  return new NextResponse(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

function getServerId(req: NextRequest) {
  const url = new URL(req.url);
  const q = url.searchParams.get("serverId")?.trim();
  const env =
    process.env.SERVER_ID ||
    process.env.NEXT_PUBLIC_SERVER_ID ||
    process.env.COMMAND_GUILD_ID ||
    "";
  const id = (q || env || "").trim();
  if (!id) throw new Error("serverId が必要です（?serverId=... か .env）");
  return id;
}

// BigInt(createdAt) → number(ms) に正規化（秒格納レガシーにも対応）
function normalizeCreatedAtMs(bi: bigint): number {
  const n = Number(bi);
  return n < 1e12 ? n * 1000 : n; // 10桁なら秒→ms
}

export async function GET(req: NextRequest) {
  try {
    const serverId = getServerId(req);

    const where: any = {
      serverId,
      excludedFromMetrics: false,
      authorIsBot: false,
    };
    if (ANALYSIS_CH) {
      where.NOT = { channelId: ANALYSIS_CH };
    }

    const first = await prisma.message.findFirst({
      where,
      orderBy: { createdAt: "asc" },
      select: { createdAt: true },
    });

    if (!first) {
      return json({
        ok: true,
        earliestMs: null,
        earliestIso: null,
        earliestSundayIso: null,
        anchorIso: null,
      });
    }

    const earliestMs = normalizeCreatedAtMs(first.createdAt as unknown as bigint);
    const earliest = new Date(earliestMs);

    const sunday = new Date(earliest);
    const w = sunday.getDay(); // 0=Sun
    sunday.setHours(0, 0, 0, 0);
    sunday.setDate(sunday.getDate() - w); // その週の日曜

    const anchor = new Date(sunday);
    anchor.setDate(anchor.getDate() + 7); // 「取得開始日から一週間後」の日曜

    return json({
      ok: true,
      earliestMs,
      earliestIso: earliest.toISOString(),
      earliestSundayIso: sunday.toISOString(),
      anchorIso: anchor.toISOString(),
    });
  } catch (e: any) {
    return json({ ok: false, error: String(e?.message ?? e) }, 400);
  }
}

export function POST(req: NextRequest) { return GET(req); }
