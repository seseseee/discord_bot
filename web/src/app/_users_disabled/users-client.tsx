"use client";

import { useEffect, useMemo, useState } from "react";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer,
} from "recharts";

type Cat = "AG" | "TP" | "EM" | "S" | "Q" | "CH" | "BOT";
type UserRow = {
  authorId: string;
  messageCount: number;
  share: number;
  labelCounts: Record<Cat, number>;
};
type Api = {
  serverId: string;
  windowDays: number;
  totals: { messageCount: number; userCount: number };
  users: UserRow[];
  tiers: {
    top1:  { users: string[]; userCount: number; messageCount: number; share: number; avgPerUser: number };
    next9: { users: string[]; userCount: number; messageCount: number; share: number; avgPerUser: number };
    rest90:{ users: string[]; userCount: number; messageCount: number; share: number; avgPerUser: number };
  };
  categories: Cat[];
};

export default function UsersClient({ serverId, days }: { serverId: string; days: number }) {
  const [data, setData] = useState<Api | null>(null);
  const [topN, setTopN] = useState(15);

  useEffect(() => {
    if (!serverId) return;
    const url = `/api/metrics/by-user?serverId=${serverId}&days=${days}`;
    fetch(url).then(r => r.json()).then(setData);
  }, [serverId, days]);

  const chartData = useMemo(() => {
    if (!data) return [];
    return data.users.slice(0, topN).map(u => ({
      user: u.authorId,
      ...u.labelCounts,
      total: u.messageCount,
    }));
  }, [data, topN]);

  if (!data) return <div className="p-8">Loading…</div>;

  return (
    <main className="p-6 space-y-8">
      <h1 className="text-2xl font-bold">ユーザー別カテゴリ可視化</h1>

      {/* 概要 */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard title="サーバID">{data.serverId}</StatCard>
        <StatCard title="期間（日）">{data.windowDays}</StatCard>
        <StatCard title="総コメント数">{data.totals.messageCount}</StatCard>
        <StatCard title="ユーザー数">{data.totals.userCount}</StatCard>
      </section>

      {/* 1%/9%/90% */}
      <section>
        <h2 className="text-xl font-semibold mb-2">1% / 9% / 90% 内訳</h2>
        <div className="overflow-x-auto">
          <table className="min-w-[640px] border text-sm">
            <thead className="bg-gray-50">
              <tr>
                <Th>層</Th><Th>人数</Th><Th>合計コメント</Th><Th>シェア</Th><Th>平均/人</Th>
              </tr>
            </thead>
            <tbody>
              <TierRow name="1%（トップ）"   t={data.tiers.top1}  total={data.totals.messageCount} />
              <TierRow name="9%（アクティブ）" t={data.tiers.next9} total={data.totals.messageCount} />
              <TierRow name="90%（その他）"  t={data.tiers.rest90} total={data.totals.messageCount} />
            </tbody>
          </table>
        </div>
      </section>

      {/* 棒グラフ */}
      <section className="space-y-2">
        <div className="flex items-center gap-3">
          <h2 className="text-xl font-semibold">ユーザー×カテゴリ（上位{topN}）</h2>
          <input
            type="number" min={5} max={50} value={topN}
            onChange={e => setTopN(Number(e.target.value))}
            className="border rounded px-2 py-1 w-24"
          />
        </div>
        <div className="h-[420px] w-full border rounded p-2">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData} margin={{ left: 10, right: 10, top: 10 }}>
              <XAxis dataKey="user" tick={{ fontSize: 12 }} />
              <YAxis allowDecimals={false} />
              <Tooltip />
              <Legend />
              {data.categories.map(c => (
                <Bar key={c} dataKey={c} stackId="labels" />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </div>
      </section>

      {/* 一覧表 */}
      <section className="space-y-2">
        <h2 className="text-xl font-semibold">ユーザー別サマリ</h2>
        <div className="overflow-x-auto">
          <table className="min-w-[960px] border text-sm">
            <thead className="bg-gray-50">
              <tr>
                <Th>ユーザー</Th>
                <Th>コメント数</Th>
                <Th>全体シェア</Th>
                {data.categories.map(c => <Th key={c}>{c}</Th>)}
              </tr>
            </thead>
            <tbody>
              {data.users.map(u => (
                <tr key={u.authorId} className="border-t">
                  <Td mono>{u.authorId}</Td>
                  <Td>{u.messageCount}</Td>
                  <Td>{(u.share * 100).toFixed(1)}%</Td>
                  {data.categories.map(c => (
                    <Td key={c}>{u.labelCounts[c] || 0}</Td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}

function StatCard({ title, children }: { title: string; children: any }) {
  return (
    <div className="border rounded p-4">
      <div className="text-xs opacity-60">{title}</div>
      <div className="text-xl">{children}</div>
    </div>
  );
}
function Th({ children }: { children: any }) {
  return <th className="text-left px-3 py-2 border-b">{children}</th>;
}
function Td({ children, mono }: { children: any; mono?: boolean }) {
  return <td className={`px-3 py-2 ${mono ? "font-mono text-xs" : ""}`}>{children}</td>;
}
function TierRow({
  name, t, total,
}: {
  name: string;
  t: { userCount: number; messageCount: number; share: number; avgPerUser: number };
  total: number;
}) {
  return (
    <tr className="border-t">
      <Td>{name}</Td>
      <Td>{t.userCount}</Td>
      <Td>{t.messageCount}</Td>
      <Td>{(t.share * 100).toFixed(1)}%</Td>
      <Td>{t.avgPerUser.toFixed(2)}</Td>
    </tr>
  );
}
