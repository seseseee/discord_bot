"use client";

import { useMemo } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from "recharts";

export type SaiPoint = { t: string; sai: number };

export default function SaiLineChart({ data, title }: { data: SaiPoint[]; title: string }) {
  const ds = useMemo(
    () => (data ?? []).map(d => ({ t: new Date(d.t).toLocaleDateString(), sai: d.sai })),
    [data]
  );

  return (
    <div className="rounded-2xl border bg-white/60 p-4 shadow-sm">
      <div className="mb-2 text-sm font-semibold opacity-70">{title}</div>
      <div className="h-60">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={ds}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="t" />
            <YAxis domain={[0, 100]} />
            <Tooltip />
            <Line type="monotone" dataKey="sai" strokeWidth={2} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
