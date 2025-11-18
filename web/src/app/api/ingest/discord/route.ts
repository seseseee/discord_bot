// src/app/api/ingest/discord/route.ts
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import crypto from "node:crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* ────────────────────────────────────────────────────────────
 * Config / Env
 * ──────────────────────────────────────────────────────────── */
const ANALYSIS_CH =
  process.env.ANALYSIS_CHANNEL_ID ||
  process.env.DISCORD_ANALYSIS_CHANNEL_ID ||
  "";
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || "*"; // 必要なら特定Originに絞る
const INGEST_API_KEY =
  process.env.INGEST_API_KEY || process.env.FEEDBACK_API_KEY || ""; // 任意: 認証を有効化したい場合に設定

/* ────────────────────────────────────────────────────────────
 * CORS & Utils
 * ──────────────────────────────────────────────────────────── */
function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": ALLOW_ORIGIN,
    "Access-Control-Allow-Methods": "OPTIONS, POST",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}
function json(data: any, status = 200, extra: Record<string, string> = {}) {
  return new NextResponse(
    // BigInt混入を避けるため、出力は数値/文字列のみに
    JSON.stringify(data),
    {
      status,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        ...corsHeaders(),
        ...extra,
      },
    }
  );
}
function toBoolean(v: unknown, def = false) {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (["1", "true", "yes", "y"].includes(s)) return true;
    if (["0", "false", "no", "n"].includes(s)) return false;
  }
  return def;
}
function toStringSafe(v: unknown, def = ""): string {
  if (v === null || v === undefined) return def;
  return String(v);
}
function normalizeContent(s: string, maxLen = 4000): string {
  // NUL を除去し、改行は維持、長文は安全にトリム
  const cleaned = s.replace(/\u0000/g, "");
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen - 1) + "…" : cleaned;
}
function pickCreatedAtMs(body: any): number {
  // createdAt(数値/文字列/BigInt) または createdAtIso を受理
  const raw = body?.createdAt;
  const rawIso = body?.createdAtIso;

  if (typeof raw === "bigint") return Number(raw);
  if (typeof raw === "number" && Number.isFinite(raw)) return Math.floor(raw);
  if (typeof raw === "string" && raw.trim() !== "" && !Number.isNaN(+raw)) {
    return Math.floor(+raw);
  }
  if (typeof rawIso === "string" && rawIso.trim() !== "") {
    const t = Date.parse(rawIso);
    if (!Number.isNaN(t)) return t;
  }
  // 不正/欠落時は現在時刻（ミリ秒）
  return Date.now();
}
function clampMsToReasonableRange(ms: number): number {
  // 2005年〜今+1日の範囲で丸める（DiscordのSnowflake時代以降）
  const min = Date.UTC(2005, 0, 1);
  const max = Date.now() + 24 * 60 * 60 * 1000;
  if (!Number.isFinite(ms)) return Date.now();
  return Math.min(Math.max(ms, min), max);
}
// 置き換え：route.ts 内の constantTimeEquals をこれに差し替え
function constantTimeEquals(a: string, b: string) {
  // 文字列→Uint8Array（UTF-8）
  const te = new TextEncoder();
  const aU8 = te.encode(a);
  const bU8 = te.encode(b);

  if (aU8.length !== bU8.length) return false;
  return crypto.timingSafeEqual(aU8, bU8); // ← ArrayBufferView なので型エラーが消えます
}


/* ────────────────────────────────────────────────────────────
 * Auth (optional)
 * ──────────────────────────────────────────────────────────── */
function requireAuthIfEnabled(req: NextRequest) {
  if (!INGEST_API_KEY) return; // 無効化（従来通りオープン）
  const auth = req.headers.get("authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  const token = m?.[1]?.trim() || "";
  if (!token || !constantTimeEquals(token, INGEST_API_KEY)) {
    throw new Error("unauthorized");
  }
}

/* ────────────────────────────────────────────────────────────
 * OPTIONS (CORS preflight)
 * ──────────────────────────────────────────────────────────── */
export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: corsHeaders(),
  });
}

/* ────────────────────────────────────────────────────────────
 * POST /api/ingest/discord
 * ──────────────────────────────────────────────────────────── */
export async function POST(req: NextRequest) {
  try {
    requireAuthIfEnabled(req);

    let body: any;
    try {
      body = await req.json();
    } catch {
      return json({ ok: false, error: "invalid JSON" }, 400);
    }

    // ---- 取り込み ----
    const id = toStringSafe(body.messageId ?? body.id).trim();
    const serverId = toStringSafe(body.serverId).trim();
    const channelId = toStringSafe(body.channelId ?? "general").trim();
    const authorId = toStringSafe(body.authorId ?? "u?").trim();
    const authorIsBot = toBoolean(body.authorIsBot, false);
    const contentText = normalizeContent(toStringSafe(body.contentText ?? ""));
    const createdMs = clampMsToReasonableRange(pickCreatedAtMs(body));

    if (!id || !serverId) {
      return json({ ok: false, error: "missing id/serverId" }, 400);
    }

    // 分析CHやBot由来はメトリクス集計から除外
    const isAnalysis = ANALYSIS_CH && channelId === ANALYSIS_CH;
    const excludedFromMetrics = isAnalysis || authorIsBot || false;

    // ---- 冪等化: 既存レコードと同一ならスキップ（書き込み削減）----
    const existing = await prisma.message.findUnique({
      where: { id },
      select: {
        id: true,
        serverId: true,
        channelId: true,
        authorId: true,
        authorIsBot: true,
        contentText: true,
        createdAt: true,
        excludedFromMetrics: true,
      },
    });

    if (existing) {
      const same =
        existing.serverId === serverId &&
        existing.channelId === channelId &&
        existing.authorId === authorId &&
        existing.authorIsBot === authorIsBot &&
        existing.contentText === contentText &&
        Number(existing.createdAt) === createdMs &&
        existing.excludedFromMetrics === excludedFromMetrics;

      if (same) {
        return json({
          ok: true,
          id,
          unchanged: true,
          excludedFromMetrics,
          createdAtMs: createdMs,
        });
      }
    }

    // ---- upsert（新規or更新）----
    const rec = await prisma.message.upsert({
      where: { id },
      create: {
        id,
        serverId,
        channelId,
        authorId,
        authorIsBot,
        contentText,
        createdAt: BigInt(createdMs),
        excludedFromMetrics,
      },
      update: {
        serverId,
        channelId,
        authorId,
        authorIsBot,
        contentText,
        createdAt: BigInt(createdMs),
        excludedFromMetrics,
      },
      select: {
        id: true,
        excludedFromMetrics: true,
      },
    });

    // 作成/更新の判定は upsert からは取れないため、existing の有無で概算
    const created = !existing;

    return json(
      {
        ok: true,
        id: rec.id,
        excludedFromMetrics: rec.excludedFromMetrics,
        created,
        createdAtMs: createdMs,
      },
      created ? 201 : 200
    );
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (msg === "unauthorized") {
      return json({ ok: false, error: "unauthorized" }, 401, {
        "WWW-Authenticate": 'Bearer realm="ingest"',
      });
    }
    // Prismaユニーク制約など → upsertで通常発生しないが念のため
    if (msg.includes("Unique constraint failed")) {
      return json({ ok: true, dup: true }, 200);
    }
    return json({ ok: false, error: msg }, 500);
  }
}
