// src/app/api/metrics/sai/route.ts
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { computeSAI } from "@/lib/metrics/sai";        // ← 修正（lib 側へ統一）
import { publishSAI } from "@/lib/sse/sai";            // ← 任意：即SSE配信したい場合

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function pickServerId(req: NextRequest): string {
  const url = new URL(req.url);
  const q = url.searchParams.get("serverId")?.trim();
  const envServer =
    process.env.SERVER_ID ||
    process.env.NEXT_PUBLIC_SERVER_ID ||
    process.env.COMMAND_GUILD_ID ||
    "";
  const serverId = (q || envServer || "").trim();
  if (!serverId) throw new Error("serverId が指定されていません（?serverId=... または .env の SERVER_ID / NEXT_PUBLIC_SERVER_ID / COMMAND_GUILD_ID）");
  return serverId;
}
function pickChannelId(req: NextRequest): string | undefined {
  const url = new URL(req.url);
  const ch = url.searchParams.get("channelId") || url.searchParams.get("channel");
  if (!ch) return undefined;
  const v = ch.trim().toLowerCase();
  return (v === "" || v === "all" || v === "null") ? undefined : ch.trim();
}
function pickWindowMinutes(req: NextRequest): number {
  const url = new URL(req.url);
  const w = url.searchParams.get("window") || url.searchParams.get("minutes") || url.searchParams.get("m");
  const n = Number(w ?? 60);
  if (!Number.isFinite(n) || n <= 0) return 60;
  return Math.max(1, Math.min(Math.floor(n), 24 * 60));
}
function json(data: any, status = 200) {
  return new NextResponse(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });
}

export async function GET(req: NextRequest) {
  const t0 = Date.now();
  try {
    const serverId = pickServerId(req);
    const channelId = pickChannelId(req);
    const windowMinutes = pickWindowMinutes(req);

    const result = await computeSAI({ prisma, serverId, channelId, windowMinutes });

    // 任意: ?broadcast=true でSSE配信
    const url = new URL(req.url);
    if (url.searchParams.get("broadcast") === "true") {
      publishSAI(result);
    }

    return json({
      ok: true as const,
      meta: { serverId, channelId: channelId ?? null, windowMinutes, tookMs: Date.now() - t0 },
      result,
    }, 200);
  } catch (err: any) {
    return json({ ok: false as const, error: String(err?.message ?? err) }, 400);
  }
}
export async function POST(req: NextRequest) { return GET(req); }
export function OPTIONS() { return json({ ok: true }); }
