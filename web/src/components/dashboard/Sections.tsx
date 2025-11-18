"use client";

import { useEffect, useMemo, useState } from "react";
import SaiLineChart from "@/components/dashboard/SaiLineChart";
import { KPICard } from "@/components/dashboard/KPICard";
import { RankingTable } from "@/components/dashboard/RankingTable";
import { UserLabelMatrix } from "@/components/dashboard/UserLabelMatrix";

type SeriesPoint = { t: string; sai: number; counts: { messages: number; users: number } };
type TopItem = { userId: string; count: number; share?: number };
type RankingsResp = {
  ok: boolean;
  range: { from: string; to: string };
  top: { Q: TopItem[]; TP: TopItem[]; EM: TopItem[]; AG: TopItem[] };
  matrix: { totalMsgs: number; users: number; matrix: any[] };
};

export default function DashboardPage() {
  const [range, setRange] = useState<"week"|"month"|"year">("month");
  const [loading, setLoading] = useState(true);
  const [series, setSeries] = useState<SeriesPoint[]>([]);
  const [rank, setRank] = useState<RankingsResp | null>(null);

  const serverId = process.env.NEXT_PUBLIC_SERVER_ID || "";

  useEffect(() => {
    let ignore = false;

    const now = new Date();
    const to = now.toISOString();
    let from: string;
    let bucket: "day"|"week"|"month" = "day";
    if (range === "week")      { from = new Date(now.getTime()-7*24*60*60*1000).toISOString(); bucket="day"; }
    else if (range === "month"){ from = new Date(now.getTime()-30*24*60*60*1000).toISOString(); bucket="day"; }
    else                       { from = new Date(now.getTime()-365*24*60*60*1000).toISOString(); bucket="week"; }

    setLoading(true);
    Promise.all([
      fetch(`/api/metrics/sai/series?serverId=${serverId}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&bucket=${bucket}`, { cache: "no-store" }).then(r=>r.json()),
      fetch(`/api/rankings?serverId=${serverId}&range=${range}`, { cache: "no-store" }).then(r=>r.json()),
    ]).then(([saiSeries, rankings]) => {
      if (ignore) return;
      setSeries(Array.isArray(saiSeries?.series) ? saiSeries.series : []);
      setRank(rankings?.ok ? rankings as RankingsResp : null);
    }).finally(()=> { if (!ignore) setLoading(false); });

    return () => { ignore = true; };
  }, [range, serverId]);

  const latestSAI = useMemo(()=> series.length ? series[series.length-1].sai : 0, [series]);
  const totalMsgs = rank?.matrix?.totalMsgs ?? 0;
  const uniqUsers = rank?.matrix?.users ?? 0;

  return (
    <div className="min-h-screen bg-neutral-900 text-neutral-100">
      <div className="max-w-7xl mx-auto px-6 py-8">
        <div className="flex items-baseline justify-between">
          <h1 className="text-3xl font-semibold tracking-tight">コミュニティ ダッシュボード</h1>
          <div className="flex gap-2">
            {(["week","month","year"] as const).map(r => (
              <button
                key={r}
                onClick={()=> setRange(r)}
                className={`px-3 py-1.5 rounded-full border ${range===r ? "bg-neutral-100 text-neutral-900 border-neutral-100" : "border-neutral-600 hover:bg-neutral-800"}`}
              >
                {r === "week" ? "過去7日" : r === "month" ? "過去30日" : "過去1年"}
              </button>
            ))}
          </div>
        </div>

        {/* KPI */}
        <div className="grid md:grid-cols-4 sm:grid-cols-2 grid-cols-1 gap-6 mt-6">
          <KPICard title="最新SAI" value={latestSAI.toString()} suffix="/100" trend={series.map(p=>({ t:p.t, sai:p.sai }))} />
          <KPICard title="総コメント" value={totalMsgs.toString()} />
          <KPICard title="ユニークユーザー" value={uniqUsers.toString()} />
          <KPICard title="期間" value={range === "week" ? "7日" : range === "month" ? "30日" : "1年"} />
        </div>

        {/* SAI line */}
        <div className="mt-8 bg-neutral-800/50 border border-neutral-700 rounded-2xl p-4">
          <h2 className="text-xl font-semibold mb-3">SAI 対時間</h2>
          <SAILineChart data={series.map(p=>({ t:p.t, sai:p.sai }))} />
        </div>

        {/* Rankings */}
        <div className="grid lg:grid-cols-2 gap-6 mt-8">
          <RankingTable title="質問王 (Q)" items={rank?.top?.Q ?? []} />
          <RankingTable title="話題フリ最強 (TP)" items={rank?.top?.TP ?? []} />
          <RankingTable title="感情王 (EM)" items={rank?.top?.EM ?? []} />
          <RankingTable title="同意王 (AG)" items={rank?.top?.AG ?? []} />
        </div>

        {/* User x Label */}
        <div className="mt-8">
          <UserLabelMatrix matrix={rank?.matrix?.matrix ?? []} />
        </div>

        {loading && <div className="mt-6 text-sm text-neutral-400">読み込み中…</div>}
      </div>
    </div>
  );
}
