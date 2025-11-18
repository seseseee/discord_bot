"use client";

type Cell = { userId: string; label: string; count: number };
type Row = { userId: string; byLabel: Record<string, number> };

export default function UserLabelMatrix({
  title, labels, cells,
}: { title: string; labels: string[]; cells: Cell[] }) {
  const users = Array.from(new Set(cells.map(c => c.userId)));
  const rows: Row[] = users.map(uid => {
    const byLabel: Record<string, number> = {};
    for (const l of labels) byLabel[l] = 0;
    for (const c of cells) if (c.userId === uid) byLabel[c.label] = (byLabel[c.label] ?? 0) + c.count;
    return { userId: uid, byLabel };
  });

  return (
    <div className="rounded-2xl border bg-white/70 p-4 shadow-sm overflow-x-auto">
      <div className="mb-2 text-sm font-semibold opacity-70">{title}</div>
      <table className="min-w-[600px] text-sm">
        <thead>
          <tr>
            <th className="px-2 py-1 text-left opacity-60">User</th>
            {labels.map(l => (
              <th key={l} className="px-2 py-1 text-right opacity-60">{l}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.userId} className="border-t">
              <td className="px-2 py-1">{r.userId}</td>
              {labels.map(l => (
                <td key={l} className="px-2 py-1 text-right font-mono">{r.byLabel[l] ?? 0}</td>
              ))}
            </tr>
          ))}
          {rows.length === 0 && (
            <tr><td colSpan={1 + labels.length} className="px-2 py-6 text-center opacity-60">データなし</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
