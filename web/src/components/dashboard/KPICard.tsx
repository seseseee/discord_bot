"use client";

export default function KPICard({
  title, value, sub,
}: { title: string; value: string | number; sub?: string }) {
  return (
    <div className="rounded-2xl border bg-white/70 p-4 shadow-sm">
      <div className="text-xs font-medium opacity-60">{title}</div>
      <div className="mt-1 text-3xl font-bold">{value}</div>
      {sub ? <div className="mt-1 text-xs opacity-60">{sub}</div> : null}
    </div>
  );
}
