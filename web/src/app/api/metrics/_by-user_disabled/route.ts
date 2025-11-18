import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { LABELS } from "@/lib/rules";

function tierSplit<T>(arr: T[], topPct=0.01, nextPct=0.09) {
  const n = arr.length;
  const topN = Math.max(1, Math.floor(n * topPct));
  const nextN = Math.floor(n * nextPct);
  return { topN, nextN };
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const serverId = searchParams.get("serverId") ?? "";
    const days = Number(searchParams.get("days") ?? "7");
    if (!serverId) return NextResponse.json({ ok:false, error:"missing serverId" }, { status:400 });

    const sinceMs = Date.now() - days * 24 * 60 * 60 * 1000;
    const since = BigInt(Math.floor(sinceMs));

    const msgs = await prisma.message.findMany({
      where: { serverId, createdAt: { gte: since } },
      select: {
        id: true,
        authorId: true,
        labels: { take: 1, orderBy: { createdAt: "desc" }, select: { label: true } },
      },
      orderBy: { createdAt: "asc" },
    });

    const byUser = new Map<string, { count:number; labelCounts: Record<string, number> }>();
    for (const m of msgs) {
      const u = m.authorId || "unknown";
      if (!byUser.has(u)) byUser.set(u, { count:0, labelCounts:Object.fromEntries(LABELS.map(l=>[l,0])) as any });
      const ref = byUser.get(u)!;
      ref.count += 1;
      const lab = m.labels?.[0]?.label as string|undefined;
      if (lab && lab in ref.labelCounts) ref.labelCounts[lab] += 1;
    }

    const users = Array.from(byUser.entries())
      .map(([authorId, v]) => ({ authorId, messageCount: v.count, labelCounts: v.labelCounts }))
      .sort((a,b)=> b.messageCount - a.messageCount);
    const total = users.reduce((a,b)=> a + b.messageCount, 0);
    const withShare = users.map(u => ({ ...u, share: total? u.messageCount/total : 0 }));

    const { topN, nextN } = tierSplit(withShare);
    const topUsers = withShare.slice(0, topN);
    const nextUsers = withShare.slice(topN, topN + nextN);
    const restUsers = withShare.slice(topN + nextN);

    function pack(arr:any[]) {
      const messageCount = arr.reduce((a,b)=> a + b.messageCount, 0);
      return { users: arr.map(x=>x.authorId), userCount: arr.length, messageCount,
               share: total? messageCount/total : 0, avgPerUser: arr.length? messageCount/arr.length : 0 };
    }

    return NextResponse.json({
      ok: true,
      serverId,
      windowDays: days,
      totals: { messageCount: total, userCount: withShare.length },
      users: withShare,
      tiers: { top1: pack(topUsers), next9: pack(nextUsers), rest90: pack(restUsers) },
      categories: LABELS,
    });
  } catch (e:any) {
    return NextResponse.json({ ok:false, error:String(e?.message ?? e) }, { status:500 });
  }
}