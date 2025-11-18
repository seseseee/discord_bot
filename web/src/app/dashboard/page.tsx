// src/app/dashboard/page.tsx
"use client";

import { useEffect, useState } from "react";
import SaiLineChart from "@/components/dashboard/SaiLineChart";
import KPICard from "@/components/dashboard/KPICard";
import RankingTable from "@/components/dashboard/RankingTable";
import UserLabelMatrix from "@/components/dashboard/UserLabelMatrix";

// ===== types =====
export type SaiPoint = {
  t: string; // ISO
  windowMinutes: number;
  counts: { messages: number; users: number };
  metrics: {
    msg_rate: number;
    user_diversity: number;
    turn_taking: number;
    burst_inverse: number;
    topical_variety: number;
  };
  sai: number;
};

type RankingItem = { userId: string; score: number; displayName?: string; avatarUrl?: string };
type MatrixCell = { userId: string; label: string; count: number };

// ===== utils =====
const last = <T,>(arr: T[] | undefined | null) =>
  Array.isArray(arr) && arr.length ? arr[arr.length - 1] : undefined;

const median = (nums: number[]) => {
  if (!nums?.length) return 0;
  const arr = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(arr.length / 2);
  return arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
};

const safeSeriesFromJson = (js: any): SaiPoint[] => {
  if (Array.isArray(js)) return js as SaiPoint[];
  if (Array.isArray(js?.result)) return js.result as SaiPoint[];
  if (Array.isArray(js?.data)) return js.data as SaiPoint[];
  if (Array.isArray(js?.points)) return js.points as SaiPoint[];
  return [];
};

const toItems = (raw: any): RankingItem[] => {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((r) => ({
      userId: String(r.userId ?? r.id ?? ""),
      score: Number(r.score ?? r.count ?? r.value ?? 0),
      displayName: r.displayName ?? r.name ?? undefined,
      avatarUrl: r.avatarUrl ?? r.iconUrl ?? r.avatar ?? undefined,
    }))
    .filter((x) => x.userId);
};

const toMatrix = (raw: any): { labels: string[]; cells: MatrixCell[] } => {
  // 既に {labels, cells} 形式ならそのまま
  if (raw && Array.isArray(raw.labels) && Array.isArray(raw.cells)) {
    return { labels: raw.labels as string[], cells: raw.cells as MatrixCell[] };
  }
  // 配列の { userId, label, count } を想定して吸収
  if (Array.isArray(raw)) {
    const set = new Set<string>();
    const cells: MatrixCell[] = [];
    for (const r of raw) {
      const userId = String(r.userId ?? r.id ?? "");
      const label = String(r.label ?? r.tag ?? "");
      const count = Number(r.count ?? r.score ?? 0);
      if (!userId || !label) continue;
      set.add(label);
      cells.push({ userId, label, count });
    }
    return { labels: Array.from(set), cells };
  }
  return { labels: [], cells: [] };
};

// ===== page =====
export default function DashboardPage() {
  const serverId =
    process.env.NEXT_PUBLIC_SERVER_ID && process.env.NEXT_PUBLIC_SERVER_ID.trim() !== ""
      ? process.env.NEXT_PUBLIC_SERVER_ID
      : undefined;

  const [weekSeries, setWeekSeries] = useState<SaiPoint[]>([]);
  const [monthSeries, setMonthSeries] = useState<SaiPoint[]>([]);
  const [rankings, setRankings] = useState<any>(null);

  useEffect(() => {
    const now = new Date();
    const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const oneMonthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const qs = (from: Date, to: Date, bucket: "day" | "week" | "month" = "day") => {
      const p = new URLSearchParams({
        from: from.toISOString(),
        to: to.toISOString(),
        bucket,
      });
      if (serverId) p.set("serverId", serverId);
      return p.toString();
    };

    // SAI series（週・月）
    (async () => {
      const r1 = await fetch(`/api/metrics/sai/series?${qs(oneWeekAgo, now, "day")}`, {
        cache: "no-store",
      });
      const j1 = await r1.json().catch(() => ({}));
      setWeekSeries(safeSeriesFromJson(j1));

      const r2 = await fetch(`/api/metrics/sai/series?${qs(oneMonthAgo, now, "day")}`, {
        cache: "no-store",
      });
      const j2 = await r2.json().catch(() => ({}));
      setMonthSeries(safeSeriesFromJson(j2));
    })();

    // ランキング（月間）
    (async () => {
      const p = new URLSearchParams({ range: "month" });
      if (serverId) p.set("serverId", serverId);
      const rr = await fetch(`/api/rankings?${p.toString()}`, { cache: "no-store" });
      const jj = await rr.json().catch(() => ({}));
      setRankings(jj?.result ?? jj ?? null);
    })();
  }, [serverId]);

  // KPI
  const kMessages = last(monthSeries)?.counts.messages ?? 0;
  const kUsers = last(monthSeries)?.counts.users ?? 0;

  // ランキング安全化
  const itemsQ: RankingItem[] = toItems(rankings?.topQ);
  const itemsTP: RankingItem[] = toItems(rankings?.topTP);
  const itemsEM: RankingItem[] = toItems(rankings?.topEM);
  const itemsAG: RankingItem[] = toItems(rankings?.topAG);

  // 行列データ安全化
  const matrix = toMatrix(rankings?.userLabelMatrix);

  return (
    <main className="p-6 md:p-8 space-y-8">
      <header className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Discord ダッシュボード</h1>
          <p className="text-sm opacity-60">
            SAI 時系列と「質問王 / 話題フリ王 / 感情王 / 同意王」ランキング
          </p>
        </div>
      </header>

      {/* KPI cards */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KPICard title="期間メッセージ数" value={kMessages} />
        <KPICard title="ユニークユーザー" value={kUsers} />
        <KPICard title="直近SAI" value={last(weekSeries)?.sai ?? 0} />
        <KPICard title="月間SAI中央値" value={median((monthSeries ?? []).map((x) => x.sai))} />
      </section>

      {/* charts */}
      <section className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <SaiLineChart data={weekSeries} title="直近7日 SAI（日別）" />
        <SaiLineChart data={monthSeries} title="直近30日 SAI（日別）" />
      </section>

      {/* rankings */}
      <section className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <RankingTable title="質問王（Q）" items={itemsQ} />
        <RankingTable title="話題フリ王（TP）" items={itemsTP} />
        <RankingTable title="感情王（EM）" items={itemsEM} />
        <RankingTable title="同意王（AG）" items={itemsAG} />
      </section>

      {/* user × label matrix */}
      <section>
        <UserLabelMatrix title="ユーザー×ラベル分布" labels={matrix.labels} cells={matrix.cells} />
      </section>
    </main>
  );
}
