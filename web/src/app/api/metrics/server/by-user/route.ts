// src/app/api/metrics/by-user/route.ts
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

type Cat = "AG"|"TP"|"EM"|"S"|"Q"|"CH"|"BOT";
const CATS: Cat[] = ["AG","TP","EM","S","Q","CH","BOT"];

function nowMinusDays(days: number) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const serverId =
      searchParams.get("serverId") ||
      process.env.NEXT_PUBLIC_SERVER_ID || ""; // ← 環境変数でも可
    const days = Number(searchParams.get("days") || "7");

    if (!serverId) {
      return NextResponse.json(
        { ok: false, error: "missing serverId" },
        { status: 400 }
      );
    }

    const since = nowMinusDays(isFinite(days) ? days : 7);

    // 各メッセージの「最新のラベル」だけ採用する
    const msgs = await prisma.message.findMany({
      where: { serverId, createdAt: { gte: since } },
      select: {
        authorId: true,
        labels: {
          take: 1,
          orderBy: { createdAt: "desc" },
          select: { label: true },
        },
      },
      orderBy: { createdAt: "asc" },
    });

    // 集計
    const byUser = new Map<
      string,
      { messageCount: number; labelCounts: Record<Cat, number> }
    >();

    for (const m of msgs) {
      const u = m.authorId ?? "(unknown)";
      if (!byUser.has(u)) {
        byUser.set(u, {
          messageCount: 0,
          labelCounts: Object.fromEntries(CATS.map(c => [c, 0])) as Record<
            Cat,
            number
          >,
        });
      }
      const row = byUser.get(u)!;
      row.messageCount += 1;

      const raw = m.labels?.[0]?.label || "";
      // "AG|TP|S" のような複合を分割してカウント
      const parts = raw
        .split("|")
        .map(s => s.trim())
        .filter((s): s is Cat => CATS.includes(s as Cat));
      if (parts.length === 0) {
        // どれにも当てはまらなければ CH として数える（好みで変更可）
        row.labelCounts["CH"] += 1;
      } else {
        for (const p of parts) row.labelCounts[p] += 1;
      }
    }

    const users = Array.from(byUser.entries()).map(([authorId, v]) => ({
      authorId,
      messageCount: v.messageCount,
      share: 0, // 後で埋める
      labelCounts: v.labelCounts,
    }));

    const totalMessages = users.reduce((a, b) => a + b.messageCount, 0);
    const userCount = users.length;

    // シェア算出
    for (const u of users) {
      u.share = totalMessages > 0 ? u.messageCount / totalMessages : 0;
    }

    // 1% / 9% / 90%
    users.sort((a, b) => b.messageCount - a.messageCount);
    const top1N = Math.max(1, Math.floor(userCount * 0.01));
    const next9N = Math.max(0, Math.floor(userCount * 0.09));
    const top1 = users.slice(0, top1N);
    const next9 = users.slice(top1N, top1N + next9N);
    const rest = users.slice(top1N + next9N);

    const sum = (xs: typeof users) => xs.reduce((n, u) => n + u.messageCount, 0);
    const mkTier = (xs: typeof users) => ({
      userCount: xs.length,
      messageCount: sum(xs),
      share: totalMessages > 0 ? sum(xs) / totalMessages : 0,
      avgPerUser: xs.length > 0 ? sum(xs) / xs.length : 0,
    });

    const payload = {
      ok: true,
      serverId,
      windowDays: isFinite(days) ? days : 7,
      totals: { messageCount: totalMessages, userCount },
      users,
      tiers: { top1: mkTier(top1), next9: mkTier(next9), rest90: mkTier(rest) },
      categories: CATS,
    };

    // 文字化け防止に UTF-8 明示
    return NextResponse.json(payload, {
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: String(e?.message ?? e) },
      { status: 500 }
    );
  }
}
