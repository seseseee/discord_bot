import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const serverId = searchParams.get("serverId") ?? "testserver";
  const days = parseInt(searchParams.get("days") ?? "7", 10);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  // 対象メッセージ
  const messages = await prisma.message.findMany({
    where: { serverId, createdAt: { gte: since } },
    select: { id: true, contentText: true, authorId: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });
  const ids = messages.map((m) => m.id);

  // 付与されたラベル（複数）
  const labels = ids.length
    ? await prisma.label.findMany({
        where: { messageId: { in: ids } },
        select: { label: true, infoMentions: true },
      })
    : [];

  // 1) カテゴリ内訳（"S|TP" → "S", "TP" をそれぞれ+1）
  const categoryCounts: Record<string, number> = {};
  for (const l of labels) {
    const parts = (l.label ?? "")
      .split("|")
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length === 0) continue;
    for (const p of parts) {
      categoryCounts[p] = (categoryCounts[p] ?? 0) + 1;
    }
  }

  // 2) infoMentionCount（配列/JSON文字列/カンマ区切り文字列に耐性）
  const infoMentionCount = labels.reduce((acc, l) => {
    const v: any = (l as any).infoMentions;
    if (!v) return acc;
    if (Array.isArray(v)) return acc + v.length;
    if (typeof v === "string") {
      // JSON配列ならパース、ダメならカンマ or 空白区切りで数える
      try {
        const parsed = JSON.parse(v);
        if (Array.isArray(parsed)) return acc + parsed.length;
      } catch {}
      return acc + v.split(/[,\s]+/).filter(Boolean).length;
    }
    return acc;
  }, 0);

  // 3) ざっくり指標（必要ならお好みで調整）
  const minSpeakerTokens = messages.length
    ? Math.min(...messages.map((m) => (m.contentText?.length ?? 0)))
    : 0;
  const mutualMentionDensity = 0; // 集計ロジック未実装なら 0 のまま

  return NextResponse.json({
    windowDays: days,
    messageCount: messages.length,
    infoMentionCount,
    minSpeakerTokens,
    mutualMentionDensity,
    fairness: { avg: null, var: null, n: 0 },
    categoryCounts,
  });
}
